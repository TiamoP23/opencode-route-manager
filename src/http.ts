import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp.js';
import type { AppConfig } from './config.js';
import type { RouteStore } from './db/route-store.js';
import type { RouteService } from './route-service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpAppDeps {
  config: AppConfig;
  store: RouteStore;
  service: RouteService;
}

// ---------------------------------------------------------------------------
// Structured logging helper — never leaks secrets
// ---------------------------------------------------------------------------

function log(event: string, extra?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event, ...extra }));
}

// ---------------------------------------------------------------------------
// Constant-time bearer guard factory
// ---------------------------------------------------------------------------

/**
 * Checks request rawHeaders for duplicate Authorization entries.
 * Node.js HTTP parser coalesces duplicate headers into a single value,
 * but rawHeaders preserves the original array of [key, value, key, value, ...].
 */
function hasRepeatedAuthorization(rawHeaders: string[]): boolean {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === 'authorization') {
      count++;
      if (count > 1) return true;
    }
  }
  return false;
}

/**
 * Creates Express middleware that validates a single `Authorization: Bearer <token>`
 * header using constant-time comparison. Rejects missing, repeated, malformed,
 * or wrong values with HTTP 401 and `WWW-Authenticate: Bearer`.
 *
 * Returns a middleware that calls `next()` on success; on failure it sends a
 * 401 response directly.
 */
function bearerGuard(expectedToken: string): (req: Request, res: Response, next: NextFunction) => void {
  const expected = Buffer.from(expectedToken, 'utf8');

  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers['authorization'];

    // Missing
    if (auth === undefined || auth === '') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Repeated — detect via rawHeaders (Node.js parses duplicates into
    // a single value, but rawHeaders preserves the original count)
    if (hasRepeatedAuthorization(req.rawHeaders)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Must be exactly "Bearer <token>" (case-sensitive per RFC 6750, Bearer
    // prefix is case-insensitive by convention, but we match exactly for
    // simplicity and consistency)
    if (!auth.startsWith('Bearer ')) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const token = auth.slice(7); // after "Bearer "

    // Reject empty token or token with whitespace
    if (!token || token !== token.trim()) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Reject characters outside allowed alphabet
    if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Constant-time comparison
    const actual = Buffer.from(token, 'utf8');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// JSON body parser error handler
// ---------------------------------------------------------------------------

function jsonErrorHandler(err: Error, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Malformed JSON' });
    return;
  }
  next(err);
}

// ---------------------------------------------------------------------------
// 405 JSON-RPC error response
// ---------------------------------------------------------------------------

function methodNotAllowedResponse(res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Method not allowed' },
  });
}

// ---------------------------------------------------------------------------
// createHttpApp
// ---------------------------------------------------------------------------

/**
 * Creates an Express application with authenticated HTTP endpoints for the
 * route-manager MCP service.
 *
 * Endpoints:
 *   GET  /health   – health check (200 / 503 based on store.ping())
 *   GET  /traefik  – Traefik provider document (Bearer provider token)
 *   POST /mcp      – MCP JSON-RPC endpoint  (Bearer MCP token)
 *   GET  /mcp      – 405 JSON-RPC error
 *   DELETE /mcp    – 405 JSON-RPC error
 */
export function createHttpApp(deps: HttpAppDeps): Express {
  const { config, store, service } = deps;

  const app: Express = express();

  // -----------------------------------------------------------------------
  // Global middleware
  // -----------------------------------------------------------------------

  app.use(express.json({ limit: '1mb' }));
  app.use(jsonErrorHandler as express.ErrorRequestHandler);

  // -----------------------------------------------------------------------
  // Auth guards (separate instances per token)
  // -----------------------------------------------------------------------

  const requireMcpToken = bearerGuard(config.mcpToken);
  const requireProviderToken = bearerGuard(config.traefikProviderToken);

  // -----------------------------------------------------------------------
  // GET /health
  // -----------------------------------------------------------------------

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const ok = await store.ping();
      res.status(ok ? 200 : 503).end();
    } catch {
      res.status(503).end();
    }
  });

  // -----------------------------------------------------------------------
  // GET /traefik — read-only provider endpoint
  // -----------------------------------------------------------------------

  app.get('/traefik', requireProviderToken, async (_req: Request, res: Response) => {
    try {
      const doc = await service.activeTraefikDocument();
      res.setHeader('Cache-Control', 'no-store');
      res.json(doc);
    } catch {
      // Projection failure — never return partial JSON
      res.status(503).end();
    }
  });

  // -----------------------------------------------------------------------
  // POST /mcp — stateless JSON-RPC
  // -----------------------------------------------------------------------

  app.post('/mcp', requireMcpToken, async (req: Request, res: Response) => {
    const mcpServer = createMcpServer(service);
    // Stateless mode — no session ID generation. The SDK defaults
    // sessionIdGenerator to undefined when omitted; we skip the field
    // explicitly because tsconfig's exactOptionalPropertyTypes rejects
    // { sessionIdGenerator: undefined }.
    const transport = new StreamableHTTPServerTransport({});

    // Track whether we already sent a response to avoid double-send
    let responded = false;

    // Idempotent cleanup helper
    const cleanup = (): void => {
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    };

    res.on('close', () => {
      if (!responded) {
        responded = true;
        cleanup();
      }
    });

    try {
      // The SDK's StreamableHTTPServerTransport satisfies the Transport
      // interface structurally at runtime; the type assertion handles a
      // mismatched onclose getter/setter pattern that exactOptionalPropertyTypes
      // surfaces in declarations but does not affect behaviour.
      await mcpServer.connect(transport as never);
      await transport.handleRequest(req, res, req.body);
      responded = true;
    } catch {
      if (!responded) {
        responded = true;
        res
          .status(500)
          .json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
          });
      }
    } finally {
      if (!responded) {
        responded = true;
        cleanup();
      }
    }
  });

  // -----------------------------------------------------------------------
  // GET /mcp — not supported in stateless mode
  // -----------------------------------------------------------------------

  app.get('/mcp', requireMcpToken, (_req: Request, res: Response) => {
    methodNotAllowedResponse(res);
  });

  // -----------------------------------------------------------------------
  // DELETE /mcp — not supported in stateless mode
  // -----------------------------------------------------------------------

  app.delete('/mcp', requireMcpToken, (_req: Request, res: Response) => {
    methodNotAllowedResponse(res);
  });

  return app;
}
