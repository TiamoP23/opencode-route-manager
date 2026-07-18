import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type { RouteStore } from '../src/db/route-store.js';
import type {
  DnsManager, OwnedDnsRecord, RouteRecord, PortProbe,
} from '../src/domain.js';
import type { AppConfig } from '../src/config.js';
import { RouteManagerError } from '../src/errors.js';
import { RouteService } from '../src/route-service.js';
import { KeyedLock } from '../src/keyed-lock.js';

// ---------------------------------------------------------------------------
// Shared event log — single timeline emitted by every fake
// ---------------------------------------------------------------------------

class SharedEventLog {
  entries: { source: string; method: string; args: unknown[] }[] = [];

  add(source: string, method: string, ...args: unknown[]): void {
    this.entries.push({ source, method, args });
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** Return method names from one source. */
  sourceMethods(source: string): string[] {
    return this.entries
      .filter((e) => e.source === source)
      .map((e) => e.method);
  }

  /** Return `source.method` strings preserving chronological order. */
  merged(): string[] {
    return this.entries.map((e) => `${e.source}.${e.method}`);
  }

  /** True when the ordered subsequence appears in merged(). */
  containsSubsequence(seq: string[]): boolean {
    const merged = this.merged();
    let mi = 0;
    for (const s of seq) {
      mi = merged.indexOf(s, mi);
      if (mi === -1) return false;
      mi++;
    }
    return true;
  }

  /** Index of the first entry matching source+method, or -1 */
  first(source: string, method: string): number {
    return this.entries.findIndex(
      (e) => e.source === source && e.method === method,
    );
  }

  /**
   * Return `source.method` strings excluding internal read-only (store.get)
   * calls, suitable for exact-array matching with toEqual().
   */
  significant(): string[] {
    return this.entries
      .filter((e) => !(e.source === 'store' && e.method === 'get'))
      .map((e) => `${e.source}.${e.method}`);
  }
}

// ---------------------------------------------------------------------------
// Fakes using the shared log
// ---------------------------------------------------------------------------

class FakeRouteStore implements RouteStore {
  private data = new Map<string, RouteRecord>();
  private log: SharedEventLog;

  constructor(log: SharedEventLog) {
    this.log = log;
  }

  async count(): Promise<number> {
    this.log.add('store', 'count');
    return this.data.size;
  }

  async get(slug: string): Promise<RouteRecord | null> {
    this.log.add('store', 'get', slug);
    return this.data.get(slug) ?? null;
  }

  async list(): Promise<RouteRecord[]> {
    this.log.add('store', 'list');
    return [...this.data.values()].sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );
  }

  async listActive(): Promise<RouteRecord[]> {
    this.log.add('store', 'listActive');
    return [...this.data.values()].filter((r) => r.status === 'active');
  }

  async listPending(): Promise<RouteRecord[]> {
    this.log.add('store', 'listPending');
    return [...this.data.values()]
      .filter((r) => r.status === 'creating' || r.status === 'deleting')
      .map((r) => ({
        ...r,
        createdAt: new Date(r.createdAt.getTime()),
        updatedAt: new Date(r.updatedAt.getTime()),
      }));
  }

