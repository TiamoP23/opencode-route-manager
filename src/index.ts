import { createServer } from 'node:http';
import type { Express } from 'express';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { SqliteRouteStore } from './db/route-store.js';
import type { RouteStore } from './db/route-store.js';
import { RouteService } from './route-service.js';
import { createHttpApp } from './http.js';
import { probeTcpPort } from './port-probe.js';
import { CloudflareDnsManager } from './cloudflare.js';
import type { DnsManager, PortProbe } from './domain.js';

// ---------------------------------------------------------------------------
// Migration folder resolved relative to this source file
// ---------------------------------------------------------------------------

const MIGRATIONS_FOLDER = new URL('../drizzle', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Structured logging — never leaks secrets
// ---------------------------------------------------------------------------

function log(event: string, extra?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event, ...extra }));
}

// ---------------------------------------------------------------------------
// Runtime dependency injection types
// ---------------------------------------------------------------------------

export interface ServerHandle {
  /** Start listening. Resolves with the assigned port. */
  listen(port: number, host: string): Promise<number>;
  /** Stop accepting connections and drain active ones. */
  close(): Promise<void>;
}

export interface TimerHandle {
  /** Cancel the timer. Idempotent. */
  clear(): void;
}

/**
 * Narrowly typed runtime primitives that `startApplication` uses instead of
 * calling Node.js globals directly.  Inject a custom implementation in tests
 * to verify ordering, rollback, shutdown, and signal behaviour without
 * binding real ports or installing process signal handlers.
 */
export interface RuntimeDeps {
  /** Wrap an Express app in an HTTP server handle. */
  createServer(handler: Express): ServerHandle;
  /**
   * Schedule `fn` to be called every `ms` milliseconds.
   * The returned handle MUST cancel the timer when `clear()` is called.
   */
  setTimer(fn: () => Promise<void>, ms: number): TimerHandle;
  /**
   * Register `handler` for OS signal `sig` (e.g. `'SIGINT'`, `'SIGTERM'`).
   * Returns an unregister function that removes the listener.
   */
  onSignal(sig: string, handler: () => void): () => void;
  /** Terminate the process with `code`. */
  exit(code: number): void;
}

// ---------------------------------------------------------------------------
// Default runtime using real Node.js primitives
// ---------------------------------------------------------------------------

