import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import type { RouteRecord } from './domain.js';
import type { PublishInput, UpdateInput } from './domain.js';
import type { RouteService } from './route-service.js';
import { RouteManagerError } from './errors.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const slug = z.string().min(1).max(63);
const portIn = z.number().int().min(1).max(65535);
const descriptionIn = z.string().max(200).nullable();

const routeOutput = z.object({
  slug: z.string(),
  port: z.number().int(),
  description: z.string().nullable(),
  status: z.string(),
  dnsRecordId: z.string().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const publishOutput = z.object({
  service: routeOutput,
  url: z.string(),
});

const updateOutput = z.object({
  service: routeOutput,
  url: z.string(),
});

const removeOutput = z.object({
  slug: z.string(),
  removed: z.boolean(),
});

const listOutput = z.object({
  services: z.array(routeOutput),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRouteOutput(record: RouteRecord) {
  return {
    slug: record.slug,
    port: record.port,
    description: record.description,
    status: record.status,
    dnsRecordId: record.cloudflareRecordId,
    error: record.lastErrorCode
      ? { code: record.lastErrorCode, message: record.lastErrorMessage ?? '' }
      : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function successResult(output: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorResultContent(error: unknown) {
  const err =
    error instanceof RouteManagerError
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : {
          code: 'INTERNAL_ERROR' as const,
          message: 'An internal error occurred',
          retryable: true,
        };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: err }) }],
    isError: true as const,
  };
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

const PUBLISH_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const UPDATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const REMOVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const LIST_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// ---------------------------------------------------------------------------
// createMcpServer
// ---------------------------------------------------------------------------

/**
 * Creates an MCP server that exposes route management operations as tools.
 *
 * @param service - The RouteService instance to back the tool handlers.
 * @returns A configured McpServer ready to connect to a transport.
 */
export function createMcpServer(service: RouteService): McpServer {
  const server = new McpServer(
    { name: 'opencode-route-manager', version: '0.1.0' },
    { capabilities: {} },
  );

  // ---- publish_service ----
  server.registerTool(
    'publish_service',
    {
      title: 'Publish Service',
      description:
        'Publish a new service route. Creates a DNS record and activates the route on success.',
      inputSchema: {
        slug,
        port: portIn,
        description: descriptionIn.optional(),
      },
      outputSchema: publishOutput,
      annotations: PUBLISH_ANNOTATIONS,
    },
    async (args) => {
      try {
        const record = await service.publish(args as PublishInput);
        const domain = (service as any).config.publicDomain;
        const url = `https://${record.slug}.${domain}`;
        return successResult({
          service: toRouteOutput(record),
          url,
        } as z.infer<typeof publishOutput>);
      } catch (err) {
        return errorResultContent(err);
      }
    },
  );

  // ---- update_service ----
  server.registerTool(
    'update_service',
    {
      title: 'Update Service',
      description:
        'Update an existing service route. Accepts partial updates for port and description.',
      inputSchema: {
        slug,
        port: portIn.optional(),
        description: descriptionIn.optional(),
      },
      outputSchema: updateOutput,
      annotations: UPDATE_ANNOTATIONS,
    },
    async (args) => {
      try {
        const record = await service.update(args as UpdateInput);
        const domain = (service as any).config.publicDomain;
        const url = `https://${record.slug}.${domain}`;
        return successResult({
          service: toRouteOutput(record),
          url,
        } as z.infer<typeof updateOutput>);
      } catch (err) {
        return errorResultContent(err);
      }
    },
  );

  // ---- remove_service ----
  server.registerTool(
    'remove_service',
    {
      title: 'Remove Service',
      description:
        'Remove a service route by slug. Performs DNS cleanup before deleting the route record.',
      inputSchema: { slug },
      outputSchema: removeOutput,
      annotations: REMOVE_ANNOTATIONS,
    },
    async (args) => {
      try {
        const result = await service.remove(args.slug);
        return successResult(result as z.infer<typeof removeOutput>);
      } catch (err) {
        return errorResultContent(err);
      }
    },
  );

  // ---- list_services ----
  server.registerTool(
    'list_services',
    {
      title: 'List Services',
      description: 'List all published service routes with their current status.',
      inputSchema: {},
      outputSchema: listOutput,
      annotations: LIST_ANNOTATIONS,
    },
    async () => {
      try {
        const records = await service.list();
        return successResult({
          services: records.map(toRouteOutput),
        } as z.infer<typeof listOutput>);
      } catch (err) {
        return errorResultContent(err);
      }
    },
  );

  return server;
}
