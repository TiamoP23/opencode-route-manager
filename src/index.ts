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

export type DeadlineResult<T> =
  | { success: true; value: T }
  | { success: false; timedOut: true };

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
  /**
   * Race `promise` against a `ms` timeout.  Returns `{ success: true, value }`
   * when the promise settles first, or `{ success: false, timedOut: true }`
   * when the deadline fires first.  Does NOT cancel the underlying promise.
   */
  deadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineResult<T>>;
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
  deadline: async <T>(promise: Promise<T>, ms: number): Promise<DeadlineResult<T>> => {
    const timeout = new Promise<DeadlineResult<T>>((resolve) => {
      const id = setTimeout(() => resolve({ success: false, timedOut: true }), ms);
      // Allow the timer to keep the event loop alive
      if (id.unref) id.unref();
    });
    const winner = await Promise.race([
      promise.then((value) => ({ success: true, value } as const)),
      timeout,
    ]);
    return winner;
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

/** Default deadline for the initial reconciliation pass. */
const INITIAL_RECONCILE_DEADLINE_MS = 10_000;

// ---------------------------------------------------------------------------
// startApplication
// ---------------------------------------------------------------------------

/**
 * Loads config, opens SQLite with migrations, constructs dependencies,
 * runs one bounded initial reconciliation, serves HTTP, schedules
 * retryable reconciliation every 30 seconds (single-flight), and handles
 * graceful shutdown on SIGINT / SIGTERM.
 *
 * Accepts an optional second argument with overridden `RuntimeDeps` for
 * testing — when omitted real Node.js primitives are used.
 *
 * Signal handlers are installed BEFORE the initial reconciliation so that
 * signals during startup own all acquired resources.
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

  // In-flight reconcile tracker for single-flight scheduler + shutdown await.
  // Set by both: timed-out initial reconcile (the running promise) and
  // scheduled reconciles (via runScheduledReconcile).
  let currentReconcile: Promise<void> | null = null;

  // Shared shutdown promise — all concurrent close/signal callers await the
  // same settled promise.
  let shutdownPromise: Promise<void> | null = null;

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
    const service = new RouteService({
      config,
      store,
      dns,
      probe,
      onReconcileEvent: (evt) => {
        log('reconcile_error', {
          slug: evt.slug,
          status: evt.status,
          code: evt.code,
        });
      },
    });
    log('service_ready');

    // -----------------------------------------------------------------------
    // Stage 4 — HTTP app
    // -----------------------------------------------------------------------
    const app = createHttpApp({ config, store, service });
    serverHandle = runtime.createServer(app);
    log('http_app_created');

    // -----------------------------------------------------------------------
    // Stage 5 — Signal handlers (BEFORE initial reconcile)
    // -----------------------------------------------------------------------
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
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
        try { dbCtx?.close(); } catch { /* already closed */ }
        log('shutdown_complete');
      })();
      return shutdownPromise;
    };

    const onSignal = (): void => {
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
    // Stage 6 — Initial reconciliation (bounded by deadline)
    // -----------------------------------------------------------------------
    log('initial_reconciliation');
    const initialPromise = service.reconcilePending();
    const deadlineResult = await runtime.deadline(
      initialPromise,
      INITIAL_RECONCILE_DEADLINE_MS,
    );

    if (!deadlineResult.success) {
      // Timed out — the promise is still running; keep it as currentReconcile
      // so the scheduler skips overlap and shutdown awaits it.
      currentReconcile = initialPromise.catch(() => {});
      log('initial_reconciliation_deadline');
    } else {
      log('initial_reconciliation_done');
    }

    // -----------------------------------------------------------------------
    // Stage 7 — Listen
    // -----------------------------------------------------------------------
    const assignedPort = await serverHandle.listen(
      config.listenPort,
      config.listenHost,
    );
    log('http_listening', { port: assignedPort });

    // -----------------------------------------------------------------------
    // Stage 8 — Scheduled single-flight reconciliation
    // -----------------------------------------------------------------------
    const runScheduledReconcile = async (): Promise<void> => {
      if (currentReconcile !== null) return; // in-flight, skip
      try {
        currentReconcile = service.reconcilePending();
        await currentReconcile;
      } catch {
        // Scheduler-level failure — log fixed code only, no message/config
        log('reconcile_scheduler_error');
      } finally {
        currentReconcile = null;
      }
    };

    timerHandle = runtime.setTimer(runScheduledReconcile, 30_000);
    log('scheduler_started', { intervalMs: 30_000 });

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
    try { dbCtx?.close(); } catch { /* already closed */ }
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
