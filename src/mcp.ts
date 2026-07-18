import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import type { PublishInput, RouteRecord, UpdateInput } from './domain.js';
import type { RouteService } from './route-service.js';
import type { RouteErrorCode } from './errors.js';

// ---------------------------------------------------------------------------
// Fixed MCP-safe error messages — no host/domain/record/config/stack leakage
// ---------------------------------------------------------------------------

const MCP_ERROR_MESSAGES: Record<string, string> = {
  INVALID_SLUG: 'The provided slug is invalid.',
  INVALID_PORT: 'The provided port is invalid or out of range.',
  PORT_DENIED: 'The provided port is not allowed.',
  PORT_UNREACHABLE: 'The target port is not reachable. Please retry.',
  ROUTE_LIMIT_REACHED: 'The maximum number of routes has been reached.',
  HOSTNAME_RESERVED: 'The provided slug is reserved.',
  ROUTE_ALREADY_EXISTS: 'A route with this slug already exists.',
  ROUTE_NOT_FOUND: 'The requested route was not found.',
  ROUTE_BUSY: 'The route is currently busy. Please retry.',
  DNS_UNAVAILABLE: 'DNS service is currently unavailable. Please retry.',
  DNS_CONFLICT: 'A DNS conflict was detected.',
  OWNERSHIP_MISMATCH: 'Ownership validation failed.',
  CONFIGURATION_ERROR: 'The server is misconfigured.',
  INTERNAL_ERROR: 'An internal error occurred.',
};

const DEFAULT_INTERNAL_CODE = 'INTERNAL_ERROR' as const;
const DEFAULT_INTERNAL_MSG: string = MCP_ERROR_MESSAGES.INTERNAL_ERROR!;

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
  status: z.enum(['creating', 'active', 'deleting']),
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

/** Shape returned by MCP on success for any tool that returns JSON output. */
type ToolSuccess<T> = {
  content: [{ type: 'text'; text: string }];
  structuredContent: T;
};

/** Shape returned by MCP on error for any tool. */
type ToolFailure = {
  content: [{ type: 'text'; text: string }];
  structuredContent: { error: { code: string; message: string; retryable: boolean } };
  isError: true;
};

/**
 * Wrap a service operation and convert its result into a consistent
 * MCP CallToolResult with proper success/error handling.
 *
 * - On success: JSON text + structuredContent matching the output
 * - On RouteManagerError: fixed MCP-safe message + structured error content
 * - On unknown errors: INTERNAL_ERROR with retryable=true
 */
async function toToolResult<T>(operation: () => Promise<T>): Promise<ToolSuccess<T> | ToolFailure> {
  try {
    const output = await operation();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (err) {
    const isRouteError = err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string';
    const errCode: RouteErrorCode = isRouteError
      ? (err as { code: RouteErrorCode }).code
      : DEFAULT_INTERNAL_CODE;
    const message: string =
      errCode in MCP_ERROR_MESSAGES
        ? MCP_ERROR_MESSAGES[errCode]!
        : DEFAULT_INTERNAL_MSG;
    const retryable =
      err instanceof Error && 'retryable' in err
        ? (err as { retryable: boolean }).retryable
        : true;

    const errorPayload = { code: errCode, message, retryable };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: errorPayload }) }],
      structuredContent: { error: errorPayload },
      isError: true as const,
    };
  }
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
    (args) =>
      toToolResult(async () => {
        const record = await service.publish(args as PublishInput);
        return {
          service: toRouteOutput(record),
          url: service.publicUrl(record.slug),
        };
      }),
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
    (args) =>
      toToolResult(async () => {
        const record = await service.update(args as UpdateInput);
        return {
          service: toRouteOutput(record),
          url: service.publicUrl(record.slug),
        };
      }),
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
    (args) =>
      toToolResult(async () => {
        const result = await service.remove(args.slug);
        return result;
      }),
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
    () =>
      toToolResult(async () => {
        const records = await service.list();
        return { services: records.map(toRouteOutput) };
      }),
  );

  return server;
}
