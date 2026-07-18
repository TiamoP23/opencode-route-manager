import { createServer } from 'node:http';
import type { Server } from 'node:http';
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
// Types
// ---------------------------------------------------------------------------

export interface RunningApplication {
  /** Graceful shutdown: stop timer, close HTTP server, close SQLite. */
  close(): Promise<void>;
  /** The port the HTTP server is listening on (0 if not listening). */
  port: number;
}

export interface StartOptions {
  /** Environment variables for config. */
  env: Record<string, string | undefined>;
  /** When true, skip HTTP listen and signal handlers (default false). */
  noListen?: boolean;
  /** Optional callback fired after each reconcile pass (for testing). */
  onReconcile?: () => void;
}

// ---------------------------------------------------------------------------
// startApplication
// ---------------------------------------------------------------------------

/**
 * Loads config, opens SQLite with migrations, constructs dependencies,
 * serves HTTP, reconciles pending routes every 30 seconds, and handles
 * graceful shutdown on SIGINT / SIGTERM.
 *
 * When `noListen` is true the HTTP server is created but not started and
 * no process signal handlers are installed — designed for testing.
 */
export async function startApplication(options: StartOptions): Promise<RunningApplication> {
  const { env, noListen = false, onReconcile } = options;

  // -----------------------------------------------------------------------
  // 1. Load and validate config
  // -----------------------------------------------------------------------
  log('config_loading');
  const config: AppConfig = loadConfig(env);
  log('config_loaded', { listenHost: config.listenHost, listenPort: config.listenPort });

  // -----------------------------------------------------------------------
  // 2. Open SQLite and run migrations
  // -----------------------------------------------------------------------
  const dbPath = config.databasePath === ':memory:' ? ':memory:' : config.databasePath;
  log('database_opening', { path: dbPath });
  const db = openDatabase(config.databasePath, MIGRATIONS_FOLDER);
  log('database_ready');

  // -----------------------------------------------------------------------
  // 3. Construct dependencies
  // -----------------------------------------------------------------------
  const store: RouteStore = new SqliteRouteStore(db);
  log('store_ready');

  let dns: DnsManager | null = null;
  if (config.cloudflare) {
    dns = new CloudflareDnsManager(config.cloudflare);
    log('cloudflare_enabled');
  } else {
    log('cloudflare_disabled');
  }

  const probe: PortProbe = probeTcpPort;
  const service = new RouteService({ config, store, dns, probe });
  log('service_ready');

  // -----------------------------------------------------------------------
  // 4. Build HTTP app
  // -----------------------------------------------------------------------
  const app = createHttpApp({ config, store, service });
  const httpServer: Server = createServer(app);

  // -----------------------------------------------------------------------
  // 5. Listen (skip for testing)
  // -----------------------------------------------------------------------
  if (!noListen) {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.listenPort, config.listenHost, () => {
        resolve();
      });
    });
    const addr = httpServer.address();
    const port = addr && typeof addr === 'object' ? addr.port : config.listenPort;
    log('http_listening', { host: config.listenHost, port });
  } else {
    log('http_skip_listen');
  }

  // -----------------------------------------------------------------------
  // 6. Run one reconcilePending pass (fire-and-forget)
  // -----------------------------------------------------------------------
  const runReconcile = (): void => {
    service.reconcilePending()
      .then(() => { onReconcile?.(); })
      .catch(() => { onReconcile?.(); });
  };
  runReconcile();
  log('reconciliation_triggered');

  // -----------------------------------------------------------------------
  // 7. Schedule reconciliation every 30 seconds
  // -----------------------------------------------------------------------
  const RECONCILE_INTERVAL_MS = 30_000;
  const timer = setInterval(runReconcile, RECONCILE_INTERVAL_MS);
  log('scheduler_started', { intervalMs: RECONCILE_INTERVAL_MS });

  // -----------------------------------------------------------------------
  // 8. Signal handlers (skip for testing)
  // -----------------------------------------------------------------------
  const onSignal = (signal: string): void => {
    log('shutdown', { signal });
    clearInterval(timer);
    httpServer.close();
    db.close();
    // eslint-disable-next-line n/no-process-exit
    process.exit(0);
  };

  const signalNames = ['SIGINT', 'SIGTERM'] as const;
  if (!noListen) {
    for (const sig of signalNames) {
      process.on(sig, onSignal as NodeJS.SignalsListener);
    }
    log('signal_handlers_installed');
  }

  // -----------------------------------------------------------------------
  // 9. Return handle
  // -----------------------------------------------------------------------
  return {
    close: async () => {
      for (const sig of signalNames) {
        process.removeListener(sig, onSignal as NodeJS.SignalsListener);
      }
      clearInterval(timer);
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      db.close();
    },
    get port(): number {
      const addr = httpServer.address();
      if (addr && typeof addr === 'object') return addr.port;
      return 0;
    },
  };
}
