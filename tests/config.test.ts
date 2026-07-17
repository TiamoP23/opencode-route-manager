import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const required = {
  MCP_TOKEN: 'm'.repeat(32),
  TRAEFIK_PROVIDER_TOKEN: 't'.repeat(32),
};

describe('loadConfig', () => {
  it('loads secure defaults', () => {
    const config = loadConfig(required);
    expect(config).toMatchObject({
      listenHost: '0.0.0.0', listenPort: 3000,
      databasePath: '/data/routes.sqlite', upstreamHost: 'opencode',
      publicDomain: 'tiamop23.de', middleware: 'dev-basic-auth@file',
      minPort: 1024, maxPort: 65535, maxRoutes: 32,
      probeTimeoutMs: 1000, cloudflareTimeoutMs: 5000,
    });
    expect(config.deniedPorts.has(4096)).toBe(true);
    expect(config.cloudflare).toBeNull();
  });

  it('requires different 32-character control tokens', () => {
    expect(() => loadConfig({ ...required, MCP_TOKEN: 'short' })).toThrow(/MCP_TOKEN/);
    expect(() => loadConfig({ ...required, TRAEFIK_PROVIDER_TOKEN: required.MCP_TOKEN })).toThrow(/different/);
  });

  it('rejects partial Cloudflare configuration', () => {
    expect(() => loadConfig({ ...required, CLOUDFLARE_ZONE_ID: 'zone' })).toThrow(/Cloudflare/);
  });

  it('loads complete Cloudflare configuration', () => {
    const config = loadConfig({
      ...required,
      CLOUDFLARE_ZONE_ID: 'zone',
      CLOUDFLARE_API_TOKEN: 'secret',
      CLOUDFLARE_CNAME_TARGET: 'opencode.tiamop23.de',
    });
    expect(config.cloudflare).toEqual({
      zoneId: 'zone', apiToken: 'secret',
      cnameTarget: 'opencode.tiamop23.de', proxied: true,
    });
  });
});
