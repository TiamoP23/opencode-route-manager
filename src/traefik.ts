import type { AppConfig } from './config.js';
import type { RouteRecord } from './domain.js';
import { RouteManagerError } from './errors.js';

export interface TraefikOptions {
  rejectNonActive?: boolean;
}

export interface TraefikDocument {
  http: {
    routers: Record<string, {
      rule: string;
      service: string;
      middlewares: string[];
    }>;
    services: Record<string, {
      loadBalancer: {
        passHostHeader: boolean;
        servers: Array<{ url: string }>;
      };
    }>;
  };
}

export function buildTraefikDocument(
  routes: RouteRecord[],
  config: AppConfig,
  options?: TraefikOptions,
): TraefikDocument {
  const routers: TraefikDocument['http']['routers'] = {};
  const services: TraefikDocument['http']['services'] = {};

  const sorted = [...routes].sort((a, b) => a.slug.localeCompare(b.slug));

  for (const route of sorted) {
    if (route.status !== 'active') {
      if (options?.rejectNonActive) {
        throw new RouteManagerError(
          'INVALID_SLUG',
          `route "${route.slug}" is not active (status: ${route.status})`,
        );
      }
      continue;
    }

    const key = `agent-${route.slug}`;

    routers[key] = {
      rule: `Host(\`${route.slug}.${config.publicDomain}\`)`,
      service: key,
      middlewares: [config.middleware],
    };

    services[key] = {
      loadBalancer: {
        passHostHeader: true,
        servers: [{ url: `http://${config.upstreamHost}:${route.port}` }],
      },
    };
  }

  return { http: { routers, services } };
}
