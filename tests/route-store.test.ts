import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/db/client.js';
import { SqliteRouteStore } from '../src/db/route-store.js';
import type { RouteStore } from '../src/db/route-store.js';

function createTestStore(dbPath: string): RouteStore {
  const dir = join(import.meta.dirname, '..');
  const ctx = openDatabase(dbPath, join(dir, 'drizzle'));
  const store = new SqliteRouteStore(ctx);
  return Object.assign(store, {
    close: () => { ctx.sqlite.close(); },
  });
}

describe('SqliteRouteStore', () => {
  let tempDir: string;
  let dbPath: string;
  let store: RouteStore & { close: () => void };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'route-store-'));
    dbPath = join(tempDir, 'test.sqlite');
    store = createTestStore(dbPath) as RouteStore & { close: () => void };
  });

  afterEach(() => {
    if (store && typeof (store as any).close === 'function') {
      (store as any).close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts empty', async () => {
    expect(await store.count()).toBe(0);
  });

  it('get returns null for unknown slug', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('inserts a creating route', async () => {
    const route = await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    expect(route.slug).toBe('demo');
    expect(route.port).toBe(5173);
    expect(route.description).toBe('Vite');
    expect(route.status).toBe('creating');
    expect(route.retryCount).toBe(0);
    expect(route.createdAt).toBeInstanceOf(Date);
    expect(route.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects duplicate slug on insertCreating', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    await expect(
      store.insertCreating({ slug: 'demo', port: 8080, description: null })
    ).rejects.toThrow();
  });

  it('get returns full RouteRecord for existing slug', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    const fetched = await store.get('demo');
    expect(fetched).toMatchObject({
      slug: 'demo',
      port: 5173,
      description: 'Vite',
      status: 'creating',
    });
    expect(fetched?.createdAt).toBeInstanceOf(Date);
    expect(fetched?.updatedAt).toBeInstanceOf(Date);
  });

  it('activates a route and records cloudflare record id, clearing prior errors', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    await store.recordError('demo', { code: 'ERR', message: 'error' });
    const route = await store.activate('demo', 'cf-record');
    expect(route.status).toBe('active');
    expect(route.cloudflareRecordId).toBe('cf-record');
    expect(route.lastErrorCode).toBeNull();
    expect(route.lastErrorMessage).toBeNull();
    expect(route.retryCount).toBe(0);
  });

  it('updates an active route and clears prior errors', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    await store.activate('demo', 'cf-record');
    await store.recordError('demo', { code: 'ERR', message: 'error' });
    const updated = await store.updateActive('demo', { port: 4173, description: null });
    expect(updated.port).toBe(4173);
    expect(updated.description).toBeNull();
    expect(updated.lastErrorCode).toBeNull();
    expect(updated.lastErrorMessage).toBeNull();
    expect(updated.retryCount).toBe(0);
  });

  it('marks route as deleting', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    await store.activate('demo', 'cf-record');
    const route = await store.markDeleting('demo');
    expect(route.status).toBe('deleting');
  });

  it('lists pending (deleting) routes', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    await store.activate('demo', 'cf-record');
    await store.markDeleting('demo');
    const routes = await store.listPending();
    expect(routes.map(r => r.status)).toEqual(['deleting']);
  });

  it('listActive excludes creating and deleting routes', async () => {
    await store.insertCreating({ slug: 'creating-route', port: 3000, description: null });
    await store.insertCreating({ slug: 'active-route', port: 3001, description: null });
    await store.activate('active-route', null);
    const active = await store.listActive();
    expect(active.map(r => r.slug)).toEqual(['active-route']);
  });

  it('list returns all routes', async () => {
    await store.insertCreating({ slug: 'a', port: 3000, description: null });
    await store.insertCreating({ slug: 'b', port: 3001, description: null });
    expect(await store.list()).toHaveLength(2);
  });

  it('setCloudflareRecordId sets the record id', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    const route = await store.setCloudflareRecordId('demo', 'record-123');
    expect(route.cloudflareRecordId).toBe('record-123');
  });

  it('records an error and increments retryCount', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    await store.recordError('demo', { code: 'DNS_UNAVAILABLE', message: 'Cloudflare unavailable' });
    const route = await store.get('demo');
    expect(route?.retryCount).toBe(1);
    expect(route?.lastErrorCode).toBe('DNS_UNAVAILABLE');
    expect(route?.lastErrorMessage).toBe('Cloudflare unavailable');
  });

  it('recordError increments retryCount on subsequent calls', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    await store.recordError('demo', { code: 'ERR1', message: 'first' });
    await store.recordError('demo', { code: 'ERR2', message: 'second' });
    const route = await store.get('demo');
    expect(route?.retryCount).toBe(2);
    expect(route?.lastErrorCode).toBe('ERR2');
  });

  it('removes a route', async () => {
    await store.insertCreating({ slug: 'demo', port: 5173, description: 'Vite' });
    await store.remove('demo');
    expect(await store.get('demo')).toBeNull();
  });

  it('ping returns true', async () => {
    expect(await store.ping()).toBe(true);
  });
});
