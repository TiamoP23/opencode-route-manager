import type { ToolError } from './domain.js';

export type RouteErrorCode =
  | 'INVALID_SLUG'
  | 'INVALID_PORT'
  | 'PORT_DENIED'
  | 'PORT_UNREACHABLE'
  | 'ROUTE_LIMIT_REACHED'
  | 'HOSTNAME_RESERVED'
  | 'ROUTE_ALREADY_EXISTS'
  | 'ROUTE_NOT_FOUND'
  | 'ROUTE_BUSY'
  | 'DNS_UNAVAILABLE'
  | 'DNS_CONFLICT'
  | 'OWNERSHIP_MISMATCH'
  | 'CONFIGURATION_ERROR'
  | 'INTERNAL_ERROR';

const retryableMap: Record<RouteErrorCode, boolean> = {
  INVALID_SLUG: false,
  INVALID_PORT: false,
  PORT_DENIED: false,
  PORT_UNREACHABLE: true,
  ROUTE_LIMIT_REACHED: false,
  HOSTNAME_RESERVED: false,
  ROUTE_ALREADY_EXISTS: false,
  ROUTE_NOT_FOUND: false,
  ROUTE_BUSY: true,
  DNS_UNAVAILABLE: true,
  DNS_CONFLICT: false,
  OWNERSHIP_MISMATCH: false,
  CONFIGURATION_ERROR: false,
  INTERNAL_ERROR: true,
};

export class RouteManagerError extends Error {
  public readonly code: RouteErrorCode;
  public readonly retryable: boolean;

  constructor(code: RouteErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'RouteManagerError';
    this.code = code;
    this.retryable = retryableMap[code] ?? false;
  }
}

export function errorResult(error: unknown): ToolError {
  if (error instanceof RouteManagerError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { code: 'INTERNAL_ERROR', message, retryable: true };
}
