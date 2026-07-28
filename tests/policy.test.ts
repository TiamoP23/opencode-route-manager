import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { RouteRecord } from '../src/domain.js';
import { validateSlug, validatePort, assertRouteCapacity } from '../src/policy.js';
import { RouteManagerError } from '../src/errors.js';

const config: AppConfig = {
  listenHost: '0.0.0.0',
  listenPort: 3000,
  databasePath: '/data/routes.sqlite',
  upstreamHost: 'opencode',
  publicDomain: 'tiamop23.de',
  middleware: 'dev-basic-auth@file',
  managedBasicAuth: null,
  minPort: 1024,
  maxPort: 65535,
  deniedPorts: new Set([4096]),
  reservedSlugs: new Set(['opencode', 'code', 'auth', 'traefik', 'dockge', 'grafana']),
  maxRoutes: 32,
  probeTimeoutMs: 1000,
  cloudflareTimeoutMs: 5000,
  mcpToken: 'm'.repeat(32),
  traefikProviderToken: 't'.repeat(32),
  cloudflare: null,
};

describe('validateSlug', () => {
  it('accepts single-letter slug', () => {
    expect(() => validateSlug('a', config)).not.toThrow();
  });

  it('accepts slug with digits and hyphens', () => {
    expect(() => validateSlug('vite-1', config)).not.toThrow();
  });

  it('accepts 63-character slug', () => {
    const slug = 'a' + 'b'.repeat(61) + 'c';
    expect(slug).toHaveLength(63);
    expect(() => validateSlug(slug, config)).not.toThrow();
  });

  it('rejects uppercase letters', () => {
    expect(() => validateSlug('Demo', config)).toThrow(RouteManagerError);
    try { validateSlug('Demo', config); } catch (e: unknown) {
      expect((e as RouteManagerError).code).toBe('INVALID_SLUG');
    }
  });

  it('rejects dots in slug', () => {
    expect(() => validateSlug('demo.app', config)).toThrow(RouteManagerError);
  });

  it('rejects leading hyphen', () => {
    expect(() => validateSlug('-demo', config)).toThrow(RouteManagerError);
  });

  it('rejects trailing hyphen', () => {
    expect(() => validateSlug('demo-', config)).toThrow(RouteManagerError);
  });

  it('rejects 64-character slug', () => {
    const slug = 'a' + 'b'.repeat(62) + 'c';
    expect(slug).toHaveLength(64);
    expect(() => validateSlug(slug, config)).toThrow(RouteManagerError);
  });

  it('rejects reserved slug', () => {
    expect(() => validateSlug('opencode', config)).toThrow(RouteManagerError);
    try { validateSlug('opencode', config); } catch (e: unknown) {
      expect((e as RouteManagerError).code).toBe('HOSTNAME_RESERVED');
    }
  });

  it('rejects empty slug', () => {
    expect(() => validateSlug('', config)).toThrow(RouteManagerError);
  });

  it('rejects slug with underscore', () => {
    expect(() => validateSlug('demo_slug', config)).toThrow(RouteManagerError);
  });
});

describe('validatePort', () => {
  it('accepts port within range and not denied', () => {
    expect(() => validatePort(5173, config)).not.toThrow();
  });

  it('rejects port below minPort', () => {
    expect(() => validatePort(23, config)).toThrow(RouteManagerError);
    try { validatePort(23, config); } catch (e: unknown) {
      expect((e as RouteManagerError).code).toBe('INVALID_PORT');
    }
  });

  it('rejects port above maxPort', () => {
    expect(() => validatePort(65536, config)).toThrow(RouteManagerError);
  });

  it('rejects denied port', () => {
    expect(() => validatePort(4096, config)).toThrow(RouteManagerError);
    try { validatePort(4096, config); } catch (e: unknown) {
      expect((e as RouteManagerError).code).toBe('PORT_DENIED');
    }
  });

  it('rejects port 0', () => {
    expect(() => validatePort(0, config)).toThrow(RouteManagerError);
  });

  it('rejects negative port', () => {
    expect(() => validatePort(-1, config)).toThrow(RouteManagerError);
  });
});

describe('assertRouteCapacity', () => {
  it('allows routes below maxRoutes', () => {
    const routes: RouteRecord[] = Array.from({ length: 31 }, (_, i) => ({
      slug: `r${i}`, port: 3000 + i, description: null, status: 'active',
      cloudflareRecordId: null, lastErrorCode: null, lastErrorMessage: null,
      retryCount: 0, createdAt: new Date(), updatedAt: new Date(),
    }));
    expect(() => assertRouteCapacity(routes, config)).not.toThrow();
  });

  it('rejects routes at exactly maxRoutes', () => {
    const routes: RouteRecord[] = Array.from({ length: 32 }, (_, i) => ({
      slug: `r${i}`, port: 3000 + i, description: null, status: 'active',
      cloudflareRecordId: null, lastErrorCode: null, lastErrorMessage: null,
      retryCount: 0, createdAt: new Date(), updatedAt: new Date(),
    }));
    expect(() => assertRouteCapacity(routes, config)).toThrow(RouteManagerError);
    try { assertRouteCapacity(routes, config); } catch (e: unknown) {
      expect((e as RouteManagerError).code).toBe('ROUTE_LIMIT_REACHED');
    }
  });

  it('allows empty routes array', () => {
    expect(() => assertRouteCapacity([], config)).not.toThrow();
  });
});
