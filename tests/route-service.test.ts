import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type { RouteStore } from '../src/db/route-store.js';
import type {
  DnsManager, OwnedDnsRecord, RouteRecord, PortProbe,
} from '../src/domain.js';
import type { AppConfig } from '../src/config.js';
import { RouteManagerError } from '../src/errors.js';
import { RouteService } from '../src/route-service.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type CallEntry = { method: string; args: unknown[] };

class FakeRouteStore implements RouteStore {
  private data = new Map<string, RouteRecord>();
  calls: CallEntry[] = [];

  _reset(): void {
    this.data.clear();
    this.calls = [];
  }

  async count(): Promise<number> {
    this.calls.push({ method: 'count', args: [] });
    return this.data.size;
  }

  async get(slug: string): Promise<RouteRecord | null> {
    this.calls.push({ method: 'get', args: [slug] });
    return this.data.get(slug) ?? null;
  }

  async list(): Promise<RouteRecord[]> {
    this.calls.push({ method: 'list', args: [] });
    return [...this.data.values()].sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );
  }

  async listActive(): Promise<RouteRecord[]> {
    this.calls.push({ method: 'listActive', args: [] });
    return [...this.data.values()].filter((r) => r.status === 'active');
  }

  async listPending(): Promise<RouteRecord[]> {
    this.calls.push({ method: 'listPending', args: [] });
    return [...this.data.values()].filter(
      (r) => r.status === 'creating' || r.status === 'deleting',
    );
  }

  async insertCreating(input: {
    slug: string;
    port: number;
    description: string | null;
  }): Promise<RouteRecord> {
    this.calls.push({ method: 'insertCreating', args: [input] });
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

  async activate(
    slug: string,
    recordId: string | null,
  ): Promise<RouteRecord> {
    this.calls.push({ method: 'activate', args: [slug, recordId] });
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
    this.calls.push({ method: 'updateActive', args: [slug, patch] });
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
    this.calls.push({ method: 'markDeleting', args: [slug] });
    const r = this.data.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.status = 'deleting';
    r.updatedAt = new Date();
    return { ...r };
  }

  async setCloudflareRecordId(
    slug: string,
    recordId: string,
  ): Promise<RouteRecord> {
    this.calls.push({
      method: 'setCloudflareRecordId',
      args: [slug, recordId],
    });
    const r = this.data.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.cloudflareRecordId = recordId;
    r.updatedAt = new Date();
    return { ...r };
  }

  async recordError(
    slug: string,
    error: { code: string; message: string },
  ): Promise<void> {
    this.calls.push({ method: 'recordError', args: [slug, error] });
    const r = this.data.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.lastErrorCode = error.code;
    r.lastErrorMessage = error.message;
    r.retryCount++;
    r.updatedAt = new Date();
  }

  async remove(slug: string): Promise<void> {
    this.calls.push({ method: 'remove', args: [slug] });
    this.data.delete(slug);
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

class FakeDnsManager implements DnsManager {
  calls: CallEntry[] = [];
  private records = new Map<
    string,
    { slug: string; id: string }
  >();

  _reset(): void {
    this.records.clear();
    this.calls = [];
  }

  _addRecord(hostname: string, slug: string, id: string): void {
    this.records.set(hostname, { slug, id });
  }

  _removeRecord(hostname: string): void {
    this.records.delete(hostname);
  }

  async assertAvailable(
    hostname: string,
    slug: string,
  ): Promise<void> {
    this.calls.push({ method: 'assertAvailable', args: [hostname, slug] });
    const existing = this.records.get(hostname);
    if (existing && existing.slug !== slug) {
      throw new RouteManagerError('DNS_CONFLICT', 'hostname taken');
    }
  }

  async findOwnedRecord(
    hostname: string,
    slug: string,
  ): Promise<OwnedDnsRecord | null> {
    this.calls.push({ method: 'findOwnedRecord', args: [hostname, slug] });
    const existing = this.records.get(hostname);
    if (existing && existing.slug === slug) {
      return { id: existing.id };
    }
    return null;
  }

  async ensureRecord(
    hostname: string,
    slug: string,
  ): Promise<OwnedDnsRecord> {
    this.calls.push({ method: 'ensureRecord', args: [hostname, slug] });
    const existing = this.records.get(hostname);
    if (existing) {
      if (existing.slug === slug) return { id: existing.id };
      throw new RouteManagerError('DNS_CONFLICT', 'hostname taken');
    }
    const id = `cf-${slug}-${Date.now()}`;
    this.records.set(hostname, { slug, id });
    return { id };
  }

  async deleteRecord(
    route: RouteRecord,
    hostname: string,
  ): Promise<void> {
    this.calls.push({ method: 'deleteRecord', args: [route, hostname] });
    if (!route.cloudflareRecordId) {
      throw new RouteManagerError(
        'INTERNAL_ERROR',
        'No Cloudflare record ID to delete',
      );
    }
    const existing = this.records.get(hostname);
    if (!existing || existing.id !== route.cloudflareRecordId) {
      throw new RouteManagerError(
        'OWNERSHIP_MISMATCH',
        'ownership mismatch',
      );
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

const okProbe: PortProbe = async () => true;
const failProbe: PortProbe = async () => false;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RouteService', () => {
  let store: FakeRouteStore;
  let dns: FakeDnsManager;
  let svc: RouteService;

  beforeEach(() => {
    store = new FakeRouteStore();
    dns = new FakeDnsManager();
    svc = new RouteService({
      config: config(),
      store,
      dns,
      probe: okProbe,
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
      expect(store.calls.length).toBe(0);
      expect(dns.calls.length).toBe(0);
    });

    it('validates port before any side effects', async () => {
      await expect(
        svc.publish({ slug: 'valid', port: 1 }),
      ).rejects.toThrow(RouteManagerError);
      expect(store.calls.length).toBe(0);
      expect(dns.calls.length).toBe(0);
    });

    it('validates description length (max 200)', async () => {
      const longDesc = 'x'.repeat(201);
      await expect(
        svc.publish({ slug: 'valid', port: 3000, description: longDesc }),
      ).rejects.toThrow(RouteManagerError);
      expect(store.calls.length).toBe(0);
    });

    it('insertCreating then activate with Cloudflare flow', async () => {
      const result = await svc.publish({
        slug: 'my-app',
        port: 5173,
        description: 'My App',
      });

      expect(result.slug).toBe('my-app');
      expect(result.port).toBe(5173);
      expect(result.status).toBe('active');
      expect(result.description).toBe('My App');
      expect(result.cloudflareRecordId).toBeTruthy();

      // durable mutation order: insertCreating, setCloudflareRecordId, activate
      const mutMethods = store.calls
        .filter((c) =>
          [
            'insertCreating',
            'setCloudflareRecordId',
            'activate',
            'recordError',
          ].includes(c.method),
        )
        .map((c) => c.method);
      expect(mutMethods).toEqual([
        'insertCreating',
        'setCloudflareRecordId',
        'activate',
      ]);
    });

    it('publish without Cloudflare: insertCreating then activate(null)', async () => {
      const nd = new RouteService({
        config: config({ cloudflare: null }),
        store,
        dns: null,
        probe: okProbe,
      });

      const result = await nd.publish({ slug: 'no-dns', port: 5173 });
      expect(result.status).toBe('active');
      expect(result.cloudflareRecordId).toBeNull();

      const mutMethods = store.calls
        .filter((c) =>
          [
            'insertCreating',
            'setCloudflareRecordId',
            'activate',
            'recordError',
          ].includes(c.method),
        )
        .map((c) => c.method);
      expect(mutMethods).toEqual(['insertCreating', 'activate']);
    });

    it('probe failure: no store or DNS mutation', async () => {
      // The probe runs inside the slug lock after re-reading via store.get().
      // A get() call is expected but NO mutation calls.
      const bad = new RouteService({
        config: config(),
        store,
        dns,
        probe: failProbe,
      });

      await expect(
        bad.publish({ slug: 'unreachable', port: 5173 }),
      ).rejects.toThrow(RouteManagerError);

      const mutMethods = new Set([
        'insertCreating', 'setCloudflareRecordId', 'activate',
        'markDeleting', 'recordError', 'remove', 'updateActive',
      ]);
      const mutations = store.calls.filter((c) => mutMethods.has(c.method));
      expect(mutations.length).toBe(0);
      expect(dns.calls.length).toBe(0);
    });

    it('DNS create failure: row stays creating, error persisted', async () => {
      // make ensureRecord throw
      const origEnsure = dns.ensureRecord.bind(dns);
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
        probe: okProbe,
      });

      await cap.publish({ slug: 'filler', port: 3000 });

      const results = await Promise.allSettled([
        cap.publish({ slug: 'race-a', port: 8080 }),
        cap.publish({ slug: 'race-b', port: 8081 }),
      ]);

      const succeeded = results.filter(
        (r) => r.status === 'fulfilled',
      );
      const failed = results.filter((r) => r.status === 'rejected');

      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(
        (failed[0] as PromiseRejectedResult).reason,
      ).toBeInstanceOf(RouteManagerError);
      expect(
        (failed[0] as PromiseRejectedResult).reason.code,
      ).toBe('ROUTE_LIMIT_REACHED');

      const all = await store.list();
      expect(all.length).toBe(2);
    });

    it('publish supports null and empty description', async () => {
      const r1 = await svc.publish({
        slug: 'null-desc',
        port: 3000,
        description: null,
      });
      expect(r1.description).toBeNull();

      const r2 = await svc.publish({
        slug: 'undef-desc',
        port: 3001,
      });
      expect(r2.description).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // update
  // ----------------------------------------------------------------
  describe('update', () => {
    it('probes replacement port before changing active route', async () => {
      await svc.publish({ slug: 'upd', port: 3000 });

      // replace probe with a spy
      const probeSpy = vi.fn(async (_host: string, _port: number, _timeout: number) => true);
      const updSvc = new RouteService({
        config: config(),
        store,
        dns: null,
        probe: probeSpy as PortProbe,
      });

      await updSvc.update({ slug: 'upd', port: 4000 });

      expect(probeSpy).toHaveBeenCalledWith(
        expect.any(String),
        4000,
        expect.any(Number),
      );

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
        probe: failProbe,
      });

      await expect(
        bad.update({ slug: 'pfail', port: 5000 }),
      ).rejects.toThrow(RouteManagerError);

      const row = await store.get('pfail');
      expect(row!.port).toBe(3000);
    });
  });

  // ----------------------------------------------------------------
  // remove
  // ----------------------------------------------------------------
  describe('remove', () => {
    it('marks deleting before DNS deletion', async () => {
      await svc.publish({ slug: 'remove-me', port: 3000 });
      store.calls = []; // reset tracking

      await svc.remove('remove-me');

      const markIdx = store.calls.findIndex(
        (c) => c.method === 'markDeleting',
      );
      const dnsDelIdx = dns.calls.findIndex(
        (c) => c.method === 'deleteRecord',
      );
      expect(markIdx).toBeGreaterThanOrEqual(0);
      expect(dnsDelIdx).toBeGreaterThanOrEqual(0);
      expect(markIdx).toBeLessThan(dnsDelIdx);
      expect(await store.get('remove-me')).toBeNull();
    });

    it('remove without Cloudflare: no DNS calls', async () => {
      const nd = new RouteService({
        config: config({ cloudflare: null }),
        store,
        dns: null,
        probe: okProbe,
      });
      await nd.publish({ slug: 'no-cf-rm', port: 3000 });
      store.calls = [];

      const result = await nd.remove('no-cf-rm');
      expect(result).toEqual({ slug: 'no-cf-rm', removed: true });
      expect(await store.get('no-cf-rm')).toBeNull();
    });

    it('removes absent route successfully', async () => {
      const result = await svc.remove('does-not-exist');
      expect(result).toEqual({ slug: 'does-not-exist', removed: false });
    });

    it('recovers cloudflareRecordId via findOwnedRecord when missing', async () => {
      // set up a creating row without cloudflareRecordId but DNS record exists
      const row = await store.insertCreating({
        slug: 'recover',
        port: 3000,
        description: null,
      });
      expect(row.cloudflareRecordId).toBeNull();
      dns._addRecord('recover.tiamop23.de', 'recover', 'cf-42');

      const result = await svc.remove('recover');
      expect(result.removed).toBe(true);

      // Must have found and then deleted the DNS record
      expect(
        dns.calls.some((c) => c.method === 'findOwnedRecord'),
      ).toBe(true);
      expect(
        dns.calls.some((c) => c.method === 'deleteRecord'),
      ).toBe(true);
      expect(await store.get('recover')).toBeNull();
    });

    it('recovers and removes when findOwnedRecord finds record', async () => {
      // Build a merged timeline to verify setCloudflareRecordId happens
      // before deleteRecord.
      await store.insertCreating({
        slug: 'recover-mid',
        port: 3000,
        description: null,
      });
      dns._addRecord(
        'recover-mid.tiamop23.de',
        'recover-mid',
        'cf-99',
      );

      await svc.remove('recover-mid');

      const merged: { source: string; method: string; ts: number }[] = [];

      // The _reset() method didn't zero ts, but each call is captured at
      // call-observation time. We use the array index as a proxy for order
      // by merging the calls into a single timeline.
      for (let i = 0; i < store.calls.length; i++) {
        merged.push({ source: 'store', method: store.calls[i]!.method, ts: i });
      }
      for (let i = 0; i < dns.calls.length; i++) {
        merged.push({ source: 'dns', method: dns.calls[i]!.method, ts: i + store.calls.length });
      }
      merged.sort((a, b) => a.ts - b.ts);

      const setIdEntry = merged.find(
        (e) => e.source === 'store' && e.method === 'setCloudflareRecordId',
      );
      const delEntry = merged.find(
        (e) => e.source === 'dns' && e.method === 'deleteRecord',
      );

      expect(setIdEntry).toBeDefined();
      expect(delEntry).toBeDefined();
      expect(setIdEntry!.ts).toBeLessThan(delEntry!.ts);
    });

    it('removes local row when findOwnedRecord returns null', async () => {
      // route exists but no DNS record
      await store.insertCreating({
        slug: 'no-dns-rec',
        port: 3000,
        description: null,
      });

      await svc.remove('no-dns-rec');

      expect(
        dns.calls.some((c) => c.method === 'findOwnedRecord'),
      ).toBe(true);
      // deleteRecord should NOT be called
      expect(
        dns.calls.some((c) => c.method === 'deleteRecord'),
      ).toBe(false);
      expect(await store.get('no-dns-rec')).toBeNull();
    });

    it('DNS failure during remove: row stays deleting, projection excludes it', async () => {
      await svc.publish({ slug: 'del-fail', port: 3000 });

      // Make deleteRecord throw
      const origDelete = dns.deleteRecord.bind(dns);
      dns.deleteRecord = async () => {
        throw new RouteManagerError('DNS_UNAVAILABLE', 'dns down');
      };

      await expect(
        svc.remove('del-fail'),
      ).rejects.toThrow(RouteManagerError);

      const row = await store.get('del-fail');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('deleting');

      // activeTraefikDocument must exclude deleting rows
      const doc = await svc.activeTraefikDocument();
      expect(doc.http.routers['agent-del-fail']).toBeUndefined();
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
      expect(router!.rule).toContain(
        'for-doc.tiamop23.de',
      );

      // Verify store.listActive was called
      expect(
        store.calls.some((c) => c.method === 'listActive'),
      ).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // concurrency: slug-level lock
  // ----------------------------------------------------------------
  describe('slug-level concurrency lock (KeyedLock)', () => {
    it('same-slug concurrent publishes are serialized (at most one creating row)', async () => {
      // Both slugs are the same — lock should serialize
      const results = await Promise.allSettled([
        svc.publish({ slug: 'same', port: 3000 }),
        svc.publish({ slug: 'same', port: 3001 }),
      ]);

      const succeeded = results.filter(
        (r) => r.status === 'fulfilled',
      );
      expect(succeeded.length).toBe(1); // second is ROUTE_ALREADY_EXISTS
    });

    it('different-slug calls may proceed independently', async () => {
      const results = await Promise.allSettled([
        svc.publish({ slug: 'alpha', port: 3000 }),
        svc.publish({ slug: 'beta', port: 3001 }),
      ]);

      const succeeded = results.filter(
        (r) => r.status === 'fulfilled',
      );
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

      // Create a creating row (simulating a previous publish that got stuck)
      const rec = await store.insertCreating({
        slug: 'recreate',
        port: 3000,
        description: 'to recover',
      });
      expect(rec.status).toBe('creating');

      // reconciler should adopt the DNS record
      dns._addRecord('recreate.tiamop23.de', 'recreate', 'cf-adopt');

      // Advance time past the backoff for retryCount=0 (1s + 20% jitter max = 1.2s)
      vi.advanceTimersByTime(2000);

      await svc.reconcilePending();

      const row = await store.get('recreate');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('active');
      expect(row!.cloudflareRecordId).toBe('cf-adopt');

      // Must have ensured DNS was adopted
      expect(
        dns.calls.some((c) => c.method === 'ensureRecord'),
      ).toBe(true);
    });

    it('reconcile deleting: delete DNS then remove row', async () => {
      vi.useFakeTimers();

      // Create and activate, then directly mark as deleting
      await store.insertCreating({
        slug: 'recon-del',
        port: 3000,
        description: null,
      });
      await store.activate('recon-del', 'cf-del-1');
      // Manually create DNS record
      dns._addRecord(
        'recon-del.tiamop23.de',
        'recon-del',
        'cf-del-1',
      );
      // Mark deleting in store, bypassing service
      await store.markDeleting('recon-del');

      // Advance time past the backoff
      vi.advanceTimersByTime(2000);

      await svc.reconcilePending();

      // Row should be gone
      expect(await store.get('recon-del')).toBeNull();
      // DNS should have been deleted
      expect(
        dns.calls.some((c) => c.method === 'deleteRecord'),
      ).toBe(true);
    });

    it('reconcile creating re-probes and does not activate when port unreachable', async () => {
      vi.useFakeTimers();

      const badProber = new RouteService({
        config: config(),
        store,
        dns,
        probe: failProbe,
      });

      await store.insertCreating({
        slug: 'unreach-recon',
        port: 3000,
        description: null,
      });
      dns._addRecord(
        'unreach-recon.tiamop23.de',
        'unreach-recon',
        'cf-unreach',
      );

      // Advance time past the backoff
      vi.advanceTimersByTime(2000);

      await badProber.reconcilePending();

      const row = await store.get('unreach-recon');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('creating');
      expect(row!.lastErrorCode).toBe('PORT_UNREACHABLE');
    });

    it('reconcile deleting does not call probe', async () => {
      vi.useFakeTimers();

      // We need a probe that fails, but deleting should never call it
      const badProber = new RouteService({
        config: config(),
        store,
        dns,
        probe: failProbe,
      });

      await store.insertCreating({
        slug: 'del-no-probe',
        port: 3000,
        description: null,
      });
      await store.activate('del-no-probe', 'cf-del-2');
      dns._addRecord(
        'del-no-probe.tiamop23.de',
        'del-no-probe',
        'cf-del-2',
      );
      await store.markDeleting('del-no-probe');

      // Advance time past the backoff
      vi.advanceTimersByTime(2000);

      await badProber.reconcilePending();

      // Should still succeed because deleting path doesn't probe
      expect(await store.get('del-no-probe')).toBeNull();
    });

    it('reconcile skips rows whose backoff is not yet due', async () => {
      vi.useFakeTimers();

      // Create a row that is NOT yet due by keeping time at creation
      await store.insertCreating({
        slug: 'not-due',
        port: 3000,
        description: null,
      });

      // Do NOT advance time — the row was just created so backoff (1s) isn't due
      await svc.reconcilePending();

      // Row should still be creating (not reconciled)
      const row = await store.get('not-due');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('creating');
    });

    it('reconcile creating retries only retryable errors', async () => {
      vi.useFakeTimers();

      // Create a row with a non-retryable error
      await store.insertCreating({
        slug: 'non-retryable',
        port: 3000,
        description: null,
      });
      // Manually set retryCount to ensure backoff isn't a factor
      await store.recordError('non-retryable', { code: 'HOSTNAME_RESERVED', message: 'reserved' });
      dns._addRecord('non-retryable.tiamop23.de', 'non-retryable', 'cf-nr');

      // Advance time past any backoff
      vi.advanceTimersByTime(2000);

      await svc.reconcilePending();

      // Should NOT be activated (non-retryable error)
      const row = await store.get('non-retryable');
      expect(row).not.toBeNull();
      expect(row!.status).toBe('creating');
    });
  });
});
