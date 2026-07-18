import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Startup / index tests
// ---------------------------------------------------------------------------

describe('startup runtime', () => {
  // Valid base env — DATABASE_PATH=:memory: and noListen=true prevent I/O
  // and port conflicts during testing.
  const baseEnv: Record<string, string> = {
    MCP_TOKEN: 'a'.repeat(32),
    TRAEFIK_PROVIDER_TOKEN: 'b'.repeat(32),
    DATABASE_PATH: ':memory:',
    LISTEN_HOST: '127.0.0.1',
    LISTEN_PORT: '3001',
  };

  // -----------------------------------------------------------------------
  // Existence
  // -----------------------------------------------------------------------

  it('exports startApplication function', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.startApplication).toBe('function');
  });

  // -----------------------------------------------------------------------
  // Config validation propagates
  // -----------------------------------------------------------------------

  it('rejects config with short MCP_TOKEN', async () => {
    const { startApplication } = await import('../src/index.js');
    const env = { ...baseEnv, MCP_TOKEN: 'short' };
    await expect(startApplication({ env, noListen: true })).rejects.toThrow(
      /MCP_TOKEN/,
    );
  });

  it('rejects config with short provider token', async () => {
    const { startApplication } = await import('../src/index.js');
    const env = { ...baseEnv, TRAEFIK_PROVIDER_TOKEN: 'tiny' };
    await expect(startApplication({ env, noListen: true })).rejects.toThrow(
      /TRAEFIK_PROVIDER_TOKEN/,
    );
  });

  it('rejects config with same tokens', async () => {
    const { startApplication } = await import('../src/index.js');
    const env = {
      ...baseEnv,
      MCP_TOKEN: 'abcdefghijklmnopqrstuvwxyz012345',
      TRAEFIK_PROVIDER_TOKEN: 'abcdefghijklmnopqrstuvwxyz012345',
    };
    await expect(startApplication({ env, noListen: true })).rejects.toThrow(
      /must be different/,
    );
  });

  // -----------------------------------------------------------------------
  // Clean start / stop
  // -----------------------------------------------------------------------

  it('starts and stops cleanly with in-memory SQLite', async () => {
    const { startApplication } = await import('../src/index.js');
    const app = await startApplication({ env: baseEnv, noListen: true });
    expect(app).toBeDefined();
    expect(typeof app.close).toBe('function');
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Reconciliation runs once on startup
  // -----------------------------------------------------------------------

  it('runs reconcilePending once on startup', async () => {
    const { startApplication } = await import('../src/index.js');
    let reconcileCount = 0;

    const app = await startApplication({
      env: baseEnv,
      noListen: true,
      onReconcile: () => {
        reconcileCount++;
      },
    });

    // The initial reconciliation is fire-and-forget; give it a moment
    await new Promise((r) => setTimeout(r, 100));
    expect(reconcileCount).toBeGreaterThanOrEqual(1);
    await app.close();
  });
});
