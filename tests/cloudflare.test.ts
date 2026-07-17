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

  describe('assertAvailable', () => {
    it('passes when no records exist', async () => {
      // No initial records — hostname is available
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

      // No mutations were made — only list calls
      expect(server.calls).toHaveLength(2);
      server.calls.forEach(c => expect(c.method).toBe('GET'));
    });
  });

  describe('findOwnedRecord', () => {
    it('returns null when no records exist for hostname', async () => {
      const result = await manager.findOwnedRecord(HOSTNAME, SLUG);
      expect(result).toBeNull();
    });

    it('returns the record ID when one exact owned CNAME exists', async () => {
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

      // No DELETE or POST — only GET
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]!.method).toBe('GET');
    });

    it('throws DNS_CONFLICT for unowned records', async () => {
      server.setRecords([unownedRecord('r1', 'A', '1.2.3.4')]);

      await expect(manager.findOwnedRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });

      // No mutations
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]!.method).toBe('GET');
    });
  });

  describe('ensureRecord', () => {
    it('adopts an existing owned CNAME record', async () => {
      server.setRecords([ownedRecord('adopt-me')]);

      const result = await manager.ensureRecord(HOSTNAME, SLUG);
      expect(result).toEqual({ id: 'adopt-me' });

      // Only GET — no POST
      expect(server.calls).toHaveLength(1);
      const calls = server.calls.filter(c => c.method === 'POST');
      expect(calls).toHaveLength(0);
    });

    it('creates a new CNAME record when hostname is free', async () => {
      const result = await manager.ensureRecord(HOSTNAME, SLUG);
      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
      expect(result.id).toMatch(/^fake-cf-/);

      // POST call has correct payload
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

    it('throws OWNERSHIP_MISMATCH for ambiguous owned records', async () => {
      server.setRecords([
        ownedRecord('dup-1'),
        ownedRecord('dup-2'),
      ]);

      await expect(manager.ensureRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'OWNERSHIP_MISMATCH',
        retryable: false,
      });

      // No POST or DELETE
      expect(server.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    });

    it('throws DNS_CONFLICT when unowned records exist', async () => {
      server.setRecords([unownedRecord('r1', 'A', '1.2.3.4')]);

      await expect(manager.ensureRecord(HOSTNAME, SLUG)).rejects.toMatchObject({
        code: 'DNS_CONFLICT',
        retryable: false,
      });

      // No POST or DELETE
      expect(server.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    });
  });

  describe('deleteRecord', () => {
    it('GETs by ID, verifies ownership, then DELETEs', async () => {
      server.setRecords([ownedRecord('cf-record-1')]);
      const route = makeRoute({ cloudflareRecordId: 'cf-record-1' });

      await manager.deleteRecord(route, HOSTNAME);

      // Should have GET by ID then DELETE
      const getCalls = server.calls.filter(c => c.method === 'GET');
      expect(getCalls).toHaveLength(1);
      expect(getCalls[0]!.path).toContain('/dns_records/cf-record-1');

      const deleteCalls = server.calls.filter(c => c.method === 'DELETE');
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0]!.path).toContain('/dns_records/cf-record-1');
    });

    it('succeeds idempotently when GET by ID returns 404', async () => {
      // Record does not exist — GET will 404
      const route = makeRoute({ cloudflareRecordId: 'nonexistent-id' });

      await expect(manager.deleteRecord(route, HOSTNAME)).resolves.toBeUndefined();

      // Should have only a GET (which 404ed) — no DELETE
      const getCalls = server.calls.filter(c => c.method === 'GET');
      expect(getCalls).toHaveLength(1);
      expect(getCalls[0]!.path).toContain('/dns_records/nonexistent-id');
      expect(server.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    });

    it('throws OWNERSHIP_MISMATCH when target/comment changed and does not DELETE', async () => {
      // Record exists but with different target
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

      // GET happened but no DELETE
      expect(server.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    });
  });

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
});
