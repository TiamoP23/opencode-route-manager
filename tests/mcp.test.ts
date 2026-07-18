import { describe, expect, it, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RouteRecord } from '../src/domain.js';
import type { RouteStore } from '../src/db/route-store.js';
import type { AppConfig } from '../src/config.js';
import { RouteManagerError } from '../src/errors.js';
import { RouteService } from '../src/route-service.js';
import { createMcpServer } from '../src/mcp.js';

// ---------------------------------------------------------------------------
// Fake RouteStore — minimal in-memory implementation
// ---------------------------------------------------------------------------

class FakeRouteStore implements RouteStore {
  private data = new Map<string, RouteRecord>();

  async count(): Promise<number> {
    return this.data.size;
  }

  async get(slug: string): Promise<RouteRecord | null> {
    return this.data.get(slug) ?? null;
  }

  async list(): Promise<RouteRecord[]> {
    return [...this.data.values()].sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );
  }

  async listActive(): Promise<RouteRecord[]> {
    return [...this.data.values()].filter((r) => r.status === 'active');
  }

  async listPending(): Promise<RouteRecord[]> {
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
    const r = this.data.get(slug);
    if (!r) throw new RouteManagerError('ROUTE_NOT_FOUND', 'not found');
    r.lastErrorCode = error.code;
    r.lastErrorMessage = error.message;
    r.retryCount++;
    r.updatedAt = new Date();
  }

  async remove(slug: string): Promise<void> {
    this.data.delete(slug);
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

function testConfig(): AppConfig {
  return {
    listenHost: '0.0.0.0',
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
// Tools annotation expectations
// ---------------------------------------------------------------------------

const EXPECTED_ANNOTATIONS: Record<
  string,
  { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
> = {
  publish_service: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  update_service: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  remove_service: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  list_services: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

interface CallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP tools', () => {
  let service: RouteService;
  let store: FakeRouteStore;
  let client: Client;

  beforeEach(async () => {
    store = new FakeRouteStore();
    service = new RouteService({
      config: testConfig(),
      store,
      dns: null,
      probe: async () => true,
    });

    const server = createMcpServer(service);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  // -----------------------------------------------------------------------
  // listTools contract
  // -----------------------------------------------------------------------

  it('exposes exactly four tools with expected names', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'list_services',
      'publish_service',
      'remove_service',
      'update_service',
    ]);
  });

  it('each tool has a title and a description', async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
    }
  });

  it('annotations match expected hints', async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      const expected = EXPECTED_ANNOTATIONS[tool.name];
      expect(expected).toBeDefined();
      expect(tool.annotations!).toMatchObject(expected as Record<string, unknown>);
    }
  });

  it('publish_service input schema accepts slug, port, description', async () => {
    const result = await client.listTools();
    const pub = result.tools.find((t) => t.name === 'publish_service')!;
    expect(pub.inputSchema).toBeDefined();
    const props = (pub.inputSchema as any).properties ?? {};
    expect(props.slug).toBeDefined();
    expect(props.port).toBeDefined();
    expect(props.description).toBeDefined();
  });

  it('list_services has no required input properties', async () => {
    const result = await client.listTools();
    const svc = result.tools.find((t) => t.name === 'list_services')!;
    // inputSchema may be an empty object or absent
    const props = (svc.inputSchema as any)?.properties ?? {};
    expect(Object.keys(props)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // publish_service — success
  // -----------------------------------------------------------------------

  it('publish_service returns service and url on success', async () => {
    const callResult = await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'my-app', port: 3000, description: 'Test app' },
    }) as CallResult;

    expect(callResult.isError).toBeUndefined();

    // JSON text content
    expect(callResult.content).toHaveLength(1);
    expect(callResult.content[0]!).toMatchObject({
      type: 'text',
    });
    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.service).toBeDefined();
    expect(body.service.slug).toBe('my-app');
    expect(body.service.port).toBe(3000);
    expect(body.service.description).toBe('Test app');
    expect(body.service.status).toBe('active');
    expect(body.url).toBe('https://my-app.test.dev');

    // structuredContent matches body
    expect(callResult.structuredContent).toBeDefined();
    expect(callResult.structuredContent).toMatchObject(body);
  });

  it('publish_service accepts nullable description', async () => {
    const callResult = await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'no-desc', port: 4000, description: null },
    }) as CallResult;

    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.service.description).toBeNull();
  });

  // -----------------------------------------------------------------------
  // update_service — success
  // -----------------------------------------------------------------------

  it('update_service returns updated service and url', async () => {
    // First publish a route
    await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'my-app', port: 3000 },
    });

    const callResult = await client.callTool({
      name: 'update_service',
      arguments: { slug: 'my-app', port: 4000, description: 'Updated' },
    }) as CallResult;

    expect(callResult.isError).toBeUndefined();
    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.service.port).toBe(4000);
    expect(body.service.description).toBe('Updated');
    expect(body.service.status).toBe('active');
    expect(body.url).toBe('https://my-app.test.dev');

    expect(callResult.structuredContent).toMatchObject(body);
  });

  // -----------------------------------------------------------------------
  // remove_service — success
  // -----------------------------------------------------------------------

  it('remove_service returns slug and removed=true for existing route', async () => {
    await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'my-app', port: 3000 },
    });

    const callResult = await client.callTool({
      name: 'remove_service',
      arguments: { slug: 'my-app' },
    }) as CallResult;

    expect(callResult.isError).toBeUndefined();
    const body = JSON.parse(callResult.content[0]!.text);
    expect(body).toEqual({ slug: 'my-app', removed: true });
    expect(callResult.structuredContent).toMatchObject(body);
  });

  it('remove_service returns removed=false for non-existent route', async () => {
    const callResult = await client.callTool({
      name: 'remove_service',
      arguments: { slug: 'ghost' },
    }) as CallResult;

    expect(callResult.isError).toBeUndefined();
    const body = JSON.parse(callResult.content[0]!.text);
    expect(body).toEqual({ slug: 'ghost', removed: false });
    expect(callResult.structuredContent).toMatchObject(body);
  });

  // -----------------------------------------------------------------------
  // list_services — success
  // -----------------------------------------------------------------------

  it('list_services returns empty array when no routes exist', async () => {
    const callResult = await client.callTool({
      name: 'list_services',
      arguments: {},
    }) as CallResult;

    expect(callResult.isError).toBeUndefined();
    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.services).toEqual([]);
    expect(callResult.structuredContent).toMatchObject(body);
  });

  it('list_services returns all published routes', async () => {
    await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'app-one', port: 3001 },
    });
    await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'app-two', port: 3002 },
    });

    const callResult = await client.callTool({
      name: 'list_services',
      arguments: {},
    }) as CallResult;

    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.services).toHaveLength(2);
    expect(body.services.map((s: any) => s.slug).sort()).toEqual([
      'app-one',
      'app-two',
    ]);
  });

  // -----------------------------------------------------------------------
  // Service errors — isError + sanitized fields
  // -----------------------------------------------------------------------

  it('returns isError=true with stable fields on RouteManagerError', async () => {
    // Use slug that passes Zod (non-empty) but fails the service-level
    // slug regex (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
    const callResult = await client.callTool({
      name: 'publish_service',
      arguments: { slug: '---', port: 3000 },
    }) as CallResult;

    expect(callResult.isError).toBe(true);
    expect(callResult.content).toHaveLength(1);
    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.error).toBeDefined();
    // Only stable fields: code, message, retryable
    expect(Object.keys(body.error).sort()).toEqual([
      'code',
      'message',
      'retryable',
    ]);
    expect(body.error.code).toBe('INVALID_SLUG');
    expect(body.error.message).toBeTruthy();
    expect(body.error.retryable).toBe(false);
  });

  it('does not expose stack traces or environment values on error', async () => {
    const callResult = await client.callTool({
      name: 'publish_service',
      arguments: { slug: '---', port: 3000 },
    }) as CallResult;

    const body = JSON.parse(callResult.content[0]!.text);
    const text = JSON.stringify(body);
    expect(text).not.toContain('stack');
    expect(text).not.toContain('ENV');
    expect(text).not.toContain('MCP_TOKEN');
    expect(text).not.toContain('database');
    expect(text).not.toContain('RouteManagerError');
  });

  it('treats unknown errors as INTERNAL_ERROR with retryable=true', async () => {
    // Make probe throw a non-RouteManagerError
    const throwingService = new RouteService({
      config: testConfig(),
      store: new FakeRouteStore(),
      dns: null,
      probe: async () => {
        throw new Error('raw network error');
      },
    });

    const mcpServer = createMcpServer(throwingService);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const throwingClient = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      throwingClient.connect(ct),
      mcpServer.connect(st),
    ]);

    const callResult = await throwingClient.callTool({
      name: 'publish_service',
      arguments: { slug: 'fail-app', port: 3000 },
    }) as CallResult;

    expect(callResult.isError).toBe(true);
    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
      retryable: true,
    });
  });

  // -----------------------------------------------------------------------
  // Output schema: dates are ISO strings
  // -----------------------------------------------------------------------

  it('route output contains ISO date strings not Date objects', async () => {
    await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'dated-app', port: 5000 },
    });

    const callResult = await client.callTool({
      name: 'list_services',
      arguments: {},
    }) as CallResult;

    const body = JSON.parse(callResult.content[0]!.text);
    const svc = body.services[0];
    expect(svc.createdAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(svc.updatedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(typeof svc.createdAt).toBe('string');
    expect(typeof svc.updatedAt).toBe('string');
  });
});
