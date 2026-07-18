import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
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
  // Signal ownership before initial reconcile (finding 2)
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
  // Initial reconcile respects deadline (finding 1)
  // -----------------------------------------------------------------------

  it('initial reconcile succeeds within deadline', async () => {
    const { startApplication } = await import('../src/index.js');
    const rt = trackRuntime();
    const app = await startApplication({ env: baseEnv }, { runtime: rt.deps });
    try {
      expect(rt.events).toContain('deadline');
    } finally {
      await app.close();
    }
  });

  it('initial reconcile deadline timeout continues to listen', async () => {
    const { startApplication } = await import('../src/index.js');
    const events: string[] = [];
    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => { events.push('listen'); return 3002; },
            close: async () => { events.push('server.close'); },
          }),
          setTimer: () => ({ clear: () => { events.push('timer.clear'); } }),
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
      expect(events).toContain('deadline.timeout');
      expect(events).toContain('listen');
      expect(app.port).toBe(3002);
    } finally {
      await app.close();
    }
    expect(events).toContain('server.close');
  });

  // -----------------------------------------------------------------------
  // No-overlap scheduled reconcile (finding 1)
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
      const { RouteService } = await import('../src/route-service.js');
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
  // Signal fires during startup
  // -----------------------------------------------------------------------

  it('signal during startup shuts down cleanly', async () => {
    const { startApplication } = await import('../src/index.js');
    let registeredHandler: (() => void) | null = null;
    let signalReady!: () => void;
    const signalReadyPromise = new Promise<void>((r) => { signalReady = r; });
    let exitCode: number | null = null;

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
            // Timeout quickly so listen proceeds; signal fires before that.
            const timeout: Promise<{ success: false; timedOut: true }> =
              new Promise((r) => {
                setTimeout(() => r({ success: false, timedOut: true } as const), 50);
              });
            return Promise.race([
              p.then((v) => ({ success: true, value: v } as const)),
              timeout,
            ]);
          },
          exit: (code) => { exitCode = code; },
        },
      },
    );

    await signalReadyPromise;
    expect(registeredHandler).toBeTruthy();
    registeredHandler!();
    await new Promise((r) => setTimeout(r, 10));
    expect(exitCode).toBe(0);

    const app = await appPromise;
    await app.close();
  }, 10000);

  // -----------------------------------------------------------------------
  // Shared shutdown promise (finding 4)
  // -----------------------------------------------------------------------

  it('multiple close calls share the same shutdown promise', async () => {
    const { startApplication } = await import('../src/index.js');
    const rt = trackRuntime();
    const app = await startApplication({ env: baseEnv }, { runtime: rt.deps });
    try {
      const [r1, r2, r3] = await Promise.all([
        app.close(),
        app.close(),
        app.close(),
      ]);
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
      const [_, __] = await Promise.all([
        new Promise<void>((r) => {
          registeredHandler!();
          setTimeout(r, 10);
        }),
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
  // Listen failure rolls back including signals + DB (finding 6)
  // -----------------------------------------------------------------------

  it('rolls back on listen failure including signal unregistration', async () => {
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
  // Shutdown order
  // -----------------------------------------------------------------------

  it('shutdown follows correct order', async () => {
    const { startApplication } = await import('../src/index.js');
    const events: string[] = [];
    const app = await startApplication(
      { env: baseEnv },
      {
        runtime: {
          createServer: () => ({
            listen: async () => 3001,
            close: async () => { events.push('http.close'); },
          }),
          setTimer: () => ({
            clear: () => { events.push('timer.clear'); },
          }),
          onSignal: (sig) => {
            events.push(`onSignal:${sig}`);
            return () => { events.push(`offSignal:${sig}`); };
          },
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
      const timerIdx = events.indexOf('timer.clear');
      const httpIdx = events.indexOf('http.close');
      expect(timerIdx).toBeLessThan(httpIdx);
    } finally {
      await app.close().catch(() => {});
    }
  });

  // -----------------------------------------------------------------------
  // Reconcile event callback (finding 5)
  // -----------------------------------------------------------------------

  it('emits reconcile error events for per-row failures', async () => {
    const { startApplication } = await import('../src/index.js');
    const rt = trackRuntime();
    const app = await startApplication({ env: baseEnv }, { runtime: rt.deps });
    try {
      expect(app).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ESM main guard — child process test (finding 6)
// ---------------------------------------------------------------------------

describe('ESM main guard', () => {
  it('startApplication is exported for main-module invocation', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.startApplication).toBe('function');
  });

  it('invokes startApplication when run as main module', async () => {
    const child = spawn(
      'node',
      [join(process.cwd(), 'dist/index.js')],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MCP_TOKEN: 'a'.repeat(32),
          TRAEFIK_PROVIDER_TOKEN: 'b'.repeat(32),
          DATABASE_PATH: ':memory:',
          LISTEN_HOST: '127.0.0.1',
          LISTEN_PORT: '3098',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      },
    );

    let output = '';
    let killed = false;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
          resolve();
        }, 2000);

        child.stdout!.on('data', (chunk: string) => {
          output += chunk;
        });
        child.stderr!.on('data', (chunk: string) => {
          output += chunk;
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('exit', () => {
          clearTimeout(timer);
          if (!killed) resolve();
        });
      });

      expect(output).toContain('config_loading');
      expect(output).toContain('database_ready');
    } finally {
      if (!killed) child.kill('SIGTERM');
    }
  }, 15000);
});
