import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { RouteRecord, PortProbe } from '../src/domain.js';
import type { RouteStore } from '../src/db/route-store.js';
import { RouteManagerError } from '../src/errors.js';
import { RouteService } from '../src/route-service.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Fake RouteStore with controllable ping
// ---------------------------------------------------------------------------

class FakeRouteStore implements RouteStore {
  private shouldPingSucceed = true;
  private records = new Map<string, RouteRecord>();
  setPingResult(ok: boolean): void { this.shouldPingSucceed = ok; }

  async ping(): Promise<boolean> { return this.shouldPingSucceed; }
  async count(): Promise<number> { return this.records.size; }
  async get(slug: string): Promise<RouteRecord | null> { return this.records.get(slug) ?? null; }
  async list(): Promise<RouteRecord[]> { return [...this.records.values()]; }
  async listActive(): Promise<RouteRecord[]> {
    return [...this.records.values()].filter(r => r.status === 'active');
  }
  async listPending(): Promise<RouteRecord[]> {
    return [...this.records.values()].filter(r => r.status === 'creating' || r.status === 'deleting');
  }
  async insertCreating(input: { slug: string; port: number; description: string | null }): Promise<RouteRecord> {
    const now = new Date();
    const r: RouteRecord = {
      slug: input.slug, port: input.port, description: input.description,
      status: 'creating', cloudflareRecordId: null, lastErrorCode: null,
      lastErrorMessage: null, retryCount: 0, createdAt: now, updatedAt: now,
    };
    this.records.set(input.slug, r);
    return { ...r };
  }
  async activate(slug: string, recordId: string | null): Promise<RouteRecord> {
    const r = this.records.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.status = 'active'; r.cloudflareRecordId = recordId; r.lastErrorCode = null;
    r.lastErrorMessage = null; r.retryCount = 0; r.updatedAt = new Date();
    return { ...r };
  }
  async updateActive(slug: string, patch: { port?: number; description?: string | null }): Promise<RouteRecord> {
    const r = this.records.get(slug);
    if (!r || r.status !== 'active') throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    if (patch.port !== undefined) r.port = patch.port;
    if (patch.description !== undefined) r.description = patch.description;
    r.lastErrorCode = null; r.lastErrorMessage = null; r.retryCount = 0; r.updatedAt = new Date();
    return { ...r };
  }
  async markDeleting(slug: string): Promise<RouteRecord> {
    const r = this.records.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.status = 'deleting'; r.updatedAt = new Date();
    return { ...r };
  }
  async setCloudflareRecordId(slug: string, recordId: string): Promise<RouteRecord> {
    const r = this.records.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.cloudflareRecordId = recordId; r.updatedAt = new Date();
    return { ...r };
  }
  async recordError(slug: string, _error: { code: string; message: string }): Promise<void> {
    const r = this.records.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.retryCount++;
    r.updatedAt = new Date();
  }
  async remove(slug: string): Promise<void> { this.records.delete(slug); }
}

// ---------------------------------------------------------------------------
// Config for tests
// ---------------------------------------------------------------------------

function testConfig(): AppConfig {
  return {
    listenHost: '127.0.0.1',
    listenPort: 0,
    databasePath: ':memory:',
    upstreamHost: 'upstream',
    publicDomain: 'test.dev',
    middleware: 'test@file',
    minPort: 1024,
    maxPort: 65535,
    deniedPorts: new Set<number>(),
    reservedSlugs: new Set<string>(),
    maxRoutes: 10,
    probeTimeoutMs: 500,
    cloudflareTimeoutMs: 500,
    mcpToken: 'x'.repeat(32),
    traefikProviderToken: 'y'.repeat(32),
    cloudflare: null,
  };
}

// ---------------------------------------------------------------------------
// HTTP app fixture
// ---------------------------------------------------------------------------

interface AppFixture {
  baseUrl: string;
  server: ReturnType<typeof createServer>;
  store: FakeRouteStore;
  close: () => Promise<void>;
}

  async function startApp(): Promise<AppFixture> {
    const config = testConfig();
    const store = new FakeRouteStore();
    const probe: PortProbe = async () => true;
    const service = new RouteService({ config, store, dns: null, probe });

    const { createHttpApp } = await import('../src/http.js');
    const app: Express = createHttpApp({ config, store, service });

    const httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('server not listening');
    const port: number = addr.port;

    return {
      baseUrl: `http://127.0.0.1:${port}`,
      server: httpServer,
      store,
      close: async () => {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      },
    };
  }

// ---------------------------------------------------------------------------
// HTTP header helper
// ---------------------------------------------------------------------------

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

