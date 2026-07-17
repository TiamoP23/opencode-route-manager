import type { AppConfig } from './config.js';
import type { RouteRecord } from './domain.js';
import { RouteManagerError } from './errors.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateSlug(slug: string, config: AppConfig): void {
  if (config.reservedSlugs.has(slug)) {
    throw new RouteManagerError('HOSTNAME_RESERVED', `slug "${slug}" is reserved`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new RouteManagerError('INVALID_SLUG', `slug "${slug}" is invalid`);
  }
}

export function validatePort(port: number, config: AppConfig): void {
  if (!Number.isInteger(port) || port < config.minPort || port > config.maxPort) {
    throw new RouteManagerError('INVALID_PORT', `port ${port} is out of range`);
  }
  if (config.deniedPorts.has(port)) {
    throw new RouteManagerError('PORT_DENIED', `port ${port} is denied`);
  }
}

export function assertRouteCapacity(routes: RouteRecord[], config: AppConfig): void {
  if (routes.length >= config.maxRoutes) {
    throw new RouteManagerError('ROUTE_LIMIT_REACHED', `route limit of ${config.maxRoutes} reached`);
  }
}
