import { describe, expect, it, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RouteRecord } from '../src/domain.js';
import type { RouteStore } from '../src/db/route-store.js';
import type { AppConfig } from '../src/config.js';
import { RouteManagerError } from '../src/errors.js';
import { RouteService } from '../src/route-service.js';
import { createMcpServer } from '../src/mcp.js';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Types for structured schema assertions
// ---------------------------------------------------------------------------

/** JSON Schema representation as returned by MCP listTools. */
interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: string[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
  $schema?: string;
}

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

// ISO-8601 full datetime regex
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

  it('annotations match expected hints exactly', async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      const expected = EXPECTED_ANNOTATIONS[tool.name];
      expect(expected).toBeDefined();
      expect(tool.annotations!).toEqual(expected);
    }
  });

  // -----------------------------------------------------------------------
  // Full JSON Schema contracts from listTools()
  // -----------------------------------------------------------------------

  it('publish_service input JSON Schema is exact', async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'publish_service')!;
    const schema = tool.inputSchema as JsonSchema;

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(['slug', 'port', 'description']);
    expect(schema.required).toEqual(['slug', 'port']);

    const slug = schema.properties!.slug as JsonSchema;
    expect(slug.type).toBe('string');
    expect(slug.minLength).toBe(1);
    expect(slug.maxLength).toBe(63);

    const port = schema.properties!.port as JsonSchema;
    expect(port.type).toBe('integer');
    expect(port.minimum).toBe(1);
    expect(port.maximum).toBe(65535);

    const desc = schema.properties!.description as JsonSchema;
    const descAnyOf = desc.anyOf!;
    expect(descAnyOf).toHaveLength(2);
    const strPart = descAnyOf.find((s) => s.type === 'string')!;
    expect(strPart.maxLength).toBe(200);
    const nullPart = descAnyOf.find((s) => s.type === 'null')!;
    expect(nullPart).toBeDefined();
  });

  it('publish_service output JSON Schema contains RouteOutput with status enum, format date-time, full required, nullable shapes', async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'publish_service')!;
    const schema = tool.outputSchema as JsonSchema;

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(['service', 'url']);
    expect(schema.required).toEqual(['service', 'url']);

    // RouteOutput shape inside service
    const svc = schema.properties!.service as JsonSchema;
    expect(svc.type).toBe('object');
    expect(svc.additionalProperties).toBe(false);

    const svcProps = svc.properties!;
    expect(Object.keys(svcProps)).toEqual([
      'slug', 'port', 'description', 'status',
      'dnsRecordId', 'error', 'createdAt', 'updatedAt',
    ]);
    expect(svc.required).toEqual([
      'slug', 'port', 'description', 'status',
      'dnsRecordId', 'error', 'createdAt', 'updatedAt',
    ]);

    // Status is an enum
    const status = svcProps.status as JsonSchema;
    expect(status.enum).toEqual(['creating', 'active', 'deleting']);

    // Timestamps have format: date-time
    const createdAt = svcProps.createdAt as JsonSchema;
    expect(createdAt.type).toBe('string');
    expect(createdAt.format).toBe('date-time');

    const updatedAt = svcProps.updatedAt as JsonSchema;
    expect(updatedAt.type).toBe('string');
    expect(updatedAt.format).toBe('date-time');

    // Nullable description (anyOf with null)
    const descAnyOf = (svcProps.description as JsonSchema).anyOf!;
    expect(descAnyOf).toHaveLength(2);
    expect(descAnyOf.find((s) => s.type === 'string')).toBeDefined();
    expect(descAnyOf.find((s) => s.type === 'null')).toBeDefined();

    // Nullable dnsRecordId
    const dnsAnyOf = (svcProps.dnsRecordId as JsonSchema).anyOf!;
    expect(dnsAnyOf).toHaveLength(2);
    expect(dnsAnyOf.find((s) => s.type === 'string')).toBeDefined();
    expect(dnsAnyOf.find((s) => s.type === 'null')).toBeDefined();

    // Nullable error with nested object
    const errorAnyOf = (svcProps.error as JsonSchema).anyOf!;
    expect(errorAnyOf).toHaveLength(2);
    const errorObj = errorAnyOf.find((s) => s.type === 'object')!;
    expect(errorObj.properties).toBeDefined();
    expect(Object.keys(errorObj.properties!)).toEqual(['code', 'message']);
    expect(errorObj.required).toEqual(['code', 'message']);
    expect(errorObj.additionalProperties).toBe(false);
    expect(errorAnyOf.find((s) => s.type === 'null')).toBeDefined();
  });

  it('update_service input JSON Schema has slug required, port and description optional', async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'update_service')!;
    const schema = tool.inputSchema as JsonSchema;

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(['slug', 'port', 'description']);
    expect(schema.required).toEqual(['slug']);
  });

  it('update_service output JSON Schema matches publish_service output', async () => {
    const result = await client.listTools();
    const pub = result.tools.find((t) => t.name === 'publish_service')!;
    const upd = result.tools.find((t) => t.name === 'update_service')!;
    // Identical output shape
    expect(upd.outputSchema).toEqual(pub.outputSchema);
  });

  it('remove_service input JSON Schema has only slug required', async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'remove_service')!;
    const schema = tool.inputSchema as JsonSchema;

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(['slug']);

    const slug = schema.properties!.slug as JsonSchema;
    expect(slug.type).toBe('string');
    expect(slug.minLength).toBe(1);
    expect(slug.maxLength).toBe(63);
    expect(schema.required).toEqual(['slug']);
  });

  it('remove_service output JSON Schema has slug and removed boolean', async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'remove_service')!;
    const schema = tool.outputSchema as JsonSchema;

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(['slug', 'removed']);
    expect(schema.required).toEqual(['slug', 'removed']);
    const removed = schema.properties!.removed as JsonSchema;
    expect(removed.type).toBe('boolean');
  });

  it('list_services input JSON Schema has no properties', async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'list_services')!;
    const schema = tool.inputSchema as JsonSchema;

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual([]);
    expect(schema.required).toBeUndefined();
  });

  it('list_services output JSON Schema has services array containing RouteOutput', async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'list_services')!;
    const schema = tool.outputSchema as JsonSchema;

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(['services']);
    expect(schema.required).toEqual(['services']);

    const services = schema.properties!.services as JsonSchema;
    expect(services.type).toBe('array');
    expect(services.items).toBeDefined();

    // The items should match the RouteOutput shape (deep schema check)
    const item = services.items!;
    expect(item.type).toBe('object');
    expect(item.additionalProperties).toBe(false);

    const itemProps = item.properties!;
    expect(Object.keys(itemProps)).toEqual([
      'slug', 'port', 'description', 'status',
      'dnsRecordId', 'error', 'createdAt', 'updatedAt',
    ]);
    expect(item.required).toEqual([
      'slug', 'port', 'description', 'status',
      'dnsRecordId', 'error', 'createdAt', 'updatedAt',
    ]);

    const status = itemProps.status as JsonSchema;
    expect(status.enum).toEqual(['creating', 'active', 'deleting']);

    const createdAt = itemProps.createdAt as JsonSchema;
    expect(createdAt.format).toBe('date-time');

    const updatedAt = itemProps.updatedAt as JsonSchema;
    expect(updatedAt.format).toBe('date-time');
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
    expect(body.service.dnsRecordId).toBeNull();
    expect(body.service.error).toBeNull();
    expect(body.service.createdAt).toMatch(ISO_RE);
    expect(body.service.updatedAt).toMatch(ISO_RE);
    expect(body.url).toBe('https://my-app.test.dev');

    // structuredContent matches body
    expect(callResult.structuredContent).toBeDefined();
    expect(callResult.structuredContent).toEqual(body);
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
    expect(body.service.createdAt).toMatch(ISO_RE);
    expect(body.service.updatedAt).toMatch(ISO_RE);
    expect(body.url).toBe('https://my-app.test.dev');

    expect(callResult.structuredContent).toEqual(body);
  });

  it('update_service rejects empty update (neither port nor description) with MCP validation error', async () => {
    await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'empty-upd', port: 3000 },
    });

    const callResult = await client.callTool({
      name: 'update_service',
      arguments: { slug: 'empty-upd' },
    }) as CallResult;

    // The Zod refine rejects at the MCP schema level before reaching
    // our handler — isError is true with a human-readable message.
    expect(callResult.isError).toBe(true);
    const text = callResult.content[0]!.text;
    expect(text).toContain('MCP error');
    expect(text).toContain('At least one');
  });

  it('update_service input JSON Schema preserves object shape after refine', async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'update_service')!;
    const schema = tool.inputSchema as JsonSchema;

    // Schema must still be an object with the expected properties
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(['slug', 'port', 'description']);
    expect(schema.required).toEqual(['slug']);
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
    expect(callResult.structuredContent).toEqual(body);
  });

  it('remove_service returns removed=false for non-existent route', async () => {
    const callResult = await client.callTool({
      name: 'remove_service',
      arguments: { slug: 'ghost' },
    }) as CallResult;

    expect(callResult.isError).toBeUndefined();
    const body = JSON.parse(callResult.content[0]!.text);
    expect(body).toEqual({ slug: 'ghost', removed: false });
    expect(callResult.structuredContent).toEqual(body);
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
    expect(callResult.structuredContent).toEqual(body);
  });

  it('list_services returns all published routes with status and ISO dates', async () => {
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
    const slugs = body.services.map((s: Record<string, unknown>) => s.slug).sort();
    expect(slugs).toEqual(['app-one', 'app-two']);

    // Each service has correct shape
    for (const svc of body.services as Array<Record<string, unknown>>) {
      expect(typeof svc.slug).toBe('string');
      expect(typeof svc.port).toBe('number');
      expect(['creating', 'active', 'deleting']).toContain(svc.status);
      expect(svc.error).toBeNull();
      expect(typeof svc.createdAt).toBe('string');
      expect(svc.createdAt).toMatch(ISO_RE);
      expect(typeof svc.updatedAt).toBe('string');
      expect(svc.updatedAt).toMatch(ISO_RE);
    }
  });

  // -----------------------------------------------------------------------
  // Service errors — isError + sanitized fields + structuredContent
  // -----------------------------------------------------------------------

  it('returns isError=true with stable fields on RouteManagerError', async () => {
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

    // structuredContent must also contain the error
    expect(callResult.structuredContent).toBeDefined();
    expect(callResult.structuredContent!.error).toBeDefined();
    expect(Object.keys(callResult.structuredContent!.error as Record<string, unknown>).sort()).toEqual([
      'code',
      'message',
      'retryable',
    ]);
    expect((callResult.structuredContent!.error as Record<string, unknown>).code).toBe('INVALID_SLUG');
    expect((callResult.structuredContent!.error as Record<string, unknown>).retryable).toBe(false);
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

  it('maps error codes to fixed MCP-safe messages with no host/config leakage', async () => {
    // INVALID_SLUG — no slug value in message
    const slugResult = await client.callTool({
      name: 'publish_service',
      arguments: { slug: '---', port: 3000 },
    }) as CallResult;
    const slugBody = JSON.parse(slugResult.content[0]!.text);
    expect(slugBody.error.code).toBe('INVALID_SLUG');
    expect(slugBody.error.message).not.toContain('---');
    expect(slugBody.error.message).toMatch(/^[A-Z][a-zA-Z0-9 .']+\.$/); // Clean sentence

    // PORT_UNREACHABLE — no host/port values in message
    const unreachableService = new RouteService({
      config: testConfig(),
      store: new FakeRouteStore(),
      dns: null,
      probe: async () => false,
    });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const unreachableClient = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      unreachableClient.connect(ct2),
      createMcpServer(unreachableService).connect(st2),
    ]);

    const portResult = await unreachableClient.callTool({
      name: 'publish_service',
      arguments: { slug: 'valid-app', port: 3000 },
    }) as CallResult;
    const portBody = JSON.parse(portResult.content[0]!.text);
    expect(portBody.error.code).toBe('PORT_UNREACHABLE');
    expect(portBody.error.message).not.toContain('3000');
    expect(portBody.error.message).not.toContain('upstream');
    expect(portBody.error.message).toMatch(/^[A-Z][a-zA-Z0-9 .']+\.$/);
  });

  it('treats unknown errors as INTERNAL_ERROR with retryable=true', async () => {
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
      message: 'An internal error occurred.',
      retryable: true,
    });

    // structuredContent also has error
    expect((callResult.structuredContent!.error as Record<string, unknown>).code).toBe('INTERNAL_ERROR');
    expect((callResult.structuredContent!.error as Record<string, unknown>).retryable).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Output schema: dates are ISO strings, status is enum
  // -----------------------------------------------------------------------

  it('route output status is one of creating, active, or deleting', async () => {
    await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'enum-app', port: 5000 },
    });

    const callResult = await client.callTool({
      name: 'list_services',
      arguments: {},
    }) as CallResult;

    const body = JSON.parse(callResult.content[0]!.text);
    expect(['creating', 'active', 'deleting']).toContain(body.services[0].status);
  });

  it('route output contains ISO-8601 date strings with full precision', async () => {
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
    expect(svc.createdAt).toMatch(ISO_RE);
    expect(svc.updatedAt).toMatch(ISO_RE);
    expect(typeof svc.createdAt).toBe('string');
    expect(typeof svc.updatedAt).toBe('string');
  });

  it('route output has nullable dnsRecordId and nullable error', async () => {
    const callResult = await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'nullable-test', port: 5000 },
    }) as CallResult;

    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.service.dnsRecordId).toBeNull();
    expect(body.service.error).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Timestamp schema: strict ISO datetime (format: date-time)
  // -----------------------------------------------------------------------

  it('timestamps satisfy strict z.iso.datetime() validation', async () => {
    await client.callTool({
      name: 'publish_service',
      arguments: { slug: 'ts-schema', port: 5000 },
    });

    const callResult = await client.callTool({
      name: 'list_services',
      arguments: {},
    }) as CallResult;

    const body = JSON.parse(callResult.content[0]!.text);
    const svc = body.services[0];
    const createdAtResult = z.iso.datetime().safeParse(svc.createdAt);
    const updatedAtResult = z.iso.datetime().safeParse(svc.updatedAt);
    expect(createdAtResult.success).toBe(true);
    expect(updatedAtResult.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Structural errors (non-RouteManagerError) → INTERNAL_ERROR
  // -----------------------------------------------------------------------

  it('maps structural error with code property but non-RouteManagerError to INTERNAL_ERROR', async () => {
    // A throwing probe that mimics an Error-like object (e.g. ECONNREFUSED)
    const structuralErrorService = new RouteService({
      config: testConfig(),
      store: new FakeRouteStore(),
      dns: null,
      probe: async () => {
        const e = new Error('connect ECONNREFUSED 127.0.0.1:3000');
        (e as any).code = 'ECONNREFUSED';
        (e as any).errno = -111;
        (e as any).syscall = 'connect';
        throw e;
      },
    });

    const mcpServer = createMcpServer(structuralErrorService);
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
      arguments: { slug: 'struct-err', port: 3000 },
    }) as CallResult;

    expect(callResult.isError).toBe(true);
    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
      retryable: true,
    });
  });

  // -----------------------------------------------------------------------
  // toRouteOutput: listed routes with persisted errors use fixed messages
  // -----------------------------------------------------------------------

  it('list_services returns routes with errors using fixed MCP-safe messages, not persisted messages', async () => {
    // Pre-populate store with a route that has a persisted error
    const now = new Date();
    const routeWithPersistedError: RouteRecord = {
      slug: 'err-route',
      port: 3000,
      description: 'has error',
      status: 'active',
      cloudflareRecordId: null,
      lastErrorCode: 'DNS_UNAVAILABLE',
      lastErrorMessage: 'sensitive@internal.host: timeout contacting 10.0.0.1',
      retryCount: 3,
      createdAt: now,
      updatedAt: now,
    };
    (store as unknown as { data: Map<string, RouteRecord> }).data.set(
      'err-route',
      routeWithPersistedError,
    );

    const callResult = await client.callTool({
      name: 'list_services',
      arguments: {},
    }) as CallResult;

    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.services).toHaveLength(1);
    const svc = body.services[0];
    expect(svc.error).toEqual({
      code: 'DNS_UNAVAILABLE',
      message: 'DNS service is currently unavailable. Please retry.',
    });
    // Must not contain sensitive persisted values
    const text = JSON.stringify(body);
    expect(text).not.toContain('sensitive');
    expect(text).not.toContain('10.0.0.1');
    expect(text).not.toContain('timeout');
  });

  it('list_services returns routes with unknown persisted error as INTERNAL_ERROR', async () => {
    const now = new Date();
    const routeWithUnknownError: RouteRecord = {
      slug: 'unknown-err',
      port: 4000,
      description: 'unknown code',
      status: 'active',
      cloudflareRecordId: null,
      lastErrorCode: 'UNKNOWN_DB_CODE',    // not in MCP_ERROR_MESSAGES
      lastErrorMessage: 'internal details about failure xyz',
      retryCount: 2,
      createdAt: now,
      updatedAt: now,
    };
    (store as unknown as { data: Map<string, RouteRecord> }).data.set(
      'unknown-err',
      routeWithUnknownError,
    );

    const callResult = await client.callTool({
      name: 'list_services',
      arguments: {},
    }) as CallResult;

    const body = JSON.parse(callResult.content[0]!.text);
    expect(body.services).toHaveLength(1);
    const svc = body.services[0];
    expect(svc.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
    });
  });

  // -----------------------------------------------------------------------
  // Inherited-key protection — Object.hasOwn vs  in (prototype pollution)
  // -----------------------------------------------------------------------

  it('maps persisted "constructor" error code to INTERNAL_ERROR', async () => {
    const now = new Date();
    const route: RouteRecord = {
      slug: 'ctor-route', port: 3000, description: null,
      status: 'active', cloudflareRecordId: null,
      lastErrorCode: 'constructor',
      lastErrorMessage: 'sensitive detail',
      retryCount: 1, createdAt: now, updatedAt: now,
    };
    (store as unknown as { data: Map<string, RouteRecord> }).data.set('ctor-route', route);

    const result = await client.callTool({ name: 'list_services', arguments: {} }) as CallResult;
    const body = JSON.parse(result.content[0]!.text);
    expect(body.services[0].error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
    });
  });

  it('maps persisted "toString" error code to INTERNAL_ERROR', async () => {
    const now = new Date();
    const route: RouteRecord = {
      slug: 'tostr-route', port: 3000, description: null,
      status: 'active', cloudflareRecordId: null,
      lastErrorCode: 'toString',
      lastErrorMessage: 'sensitive detail',
      retryCount: 1, createdAt: now, updatedAt: now,
    };
    (store as unknown as { data: Map<string, RouteRecord> }).data.set('tostr-route', route);

    const result = await client.callTool({ name: 'list_services', arguments: {} }) as CallResult;
    const body = JSON.parse(result.content[0]!.text);
    expect(body.services[0].error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
    });
  });

  // -----------------------------------------------------------------------
  // Inherited-key: thrown RouteManagerError
  // -----------------------------------------------------------------------

  it('maps thrown RouteManagerError with "constructor" code to INTERNAL_ERROR', async () => {
    class ConstructorThrowingStore extends FakeRouteStore {
      override async insertCreating(
        _input: { slug: string; port: number; description: string | null },
      ): Promise<RouteRecord> {
        throw new RouteManagerError('constructor' as any, 'deliberate ctor error');
      }
    }

    const throwingService = new RouteService({
      config: testConfig(),
      store: new ConstructorThrowingStore(),
      dns: null,
      probe: async () => true,
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

    const result = await throwingClient.callTool({
      name: 'publish_service',
      arguments: { slug: 'ctor-thrown', port: 3000 },
    }) as CallResult;

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
      retryable: true,
    });
  });
});
