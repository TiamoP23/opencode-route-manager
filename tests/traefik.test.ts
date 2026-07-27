import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { RouteRecord } from '../src/domain.js';
import { buildTraefikDocument } from '../src/traefik.js';
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

function activeRoute(slug: string, port: number): RouteRecord {
  return {
    slug, port, description: null, status: 'active',
    cloudflareRecordId: null, lastErrorCode: null, lastErrorMessage: null,
    retryCount: 0, createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('buildTraefikDocument', () => {
  it('projects a single active route', () => {
    const route = activeRoute('demo', 5173);
    expect(buildTraefikDocument([route], config)).toEqual({
      http: {
        routers: {
          'agent-demo': {
            rule: 'Host(`demo.tiamop23.de`)',
            service: 'agent-demo',
            middlewares: ['dev-basic-auth@file'],
          },
        },
        services: {
          'agent-demo': {
            loadBalancer: {
              passHostHeader: true,
              servers: [{ url: 'http://opencode:5173' }],
            },
          },
        },
      },
    });
  });

  it('sorts routes by slug', () => {
    const routes = [
      activeRoute('zeta', 3001),
      activeRoute('alpha', 3000),
    ];
    const doc = buildTraefikDocument(routes, config);
    const routerKeys = Object.keys(doc.http.routers);
    expect(routerKeys).toEqual(['agent-alpha', 'agent-zeta']);
  });

  it('rejects creating route unconditionally', () => {
    const creating = { ...activeRoute('demo', 5173), status: 'creating' as const };
    expect(() => buildTraefikDocument([creating], config)).toThrow(RouteManagerError);
  });

  it('rejects deleting route unconditionally', () => {
    const deleting = { ...activeRoute('demo', 5173), status: 'deleting' as const };
    expect(() => buildTraefikDocument([deleting], config)).toThrow(RouteManagerError);
  });

  it('rejects non-active route with INVALID_SLUG code', () => {
    const creating = { ...activeRoute('demo', 5173), status: 'creating' as const };
    try {
      buildTraefikDocument([creating], config);
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      expect((e as RouteManagerError).code).toBe('INVALID_SLUG');
    }
  });

  it('rejects mixed routes containing a non-active route', () => {
    const routes: RouteRecord[] = [
      activeRoute('alpha', 3000),
      { ...activeRoute('broken', 3001), status: 'creating' as const },
    ];
    expect(() => buildTraefikDocument(routes, config)).toThrow(RouteManagerError);
  });

  it('returns empty projection for empty routes', () => {
    expect(buildTraefikDocument([], config)).toEqual({
      http: { routers: {}, services: {} },
    });
  });

  it('includes multiple active routes', () => {
    const routes = [
      activeRoute('first', 3000),
      activeRoute('second', 3001),
    ];
    const doc = buildTraefikDocument(routes, config);
    expect(Object.keys(doc.http.routers)).toHaveLength(2);
    expect(doc.http.routers['agent-first']).toBeDefined();
    expect(doc.http.routers['agent-second']).toBeDefined();
    expect(doc.http.services['agent-first']).toBeDefined();
    expect(doc.http.services['agent-second']).toBeDefined();
  });
});
