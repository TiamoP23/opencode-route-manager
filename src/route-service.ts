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
 * Orchestrates the route lifecycle:
 *
 *   validate → probe → DNS preflight → [global lock: count + insertCreating]
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
    if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
      throw new RouteManagerError(
        'INVALID_SLUG',
        `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }

    return this.slugLock.run(input.slug, async () => {
      // 2. Re-read state after acquiring the slug lock
      const existing = await this.store.get(input.slug);
      if (existing) {
        throw new RouteManagerError(
          'ROUTE_ALREADY_EXISTS',
          `route "${input.slug}" already exists`,
        );
      }

      // 3. Probe upstream port before persistence
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

      // 4. DNS preflight
      if (this.dns) {
        await this.dns.assertAvailable(hostname, input.slug);
      }

      // 5. Global capacity lock: count + insertCreating
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

      // 6. DNS mutation (creating before DNS)
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

      // 7. Active only after DNS success
      return this.store.activate(input.slug, recordId);
    });
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(input: UpdateInput): Promise<RouteRecord> {
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

      // Validate description
      if (descProvided && input.description !== null && input.description!.length > MAX_DESCRIPTION_LENGTH) {
        throw new RouteManagerError(
          'INVALID_SLUG',
          `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
        );
      }

      // Probe replacement port before changing active route
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

      // Build patch — description null explicitly clears it
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
    return this.slugLock.run(slug, async () => {
      const route = await this.store.get(slug);
      if (!route) return { slug, removed: false };

      // Mark deleting before DNS mutation
      await this.store.markDeleting(slug);

      if (this.dns) {
        try {
          const hostname = `${slug}.${this.config.publicDomain}`;
          let recordId = route.cloudflareRecordId;

          // Recover missing Cloudflare record ID
          if (!recordId) {
            const found = await this.dns.findOwnedRecord(hostname, slug);
            if (found) {
              await this.store.setCloudflareRecordId(slug, found.id);
              // Re-read to get the updated record with recovered ID
              const updated = await this.store.get(slug);
              if (updated) {
                recordId = updated.cloudflareRecordId;
              }
            }
          }

          if (recordId) {
            const current = (await this.store.get(slug))!;
            await this.dns.deleteRecord(current, hostname);
          }
        } catch (err) {
          const sanitized = err instanceof RouteManagerError
            ? err
            : new RouteManagerError('INTERNAL_ERROR', 'An internal error occurred');
          await this.store.recordError(slug, { code: sanitized.code, message: sanitized.message });
          throw err;
        }
      }

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
      // Backoff: 2^min(retryCount,8) * 1000ms, capped at 300s, + 0–20% jitter
      const baseDelay = Math.min(
        300_000,
        1_000 * 2 ** Math.min(row.retryCount, 8),
      );
      const jitteredDelay = baseDelay * (1 + 0.2 * Math.random());
      if (now - row.updatedAt.getTime() < jitteredDelay) continue;

      if (row.status === 'creating') {
        // Only retry retryable errors; fresh (no-error) rows are always processed
        if (row.lastErrorCode !== null &&
            row.lastErrorCode !== 'DNS_UNAVAILABLE' &&
            row.lastErrorCode !== 'PORT_UNREACHABLE') {
          continue;
        }

        await this.slugLock.run(row.slug, async () => {
          const current = await this.store.get(row.slug);
          if (!current || current.status !== 'creating') return;

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
        // Deleting rows always try cleanup
        await this.slugLock.run(row.slug, async () => {
          const current = await this.store.get(row.slug);
          if (!current || current.status !== 'deleting') return;

          if (this.dns && current.cloudflareRecordId) {
            try {
              const hostname = `${current.slug}.${this.config.publicDomain}`;
              await this.dns.deleteRecord(current, hostname);
            } catch (err) {
              const sanitized = err instanceof RouteManagerError
                ? err
                : new RouteManagerError('INTERNAL_ERROR', 'An internal error occurred');
              await this.store.recordError(current.slug, { code: sanitized.code, message: sanitized.message });
              return;
            }
          }

          await this.store.remove(current.slug);
        });
      }
    }
  }
}