  async insertCreating(input: {
    slug: string;
    port: number;
    description: string | null;
  }): Promise<RouteRecord> {
    this.log.add('store', 'insertCreating', input);
    if (this.data.has(input.slug)) {
      throw new RouteManagerError(
        'ROUTE_ALREADY_EXISTS',
        `slug "${input.slug}" already exists`,
      );
    }
    const now = new Date();
    const record: RouteRecord = {
      slug: input.slug,
      port: input.port,
      description: input.description,
      status: 'creating',
      cloudflareRecordId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.set(input.slug, record);
    return { ...record };
  }

  async activate(slug: string, recordId: string | null): Promise<RouteRecord> {
    this.log.add('store', 'activate', slug, recordId);
    const r = this.data.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.status = 'active';
    r.cloudflareRecordId = recordId;
    r.lastErrorCode = null;
    r.lastErrorMessage = null;
    r.retryCount = 0;
    r.updatedAt = new Date();
    return { ...r };
  }

  async updateActive(
    slug: string,
    patch: { port?: number; description?: string | null },
  ): Promise<RouteRecord> {
    this.log.add('store', 'updateActive', slug, patch);
    const r = this.data.get(slug);
    if (!r || r.status !== 'active')
      throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    if (patch.port !== undefined) r.port = patch.port;
    if (patch.description !== undefined) r.description = patch.description;
    r.lastErrorCode = null;
    r.lastErrorMessage = null;
    r.retryCount = 0;
    r.updatedAt = new Date();
    return { ...r };
  }

  async markDeleting(slug: string): Promise<RouteRecord> {
    this.log.add('store', 'markDeleting', slug);
    const r = this.data.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.status = 'deleting';
    r.updatedAt = new Date();
    return { ...r };
  }

  async setCloudflareRecordId(slug: string, recordId: string): Promise<RouteRecord> {
    this.log.add('store', 'setCloudflareRecordId', slug, recordId);
    const r = this.data.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.cloudflareRecordId = recordId;
    r.updatedAt = new Date();
    return { ...r };
  }

  async recordError(slug: string, error: { code: string; message: string }): Promise<void> {
    this.log.add('store', 'recordError', slug, error);
    const r = this.data.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.lastErrorCode = error.code;
    r.lastErrorMessage = error.message;
    r.retryCount++;
    r.updatedAt = new Date();
  }

  async remove(slug: string): Promise<void> {
    this.log.add('store', 'remove', slug);
    this.data.delete(slug);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  /** Expose internal state for tests that need to manipulate rows. */
  _rawData(): Map<string, RouteRecord> {
    return this.data;
  }
}

class FakeDnsManager implements DnsManager {
  private log: SharedEventLog;
  private records = new Map<string, { slug: string; id: string }>();

  constructor(log: SharedEventLog) {
    this.log = log;
  }

  _addRecord(hostname: string, slug: string, id: string): void {
    this.records.set(hostname, { slug, id });
  }

  _removeRecord(hostname: string): void {
    this.records.delete(hostname);
  }

  async assertAvailable(hostname: string, slug: string): Promise<void> {
    this.log.add('dns', 'assertAvailable', hostname, slug);
    const existing = this.records.get(hostname);
    if (existing && existing.slug !== slug) {
      throw new RouteManagerError('DNS_CONFLICT', 'hostname taken');
    }
  }

  async findOwnedRecord(hostname: string, slug: string): Promise<OwnedDnsRecord | null> {
    this.log.add('dns', 'findOwnedRecord', hostname, slug);
    const existing = this.records.get(hostname);
    if (existing && existing.slug === slug) {
      return { id: existing.id };
    }
    return null;
  }

  async ensureRecord(hostname: string, slug: string): Promise<OwnedDnsRecord> {
    this.log.add('dns', 'ensureRecord', hostname, slug);
    const existing = this.records.get(hostname);
    if (existing) {
      if (existing.slug === slug) return { id: existing.id };
      throw new RouteManagerError('DNS_CONFLICT', 'hostname taken');
    }
    const id = `cf-${slug}-${Date.now()}`;
    this.records.set(hostname, { slug, id });
    return { id };
  }

  async deleteRecord(route: RouteRecord, hostname: string): Promise<void> {
    this.log.add('dns', 'deleteRecord', route, hostname);
    if (!route.cloudflareRecordId) {
      throw new RouteManagerError('INTERNAL_ERROR', 'No Cloudflare record ID to delete');
    }
    const existing = this.records.get(hostname);
    if (!existing || existing.id !== route.cloudflareRecordId) {
      throw new RouteManagerError('OWNERSHIP_MISMATCH', 'ownership mismatch');
    }
    this.records.delete(hostname);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: AppConfig = {
  listenHost: '0.0.0.0',
  listenPort: 3000,
  databasePath: ':memory:',
  upstreamHost: 'opencode',
  publicDomain: 'tiamop23.de',
  middleware: 'test-auth@file',
  minPort: 1024,
  maxPort: 65535,
  deniedPorts: new Set([4096]),
  reservedSlugs: new Set(['admin', 'api']),
  maxRoutes: 32,
  probeTimeoutMs: 500,
  cloudflareTimeoutMs: 1000,
  mcpToken: 'x'.repeat(32),
  traefikProviderToken: 'y'.repeat(32),
  cloudflare: {
    zoneId: 'zone',
    apiToken: 'token',
    cnameTarget: 'target.tiamop23.de',
    proxied: false,
  },
};

function config(overrides?: Partial<AppConfig>): AppConfig {
  return { ...BASE_CONFIG, ...overrides };
}

function loggedProbe(result: boolean, log: SharedEventLog): PortProbe {
  return async (host: string, port: number, timeoutMs: number) => {
    log.add('probe', 'probe', host, port, timeoutMs);
    return result;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RouteService', () => {
  let log: SharedEventLog;
  let store: FakeRouteStore;
  let dns: FakeDnsManager;
  let svc: RouteService;

  beforeEach(() => {
    log = new SharedEventLog();
    store = new FakeRouteStore(log);
    dns = new FakeDnsManager(log);
    svc = new RouteService({
      config: config(),
      store,
      dns,
      probe: loggedProbe(true, log),
    });
  });

  // ----------------------------------------------------------------
  // publish
  // ----------------------------------------------------------------
  describe('publish', () => {
    it('validates slug before any side effects', async () => {
      await expect(
        svc.publish({ slug: 'INVALID', port: 3000 }),
      ).rejects.toThrow(RouteManagerError);
      expect(log.entries.length).toBe(0);
    });

    it('validates port before any side effects', async () => {
      await expect(
        svc.publish({ slug: 'valid', port: 1 }),
      ).rejects.toThrow(RouteManagerError);
      expect(log.entries.length).toBe(0);
    });

    it('validates description length (max 200)', async () => {
      const longDesc = 'x'.repeat(201);
      await expect(
        svc.publish({ slug: 'valid', port: 3000, description: longDesc }),
      ).rejects.toThrow(RouteManagerError);
      expect(log.entries.length).toBe(0);
    });

    it('validates description type: null and undefined accepted, string | null | undefined', async () => {
      // null description
      const r1 = await svc.publish({ slug: 'desc-null', port: 3000, description: null });
      expect(r1.description).toBeNull();

      // undefined description (omitted)
      const r2 = await svc.publish({ slug: 'desc-undef', port: 3001 });
      expect(r2.description).toBeNull();
    });

    it('rejects non-string description types at runtime', async () => {
      // number
      await expect(
        svc.publish({ slug: 'desc-num', port: 3000, description: 42 as unknown as string }),
      ).rejects.toThrow(RouteManagerError);
      expect(log.entries.length).toBe(0);

      // boolean
      await expect(
        svc.publish({ slug: 'desc-bool', port: 3000, description: true as unknown as string }),
      ).rejects.toThrow(RouteManagerError);
      expect(log.entries.length).toBe(0);

      // object
      await expect(
        svc.publish({ slug: 'desc-obj', port: 3000, description: {} as unknown as string }),
      ).rejects.toThrow(RouteManagerError);
      expect(log.entries.length).toBe(0);
    });

    it('full event order with Cloudflare', async () => {
      await svc.publish({
        slug: 'my-app',
        port: 5173,
        description: 'My App',
      });

      // Exact significant event order for publish with DNS:
      // get → early count → probe → assertAvailable → re-count → insertCreating → ensureRecord → setCloudflareRecordId → activate
      expect(log.significant()).toEqual([
        'store.count',
        'probe.probe',
        'dns.assertAvailable',
        'store.count',
        'store.insertCreating',
        'dns.ensureRecord',
        'store.setCloudflareRecordId',
        'store.activate',
      ]);
    });

    it('publish without Cloudflare: store.get count probe count insertCreating activate', async () => {
      const nd = new RouteService({
        config: config({ cloudflare: null }),
        store,
        dns: null,
        probe: loggedProbe(true, log),
      });

      await nd.publish({ slug: 'no-dns', port: 5173 });

      expect(log.significant()).toEqual([
        'store.count',
        'probe.probe',
        'store.count',
        'store.insertCreating',
        'store.activate',
      ]);
      // No DNS entries
      expect(log.sourceMethods('dns').length).toBe(0);
    });

    it('probe failure: no store mutations and no DNS calls', async () => {
      const bad = new RouteService({
        config: config(),
        store,
        dns,
        probe: loggedProbe(false, log),
      });

      await expect(
        bad.publish({ slug: 'unreachable', port: 5173 }),
      ).rejects.toThrow(RouteManagerError);

      // store.get is expected (re-read under slug lock), but no mutations
      const storeMuts = log.sourceMethods('store').filter(
        (m) => m !== 'get' && m !== 'count',
      );
      expect(storeMuts.length).toBe(0);
      expect(log.sourceMethods('dns').length).toBe(0);
    });

    it('DNS create failure: row stays creating, error persisted', async () => {
      // make ensureRecord throw
      dns.ensureRecord = async () => {
        throw new RouteManagerError('DNS_UNAVAILABLE', 'dns is down');
      };

      await expect(
        svc.publish({ slug: 'dns-fail', port: 5173, description: null }),
      ).rejects.toThrow(RouteManagerError);

      const row = await store.get('dns-fail');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('creating');
      expect(row!.lastErrorCode).toBe('DNS_UNAVAILABLE');

      // activeTraefikDocument must exclude creating rows
      const doc = await svc.activeTraefikDocument();
      expect(doc.http.routers['agent-dns-fail']).toBeUndefined();
    });

    it('duplicate publish: ROUTE_ALREADY_EXISTS', async () => {
      await svc.publish({ slug: 'dup', port: 5173 });

      await expect(
        svc.publish({ slug: 'dup', port: 8080 }),
      ).rejects.toThrow(RouteManagerError);
    });

    it('global capacity lock: at most one creating row when at limit', async () => {
      const capCfg = config({ maxRoutes: 2 });
      const cap = new RouteService({
        config: capCfg,
        store,
        dns: null,
        probe: loggedProbe(true, log),
      });

      await cap.publish({ slug: 'filler', port: 3000 });

      const results = await Promise.allSettled([
        cap.publish({ slug: 'race-a', port: 8080 }),
        cap.publish({ slug: 'race-b', port: 8081 }),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');

      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        RouteManagerError,
      );
      expect((failed[0] as PromiseRejectedResult).reason.code).toBe(
        'ROUTE_LIMIT_REACHED',
      );

      const all = await store.list();
      expect(all.length).toBe(2);
    });

    it('early capacity check avoids probe/DNS when already at limit', async () => {
      const capCfg = config({ maxRoutes: 1 });
      const cap = new RouteService({
        config: capCfg,
        store,
        dns,
        probe: loggedProbe(true, log),
      });

      await cap.publish({ slug: 'filler', port: 3000 });
      log.clear();

      await expect(
        cap.publish({ slug: 'overflow', port: 8080 }),
      ).rejects.toThrow(RouteManagerError);

      // Should fail at early count — no probe, no DNS calls
      const merged = log.merged();
      expect(merged).toContain('store.count');
      expect(merged).not.toContain('probe.probe');
      expect(merged).not.toContain('dns.assertAvailable');
    });
  });

  // ----------------------------------------------------------------
  // update
  // ----------------------------------------------------------------
  describe('update', () => {
    it('validates slug before any side effects', async () => {
      await expect(
        svc.update({ slug: 'INVALID', port: 3000 }),
      ).rejects.toThrow(RouteManagerError);
      expect(log.entries.length).toBe(0);
    });

    it('validates port with configured policy before store/probe', async () => {
      await svc.publish({ slug: 'upd', port: 3000 });
      log.clear();

      // denied port — should fail before probe
      await expect(
        svc.update({ slug: 'upd', port: 4096 }),
      ).rejects.toThrow(RouteManagerError);

      const merged = log.merged();
      // No probe call should have happened because validatePort should
      // reject the denied port first
      expect(merged).not.toContain('probe.probe');
      // Route should still have original port
      const row = await store.get('upd');
      expect(row!.port).toBe(3000);
    });

    it('validates port policy before acquiring slug lock', async () => {
      await svc.publish({ slug: 'pre-lock-upd', port: 3000 });
      log.clear();

      // Sub-min port should fail without any store/DNS interactions
      await expect(
        svc.update({ slug: 'pre-lock-upd', port: 1 }),
      ).rejects.toThrow(RouteManagerError);

      expect(log.entries.length).toBe(0);
    });

    it('validates description before acquiring slug lock', async () => {
      await svc.publish({ slug: 'pre-lock-desc', port: 3000 });
      log.clear();

      // Too-long description should fail without any store interactions
      await expect(
        svc.update({ slug: 'pre-lock-desc', description: 'x'.repeat(201) }),
      ).rejects.toThrow(RouteManagerError);

      expect(log.entries.length).toBe(0);

      // Non-string type should also fail before locking
      await expect(
        svc.update({ slug: 'pre-lock-desc', description: 99 as unknown as string }),
      ).rejects.toThrow(RouteManagerError);

      expect(log.entries.length).toBe(0);
    });

    it('validates description as string | null | undefined, max 200', async () => {
      await svc.publish({ slug: 'desc-upd', port: 3000, description: 'orig' });

      // null clears
      await svc.update({ slug: 'desc-upd', description: null });
      expect((await store.get('desc-upd'))!.description).toBeNull();

      // string sets
      await svc.update({ slug: 'desc-upd', description: 'new desc' });
      expect((await store.get('desc-upd'))!.description).toBe('new desc');

      // too long
      await expect(
        svc.update({ slug: 'desc-upd', description: 'x'.repeat(201) }),
      ).rejects.toThrow(RouteManagerError);
    });

    it('rejects non-string description types at runtime before side effects', async () => {
      await svc.publish({ slug: 'desc-type-upd', port: 3000 });
      log.clear();

      // number
      await expect(
        svc.update({ slug: 'desc-type-upd', description: 42 as unknown as string }),
      ).rejects.toThrow(RouteManagerError);
      // No store or probe calls before the lock
      expect(log.merged()).not.toContain('store.get');

      // boolean
      await expect(
        svc.update({ slug: 'desc-type-upd', description: true as unknown as string }),
      ).rejects.toThrow(RouteManagerError);

      // object
      await expect(
        svc.update({ slug: 'desc-type-upd', description: {} as unknown as string }),
      ).rejects.toThrow(RouteManagerError);
    });

    it('probes replacement port before changing active route', async () => {
      await svc.publish({ slug: 'upd', port: 3000 });

      const probeSpy = loggedProbe(true, log);
      const updSvc = new RouteService({
        config: config(),
        store,
        dns: null,
        probe: probeSpy,
      });

      await updSvc.update({ slug: 'upd', port: 4000 });

      const merged = log.merged();
      const probeIdx = merged.indexOf('probe.probe');
      const updateIdx = merged.indexOf('store.updateActive');
      expect(probeIdx).toBeGreaterThanOrEqual(0);
      expect(updateIdx).toBeGreaterThan(probeIdx);

      const row = await store.get('upd');
      expect(row!.port).toBe(4000);
    });

    it('description null clears description', async () => {
      await svc.publish({
        slug: 'desc-clear',
        port: 3000,
        description: 'hello',
      });
      await svc.update({ slug: 'desc-clear', description: null });

      const row = await store.get('desc-clear');
      expect(row!.description).toBeNull();
    });

    it('probe failure: no store mutation', async () => {
      await svc.publish({ slug: 'pfail', port: 3000 });

      const bad = new RouteService({
        config: config(),
        store,
        dns: null,
        probe: loggedProbe(false, log),
      });

      await expect(
        bad.update({ slug: 'pfail', port: 5000 }),
      ).rejects.toThrow(RouteManagerError);

      const row = await store.get('pfail');
      expect(row!.port).toBe(3000);
    });

    it('rejects empty update with neither port nor description using INVALID_INPUT', async () => {
      await svc.publish({ slug: 'empty-upd', port: 3000, description: 'test' });
      log.clear();

      let error: unknown;
      try {
        await svc.update({ slug: 'empty-upd' });
      } catch (e: unknown) {
        error = e;
      }
      expect(error).toBeInstanceOf(RouteManagerError);
      expect((error as RouteManagerError).code).toBe('INVALID_INPUT');
      expect((error as RouteManagerError).retryable).toBe(false);

      // No store mutations should have occurred
      expect(log.entries.length).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // remove
  // ----------------------------------------------------------------
  describe('remove', () => {
    it('validates slug before any side effects', async () => {
      await expect(
        svc.remove('INVALID'),
      ).rejects.toThrow(RouteManagerError);
      expect(log.entries.length).toBe(0);
    });

    it('marks deleting before DNS deletion', async () => {
      await svc.publish({ slug: 'remove-me', port: 3000 });
      log.clear();

      await svc.remove('remove-me');

      const merged = log.merged();
      const markIdx = merged.indexOf('store.markDeleting');
      const delIdx = merged.indexOf('dns.deleteRecord');
      expect(markIdx).toBeGreaterThanOrEqual(0);
      expect(delIdx).toBeGreaterThanOrEqual(0);
      expect(markIdx).toBeLessThan(delIdx);
      expect(await store.get('remove-me')).toBeNull();
    });

    it('remove without Cloudflare: no DNS calls', async () => {
      const nd = new RouteService({
        config: config({ cloudflare: null }),
        store,
        dns: null,
        probe: loggedProbe(true, log),
      });
      await nd.publish({ slug: 'no-cf-rm', port: 3000 });
      log.clear();

      const result = await nd.remove('no-cf-rm');
      expect(result).toEqual({ slug: 'no-cf-rm', removed: true });
      expect(await store.get('no-cf-rm')).toBeNull();
      expect(log.sourceMethods('dns').length).toBe(0);
    });

    it('removes absent route successfully', async () => {
      const result = await svc.remove('does-not-exist');
      expect(result).toEqual({ slug: 'does-not-exist', removed: false });
    });

    it('recovers cloudflareRecordId via findOwnedRecord when missing', async () => {
      await store.insertCreating({
        slug: 'recover',
        port: 3000,
        description: null,
      });
      dns._addRecord('recover.tiamop23.de', 'recover', 'cf-42');

      const result = await svc.remove('recover');
      expect(result.removed).toBe(true);

      const merged = log.merged();
      expect(merged).toContain('dns.findOwnedRecord');
      expect(merged).toContain('dns.deleteRecord');
      // setCloudflareRecordId must happen before deleteRecord
      expect(log.containsSubsequence([
        'store.setCloudflareRecordId',
        'dns.deleteRecord',
      ])).toBe(true);
      expect(await store.get('recover')).toBeNull();
    });

    it('removes local row when findOwnedRecord returns null', async () => {
      await store.insertCreating({
        slug: 'no-dns-rec',
        port: 3000,
        description: null,
      });

      await svc.remove('no-dns-rec');

      expect(log.merged()).toContain('dns.findOwnedRecord');
      expect(log.merged()).not.toContain('dns.deleteRecord');
      expect(await store.get('no-dns-rec')).toBeNull();
    });

    it('DNS failure during remove: row stays deleting, projection excludes it', async () => {
      await svc.publish({ slug: 'del-fail', port: 3000 });

      dns.deleteRecord = async () => {
        throw new RouteManagerError('DNS_UNAVAILABLE', 'dns down');
      };

      await expect(svc.remove('del-fail')).rejects.toThrow(RouteManagerError);

      const row = await store.get('del-fail');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('deleting');

      // activeTraefikDocument must exclude deleting rows
      const doc = await svc.activeTraefikDocument();
      expect(doc.http.routers['agent-del-fail']).toBeUndefined();
    });

    it('persists findOwnedRecord errors in performDnsCleanup', async () => {
      // Create a route with no cloudflareRecordId so findOwnedRecord is called
      await store.insertCreating({ slug: 'find-err-rm', port: 3000, description: null });
      dns._addRecord('find-err-rm.tiamop23.de', 'find-err-rm', 'cf-find-err');
      await store.activate('find-err-rm', null);

      // Make findOwnedRecord throw
      dns.findOwnedRecord = async () => {
        throw new RouteManagerError('DNS_UNAVAILABLE', 'find failed');
      };

      await expect(svc.remove('find-err-rm')).rejects.toThrow(RouteManagerError);

      const row = await store.get('find-err-rm');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('deleting');
      expect(row!.lastErrorCode).toBe('DNS_UNAVAILABLE');
    });

    it('full event order for remove with Cloudflare', async () => {
      await svc.publish({ slug: 'order-rm', port: 3000 });
      log.clear();

      await svc.remove('order-rm');

      expect(log.significant()).toEqual([
        'store.markDeleting',
        'dns.deleteRecord',
        'store.remove',
      ]);
    });

    it('full event order for remove with missing-id recovery', async () => {
      await store.insertCreating({ slug: 'order-rec', port: 3000, description: null });
      dns._addRecord('order-rec.tiamop23.de', 'order-rec', 'cf-rec99');
      log.clear();

      await svc.remove('order-rec');

      expect(log.significant()).toEqual([
        'store.markDeleting',
        'dns.findOwnedRecord',
        'store.setCloudflareRecordId',
        'dns.deleteRecord',
        'store.remove',
      ]);
    });
  });

  // ----------------------------------------------------------------
  // list & activeTraefikDocument
  // ----------------------------------------------------------------
  describe('list / activeTraefikDocument', () => {
    it('list returns all routes regardless of status', async () => {
      await svc.publish({ slug: 'a', port: 3000 });
      await svc.publish({ slug: 'b', port: 3001 });

      const all = await svc.list();
      expect(all.length).toBe(2);
    });

    it('activeTraefikDocument calls store.listActive', async () => {
      await svc.publish({ slug: 'for-doc', port: 3000 });

      const doc = await svc.activeTraefikDocument();
      const router = doc.http.routers['agent-for-doc'];
      expect(router).toBeDefined();
      expect(router!.rule).toContain('for-doc.tiamop23.de');

      // Verify store.listActive was called
      expect(log.sourceMethods('store')).toContain('listActive');
    });
  });

  // ----------------------------------------------------------------
  // concurrency: slug-level lock
  // ----------------------------------------------------------------
  describe('slug-level concurrency lock (KeyedLock)', () => {
    it('same-slug concurrent publishes are serialized (at most one creating row)', async () => {
      const results = await Promise.allSettled([
        svc.publish({ slug: 'same', port: 3000 }),
        svc.publish({ slug: 'same', port: 3001 }),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded.length).toBe(1); // second is ROUTE_ALREADY_EXISTS
    });

    it('different-slug calls may proceed independently', async () => {
      const results = await Promise.allSettled([
        svc.publish({ slug: 'alpha', port: 3000 }),
        svc.publish({ slug: 'beta', port: 3001 }),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded.length).toBe(2);
    });
  });

  // ----------------------------------------------------------------
  // reconcile
  // ----------------------------------------------------------------
  describe('reconcilePending', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reconcile creating: re-probe, ensure DNS, store ID, activate', async () => {
      vi.useFakeTimers();
      await store.insertCreating({ slug: 'recreate', port: 3000, description: 'to recover' });
      dns._addRecord('recreate.tiamop23.de', 'recreate', 'cf-adopt');
      vi.advanceTimersByTime(2000);
      log.clear();

      await svc.reconcilePending();

      const row = await store.get('recreate');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('active');
      expect(row!.cloudflareRecordId).toBe('cf-adopt');

      const seq = [
        'store.listPending',
        'probe.probe',
        'dns.ensureRecord',
        'store.setCloudflareRecordId',
        'store.activate',
      ];
      expect(log.containsSubsequence(seq)).toBe(true);
    });

    it('reconcile deleting: delete DNS then remove row', async () => {
      vi.useFakeTimers();
      await store.insertCreating({ slug: 'recon-del', port: 3000, description: null });
      await store.activate('recon-del', 'cf-del-1');
      dns._addRecord('recon-del.tiamop23.de', 'recon-del', 'cf-del-1');
      await store.markDeleting('recon-del');
      vi.advanceTimersByTime(2000);
      log.clear();

      await svc.reconcilePending();

      expect(await store.get('recon-del')).toBeNull();

      const seq = ['store.listPending', 'dns.deleteRecord', 'store.remove'];
      expect(log.containsSubsequence(seq)).toBe(true);
    });

    it('reconcile creating re-probes and does not activate when port unreachable', async () => {
      vi.useFakeTimers();
      const badProber = new RouteService({
        config: config(),
        store,
        dns,
        probe: loggedProbe(false, log),
      });

      await store.insertCreating({ slug: 'unreach-recon', port: 3000, description: null });
      dns._addRecord('unreach-recon.tiamop23.de', 'unreach-recon', 'cf-unreach');
      vi.advanceTimersByTime(2000);
      log.clear();

      await badProber.reconcilePending();

      const row = await store.get('unreach-recon');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('creating');
      expect(row!.lastErrorCode).toBe('PORT_UNREACHABLE');
    });

    it('reconcile deleting does not call probe', async () => {
      vi.useFakeTimers();
      const badProber = new RouteService({
        config: config(),
        store,
        dns,
        probe: loggedProbe(false, log),
      });

      await store.insertCreating({ slug: 'del-no-probe', port: 3000, description: null });
      await store.activate('del-no-probe', 'cf-del-2');
      dns._addRecord('del-no-probe.tiamop23.de', 'del-no-probe', 'cf-del-2');
      await store.markDeleting('del-no-probe');
      vi.advanceTimersByTime(2000);
      log.clear();

      await badProber.reconcilePending();

      expect(await store.get('del-no-probe')).toBeNull();
      expect(log.sourceMethods('probe').length).toBe(0);
    });

    it('reconcile skips rows whose backoff is not yet due', async () => {
      vi.useFakeTimers();
      await store.insertCreating({ slug: 'not-due', port: 3000, description: null });
      // Do NOT advance time

      await svc.reconcilePending();

      const row = await store.get('not-due');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('creating');
    });

    it('reconcile creating retries only retryable errors', async () => {
      vi.useFakeTimers();
      await store.insertCreating({ slug: 'non-retryable', port: 3000, description: null });
      await store.recordError('non-retryable', { code: 'HOSTNAME_RESERVED', message: 'reserved' });
      dns._addRecord('non-retryable.tiamop23.de', 'non-retryable', 'cf-nr');
      vi.advanceTimersByTime(2000);

      await svc.reconcilePending();

      const row = await store.get('non-retryable');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('creating');
    });

    it('reconcile deleting with missing ID: findOwnedRecord then delete DNS and remove', async () => {
      vi.useFakeTimers();
      await store.insertCreating({ slug: 'del-rec', port: 3000, description: null });
      await store.activate('del-rec', null); // no cloudflareRecordId stored
      dns._addRecord('del-rec.tiamop23.de', 'del-rec', 'cf-found');
      await store.markDeleting('del-rec');
      vi.advanceTimersByTime(2000);
      log.clear();

      await svc.reconcilePending();

      expect(await store.get('del-rec')).toBeNull();

      const seq = [
        'dns.findOwnedRecord',
        'store.setCloudflareRecordId',
        'dns.deleteRecord',
        'store.remove',
      ];
      expect(log.containsSubsequence(seq)).toBe(true);
    });

    it('reconcile deleting with no owned record: remove local row without DNS call', async () => {
      vi.useFakeTimers();
      await store.insertCreating({ slug: 'del-no-owned', port: 3000, description: null });
      await store.activate('del-no-owned', null);
      // No DNS record in fake
      await store.markDeleting('del-no-owned');
      vi.advanceTimersByTime(2000);
      log.clear();

      await svc.reconcilePending();

      expect(await store.get('del-no-owned')).toBeNull();
      expect(log.merged()).toContain('dns.findOwnedRecord');
      expect(log.merged()).not.toContain('dns.deleteRecord');
    });

    it('reconcile deleting with permanent error: skips auto-retry', async () => {
      vi.useFakeTimers();
      await store.insertCreating({ slug: 'del-perm', port: 3000, description: null });
      await store.activate('del-perm', 'cf-perm');
      dns._addRecord('del-perm.tiamop23.de', 'del-perm', 'cf-perm');
      await store.markDeleting('del-perm');
      // Set a permanent error
      await store.recordError('del-perm', { code: 'OWNERSHIP_MISMATCH', message: 'not ours' });
      vi.advanceTimersByTime(2000);
      log.clear();

      await svc.reconcilePending();

      // Row should still be deleting (not removed, not retried)
      const row = await store.get('del-perm');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('deleting');
      // No DNS or remove calls after slug-lock re-evaluation
      expect(log.merged()).not.toContain('dns.deleteRecord');
      expect(log.merged()).not.toContain('store.remove');
    });

    it('reconcile re-evaluates status after slug lock (skips already-resolved)', async () => {
      vi.useFakeTimers();
      await store.insertCreating({ slug: 'already-active', port: 3000, description: null });
      vi.advanceTimersByTime(2000);
      // Manually activate it before reconcile runs
      await store.activate('already-active', null);
      log.clear();

      await svc.reconcilePending();

      // No further mutations after activation
      const storeMuts = log.sourceMethods('store').filter(
        (m) => m === 'insertCreating' || m === 'activate' || m === 'remove',
      );
      expect(storeMuts.length).toBe(0);
    });

    it('reconcile re-evaluates stale row behind slug lock (backoff + retryability)', async () => {
      vi.useFakeTimers();
      // Insert a creating row — updatedAt = fake time 0
      await store.insertCreating({ slug: 're-eval-slug', port: 3000, description: null });
      dns._addRecord('re-eval-slug.tiamop23.de', 're-eval-slug', 'cf-re-eval');
      // Advance 10s — well past any backoff (max ~1200ms for retryCount=0)
      vi.advanceTimersByTime(10_000);

      // Hold the slug lock so reconcile is forced to queue behind it
      let release: () => void;
      const blocked = new Promise<void>((r) => { release = r; });
      const slugLock = (svc as unknown as { slugLock: KeyedLock }).slugLock;
      const holdPromise = slugLock.run('re-eval-slug', () => blocked);

      // Spy on slugLock.run to signal when reconcile attempts this slug
      let resolveReconcileQueued: () => void;
      const reconcileQueued = new Promise<void>((r) => { resolveReconcileQueued = r; });
      const origRun = slugLock.run.bind(slugLock);
      slugLock.run = ((key: string, operation: () => Promise<unknown>) => {
        if (key === 're-eval-slug') resolveReconcileQueued();
        return origRun(key, operation);
      }) as typeof slugLock.run;

      // Start reconcile — listPending() returns a cloned snapshot with
      // updatedAt=0 (way past backoff) and status='creating'.
      // reconcile queues behind the held lock.
      log.clear();
      const reconcilePromise = svc.reconcilePending();

      // Wait for reconcile to attempt the slug lock
      await reconcileQueued;

      // Mutate the stored row directly (no log entry): set a permanent
      // error so the reconciler must re-evaluate and skip (non-retryable).
      const rawData = store._rawData();
      const row = rawData.get('re-eval-slug')!;
      row.lastErrorCode = 'HOSTNAME_RESERVED';
      row.lastErrorMessage = 'reserved';

      // Release — reconciler's callback now runs
      release!();
      await holdPromise;
      await reconcilePromise;

      // The reconciler re-reads the row, sees the permanent error, and skips
      const current = await store.get('re-eval-slug');
      expect(current).not.toBeNull();
      expect(current!.status).toBe('creating');
      // No probe, DNS, or activate from the reconciler
      expect(log.significant()).toEqual(['store.listPending']);
    });

    it('reconcile re-checks backoff from fresh row behind slug lock', async () => {
      vi.useFakeTimers();
      // Insert a creating row — updatedAt = fake time 0
      await store.insertCreating({ slug: 'backoff-slug', port: 3000, description: null });
      dns._addRecord('backoff-slug.tiamop23.de', 'backoff-slug', 'cf-backoff');
      // Advance 10s — well past any backoff for retryCount=0 (~1200ms max)
      vi.advanceTimersByTime(10_000);

      // Hold the slug lock so reconcile is forced to queue behind it
      let release: () => void;
      const blocked = new Promise<void>((r) => { release = r; });
      const slugLock = (svc as unknown as { slugLock: KeyedLock }).slugLock;
      const holdPromise = slugLock.run('backoff-slug', () => blocked);

      // Spy on slugLock.run to signal when reconcile attempts this slug
      let resolveReconcileQueued: () => void;
      const reconcileQueued = new Promise<void>((r) => { resolveReconcileQueued = r; });
      const origRun = slugLock.run.bind(slugLock);
      slugLock.run = ((key: string, operation: () => Promise<unknown>) => {
        if (key === 'backoff-slug') resolveReconcileQueued();
        return origRun(key, operation);
      }) as typeof slugLock.run;

      // Start reconcile — listPending() returns a cloned snapshot with
      // updatedAt=0 (way past backoff). reconcile queues behind the held lock.
      log.clear();
      const reconcilePromise = svc.reconcilePending();

      // Wait for reconcile to attempt the slug lock
      await reconcileQueued;

      // Mutate the stored row directly (no log entry): bring updatedAt to
      // current fake time (10_000ms), making fresh elapsed time = 0.
      // Leave lastErrorCode null (retryable) so only the backoff re-check
      // prevents processing — no jitter ambiguity since 0 < min(1000, ...).
      const rawData = store._rawData();
      const row = rawData.get('backoff-slug')!;
      row.updatedAt = new Date();

      // Release — reconciler's callback now runs
      release!();
      await holdPromise;
      await reconcilePromise;

      // The reconciler re-reads the row, re-checks backoff, sees elapsed=0,
      // and skips (0 < 1000ms base delay)
      const current = await store.get('backoff-slug');
      expect(current).not.toBeNull();
      expect(current!.status).toBe('creating');
      // No probe, DNS, or activate from the reconciler
      expect(log.significant()).toEqual(['store.listPending']);
    });

    it('reconcile outer catch persists INTERNAL_ERROR and continues to next row', async () => {
      vi.useFakeTimers();

      // Track reconciliation events
      const events: Array<{ slug: string; status: string; code: string }> = [];
      const eventSvc = new RouteService({
        config: config(),
        store,
        dns,
        probe: loggedProbe(true, log),
        onReconcileEvent: (evt) => { events.push(evt); },
      });

      // First row: creating, slug lock will throw unexpectedly
      await store.insertCreating({ slug: 'outer-catch-1', port: 3000, description: null });
      // Second row: creating, should succeed
      await store.insertCreating({ slug: 'outer-catch-2', port: 3001, description: null });
      dns._addRecord('outer-catch-2.tiamop23.de', 'outer-catch-2', 'cf-2');

      vi.advanceTimersByTime(10_000);

      // Make the first row's slugLock.run throw unexpectedly
      const slugLock = (eventSvc as unknown as { slugLock: KeyedLock }).slugLock;
      const origRun = slugLock.run.bind(slugLock);
      let firstCall = true;
      slugLock.run = ((key: string, operation: () => Promise<unknown>) => {
        if (key === 'outer-catch-1' && firstCall) {
          firstCall = false;
          throw new Error('unexpected lock error');
        }
        return origRun(key, operation);
      }) as typeof slugLock.run;

      log.clear();
      await eventSvc.reconcilePending();

      // First row: INTERNAL_ERROR persisted
      const row1 = await store.get('outer-catch-1');
      expect(row1).not.toBeNull();
      expect(row1!.lastErrorCode).toBe('INTERNAL_ERROR');
      expect(row1!.retryCount).toBeGreaterThanOrEqual(1);

      // Second row: successfully activated
      const row2 = await store.get('outer-catch-2');
      expect(row2).not.toBeNull();
      expect(row2!.status).toBe('active');

      // Reconciliation event emitted for the outer catch
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.slug).toBe('outer-catch-1');
      expect(events[0]!.code).toBe('INTERNAL_ERROR');
    });

    it('reconcile outer catch recordError failure does not prevent later rows', async () => {
      vi.useFakeTimers();

      // First row: creating, slug lock throws; store.recordError also throws
      await store.insertCreating({ slug: 'double-fail', port: 3000, description: null });
      // Second row: creating, should succeed
      await store.insertCreating({ slug: 'double-ok', port: 3001, description: null });
      dns._addRecord('double-ok.tiamop23.de', 'double-ok', 'cf-ok');

      vi.advanceTimersByTime(10_000);

      // Make slugLock.run throw for first row
      const slugLock = (svc as unknown as { slugLock: KeyedLock }).slugLock;
      const origRun = slugLock.run.bind(slugLock);
      let firstCall = true;
      slugLock.run = ((key: string, operation: () => Promise<unknown>) => {
        if (key === 'double-fail' && firstCall) {
          firstCall = false;
          throw new Error('lock error');
        }
        return origRun(key, operation);
      }) as typeof slugLock.run;

      // Make recordError throw for any slug
      const origRecordError = store.recordError.bind(store);
      store.recordError = async () => {
        throw new Error('persistence failure');
      };

      log.clear();
      await svc.reconcilePending();

      // Second row should still be processed even after first row's double failure
      const row2 = await store.get('double-ok');
      expect(row2).not.toBeNull();
      expect(row2!.status).toBe('active');
    });

    it('reconcile isolating deleting cleanup failures across rows', async () => {
      vi.useFakeTimers();

      // First row: deleting, will fail DNS cleanup
      await store.insertCreating({ slug: 'del-fail-iso', port: 3000, description: null });
      await store.activate('del-fail-iso', 'cf-del-fail');
      dns._addRecord('del-fail-iso.tiamop23.de', 'del-fail-iso', 'cf-del-fail');
      await store.markDeleting('del-fail-iso');

      // Second row: deleting, should succeed
      await store.insertCreating({ slug: 'del-good-iso', port: 3001, description: null });
      await store.activate('del-good-iso', 'cf-del-good');
      dns._addRecord('del-good-iso.tiamop23.de', 'del-good-iso', 'cf-del-good');
      await store.markDeleting('del-good-iso');

      vi.advanceTimersByTime(2000);

      // Make deleteRecord throw for the first row only
      let callCount = 0;
      const origDelete = dns.deleteRecord.bind(dns);
      dns.deleteRecord = async (route, hostname) => {
        callCount++;
        if (callCount === 1) throw new RouteManagerError('DNS_UNAVAILABLE', 'delete failed');
        return origDelete(route, hostname);
      };

      log.clear();
      await svc.reconcilePending();

      // First row: error persisted, still deleting
      const failRow = await store.get('del-fail-iso');
      expect(failRow).not.toBeNull();
      expect(failRow!.status).toBe('deleting');
      expect(failRow!.lastErrorCode).toBe('DNS_UNAVAILABLE');

      // Second row: successfully removed
      const goodRow = await store.get('del-good-iso');
      expect(goodRow).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // publicUrl
  // -----------------------------------------------------------------------

  describe('publicUrl', () => {
    it('returns the full https URL for a given slug', () => {
      const url = svc.publicUrl('my-app');
      expect(url).toBe('https://my-app.tiamop23.de');
    });

    it('includes the configured publicDomain', () => {
      const url = svc.publicUrl('test');
      expect(url).toMatch(/^https:\/\/test\.tiamop23\.de$/);
    });
  });
});
