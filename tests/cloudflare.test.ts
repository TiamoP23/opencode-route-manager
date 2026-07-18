import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { CloudflareDnsManager } from '../src/cloudflare.js';
import { RouteManagerError } from '../src/errors.js';
import { createCloudflareServer, type CloudflareFakeServer, type FakeDnsRecord } from './helpers/cloudflare-server.js';
import type { RouteRecord } from '../src/domain.js';

const ZONE_ID = 'test-zone-123';
const API_TOKEN = 'fake-token-xxx';
const CNAME_TARGET = 'proxy.example.com';
const SLUG = 'my-app';
const HOSTNAME = 'my-app.example.com';

function makeRoute(overrides: Partial<RouteRecord> = {}): RouteRecord {
  return {
    slug: SLUG,
    port: 8080,
    description: null,
    status: 'active',
    cloudflareRecordId: 'cf-record-1',
    lastErrorCode: null,
    lastErrorMessage: null,
    retryCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function ownedRecord(id: string, name?: string): FakeDnsRecord {
  return {
    id,
    type: 'CNAME',
    name: name ?? HOSTNAME,
    content: CNAME_TARGET,
    proxied: false,
    ttl: 1,
    comment: `opencode-route-manager:${SLUG}`,
  };
}

function unownedRecord(id: string, type: string, content?: string): FakeDnsRecord {
  return {
    id,
    type,
    name: HOSTNAME,
    content: content ?? 'other-target.example.com',
    proxied: false,
    ttl: 120,
    comment: null,
  };
}

describe('CloudflareDnsManager', () => {
  let server: CloudflareFakeServer;
  let manager: CloudflareDnsManager;

  beforeEach(async () => {
    server = await createCloudflareServer();
    manager = new CloudflareDnsManager(
      { zoneId: ZONE_ID, apiToken: API_TOKEN, cnameTarget: CNAME_TARGET, proxied: true },
      { baseUrl: server.url, fetch: globalThis.fetch, timeoutMs: 2000 },
    );
  });

  afterEach(async () => {
    await server.destroy();
  });

  // ---------------------------------------------------------------------------
  // Query capture
  // ---------------------------------------------------------------------------
  describe('query capture', () => {
    it('sends name.exact, page, and per_page query parameters on list', async () => {
      server.setRecords([ownedRecord('r1')]);
      await manager.findOwnedRecord(HOSTNAME, SLUG);

      expect(server.calls).toHaveLength(1);
      const call = server.calls[0]!;
      expect(call.method).toBe('GET');
      expect(call.query).toContain('name.exact=my-app.example.com');
      expect(call.query).toContain('page=1');
      expect(call.query).toContain('per_page=100');
    });
  });

  // ---------------------------------------------------------------------------
  // assertAvailable
  // ---------------------------------------------------------------------------
  describe('assertAvailable', () => {
    it('passes when no records exist', async () => {
      await expect(manager.assertAvailable(HOSTNAME, SLUG)).resolves.toBeUndefined();
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]!.method).toBe('GET');
      expect(server.calls[0]!.path).toContain('/dns_records');
      expect(server.calls[0]!.authorization).toBe(`Bearer ${API_TOKEN}`);
    });

    it('throws DNS_CONFLICT when unowned A/CNAME/TXT records exist', async () => {
      server.setRecords([
        unownedRecord('r1', 'A', '1.2.3.4'),
        unownedRecord('r2', 'CNAME', 'other.example.com'),
        unownedRecord('r3', 'TXT', 'some-txt'),
      ]);

      await expect(manager.assertAvailable(HOSTNAME, SLUG)).rejects.toThrow(RouteManagerError);
      await expect(manager.assertAvailable(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });

      // No mutations — only list calls
      expect(server.calls).toHaveLength(2);
      server.calls.forEach(c => expect(c.method).toBe('GET'));
    });

    it('throws DNS_CONFLICT when owned + unowned records coexist', async () => {
      // One owned and one unowned — the set is mixed
      server.setRecords([
        ownedRecord('owned-1'),
        unownedRecord('r1', 'A', '1.2.3.4'),
      ]);

      await expect(manager.assertAvailable(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });

      // No mutations
      expect(server.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // findOwnedRecord
  // ---------------------------------------------------------------------------
  describe('findOwnedRecord', () => {
    it('returns null when no records exist for hostname', async () => {
      const result = await manager.findOwnedRecord(HOSTNAME, SLUG);
      expect(result).toBeNull();
    });

    it('returns the record ID when one exact owned CNAME is the sole record', async () => {
      server.setRecords([ownedRecord('owned-1')]);

      const result = await manager.findOwnedRecord(HOSTNAME, SLUG);
      expect(result).toEqual({ id: 'owned-1' });

      // Only GET — no mutations
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]!.method).toBe('GET');
    });

    it('throws OWNERSHIP_MISMATCH when two owned records exist', async () => {
      server.setRecords([
        ownedRecord('dup-1'),
        ownedRecord('dup-2'),
      ]);

      await expect(manager.findOwnedRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'OWNERSHIP_MISMATCH',
        retryable: false,
      });

      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]!.method).toBe('GET');
    });

    it('throws DNS_CONFLICT when only unowned records exist', async () => {
      server.setRecords([unownedRecord('r1', 'A', '1.2.3.4')]);

      await expect(manager.findOwnedRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });

      expect(server.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    });

    it('rejects mixed owned + unowned records as conflict', async () => {
      // One owned record coexists with an unowned record — complete result
      // set is not "exactly one matching owned record"
      server.setRecords([
        ownedRecord('owned-1'),
        unownedRecord('r1', 'A', '1.2.3.4'),
      ]);

      await expect(manager.findOwnedRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });

      // No mutations
      expect(server.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // ensureRecord
  // ---------------------------------------------------------------------------
  describe('ensureRecord', () => {
    it('adopts an existing owned CNAME record when it is the sole record', async () => {
      server.setRecords([ownedRecord('adopt-me')]);

      const result = await manager.ensureRecord(HOSTNAME, SLUG);
      expect(result).toEqual({ id: 'adopt-me' });

      expect(server.calls).toHaveLength(1);
      expect(server.calls.filter(c => c.method === 'POST')).toHaveLength(0);
    });

    it('creates a new CNAME record when hostname is free', async () => {
      const result = await manager.ensureRecord(HOSTNAME, SLUG);
      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
      expect(result.id).toMatch(/^fake-cf-/);

      const postCalls = server.calls.filter(c => c.method === 'POST');
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0]!.body).toMatchObject({
        type: 'CNAME',
        name: HOSTNAME,
        content: CNAME_TARGET,
        proxied: true,
        ttl: 1,
        comment: `opencode-route-manager:${SLUG}`,
      });
    });

    it('honours configured proxied=false in create payload', async () => {
      const nonProxyManager = new CloudflareDnsManager(
        { zoneId: ZONE_ID, apiToken: API_TOKEN, cnameTarget: CNAME_TARGET, proxied: false },
        { baseUrl: server.url, fetch: globalThis.fetch, timeoutMs: 2000 },
      );

      await nonProxyManager.ensureRecord(HOSTNAME, SLUG);

      const postCalls = server.calls.filter(c => c.method === 'POST');
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0]!.body).toMatchObject({
        type: 'CNAME',
        name: HOSTNAME,
        content: CNAME_TARGET,
        proxied: false,
        ttl: 1,
        comment: `opencode-route-manager:${SLUG}`,
      });
    });

    it('throws OWNERSHIP_MISMATCH for ambiguous owned records', async () => {
      server.setRecords([
        ownedRecord('dup-1'),
        ownedRecord('dup-2'),
      ]);

      await expect(manager.ensureRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'OWNERSHIP_MISMATCH',
        retryable: false,
      });

      expect(server.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    });

    it('throws DNS_CONFLICT when unowned records exist', async () => {
      server.setRecords([unownedRecord('r1', 'A', '1.2.3.4')]);

      await expect(manager.ensureRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });

      expect(server.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    });

    it('rejects mixed owned + unowned records as conflict', async () => {
      server.setRecords([
        ownedRecord('owned-1'),
        unownedRecord('r1', 'A', '1.2.3.4'),
      ]);

      await expect(manager.ensureRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });

      // No POST or DELETE
      expect(server.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteRecord
  // ---------------------------------------------------------------------------
  describe('deleteRecord', () => {
    it('GETs by ID, verifies ownership, then DELETEs', async () => {
      server.setRecords([ownedRecord('cf-record-1')]);
      const route = makeRoute({ cloudflareRecordId: 'cf-record-1' });

      await manager.deleteRecord(route, HOSTNAME);

      const getCalls = server.calls.filter(c => c.method === 'GET');
      expect(getCalls).toHaveLength(1);
      expect(getCalls[0]!.path).toContain('/dns_records/cf-record-1');

      const deleteCalls = server.calls.filter(c => c.method === 'DELETE');
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]!.path).toContain('/dns_records/cf-record-1');
    });

    it('succeeds idempotently when GET by ID returns true 404', async () => {
      // Record does not exist — server returns genuine 404
      const route = makeRoute({ cloudflareRecordId: 'nonexistent-id' });

      await expect(manager.deleteRecord(route, HOSTNAME)).resolves.toBeUndefined();

      const getCalls = server.calls.filter(c => c.method === 'GET');
      expect(getCalls).toHaveLength(1);
      expect(getCalls[0]!.path).toContain('/dns_records/nonexistent-id');
      expect(server.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    });

    it('rejects non-404 GET-by-ID errors (e.g. 400) and does not DELETE', async () => {
      // Use setRecordError to make GET-by-ID for this record return 400
      server.setRecordError('bad-id', 400);
      const route = makeRoute({ cloudflareRecordId: 'bad-id' });

      await expect(manager.deleteRecord(route, HOSTNAME)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });

      // GET happened (400 response) but no DELETE
      expect(server.calls.filter(c => c.method === 'GET')).toHaveLength(1);
      expect(server.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    });

    it('rejects Auth-adjacent 403 on GET-by-ID', async () => {
      server.setRecordError('forbidden-id', 403);
      const route = makeRoute({ cloudflareRecordId: 'forbidden-id' });

      await expect(manager.deleteRecord(route, HOSTNAME)).rejects.toMatchObject({
        code: 'CONFIGURATION_ERROR',
        retryable: false,
      });

      expect(server.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    });

    it('throws OWNERSHIP_MISMATCH when target/comment changed and does not DELETE', async () => {
      server.setRecords([{
        id: 'cf-record-1',
        type: 'CNAME',
        name: HOSTNAME,
        content: 'different-target.example.com',
        proxied: false,
        ttl: 120,
        comment: 'some-other-owner:my-app',
      }]);
      const route = makeRoute({ cloudflareRecordId: 'cf-record-1' });

      await expect(manager.deleteRecord(route, HOSTNAME)).rejects.toMatchObject({
        code: 'OWNERSHIP_MISMATCH',
        retryable: false,
      });

      expect(server.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------
  describe('pagination', () => {
    it('fetches multiple pages and aggregates all records', async () => {
      // 150 unowned records for HOSTNAME: page 1 gets 100, page 2 gets 50.
      // Pagination must follow result_info.total_pages to reach page 2.
      const manyRecords: FakeDnsRecord[] = [];
      for (let i = 0; i < 150; i++) {
        manyRecords.push(unownedRecord(`p-unowned-${i}`, 'A', `10.0.0.${i}`));
      }
      server.setRecords(manyRecords);

      await expect(manager.findOwnedRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
      });

      // Must have fetched both pages
      expect(server.calls.filter(c => c.method === 'GET').length).toBe(2);
    });

    it('stops after one page when fewer records than per_page', async () => {
      // 51 records — all fit on one page (per_page=100)
      const records: FakeDnsRecord[] = [];
      for (let i = 0; i < 51; i++) {
        records.push(unownedRecord(`unowned-${i}`, 'A', `10.0.0.${i}`));
      }
      server.setRecords(records);

      await expect(manager.findOwnedRecord(HOSTNAME, SLUG)).rejects.toThrow();

      expect(server.calls.filter(c => c.method === 'GET').length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Error mapping
  // ---------------------------------------------------------------------------
  describe('error mapping', () => {
    it('maps 403 to CONFIGURATION_ERROR, retryable=false', async () => {
      server.setNextError(403);

      await expect(manager.assertAvailable(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'CONFIGURATION_ERROR',
        retryable: false,
      });
    });

    it('maps 429 to DNS_UNAVAILABLE, retryable=true', async () => {
      server.setNextError(429);

      await expect(manager.assertAvailable(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_UNAVAILABLE',
        retryable: true,
      });
    });

    it('maps 500 to DNS_UNAVAILABLE, retryable=true', async () => {
      server.setNextError(500);

      await expect(manager.assertAvailable(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_UNAVAILABLE',
        retryable: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Cloudflare rejection mapping — no private error type may escape
  // ---------------------------------------------------------------------------
  describe('Cloudflare rejection mapping', () => {
    it('maps list 400 to DNS_CONFLICT with sanitized message', async () => {
      server.setNextError(400);

      await expect(manager.assertAvailable(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });
    });

    it('maps list 404 to DNS_CONFLICT with sanitized message', async () => {
      server.setNextError(404);

      await expect(manager.assertAvailable(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });
    });

    it('maps list 405 to DNS_CONFLICT with sanitized message', async () => {
      server.setNextError(405);

      await expect(manager.assertAvailable(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });
    });

    it('maps create 400 to DNS_CONFLICT with sanitized message', async () => {
      // ensureRecord first does a GET (hostname is free → empty list),
      // then POSTs. setCreateError makes only the POST fail.
      server.setCreateError(400);

      await expect(manager.ensureRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });
    });

    it('maps create 404 to DNS_CONFLICT with sanitized message', async () => {
      server.setCreateError(404);

      await expect(manager.ensureRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });
    });

    it('maps delete 400 to DNS_CONFLICT with sanitized message', async () => {
      // deleteRecord first GETs by ID (record exists), then DELETEs
      server.setRecords([ownedRecord('cf-del-400')]);
      server.setDeleteError(400);

      const route = makeRoute({ cloudflareRecordId: 'cf-del-400' });
      await expect(manager.deleteRecord(route, HOSTNAME)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });
    });

    it('maps delete 405 to DNS_CONFLICT with sanitized message', async () => {
      server.setRecords([ownedRecord('cf-del-405')]);
      server.setDeleteError(405);

      const route = makeRoute({ cloudflareRecordId: 'cf-del-405' });
      await expect(manager.deleteRecord(route, HOSTNAME)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });
    });

    it('never leaks private error details in the message', async () => {
      // Run each rejection pathway and verify the message is always the
      // sanitized 'Cloudflare rejected the DNS change' string. No status
      // codes, no payloads, no authorization tokens.
      const checkMessage = async (p: Promise<unknown>) => {
        try {
          await p;
          expect.unreachable('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(RouteManagerError);
          expect((err as RouteManagerError).message).toBe('Cloudflare rejected the DNS change');
        }
      };

      // List 400
      server.setNextError(400);
      await checkMessage(manager.assertAvailable(HOSTNAME, SLUG));

      // Create 400
      server.setCreateError(400);
      await checkMessage(manager.ensureRecord(HOSTNAME, SLUG));

      // Delete 400
      server.setRecords([ownedRecord('cf-leak')]);
      server.setDeleteError(400);
      await checkMessage(manager.deleteRecord(makeRoute({ cloudflareRecordId: 'cf-leak' }), HOSTNAME));
    });
  });
});