const defaultRuntime: RuntimeDeps = {
  createServer: (handler) => {
    const server = createServer(handler);
    return {
      listen: (port, host) =>
        new Promise<number>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => {
            const addr = server.address();
            resolve(addr && typeof addr === 'object' ? addr.port : port);
          });
        }),
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  },
  setTimer: (fn, ms) => {
    const id = setInterval(fn, ms);
    return { clear: () => clearInterval(id) };
  },
  onSignal: (sig, handler) => {
    process.on(sig, handler as NodeJS.SignalsListener);
    return () => {
      process.removeListener(sig, handler as NodeJS.SignalsListener);
    };
  },
  exit: (code) => {
    process.exit(code);
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunningApplication {
  /** Graceful shutdown: stop scheduler, drain HTTP, await reconcile, close DB. */
  close(): Promise<void>;
  /** The port the HTTP server is listening on. */
  port: number;
}

export interface StartOptions {
  /** Environment variables for config. */
  env: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// startApplication
// ---------------------------------------------------------------------------

/**
 * Loads config, opens SQLite with migrations, constructs dependencies,
 * runs one awaitable initial reconciliation, serves HTTP, schedules
 * retryable reconciliation every 30 seconds (single-flight), and handles
 * graceful shutdown on SIGINT / SIGTERM.
 *
 * Accepts an optional second argument with overridden `RuntimeDeps` for
 * testing — when omitted real Node.js primitives are used.
 *
 * On any startup failure all previously-acquired resources (DB, server,
 * timer) are rolled back before the error propagates.
 */
export async function startApplication(
  options: StartOptions,
  overrides?: { runtime?: Partial<RuntimeDeps> },
): Promise<RunningApplication> {
  const runtime: RuntimeDeps = { ...defaultRuntime, ...overrides?.runtime };
  const { env } = options;

  // ---------------------------------------------------------------------------
  // Track acquired resources for rollback
  // ---------------------------------------------------------------------------
  let dbCtx: ReturnType<typeof openDatabase> | null = null;
  let serverHandle: ServerHandle | null = null;
  let timerHandle: TimerHandle | null = null;
  let unregisterSignal: (() => void) | null = null;

  // In-flight reconcile tracker for shutdown ordering
  let currentReconcile: Promise<void> | null = null;

  try {
    // -----------------------------------------------------------------------
    // Stage 1 — Config
    // -----------------------------------------------------------------------
    log('config_loading');
    const config: AppConfig = loadConfig(env);
    log('config_loaded');

    // -----------------------------------------------------------------------
    // Stage 2 — Database
    // -----------------------------------------------------------------------
    log('database_opening');
    dbCtx = openDatabase(config.databasePath, MIGRATIONS_FOLDER);
    log('database_ready');

    // -----------------------------------------------------------------------
    // Stage 3 — Store, DNS, Service
    // -----------------------------------------------------------------------
    const store: RouteStore = new SqliteRouteStore(dbCtx);
    log('store_ready');

    let dns: DnsManager | null = null;
    if (config.cloudflare) {
      dns = new CloudflareDnsManager(config.cloudflare, {
        timeoutMs: config.cloudflareTimeoutMs,
      });
      log('cloudflare_enabled');
    } else {
      log('cloudflare_disabled');
    }

    const probe: PortProbe = probeTcpPort;
    const service = new RouteService({ config, store, dns, probe });
    log('service_ready');

    // -----------------------------------------------------------------------
    // Stage 4 — HTTP app
    // -----------------------------------------------------------------------
    const app = createHttpApp({ config, store, service });
    serverHandle = runtime.createServer(app);
    log('http_app_created');

    // -----------------------------------------------------------------------
    // Stage 5 — Initial reconciliation (await BEFORE listen)
    // -----------------------------------------------------------------------
    log('initial_reconciliation');
    await service.reconcilePending();
    log('initial_reconciliation_done');

    // -----------------------------------------------------------------------
    // Stage 6 — Listen
    // -----------------------------------------------------------------------
    const assignedPort = await serverHandle.listen(
      config.listenPort,
      config.listenHost,
    );
    log('http_listening', { port: assignedPort });

    // -----------------------------------------------------------------------
    // Stage 7 — Scheduled single-flight reconciliation
    // -----------------------------------------------------------------------
    const runScheduledReconcile = async (): Promise<void> => {
      if (currentReconcile !== null) return; // in-flight, skip
      try {
        currentReconcile = service.reconcilePending();
        await currentReconcile;
      } catch {
        // Errors are logged inside reconcilePending; swallow here so the
        // scheduler interval stays alive.
      } finally {
        currentReconcile = null;
      }
    };

    timerHandle = runtime.setTimer(runScheduledReconcile, 30_000);
    log('scheduler_started', { intervalMs: 30_000 });

    // -----------------------------------------------------------------------
    // Stage 8 — Signal handlers
    // -----------------------------------------------------------------------
    let shutdownCalled = false;
    const shutdown = async (): Promise<void> => {
      if (shutdownCalled) return;
      shutdownCalled = true;
      log('shutdown_initiated');
      // 1. Stop scheduler — no new reconciles
      timerHandle?.clear();
      // 2. Unregister signal handler — prevent re-entrance
      unregisterSignal?.();
      // 3. Stop accepting HTTP and drain active connections
      await serverHandle?.close().catch(() => {});
      // 4. Await in-flight reconcile
      if (currentReconcile !== null) {
        await currentReconcile.catch(() => {});
      }
      // 5. Close SQLite
      dbCtx?.close();
      log('shutdown_complete');
    };

    const onSignal = (): void => {
      // Fire-and-forget shutdown, then exit
      shutdown().then(
        () => runtime.exit(0),
        () => runtime.exit(1),
      );
    };

    const unregSigint = runtime.onSignal('SIGINT', onSignal);
    const unregSigterm = runtime.onSignal('SIGTERM', onSignal);
    unregisterSignal = () => {
      unregSigint();
      unregSigterm();
    };
    log('signal_handlers_installed');

    // -----------------------------------------------------------------------
    // Return handle
    // -----------------------------------------------------------------------
    return {
      close: shutdown,
      get port(): number {
        return assignedPort;
      },
    };
  } catch (err) {
    // -----------------------------------------------------------------------
    // Rollback — close resources in reverse order, best-effort
    // -----------------------------------------------------------------------
    timerHandle?.clear();
    if (unregisterSignal) unregisterSignal();
    await serverHandle?.close().catch(() => {});
    dbCtx?.close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// ESM main-module guard
// ---------------------------------------------------------------------------

/** True when this module was loaded directly via `node dist/index.js`. */
const isMainModule =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  startApplication({ env: process.env }).catch(() => {
    log('startup_failed');
    process.exit(1);
  });
}
