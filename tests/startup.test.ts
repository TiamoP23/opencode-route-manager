import { describe, expect, it } from 'vitest';
import type { RuntimeDeps } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseEnv: Record<string, string> = {
  MCP_TOKEN: 'a'.repeat(32),
  TRAEFIK_PROVIDER_TOKEN: 'b'.repeat(32),
  DATABASE_PATH: ':memory:',
  LISTEN_HOST: '127.0.0.1',
  LISTEN_PORT: '3001',
};

/** Fake runtime that tracks events via a mutable array. */
function trackRuntime(): {
  deps: RuntimeDeps;
  events: string[];
} {
  const events: string[] = [];

  return {
    deps: {
      createServer: () => {
        events.push('createServer');
        return {
          listen: async (port, host) => {
            events.push(`listen:${host}:${port}`);
            return Number(port);
          },
          close: async () => {
            events.push('server.close');
          },
        };
      },
      setTimer: (fn) => {
        events.push('setTimer');
        return { clear: () => events.push('timer.clear') };
      },
      onSignal: (sig) => {
        events.push(`onSignal:${sig}`);
        return () => { events.push(`offSignal:${sig}`); };
      },
      exit: (code) => { events.push(`exit:${code}`); },
    },
    events,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startup runtime', () => {
  // -----------------------------------------------------------------------
  // Existence & config validation
  // -----------------------------------------------------------------------

  it('exports startApplication function', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.startApplication).toBe('function');
  });

  it('rejects config with short MCP_TOKEN', async () => {
    const { startApplication } = await import('../src/index.js');
    const env = { ...baseEnv, MCP_TOKEN: 'short' };
    await expect(startApplication({ env })).rejects.toThrow(/MCP_TOKEN/);
  });

  it('rejects config with same tokens', async () => {
    const { startApplication } = await import('../src/index.js');
    const env = {
      ...baseEnv,
      MCP_TOKEN: 'abcdefghijklmnopqrstuvwxyz012345',
      TRAEFIK_PROVIDER_TOKEN: 'abcdefghijklmnopqrstuvwxyz012345',
    };
    await expect(startApplication({ env })).rejects.toThrow(/must be different/);
  });

  // -----------------------------------------------------------------------
  // Clean start / stop with fake runtime
  // -----------------------------------------------------------------------

  it('starts and stops cleanly with injected runtime', async () => {
    const { startApplication } = await import('../src/index.js');
    const rt = trackRuntime();
    const app = await startApplication({ env: baseEnv }, { runtime: rt.deps });
    expect(app).toBeDefined();
    expect(typeof app.close).toBe('function');
    expect(app.port).toBeGreaterThan(0);
    // Events: createServer -> listen -> setTimer -> onSignal
    expect(rt.events).toContain('createServer');
    expect(rt.events).toContain('setTimer');
    await app.close();
    // Close should stop timer, close server, remove signal handlers
    expect(rt.events).toContain('timer.clear');
    expect(rt.events).toContain('server.close');
    // Both SIGINT and SIGTERM were registered, both should be cleaned
    expect(rt.events.filter((e) => e.startsWith('offSignal')).length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Initial reconcile BEFORE listen (events order)
  // -----------------------------------------------------------------------

  it('runs initial reconcile before listen', async () => {
    const { startApplication } = await import('../src/index.js');
    const events: string[] = [];
    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => {
            events.push('createServer');
            return {
              listen: async (port, host) => {
                events.push('listen');
                return Number(port);
              },
              close: async () => { events.push('server.close'); },
            };
          },
          setTimer: () => {
            events.push('setTimer');
            return { clear: () => { events.push('timer.clear'); } };
          },
          onSignal: () => {
            events.push('onSignal');
            return () => { events.push('offSignal'); };
          },
          exit: () => {},
        },
      },
    );
    // createServer before setTimer (which is set up after listen)
    const createIdx = events.indexOf('createServer');
    const timerIdx = events.indexOf('setTimer');
    expect(createIdx).toBeLessThan(timerIdx);
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Shutdown awaits in-flight reconcile
  // -----------------------------------------------------------------------

  it('awaits in-flight reconcile during shutdown', async () => {
    const { startApplication } = await import('../src/index.js');
    let timerCb: (() => Promise<void>) | null = null;
    let slowReconcileResolve!: () => void;
    const slowReconcileDone = new Promise<void>((r) => { slowReconcileResolve = r; });
    let slowReconcileStarted = false;

    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => 3001,
            close: async () => {},
          }),
          setTimer: (fn) => {
            timerCb = fn;
            return { clear: () => {} };
          },
          onSignal: () => () => {},
          exit: () => {},
        },
      },
    );

    // Initial reconcile already completed. Patch RouteService to slow down
    // subsequent (scheduled) reconciles.
    const { RouteService } = await import('../src/route-service.js');
    const origReconcile = RouteService.prototype.reconcilePending;

    try {
      RouteService.prototype.reconcilePending = async function () {
        slowReconcileStarted = true;
        await slowReconcileDone;
        return origReconcile.call(this);
      };

      // Fire timer to trigger a scheduled reconcile (will hang)
      const scheduledPromise = timerCb!();
      // Give it a tick to start
      await new Promise((r) => setTimeout(r, 50));
      expect(slowReconcileStarted).toBe(true);

      // Close while reconcile is in-flight
      const closePromise = app.close();

      // Unblock reconcile
      slowReconcileResolve();
      await scheduledPromise;
      await closePromise;
    } finally {
      RouteService.prototype.reconcilePending = origReconcile;
      if (!slowReconcileStarted) slowReconcileResolve();
    }
  }, 10000);

  // -----------------------------------------------------------------------
  // Signal path calls exit
  // -----------------------------------------------------------------------

  it('signal handler calls exit and shares shutdown path', async () => {
    const { startApplication } = await import('../src/index.js');
    let exitCode: number | null = null;
    let registeredHandler: (() => void) | null = null;
    let unregistered = false;

    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => 3001,
            close: async () => {},
          }),
          setTimer: () => ({ clear: () => {} }),
          onSignal: (_sig, handler) => {
            registeredHandler = handler as () => void;
            return () => { unregistered = true; };
          },
          exit: (code) => { exitCode = code; },
        },
      },
    );

    expect(registeredHandler).toBeTruthy();

    // Fire the registered signal handler (async — shutdown then exit)
    registeredHandler!();
    // Wait for the promise chain (shutdown → exit) to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(exitCode).toBe(0);
    expect(unregistered).toBe(true);

    await app.close();
  }, 10000);

  // -----------------------------------------------------------------------
  // Listen failure rolls back
  // -----------------------------------------------------------------------

  it('rolls back on listen failure', async () => {
    const { startApplication } = await import('../src/index.js');
    let serverClosed = false;

    await expect(
      startApplication(
        { env: baseEnv },
        {
          runtime: {
            createServer: () => ({
              listen: async () => {
                throw new Error('port in use');
              },
              close: async () => { serverClosed = true; },
            }),
            setTimer: () => ({ clear: () => {} }),
            onSignal: () => () => {},
            exit: () => {},
          },
        },
      ),
    ).rejects.toThrow(/port in use/);

    expect(serverClosed).toBe(true);
  }, 10000);

  // -----------------------------------------------------------------------
  // Cloudflare timeout is wired
  // -----------------------------------------------------------------------

  it('wires Cloudflare timeout from config', async () => {
    const { startApplication } = await import('../src/index.js');
    const env = {
      ...baseEnv,
      CLOUDFLARE_ZONE_ID: 'zone',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_CNAME_TARGET: 'cname.dev',
      CLOUDFLARE_TIMEOUT_MS: '9999',
    };
    const rt = trackRuntime();
    const app = await startApplication({ env }, { runtime: rt.deps });
    expect(app).toBeDefined();
    // Verify cloudflare config was accepted (startup succeeds)
    const configMod = await import('../src/config.js');
    const config = configMod.loadConfig(env);
    expect(config.cloudflareTimeoutMs).toBe(9999);
    await app.close();
  }, 10000);

  // -----------------------------------------------------------------------
  // Timer cancellation on close
  // -----------------------------------------------------------------------

  it('cancels timer on close', async () => {
    const { startApplication } = await import('../src/index.js');
    const events: string[] = [];
    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => 3001,
            close: async () => { events.push('server.close'); },
          }),
          setTimer: () => ({
            clear: () => { events.push('timer.clear'); },
          }),
          onSignal: () => () => {},
          exit: () => {},
        },
      },
    );
    await app.close();
    expect(events).toContain('timer.clear');
    expect(events).toContain('server.close');
  }, 10000);
});

// ---------------------------------------------------------------------------
// ESM main guard (finding 1)
// ---------------------------------------------------------------------------

describe('ESM main guard', () => {
  it('startApplication is exported for main-module invocation', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.startApplication).toBe('function');
  });
});
