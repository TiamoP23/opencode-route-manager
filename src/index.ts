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
import type { PasswordHasher } from './basic-auth.js';

const MIGRATIONS_FOLDER = new URL('../drizzle', import.meta.url).pathname;

function log(event: string, extra?: Record<string, unknown>): void {
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
  setTimer(fn: () => void, ms: number): TimerHandle;
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

export async function startApplication(
  options: StartOptions,
  overrides?: {
    runtime?: Partial<RuntimeDeps> | undefined;
    hashPassword?: PasswordHasher | undefined;
  },
): Promise<RunningApplication> {
  const runtime: RuntimeDeps = { ...defaultRuntime, ...overrides?.runtime };
  const { env } = options;

  let dbCtx: ReturnType<typeof openDatabase> | null = null;
  let serverHandle: ServerHandle | null = null;
  let timerHandle: TimerHandle | null = null;
  let unregisterSignal: (() => void) | null = null;

  // In-flight reconcile tracker — assigned BEFORE the deadline race and
  // cleared by the tracked promise's own finally only when still current.
  let currentReconcile: Promise<void> | null = null;

  // Shared shutdown promise — concurrent close/signal callers await the same.
  let shutdownPromise: Promise<void> | null = null;

  try {
    // -----------------------------------------------------------------------
    // Stage 1 — Config
    // -----------------------------------------------------------------------
    log('config_loading');
    const config: AppConfig = loadConfig(env, {
      hashPassword: overrides?.hashPassword,
    });
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
      if (shutdownPromise !== null) return shutdownPromise;
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

    const unregSigint = runtime.onSignal('SIGINT', onSignal);
    try {
      const unregSigterm = runtime.onSignal('SIGTERM', onSignal);
      unregisterSignal = () => {
        unregSigint();
        unregSigterm();
      };
    } catch {
      unregSigint();
      throw new Error('Failed to register SIGTERM');
    }
    log('signal_handlers_installed');

    // -----------------------------------------------------------------------
    // Stage 6 — Initial reconciliation (bounded by deadline)
    // -----------------------------------------------------------------------
    log('initial_reconciliation');

    const initialReconcilePromise = service.reconcilePending();

    const tracked = initialReconcilePromise
      .catch(() => {})
      .finally(() => {
        if (currentReconcile === tracked) currentReconcile = null;
      });
    currentReconcile = tracked;

    // Guard: signal handler may have fired during reconcile setup.
    // TS narrows the local const correctly.
    const guardA = shutdownPromise as Promise<void> | null;
    if (guardA !== null) {
      await tracked.catch(() => {});
      throw new Error('shutdown_during_startup');
    }

    // Deadline uses the raw promise (may reject).  A rejection means
    // the reconcile itself failed.  Log fixed code and propagate.
    let deadlineResult: DeadlineResult<unknown>;
    try {
      deadlineResult = await runtime.deadline(
        initialReconcilePromise,
        INITIAL_RECONCILE_DEADLINE_MS,
      );
    } catch (err) {
      log('initial_reconciliation_error', { code: 'INTERNAL_ERROR' });
      throw err;
    }

    const guardB = shutdownPromise as Promise<void> | null;
    if (guardB !== null) {
      await tracked.catch(() => {});
      throw new Error('shutdown_during_startup');
    }

    if (!deadlineResult.success) {
      log('initial_reconciliation_deadline');
    } else {
      log('initial_reconciliation_done');
    }

    // -----------------------------------------------------------------------
    // Stage 7 — Listen
    // -----------------------------------------------------------------------
    const guardC = shutdownPromise as Promise<void> | null;
    if (guardC !== null) {
      await guardC.catch(() => {});
      throw new Error('shutdown_during_startup');
    }
    const assignedPort = await serverHandle.listen(
      config.listenPort,
      config.listenHost,
    );
    {
      const guardD = shutdownPromise as Promise<void> | null;
      if (guardD !== null) {
        await guardD.catch(() => {});
        throw new Error('shutdown_during_startup');
      }
    }
    log('http_listening', { port: assignedPort });

    // -----------------------------------------------------------------------
    // Stage 8 — Scheduled single-flight reconciliation
    // -----------------------------------------------------------------------
    const guardE = shutdownPromise as Promise<void> | null;
    if (guardE !== null) {
      await guardE.catch(() => {});
      throw new Error('shutdown_during_startup');
    }
    const runScheduledReconcile = (): void => {
      if (shutdownPromise !== null || currentReconcile !== null) return;
      try {
        const sched = service.reconcilePending();
        const trackedSched = sched
          .catch(() => {
            log('reconcile_scheduler_error', { code: 'INTERNAL_ERROR' });
          })
          .finally(() => {
            if (currentReconcile === trackedSched) currentReconcile = null;
          });
        currentReconcile = trackedSched;
        // Fire-and-forget the tracked promise — errors already caught
        // above and cleared in finally.
        trackedSched.catch(() => {});
      } catch {
        log('reconcile_scheduler_error', { code: 'INTERNAL_ERROR' });
      }
    };

    timerHandle = runtime.setTimer(runScheduledReconcile, 30_000);
    const guardF = shutdownPromise as Promise<void> | null;
    if (guardF !== null) {
      timerHandle.clear();
      await guardF.catch(() => {});
      throw new Error('shutdown_during_startup');
    }
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
    // Rollback — when stopping, the shared shutdown already handled cleanup.
    // -----------------------------------------------------------------------
    const guardG = shutdownPromise as Promise<void> | null;
    if (guardG !== null) {
      await guardG.catch(() => {});
    } else {
      timerHandle?.clear();
      if (unregisterSignal) unregisterSignal();
      await serverHandle?.close().catch(() => {});
      if (currentReconcile !== null) {
        await currentReconcile.catch(() => {});
      }
      try { dbCtx?.close(); } catch { /* already closed */ }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main runner — used by the ESM main-module guard and tests.
// ---------------------------------------------------------------------------

export async function runApplication(
  options: StartOptions,
  overrides?: {
    runtime?: Partial<RuntimeDeps> | undefined;
    hashPassword?: PasswordHasher | undefined;
    exit?: ((code: number) => void) | undefined;
  },
): Promise<void> {
  const exit = overrides?.exit ?? process.exit;
  try {
    await startApplication(options, {
      runtime: overrides?.runtime,
      hashPassword: overrides?.hashPassword,
    });
  } catch {
    log('startup_failed');
    exit(1);
  }
}

// ---------------------------------------------------------------------------
// ESM main-module guard
// ---------------------------------------------------------------------------

const isMainModule =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  runApplication({ env: process.env });
}
