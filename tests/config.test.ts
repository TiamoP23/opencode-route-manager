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

  it('rejects non-integer values in port variables', () => {
    expect(() => loadConfig({ ...required, LISTEN_PORT: '3000junk' })).toThrow(/LISTEN_PORT/);
    expect(() => loadConfig({ ...required, LISTEN_PORT: '1.5' })).toThrow(/LISTEN_PORT/);
    expect(() => loadConfig({ ...required, LISTEN_PORT: '' })).toThrow(/LISTEN_PORT/);
  });

  it('rejects invalid DENIED_PORTS members', () => {
    expect(() => loadConfig({ ...required, DENIED_PORTS: 'abc' })).toThrow(/DENIED_PORTS/);
    expect(() => loadConfig({ ...required, DENIED_PORTS: '4096,abc' })).toThrow(/DENIED_PORTS/);
    expect(() => loadConfig({ ...required, DENIED_PORTS: '0' })).toThrow(/DENIED_PORTS/);
    expect(() => loadConfig({ ...required, DENIED_PORTS: '70000' })).toThrow(/DENIED_PORTS/);
    expect(() => loadConfig({ ...required, DENIED_PORTS: '1.5' })).toThrow(/DENIED_PORTS/);
  });

  it('rejects MIN_PORT > MAX_PORT', () => {
    expect(() => loadConfig({ ...required, MIN_PORT: '30000', MAX_PORT: '20000' })).toThrow(/MIN_PORT.*MAX_PORT/i);
  });

  it('accepts MIN_PORT === MAX_PORT', () => {
    const config = loadConfig({ ...required, MIN_PORT: '5000', MAX_PORT: '5000' });
    expect(config.minPort).toBe(5000);
    expect(config.maxPort).toBe(5000);
  });

  it('rejects invalid CLOUDFLARE_PROXIED values', () => {
    expect(() => loadConfig({ ...required, CLOUDFLARE_ZONE_ID: 'z', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_CNAME_TARGET: 'c', CLOUDFLARE_PROXIED: 'yes' })).toThrow(/CLOUDFLARE_PROXIED/);
    expect(() => loadConfig({ ...required, CLOUDFLARE_ZONE_ID: 'z', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_CNAME_TARGET: 'c', CLOUDFLARE_PROXIED: 'no' })).toThrow(/CLOUDFLARE_PROXIED/);
  });

  // -----------------------------------------------------------------------
  // Token character validation (finding 7)
  // -----------------------------------------------------------------------

  it('rejects MCP_TOKEN containing whitespace', () => {
    expect(() =>
      loadConfig({ ...required, MCP_TOKEN: 'abc def ' + 'x'.repeat(23) }),
    ).toThrow(/MCP_TOKEN/);
  });

  it('rejects MCP_TOKEN with special characters', () => {
    expect(() =>
      loadConfig({ ...required, MCP_TOKEN: 'abc!def' + 'x'.repeat(25) }),
    ).toThrow(/MCP_TOKEN/);
  });

  it('rejects MCP_TOKEN with non-ASCII characters', () => {
    expect(() =>
      loadConfig({ ...required, MCP_TOKEN: 'abcñde' + 'x'.repeat(26) }),
    ).toThrow(/MCP_TOKEN/);
  });

  it('accepts tokens with underscores and hyphens', () => {
    const token = 'a_b-c_def-ghi_jkl-mno_pqr-stu_1234';
    expect(token.length).toBeGreaterThanOrEqual(32);
    const config = loadConfig({ ...required, MCP_TOKEN: token });
    expect(config.mcpToken).toBe(token);
  });

  it('rejects TRAEFIK_PROVIDER_TOKEN containing whitespace', () => {
    expect(() =>
      loadConfig({ ...required, TRAEFIK_PROVIDER_TOKEN: 'ab cd' + 'x'.repeat(28) }),
    ).toThrow(/TRAEFIK_PROVIDER_TOKEN/);
  });
});