const MCP_TOKEN = testConfig().mcpToken;
const PROVIDER_TOKEN = testConfig().traefikProviderToken;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HTTP runtime', () => {
  let app: AppFixture;

  beforeAll(async () => {
    app = await startApp();
  }, 15000);

  afterAll(async () => {
    await app.close();
  }, 10000);

  // -----------------------------------------------------------------------
  // GET /health
  // -----------------------------------------------------------------------

  it('GET /health returns 200 when store ping succeeds', async () => {
    app.store.setPingResult(true);
    const res = await fetch(`${app.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('GET /health returns 503 when store ping fails', async () => {
    app.store.setPingResult(false);
    const res = await fetch(`${app.baseUrl}/health`);
    expect(res.status).toBe(503);
  });

  // -----------------------------------------------------------------------
  // GET /traefik — authorization
  // -----------------------------------------------------------------------

  it('GET /traefik without token returns 401', async () => {
    const res = await fetch(`${app.baseUrl}/traefik`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('GET /traefik with MCP token returns 401', async () => {
    const res = await fetch(`${app.baseUrl}/traefik`, {
      headers: bearer(MCP_TOKEN),
    });
    expect(res.status).toBe(401);
  });

  it('GET /traefik with wrong token returns 401', async () => {
    const res = await fetch(`${app.baseUrl}/traefik`, {
      headers: bearer('wrong'.repeat(10)),
    });
    expect(res.status).toBe(401);
  });

  it('GET /traefik with provider token returns 200 and deterministic JSON', async () => {
    const res = await fetch(`${app.baseUrl}/traefik`, {
      headers: bearer(PROVIDER_TOKEN),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    // Empty traefik document shape
    expect(body).toHaveProperty('http');
    expect(body.http).toHaveProperty('routers');
    expect(body.http).toHaveProperty('services');
  });

  // -----------------------------------------------------------------------
  // POST /mcp — authorization
  // -----------------------------------------------------------------------

  it('POST /mcp without token returns 401', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('POST /mcp with provider token returns 401', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...bearer(PROVIDER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /mcp with wrong random token returns 401', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...bearer('z'.repeat(32)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // POST /mcp — success with MCP client
  // -----------------------------------------------------------------------

  it('POST /mcp with MCP token: initialize and listTools succeed', async () => {
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`${app.baseUrl}/mcp`),
      { requestInit: { headers: bearer(MCP_TOKEN) } },
    );
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    try {
      // Same SDK type-guard as src/http.ts — see there.
      await client.connect(clientTransport as never);
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'list_services',
        'publish_service',
        'remove_service',
        'update_service',
      ]);
    } finally {
      await client.close();
    }
  }, 20000);

  // -----------------------------------------------------------------------
  // GET /mcp and DELETE /mcp return 405 JSON-RPC
  // -----------------------------------------------------------------------

  it('GET /mcp returns 405 with JSON-RPC error', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      headers: bearer(MCP_TOKEN),
    });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body).toHaveProperty('jsonrpc', '2.0');
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code');
    expect(body.error).toHaveProperty('message');
  });

  it('DELETE /mcp returns 405 with JSON-RPC error', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'DELETE',
      headers: bearer(MCP_TOKEN),
    });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body).toHaveProperty('jsonrpc', '2.0');
    expect(body).toHaveProperty('error');
  });

  // -----------------------------------------------------------------------
  // Malformed / repeated Authorization rejection
  // -----------------------------------------------------------------------

  it('rejects repeated Authorization header values with 401', async () => {
    const { request } = await import('node:http');
    const url = new URL(`${app.baseUrl}/traefik`);
    const res = await new Promise<{ statusCode: number | undefined }>((resolve) => {
      const req = request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET' },
        (res) => {
          let body = '';
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => resolve({ statusCode: res.statusCode }));
        },
      );
      // Two Authorization values in same header (array)
      const authValue = String(bearer(PROVIDER_TOKEN).Authorization);
      req.setHeader('Authorization', [authValue, authValue]);
      req.end();
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-Bearer Authorization scheme with 401', async () => {
    const res = await fetch(`${app.baseUrl}/traefik`, {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects Authorization without space after Bearer', async () => {
    const res = await fetch(`${app.baseUrl}/traefik`, {
      headers: { Authorization: 'Bearertokenvalue' },
    });
    expect(res.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Token separation: each guard only accepts its own token
  // -----------------------------------------------------------------------

  it('provider token rejected on /mcp endpoint', async () => {
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...bearer(PROVIDER_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('MCP token rejected on /traefik endpoint', async () => {
    const res = await fetch(`${app.baseUrl}/traefik`, {
      headers: bearer(MCP_TOKEN),
    });
    expect(res.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Projection failure on /traefik
  // -----------------------------------------------------------------------

  it('returns 503 on traefik projection failure without partial JSON', async () => {
    // Start a second app that has a failing projection
    // We override activeTraefikDocument by having the service with no routes
    // and temporarily make it throw

    // Actually, let's use a different approach: create a service where the
    // traefik document building fails. We mock the store.listActive to throw.
    const failStore = new FakeRouteStore();
    failStore.setPingResult(true);
    const serviceWithFailure = new RouteService({
      config: testConfig(), store: failStore, dns: null, probe: async () => true,
    });

    // Override the listActive to throw
    const origListActive = failStore.listActive.bind(failStore);
    failStore.listActive = async () => {
      throw new RouteManagerError('INTERNAL_ERROR', 'projection failed');
    };

    const { createHttpApp } = await import('../src/http.js');
    const failApp = createHttpApp({ config: testConfig(), store: failStore, service: serviceWithFailure });
    const failServer = createServer(failApp);
    const addr = await new Promise<AddressInfo>((resolve, reject) => {
      failServer.once('error', reject);
      failServer.listen(0, () => {
        const a = failServer.address();
        if (!a || typeof a === 'string') reject(new Error('not listening'));
        else resolve(a);
      });
    });
    const failPort: number = addr.port;

    try {
      const res = await fetch(`http://127.0.0.1:${failPort}/traefik`, {
        headers: bearer(PROVIDER_TOKEN),
      });
      expect(res.status).toBe(503);
      const text = await res.text();
      // Must never return partial JSON
      expect(() => JSON.parse(text)).toThrow();
    } finally {
      await new Promise<void>((resolve) => failServer.close(() => resolve()));
    }
  });
});
