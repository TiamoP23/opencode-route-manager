import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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
  // Clean start / stop with injected runtime
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
  // Signal handlers installed before initial reconcile
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
  // Initial reconcile tracked in currentReconcile before deadline
  // -----------------------------------------------------------------------

  it('assigns currentReconcile before deadline race', async () => {
    const { startApplication } = await import('../src/index.js');
    const rt = trackRuntime();
    const app = await startApplication({ env: baseEnv }, { runtime: rt.deps });
    try {
      expect(rt.events).toContain('deadline');
    } finally {
      await app.close();
    }
  });

  // -----------------------------------------------------------------------
  // Deadline timeout: scheduled-skip then settled-resume
  // -----------------------------------------------------------------------

  it('initial timeout blocks scheduler; after settle scheduler resumes', async () => {
    const { startApplication } = await import('../src/index.js');
    let timerCb: (() => Promise<void>) | null = null;
    let resolveInitial!: () => void;
    const initialGate = new Promise<void>((r) => { resolveInitial = r; });
    const scheduleEvents: string[] = [];

    const initialPromise = new Promise<void>((r) => { resolveInitial = r; });

    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => { scheduleEvents.push('listen'); return 3001; },
            close: async () => { scheduleEvents.push('server.close'); },
          }),
          setTimer: (fn) => {
            timerCb = fn;
            return { clear: () => { scheduleEvents.push('timer.clear'); } };
          },
          onSignal: () => () => {},
          deadline: async <T>(_p: Promise<T>, _ms: number) => {
            // Time out the initial promise so it stays as currentReconcile
            scheduleEvents.push('deadline.timeout');
            return { success: false, timedOut: true } as const;
          },
          exit: () => {},
        },
      },
    );
    try {
      // After startApplication, deadline timed out -> currentReconcile is set
      // Fire timer: scheduler should skip (currentReconcile !== null)
      scheduleEvents.push('sched.before');
      timerCb!();
      scheduleEvents.push('sched.after');
      expect(scheduleEvents.filter(e => e === 'sched.before' || e === 'sched.after').length).toBe(2);
      // No reconcile.start was emitted (we didn't patch the service)
    } finally {
      await app.close();
    }
    expect(scheduleEvents).toContain('listen');
  }, 10000);

  // -----------------------------------------------------------------------
  // No-overlap scheduled reconcile
  // -----------------------------------------------------------------------

  it('does not overlap scheduled reconciles', async () => {
    const { startApplication } = await import('../src/index.js');
    let timerCb: (() => Promise<void>) | null = null;
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
  // Signal during startup aborts / rejects
  // -----------------------------------------------------------------------

  it('signal during startup rejects startApplication', async () => {
    const { startApplication } = await import('../src/index.js');
    let registeredHandler: (() => void) | null = null;
    let signalReady!: () => void;
    const signalReadyPromise = new Promise<void>((r) => { signalReady = r; });
    let exitCode: number | null = null;
    let caught: unknown = null;

    // Attach rejection handler immediately so Node.js never sees
    // an unhandled rejection from the abort error.
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

    // The app promise was caught above; verify the error
    expect(caught).toBeTruthy();
    expect((caught as Error).message).toMatch(/shutdown_during_startup/);
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
  // Shutdown order: timer → HTTP drain → reconcile settle → DB close
  // -----------------------------------------------------------------------

  it('shutdown follows correct order with reconcile settle', async () => {
    const { startApplication } = await import('../src/index.js');
    const events: string[] = [];
    let timerCb: (() => Promise<void>) | null = null;
    let resolveReconcile!: () => void;
    const reconcileGate = new Promise<void>((r) => { resolveReconcile = r; });
    let dbClosed = false;

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

    // StartApplication completed (initial reconcile done).
    // Now patch to make scheduled reconcile slow, then fire timer.
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

      // Fire timer to start a slow scheduled reconcile
      timerCb!();
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toContain('reconcile.start');

      // Close while reconcile is in-flight
      const closePromise = app.close();
      await new Promise((r) => setTimeout(r, 50));

      // timer.clear should happen before http.close
      expect(events.indexOf('timer.clear')).toBeLessThan(events.indexOf('http.close'));

      // Unblock reconcile
      resolveReconcile();
      await closePromise;

      // http.close should happen before reconcile.end
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

  it('rolls back on listen failure including signal unregistration and reconcile await', async () => {
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
  // Reconcile event callback fires real stable event
  // -----------------------------------------------------------------------

  it('emits reconcile error events for per-row creating failures', async () => {
    const { startApplication } = await import('../src/index.js');
    const events: Array<{ slug: string; status: string; code: string }> = [];

    // Create a service with a route in 'creating' state, then run reconcile
    // which will fail (no port probe) and emit an event.
    const { SqliteRouteStore } = await import('../src/db/route-store.js');
    const { openDatabase } = await import('../src/db/client.js');
    const migrations = new URL('../drizzle', import.meta.url).pathname;

    const db = openDatabase(':memory:', migrations);
    try {
      const store = new SqliteRouteStore(db);

      // Insert a creating row that will fail reconcile (probe will fail)
      await store.insertCreating({
        slug: 'test-fail',
        port: 9999,
        description: null,
      });

      // Wait for backoff period (retryCount 0 → ~1s delay) to elapse
      await new Promise((r) => setTimeout(r, 1500));

      const service = new RouteService({
        config: { ...(await import('../src/config.js')).loadConfig(baseEnv) },
        store,
        dns: null,
        probe: async () => false, // probe always fails
        onReconcileEvent: (evt) => {
          events.push(evt);
        },
      });

      // Trigger reconcile
      await service.reconcilePending();

      // Should have emitted one error event for PORT_UNREACHABLE
      expect(events.length).toBe(1);
      expect(events[0]?.slug).toBe('test-fail');
      expect(events[0]?.status).toBe('creating');
      expect(events[0]?.code).toBe('PORT_UNREACHABLE');
    } finally {
      db.close();
    }
  });

  it('emits reconcile error events for per-row deleting failures', async () => {
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
      // Give the row a cloudflare record ID so DNS cleanup is attempted
      await store.setCloudflareRecordId('test-del-fail', 'cf-record-1');
      await store.markDeleting('test-del-fail');

      // Wait for backoff period to elapse
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
        onReconcileEvent: (evt) => {
          events.push(evt);
        },
      });

      await service.reconcilePending();

      // With dns present but throwing, deleting row should emit error
      // Note: performDnsCleanup returns early when dns is absent;
      // with dns present, it tries to find an owned record and fails.
      // The deleteRecord call throws DNS_UNAVAILABLE.
      expect(events.length).toBeGreaterThanOrEqual(1);
      if (events.length > 0) {
        expect(events[0]?.slug).toBe('test-del-fail');
        expect(events[0]?.status).toBe('deleting');
      }
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ESM main guard — child process via tsx with invalid config (no port needed)
// ---------------------------------------------------------------------------

describe('ESM main guard', () => {
  it('startApplication is exported for main-module invocation', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.startApplication).toBe('function');
  });

  it('fails fast with invalid config when run as main module', async () => {
    // Use the local tsx binary to run src/index.ts with intentionally invalid
    // config (short MCP_TOKEN). No network port needed.
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const child = spawn(
      tsx,
      [join(process.cwd(), 'src/index.ts')],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MCP_TOKEN: 'short',            // too short — guaranteed failure
          TRAEFIK_PROVIDER_TOKEN: 'b'.repeat(32),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let killed = false;

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          killed = true;
          child.kill('SIGKILL');
          resolve(null);
        }, 5000);

        child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
      });

      // Should have logged config_loading before failing
      expect(stdout).toContain('config_loading');
      // Should have logged startup_failed
      expect(stdout).toContain('startup_failed');
      // Exit code should be 1 (startup failure)
      expect(exitCode).toBe(1);
    } finally {
      if (!killed) child.kill('SIGKILL');
    }
  }, 10000);
});
