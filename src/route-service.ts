import type { AppConfig } from './config.js';
import type {
  DnsManager,
  PortProbe,
  PublishInput,
  RouteRecord,
  UpdateInput,
} from './domain.js';
import type { RouteStore } from './db/route-store.js';
import type { TraefikDocument } from './traefik.js';
import { buildTraefikDocument } from './traefik.js';
import { validateSlug, validatePort } from './policy.js';
import { RouteManagerError } from './errors.js';
import { KeyedLock } from './keyed-lock.js';

/**
 * Minimum description length constraint applied by the service layer.
 * The MCP schema must also enforce this.
 */
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * Runtime description validator that rejects non-string types and enforces
 * the maximum length. Accepts null and undefined (which clear the field).
 * Throws RouteManagerError with INVALID_SLUG on failure.
 */
function validateDescription(value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string') {
    throw new RouteManagerError(
      'INVALID_SLUG',
      'description must be a string',
    );
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    throw new RouteManagerError(
      'INVALID_SLUG',
      `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }
}

/**
 * Error codes that the reconciler automatically retries.
 */
const RETRYABLE_CODES = new Set(['DNS_UNAVAILABLE', 'PORT_UNREACHABLE']);

/**
 * Orchestrates the route lifecycle:
 *
 *   validate → [global lock: count + insertCreating]
 *   → DNS mutation → activate
 *
 * The security ordering guarantees: no persistence before validation/probe,
 * creating before DNS mutation, active only after DNS success, deleting
 * before DNS cleanup, and projection from active rows only.
 */
export class RouteService {
  private readonly slugLock = new KeyedLock();
  private readonly globalLock = new KeyedLock();
  private readonly config: AppConfig;
  private readonly store: RouteStore;
  private readonly dns: DnsManager | null;
  private readonly probe: PortProbe;

  constructor(deps: {
    config: AppConfig;
    store: RouteStore;
    dns: DnsManager | null;
    probe: PortProbe;
  }) {
    this.config = deps.config;
    this.store = deps.store;
    this.dns = deps.dns;
    this.probe = deps.probe;
  }

  // -------------------------------------------------------------------------
  // publish
  // -------------------------------------------------------------------------

  async publish(input: PublishInput): Promise<RouteRecord> {
    const description = input.description ?? null;

    // 1. Validate before any side effects
    validateSlug(input.slug, this.config);
    validatePort(input.port, this.config);
    validateDescription(input.description);

    return this.slugLock.run(input.slug, async () => {
      // 2. Re-read state after acquiring the slug lock
      const existing = await this.store.get(input.slug);
      if (existing) {
        throw new RouteManagerError(
          'ROUTE_ALREADY_EXISTS',
          `route "${input.slug}" already exists`,
        );
      }

      // 3. Early capacity check — fast failure before probe/DNS
      const earlyCount = await this.store.count();
      if (earlyCount >= this.config.maxRoutes) {
        throw new RouteManagerError(
          'ROUTE_LIMIT_REACHED',
          `route limit of ${this.config.maxRoutes} reached`,
        );
      }

      // 4. Probe upstream port before persistence
      const reachable = await this.probe(
        this.config.upstreamHost,
        input.port,
        this.config.probeTimeoutMs,
      );
      if (!reachable) {
        throw new RouteManagerError(
          'PORT_UNREACHABLE',
          `port ${input.port} on ${this.config.upstreamHost} is not reachable`,
        );
      }

      const hostname = `${input.slug}.${this.config.publicDomain}`;

      // 5. DNS preflight
      if (this.dns) {
        await this.dns.assertAvailable(hostname, input.slug);
      }

      // 6. Global capacity lock: re-count + insertCreating (closes races)
      const route = await this.globalLock.run('__global_capacity__', async () => {
        const total = await this.store.count();
        if (total >= this.config.maxRoutes) {
          throw new RouteManagerError(
            'ROUTE_LIMIT_REACHED',
            `route limit of ${this.config.maxRoutes} reached`,
          );
        }
        return this.store.insertCreating({
          slug: input.slug,
          port: input.port,
          description,
        });
      });
      // Global lock released — no more capacity checks.

      // 7. DNS mutation (creating before DNS)
      let recordId: string | null = null;
      if (this.dns) {
        try {
          const dnsRecord = await this.dns.ensureRecord(hostname, input.slug);
          await this.store.setCloudflareRecordId(input.slug, dnsRecord.id);
          recordId = dnsRecord.id;
        } catch (err) {
          const sanitized = err instanceof RouteManagerError
            ? err
            : new RouteManagerError('INTERNAL_ERROR', 'An internal error occurred');
          await this.store.recordError(input.slug, { code: sanitized.code, message: sanitized.message });
          throw err;
        }
      }

      // 8. Active only after DNS success
      return this.store.activate(input.slug, recordId);
    });
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(input: UpdateInput): Promise<RouteRecord> {
    // Validate before any side effects (all checks before slug lock)
    validateSlug(input.slug, this.config);
    validateDescription(input.description);
    if (input.port !== undefined) {
      validatePort(input.port, this.config);
    }

    return this.slugLock.run(input.slug, async () => {
      const route = await this.store.get(input.slug);
      if (!route) {
        throw new RouteManagerError(
          'ROUTE_NOT_FOUND',
          `route "${input.slug}" not found`,
        );
      }

      const portChanged = input.port !== undefined && input.port !== route.port;
      const descProvided = input.description !== undefined;

      // Probe replacement port only when it actually changed (inside lock)
      if (portChanged) {
        const reachable = await this.probe(
          this.config.upstreamHost,
          input.port!,
          this.config.probeTimeoutMs,
        );
        if (!reachable) {
          throw new RouteManagerError(
            'PORT_UNREACHABLE',
            `port ${input.port} on ${this.config.upstreamHost} is not reachable`,
          );
        }
      }

      // Build patch — description null explicitly clears it.
      // After the descProvided guard, input.description is string | null.
      const patch: { port?: number; description?: string | null } = {};
      if (portChanged) patch.port = input.port!;
      if (descProvided) patch.description = input.description as string | null;

      return this.store.updateActive(input.slug, patch);
    });
  }

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  async remove(
    slug: string,
  ): Promise<{ slug: string; removed: boolean }> {
    // Validate slug before any side effects
    validateSlug(slug, this.config);

    return this.slugLock.run(slug, async () => {
      const route = await this.store.get(slug);
      if (!route) return { slug, removed: false };

      // Mark deleting before DNS mutation
      await this.store.markDeleting(slug);

      await this.performDnsCleanup(slug);

      await this.store.remove(slug);
      return { slug, removed: true };
    });
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  async list(): Promise<RouteRecord[]> {
    return this.store.list();
  }

  // -------------------------------------------------------------------------
  // publicUrl
  // -------------------------------------------------------------------------

  /**
   * Returns the public HTTPS URL for a given slug based on the configured
   * publicDomain. No validation — callers must validate the slug first.
   */
  publicUrl(slug: string): string {
    return `https://${slug}.${this.config.publicDomain}`;
  }

  // -------------------------------------------------------------------------
  // activeTraefikDocument
  // -------------------------------------------------------------------------

  async activeTraefikDocument(): Promise<TraefikDocument> {
    const active = await this.store.listActive();
    return buildTraefikDocument(active, this.config);
  }

  // -------------------------------------------------------------------------
  // reconcilePending
  // -------------------------------------------------------------------------

  async reconcilePending(): Promise<void> {
    const pending = await this.store.listPending();
    const now = Date.now();

    for (const row of pending) {
      try {
        // Backoff: 2^min(retryCount,8) * 1000ms, capped at 300s, + 0–20% jitter
        const baseDelay = Math.min(
          300_000,
          1_000 * 2 ** Math.min(row.retryCount, 8),
        );
        const jitteredDelay = baseDelay * (1 + 0.2 * Math.random());
        if (now - row.updatedAt.getTime() < jitteredDelay) continue;

        if (row.status === 'creating') {
          await this.slugLock.run(row.slug, async () => {
            // Re-read and re-evaluate status, retryability, backoff
            const current = await this.store.get(row.slug);
            if (!current || current.status !== 'creating') return;

            // Re-check backoff from fresh row (handles stale rows or
            // concurrent reconciler processing)
            const freshNow = Date.now();
            const baseDelay2 = Math.min(
              300_000,
              1_000 * 2 ** Math.min(current.retryCount, 8),
            );
            const jitteredDelay2 = baseDelay2 * (1 + 0.2 * Math.random());
            if (freshNow - current.updatedAt.getTime() < jitteredDelay2) return;

            // Re-evaluate retryability from fresh row
            if (current.lastErrorCode !== null &&
                !RETRYABLE_CODES.has(current.lastErrorCode)) {
              return; // Non-retryable — skip
            }

            const reachable = await this.probe(
              this.config.upstreamHost,
              current.port,
              this.config.probeTimeoutMs,
            );
            if (!reachable) {
              await this.store.recordError(row.slug, {
                code: 'PORT_UNREACHABLE',
                message: `port ${current.port} on ${this.config.upstreamHost} is not reachable`,
              });
              return;
            }

            let recordId: string | null = null;
            if (this.dns) {
              try {
                const hostname = `${current.slug}.${this.config.publicDomain}`;
                const dnsRecord = await this.dns.ensureRecord(hostname, current.slug);
                await this.store.setCloudflareRecordId(current.slug, dnsRecord.id);
                recordId = dnsRecord.id;
              } catch (err) {
                const sanitized = err instanceof RouteManagerError
                  ? err
                  : new RouteManagerError('INTERNAL_ERROR', 'An internal error occurred');
                await this.store.recordError(current.slug, { code: sanitized.code, message: sanitized.message });
                return;
              }
            }

            await this.store.activate(current.slug, recordId);
          });
        } else if (row.status === 'deleting') {
          await this.slugLock.run(row.slug, async () => {
            // Re-read and re-evaluate status, retryability, backoff
            const current = await this.store.get(row.slug);
            if (!current || current.status !== 'deleting') return;

            // Re-check backoff from fresh row
            const freshNow = Date.now();
            const baseDelay2 = Math.min(
              300_000,
              1_000 * 2 ** Math.min(current.retryCount, 8),
            );
            const jitteredDelay2 = baseDelay2 * (1 + 0.2 * Math.random());
            if (freshNow - current.updatedAt.getTime() < jitteredDelay2) return;

            // Same retryability gate as creating — only auto-retry retryable errors
            if (current.lastErrorCode !== null &&
                !RETRYABLE_CODES.has(current.lastErrorCode)) {
              return; // Non-retryable — skip
            }

            await this.performDnsCleanup(current.slug);

            await this.store.remove(current.slug);
          });
        }
      } catch {
        // Internal handlers (e.g. performDnsCleanup) already persisted
        // the error. Swallow so later rows continue processing.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Clean up DNS (with missing-ID recovery) for a row that is already
   * in a terminal-transition state (deleting). Called from both `remove()`
   * and the deleting reconciler so behaviour is identical.
   *
   * Precondition: caller holds the slug lock.
   * Postcondition on success: DNS record is deleted (or confirmed absent).
   * Postcondition on throw: error is persisted on the row; caller should
   *   NOT remove the row.
   */
  private async performDnsCleanup(slug: string): Promise<void> {
    if (!this.dns) return;

    const hostname = `${slug}.${this.config.publicDomain}`;
    const route = await this.store.get(slug);
    if (!route) return;

    let recordId = route.cloudflareRecordId;

    // Recover missing Cloudflare record ID
    if (!recordId) {
      try {
        const found = await this.dns.findOwnedRecord(hostname, slug);
        if (found) {
          await this.store.setCloudflareRecordId(slug, found.id);
          // Re-read to get the updated record with recovered ID
          const updated = await this.store.get(slug);
          if (updated) {
            recordId = updated.cloudflareRecordId;
          }
        }
      } catch (err) {
        const sanitized = err instanceof RouteManagerError
          ? err
          : new RouteManagerError('INTERNAL_ERROR', 'An internal error occurred');
        await this.store.recordError(slug, { code: sanitized.code, message: sanitized.message });
        throw err;
      }
    }

    if (recordId) {
      try {
        const current = (await this.store.get(slug))!;
        await this.dns.deleteRecord(current, hostname);
      } catch (err) {
        const sanitized = err instanceof RouteManagerError
          ? err
          : new RouteManagerError('INTERNAL_ERROR', 'An internal error occurred');
        await this.store.recordError(slug, { code: sanitized.code, message: sanitized.message });
        throw err;
      }
    }
  }
}
