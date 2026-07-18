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
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
}

export interface TimerHandle {
  clear(): void;
}

export type DeadlineResult<T> =
  | { success: true; value: T }
  | { success: false; timedOut: true };

export interface RuntimeDeps {
  createServer(handler: Express): ServerHandle;
  setTimer(fn: () => Promise<void>, ms: number): TimerHandle;
  onSignal(sig: string, handler: () => void): () => void;
  exit(code: number): void;
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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<DeadlineResult<T>>((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ success: false, timedOut: true } as const),
          ms,
        );
        if (timeoutId.unref) timeoutId.unref();
      });
      return await Promise.race([
        promise.then((value) => ({ success: true, value } as const)),
        timeout,
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunningApplication {
  close(): Promise<void>;
  port: number;
}

export interface StartOptions {
  env: Record<string, string | undefined>;
}

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
 * Signal handlers are installed BEFORE the initial reconciliation so that
 * a signal during startup sets a `stopping` flag that aborts startup.
 *
 * On any startup failure all previously-acquired resources are rolled
 * back before the error propagates.
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

  // In-flight reconcile tracker — assigned BEFORE the deadline race and
  // cleared by the tracked promise's own finally only when still current.
  let currentReconcile: Promise<void> | null = null;

  // Shared shutdown promise — concurrent close/signal callers await the same.
  let shutdownPromise: Promise<void> | null = null;

  // Once true no new work begins and startup aborts.
  let stopping = false;

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
      stopping = true;
      shutdownPromise = (async () => {
        log('shutdown_initiated');
        timerHandle?.clear();
        unregisterSignal?.();
        await serverHandle?.close().catch(() => {});
        if (currentReconcile !== null) {
          await currentReconcile.catch(() => {});
        }
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

    // Register both signals; if the second throws, roll back the first.
    const unregSigint = runtime.onSignal('SIGINT', onSignal);
    try {
      const unregSigterm = runtime.onSignal('SIGTERM', onSignal);
      unregisterSignal = () => {
        unregSigint();
        unregSigterm();
      };
    } catch {
      unregSigint(); // clean up the already-registered SIGINT
      throw new Error('Failed to register SIGTERM');
    }
    log('signal_handlers_installed');

    // -----------------------------------------------------------------------
    // Stage 6 — Initial reconciliation (bounded by deadline)
    // -----------------------------------------------------------------------
    log('initial_reconciliation');

    // Track the promise before the deadline race so signal shutdown and
    // the scheduler can see it.
    const initialReconcilePromise = service.reconcilePending();

    const tracked = initialReconcilePromise
      .catch(() => {})
      .finally(() => {
        if (currentReconcile === tracked) currentReconcile = null;
      });
    currentReconcile = tracked;

    // Guard: if a signal fired before we finished setting up, await the
    // tracked promise to settle, then abort.
    if (stopping) {
      await tracked.catch(() => {});
      throw new Error('shutdown_during_startup');
    }

    // Deadline uses the raw promise (which may reject).  Catch its
    // rejection so there is never a detached unhandled rejection while
    // tracked's .catch() remains the primary handler.
    let deadlineResult: DeadlineResult<unknown>;
    try {
      deadlineResult = await runtime.deadline(
        initialReconcilePromise,
        INITIAL_RECONCILE_DEADLINE_MS,
      );
    } catch {
      // The raw promise rejected (e.g. DB was closed by shutdown).
      // Treat as deadline timeout so startup continues with
      // currentReconcile set and the scheduler skips.
      deadlineResult = { success: false, timedOut: true };
    }

    if (stopping) {
      await tracked.catch(() => {});
      throw new Error('shutdown_during_startup');
    }

    if (!deadlineResult.success) {
      // Timed out — `currentReconcile` stays set so the scheduler skips
      // overlap and shutdown awaits it.  When the promise settles,
      // `.finally()` above clears it (if still current).
      log('initial_reconciliation_deadline');
    } else {
      log('initial_reconciliation_done');
    }

    // -----------------------------------------------------------------------
    // Stage 7 — Listen
    // -----------------------------------------------------------------------
    if (stopping) {
      await currentReconcile?.catch(() => {});
      throw new Error('shutdown_during_startup');
    }
    const assignedPort = await serverHandle.listen(
      config.listenPort,
      config.listenHost,
    );
    log('http_listening', { port: assignedPort });

    // -----------------------------------------------------------------------
    // Stage 8 — Scheduled single-flight reconciliation
    // -----------------------------------------------------------------------
    const runScheduledReconcile = async (): Promise<void> => {
      if (stopping || currentReconcile !== null) return;
      const sched = service
        .reconcilePending()
        .catch(() => {})
        .finally(() => {
          if (currentReconcile === sched) currentReconcile = null;
        });
      currentReconcile = sched;
      await sched;
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
    // Rollback — close resources in reverse order
    // -----------------------------------------------------------------------
    timerHandle?.clear();
    if (unregisterSignal) unregisterSignal();
    await serverHandle?.close().catch(() => {});
    if (currentReconcile !== null) {
      await currentReconcile.catch(() => {});
    }
    try { dbCtx?.close(); } catch { /* already closed */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// ESM main-module guard
// ---------------------------------------------------------------------------

const isMainModule =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  startApplication({ env: process.env }).catch(() => {
    log('startup_failed');
    process.exit(1);
  });
}
