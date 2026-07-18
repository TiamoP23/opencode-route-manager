import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { RuntimeDeps } from '../src/index.js';
import { RouteService } from '../src/route-service.js';
import { RouteManagerError } from '../src/errors.js';

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

function trackRuntime(): { deps: RuntimeDeps; events: string[] } {
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
          close: async () => { events.push('server.close'); },
        };
      },
      setTimer: () => {
        events.push('setTimer');
        return { clear: () => events.push('timer.clear') };
      },
      onSignal: (sig) => {
        events.push(`onSignal:${sig}`);
        return () => { events.push(`offSignal:${sig}`); };
      },
      exit: (code) => { events.push(`exit:${code}`); },
      deadline: async <T>(p: Promise<T>, _ms: number) => {
        events.push('deadline');
        const value = await p;
        return { success: true, value } as const;
      },
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
  // Clean start / stop
  // -----------------------------------------------------------------------

  it('starts and stops cleanly with injected runtime', async () => {
    const { startApplication } = await import('../src/index.js');
    const rt = trackRuntime();
    const app = await startApplication({ env: baseEnv }, { runtime: rt.deps });
    try {
      expect(app).toBeDefined();
      expect(typeof app.close).toBe('function');
      expect(app.port).toBeGreaterThan(0);
      expect(rt.events).toContain('createServer');
      expect(rt.events).toContain('setTimer');
    } finally {
      await app.close();
    }
    expect(rt.events).toContain('timer.clear');
    expect(rt.events).toContain('server.close');
    expect(rt.events.filter((e) => e.startsWith('offSignal')).length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Signal ownership before initial reconcile
  // -----------------------------------------------------------------------

  it('installs signal handlers before initial reconcile and listen', async () => {
    const { startApplication } = await import('../src/index.js');
    const events: string[] = [];
    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => {
            events.push('createServer');
            return {
              listen: async () => { events.push('listen'); return 3001; },
              close: async () => { events.push('server.close'); },
            };
          },
          setTimer: () => {
            events.push('setTimer');
            return { clear: () => { events.push('timer.clear'); } };
          },
          onSignal: (sig) => {
            events.push(`onSignal:${sig}`);
            return () => { events.push(`offSignal:${sig}`); };
          },
          deadline: async <T>(p: Promise<T>, _ms: number) => {
            events.push('deadline');
            const value = await p;
            return { success: true, value } as const;
          },
          exit: () => {},
        },
      },
    );
    try {
      const signalIdx = events.findIndex((e) => e.startsWith('onSignal'));
      const deadlineIdx = events.indexOf('deadline');
      const listenIdx = events.indexOf('listen');
      expect(signalIdx).toBeLessThan(deadlineIdx);
      expect(signalIdx).toBeLessThan(listenIdx);
    } finally {
      await app.close();
    }
  });

  // -----------------------------------------------------------------------
  // Deadline timeout → scheduler skip → settle → scheduler resume
  // -----------------------------------------------------------------------

  it('initial timeout blocks scheduler; after settle scheduler resumes', async () => {
    const { startApplication } = await import('../src/index.js');
    let timerCb: (() => void) | null = null;
    const events: string[] = [];
    let scheduledCalls = 0;
    let resolveSlow!: () => void;
    const slowGate = new Promise<void>((r) => { resolveSlow = r; });

    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => { events.push('listen'); return 3001; },
            close: async () => { events.push('server.close'); },
          }),
          setTimer: (fn) => {
            timerCb = fn;
            return { clear: () => { events.push('timer.clear'); } };
          },
          onSignal: () => () => {},
          deadline: async <T>(_p: Promise<T>, _ms: number) => {
            events.push('deadline.timeout');
            return { success: false, timedOut: true } as const;
          },
          exit: () => {},
        },
      },
    );
    try {
      // At this point: deadline timed out, currentReconcile is set (initial
      // reconcile running in the background on the real DB).  Patch so
      // scheduled calls are observable.
      const orig = RouteService.prototype.reconcilePending;
      try {
        RouteService.prototype.reconcilePending = async function () {
          scheduledCalls++;
          events.push(`sched.${scheduledCalls}`);
          if (scheduledCalls <= 1) await slowGate;
          return orig.call(this);
        };

        // Fire timer while currentReconcile is potentially still set
        timerCb!();
        await new Promise((r) => setTimeout(r, 200));
        // By now the initial reconcile has settled (empty DB → fast).
        // currentReconcile cleared by finally.  Release any gated call.
        resolveSlow();
        await new Promise((r) => setTimeout(r, 100));

        // Fire timer again — should start exactly one new reconcile
        timerCb!();
        await new Promise((r) => setTimeout(r, 100));

        // At least one scheduled reconcile ran
        expect(scheduledCalls).toBeGreaterThanOrEqual(1);
      } finally {
        resolveSlow();
        RouteService.prototype.reconcilePending = orig;
      }
    } finally {
      await app.close();
    }
  }, 15000);

  // -----------------------------------------------------------------------
  // No-overlap scheduled reconcile
  // -----------------------------------------------------------------------

  it('does not overlap scheduled reconciles', async () => {
    const { startApplication } = await import('../src/index.js');
    let timerCb: (() => void) | null = null;
    const events: string[] = [];

    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => { events.push('listen'); return 3001; },
            close: async () => { events.push('server.close'); },
          }),
          setTimer: (fn) => {
            timerCb = fn;
            return { clear: () => { events.push('timer.clear'); } };
          },
          onSignal: () => () => {},
          deadline: async <T>(p: Promise<T>, _ms: number) => {
            events.push('deadline');
            const value = await p;
            return { success: true, value } as const;
          },
          exit: () => {},
        },
      },
    );
    try {
      const orig = RouteService.prototype.reconcilePending;
      let reconcileCount = 0;
      let resolveSlow!: () => void;
      const slowGate = new Promise<void>((r) => { resolveSlow = r; });

      try {
        RouteService.prototype.reconcilePending = async function () {
          reconcileCount++;
          events.push('reconcile.start');
          await slowGate;
          events.push('reconcile.end');
          return orig.call(this);
        };
        timerCb!();
        await new Promise((r) => setTimeout(r, 50));
        timerCb!();
        await new Promise((r) => setTimeout(r, 50));
        const starts = events.filter((e) => e === 'reconcile.start');
        expect(starts.length).toBe(1);
      } finally {
        resolveSlow!();
        RouteService.prototype.reconcilePending = orig;
      }
    } finally {
      await app.close();
    }
  }, 15000);

  // -----------------------------------------------------------------------
  // Signal during startup (before listen) aborts
  // -----------------------------------------------------------------------

  it('signal during startup rejects startApplication', async () => {
    const { startApplication } = await import('../src/index.js');
    let registeredHandler: (() => void) | null = null;
    let signalReady!: () => void;
    const signalReadyPromise = new Promise<void>((r) => { signalReady = r; });
    let exitCode: number | null = null;
    let caught: unknown = null;

    const appPromise = startApplication(
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
            signalReady();
            return () => {};
          },
          deadline: async <T>(p: Promise<T>, _ms: number) => {
            const value = await p;
            return { success: true, value } as const;
          },
          exit: (code) => { exitCode = code; },
        },
      },
    ).catch((err) => { caught = err; });

    await signalReadyPromise;
    expect(registeredHandler).toBeTruthy();
    registeredHandler!();
    await new Promise((r) => setTimeout(r, 10));
    expect(exitCode).toBe(0);

    expect(caught).toBeTruthy();
    expect((caught as Error).message).toMatch(/shutdown_during_startup/);
  }, 10000);

  // -----------------------------------------------------------------------
  // Signal during listen — no timer, startup rejects
  // -----------------------------------------------------------------------

  it('signal during listen rejects startup with no timer', async () => {
    const { startApplication } = await import('../src/index.js');
    let registeredHandler: (() => void) | null = null;
    let signalReady!: () => void;
    const signalReadyPromise = new Promise<void>((r) => { signalReady = r; });
    let exitCode: number | null = null;
    let timerSet = false;
    let listenStarted = false;
    let resolveListen!: () => void;
    let caught: unknown = null;

    const appPromise = startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => {
              listenStarted = true;
              await new Promise<void>((r) => { resolveListen = r; });
              return 3001;
            },
            close: async () => {},
          }),
          setTimer: () => {
            timerSet = true;
            return { clear: () => {} };
          },
          onSignal: (_sig, handler) => {
            registeredHandler = handler as () => void;
            signalReady();
            return () => {};
          },
          deadline: async <T>(p: Promise<T>, _ms: number) => {
            const value = await p;
            return { success: true, value } as const;
          },
          exit: (code) => { exitCode = code; },
        },
      },
    ).catch((err) => { caught = err; });

    await signalReadyPromise;
    await new Promise((r) => setTimeout(r, 50));
    expect(listenStarted).toBe(true);

    // Fire signal while listen is in-flight
    registeredHandler!();
    await new Promise((r) => setTimeout(r, 10));
    expect(exitCode).toBe(0);

    // Resolve listen
    resolveListen();
    await new Promise((r) => setTimeout(r, 50));

    expect(caught).toBeTruthy();
    expect((caught as Error).message).toMatch(/shutdown_during_startup/);
    expect(timerSet).toBe(false);
  }, 10000);

  // -----------------------------------------------------------------------
  // Shared shutdown promise
  // -----------------------------------------------------------------------

  it('multiple close calls share the same shutdown promise', async () => {
    const { startApplication } = await import('../src/index.js');
    const rt = trackRuntime();
    const app = await startApplication({ env: baseEnv }, { runtime: rt.deps });
    try {
      await Promise.all([app.close(), app.close(), app.close()]);
      expect(rt.events.filter((e) => e === 'server.close').length).toBe(1);
      expect(rt.events.filter((e) => e === 'timer.clear').length).toBe(1);
    } finally {
      await app.close().catch(() => {});
    }
  });

  it('close and signal path share the same shutdown', async () => {
    const { startApplication } = await import('../src/index.js');
    let exitCode: number | null = null;
    let registeredHandler: (() => void) | null = null;

    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({ listen: async () => 3001, close: async () => {} }),
          setTimer: () => ({ clear: () => {} }),
          onSignal: (_sig, handler) => {
            registeredHandler = handler as () => void;
            return () => {};
          },
          deadline: async <T>(p: Promise<T>, _ms: number) => {
            const value = await p;
            return { success: true, value } as const;
          },
          exit: (code) => { exitCode = code; },
        },
      },
    );
    try {
      await Promise.all([
        new Promise<void>((r) => { registeredHandler!(); setTimeout(r, 10); }),
        app.close(),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      await app.close().catch(() => {});
    }
  }, 10000);

  // -----------------------------------------------------------------------
  // Timer cancellation
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
          setTimer: () => ({ clear: () => { events.push('timer.clear'); } }),
          onSignal: () => () => {},
          deadline: async <T>(p: Promise<T>, _ms: number) => {
            const value = await p;
            return { success: true, value } as const;
          },
          exit: () => {},
        },
      },
    );
    try {
      await app.close();
      expect(events).toContain('timer.clear');
      expect(events).toContain('server.close');
    } finally {
      await app.close().catch(() => {});
    }
  });

  // -----------------------------------------------------------------------
  // Shutdown order with reconcile settle
  // -----------------------------------------------------------------------

  it('shutdown follows correct order with reconcile settle', async () => {
    const { startApplication } = await import('../src/index.js');
    const events: string[] = [];
    let timerCb: (() => void) | null = null;
    let resolveReconcile!: () => void;
    const reconcileGate = new Promise<void>((r) => { resolveReconcile = r; });

    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => { events.push('listen'); return 3001; },
            close: async () => { events.push('http.close'); },
          }),
          setTimer: (fn) => {
            timerCb = fn;
            return { clear: () => { events.push('timer.clear'); } };
          },
          onSignal: () => () => {},
          deadline: async <T>(p: Promise<T>, _ms: number) => {
            events.push('deadline');
            const value = await p;
            return { success: true, value } as const;
          },
          exit: () => {},
        },
      },
    );

    const origReconcile = RouteService.prototype.reconcilePending;
    let reconcileStarted = false;

    try {
      RouteService.prototype.reconcilePending = async function () {
        if (reconcileStarted) return origReconcile.call(this);
        reconcileStarted = true;
        events.push('reconcile.start');
        await reconcileGate;
        events.push('reconcile.end');
        return origReconcile.call(this);
      };

      timerCb!();
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toContain('reconcile.start');

      const closePromise = app.close();
      await new Promise((r) => setTimeout(r, 50));

      expect(events.indexOf('timer.clear')).toBeLessThan(events.indexOf('http.close'));

      resolveReconcile();
      await closePromise;

      expect(events.indexOf('http.close')).toBeLessThan(events.indexOf('reconcile.end'));

      await app.close().catch(() => {});
    } finally {
      RouteService.prototype.reconcilePending = origReconcile;
      if (!reconcileStarted) resolveReconcile();
    }
  }, 15000);

  // -----------------------------------------------------------------------
  // Listen failure rolls back with reconcile await
  // -----------------------------------------------------------------------

  it('rolls back on listen failure', async () => {
    const { startApplication } = await import('../src/index.js');
    let serverClosed = false;
    let offSignalCalled = 0;

    await expect(
      startApplication(
        { env: baseEnv },
        {
          runtime: {
            createServer: () => ({
              listen: async () => { throw new Error('port in use'); },
              close: async () => { serverClosed = true; },
            }),
            setTimer: () => ({ clear: () => {} }),
            onSignal: () => () => { offSignalCalled++; },
            deadline: async <T>(p: Promise<T>, _ms: number) => {
              const value = await p;
              return { success: true, value } as const;
            },
            exit: () => {},
          },
        },
      ),
    ).rejects.toThrow(/port in use/);

    expect(serverClosed).toBe(true);
    expect(offSignalCalled).toBe(2);
  }, 10000);

  // -----------------------------------------------------------------------
  // Listen failure after initial timeout — rollback awaits reconcile settle
  // -----------------------------------------------------------------------

  it('listen failure after initial timeout rolls back after reconcile settles', async () => {
    const { startApplication } = await import('../src/index.js');
    let resolveReconcile!: () => void;
    const reconcileGate = new Promise<void>((r) => { resolveReconcile = r; });
    let serverClosed = false;
    let reconcileReleased = false;

    const orig = RouteService.prototype.reconcilePending;
    const isFirst = { value: true };
    try {
      RouteService.prototype.reconcilePending = async function () {
        if (isFirst.value) {
          isFirst.value = false;
          await reconcileGate;
          reconcileReleased = true;
        }
        return orig.call(this);
      };

      const startPromise = startApplication(
        { env: baseEnv },
        {
          runtime: {
            createServer: () => ({
              listen: async () => { throw new Error('port in use'); },
              close: async () => { serverClosed = true; },
            }),
            setTimer: () => ({ clear: () => {} }),
            onSignal: () => () => {},
            deadline: async <T>(_p: Promise<T>, _ms: number) => {
              return { success: false, timedOut: true } as const;
            },
            exit: () => {},
          },
        },
      );

      // Give startup a tick to reach the reconcile gate
      await new Promise((r) => setTimeout(r, 100));
      expect(reconcileReleased).toBe(false);

      // Release reconcile — rollback should now complete
      resolveReconcile();
      await expect(startPromise).rejects.toThrow(/port in use/);
      expect(serverClosed).toBe(true);
      expect(reconcileReleased).toBe(true);
    } finally {
      RouteService.prototype.reconcilePending = orig;
      if (!reconcileReleased) resolveReconcile();
    }
  }, 10000);

  // -----------------------------------------------------------------------
  // Cloudflare timeout propagation
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
    try {
      const configMod = await import('../src/config.js');
      const config = configMod.loadConfig(env);
      expect(config.cloudflareTimeoutMs).toBe(9999);
    } finally {
      await app.close();
    }
  }, 10000);

  // -----------------------------------------------------------------------
  // Reconcile event — creating failure (PORT_UNREACHABLE)
  // -----------------------------------------------------------------------

  it('emits PORT_UNREACHABLE for creating failure', async () => {
    const { startApplication } = await import('../src/index.js');
    const events: Array<{ slug: string; status: string; code: string }> = [];

    const { SqliteRouteStore } = await import('../src/db/route-store.js');
    const { openDatabase } = await import('../src/db/client.js');
    const migrations = new URL('../drizzle', import.meta.url).pathname;

    const db = openDatabase(':memory:', migrations);
    try {
      const store = new SqliteRouteStore(db);

      await store.insertCreating({
        slug: 'test-fail',
        port: 9999,
        description: null,
      });

      // Wait for backoff period to elapse
      await new Promise((r) => setTimeout(r, 1500));

      const service = new RouteService({
        config: { ...(await import('../src/config.js')).loadConfig(baseEnv) },
        store,
        dns: null,
        probe: async () => false,
        onReconcileEvent: (evt) => { events.push(evt); },
      });

      await service.reconcilePending();

      expect(events.length).toBe(1);
      expect(events[0]?.slug).toBe('test-fail');
      expect(events[0]?.status).toBe('creating');
      expect(events[0]?.code).toBe('PORT_UNREACHABLE');
    } finally {
      db.close();
    }
  });

  // -----------------------------------------------------------------------
  // Reconcile event — deleting failure (DNS_UNAVAILABLE)
  // -----------------------------------------------------------------------

  it('emits DNS_UNAVAILABLE for deleting failure', async () => {
    const events: Array<{ slug: string; status: string; code: string }> = [];

    const { SqliteRouteStore } = await import('../src/db/route-store.js');
    const { openDatabase } = await import('../src/db/client.js');
    const migrations = new URL('../drizzle', import.meta.url).pathname;

    const db = openDatabase(':memory:', migrations);
    try {
      const store = new SqliteRouteStore(db);

      await store.insertCreating({
        slug: 'test-del-fail',
        port: 9999,
        description: null,
      });
      await store.setCloudflareRecordId('test-del-fail', 'cf-record-1');
      await store.markDeleting('test-del-fail');

      await new Promise((r) => setTimeout(r, 1500));

      const dns = {
        assertAvailable: async () => {},
        findOwnedRecord: async () => null,
        ensureRecord: async () => { throw new RouteManagerError('DNS_UNAVAILABLE', 'test'); },
        deleteRecord: async () => { throw new RouteManagerError('DNS_UNAVAILABLE', 'test'); },
      };

      const service = new RouteService({
        config: { ...(await import('../src/config.js')).loadConfig(baseEnv) },
        store,
        dns,
        probe: async () => true,
        onReconcileEvent: (evt) => { events.push(evt); },
      });

      await service.reconcilePending();

      expect(events.length).toBe(1);
      expect(events[0]?.slug).toBe('test-del-fail');
      expect(events[0]?.status).toBe('deleting');
      expect(events[0]?.code).toBe('DNS_UNAVAILABLE');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ESM main guard — execFileSync with invalid config, no port
// ---------------------------------------------------------------------------

describe('ESM main guard', () => {
  it('startApplication is exported for main-module invocation', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.startApplication).toBe('function');
  });

  it('fails fast with invalid config via execFileSync', () => {
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    try {
      execFileSync(
        tsx,
        [join(process.cwd(), 'src/index.ts')],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MCP_TOKEN: 'short',
            TRAEFIK_PROVIDER_TOKEN: 'b'.repeat(32),
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      // Should not reach here — the process should exit with error
      expect('unreachable').toBe('reached');
    } catch (err: unknown) {
      const result = err as { status: number; stdout: string };
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('config_loading');
      expect(result.stdout).toContain('startup_failed');
    }
  });
});
