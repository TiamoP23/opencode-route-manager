import type { CloudflareConfig } from './domain.js';

export interface AppConfig {
  listenHost: string;
  listenPort: number;
  databasePath: string;
  upstreamHost: string;
  publicDomain: string;
  middleware: string;
  minPort: number;
  maxPort: number;
  deniedPorts: ReadonlySet<number>;
  reservedSlugs: ReadonlySet<string>;
  maxRoutes: number;
  probeTimeoutMs: number;
  cloudflareTimeoutMs: number;
  mcpToken: string;
  traefikProviderToken: string;
  cloudflare: CloudflareConfig | null;
}

function parseBoundedInt(
  env: Record<string, string | undefined>,
  key: string,
  def: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${key}=${raw} must be an integer between ${min} and ${max}`);
  }
  const val = Number(raw);
  if (!Number.isInteger(val) || val < min || val > max) {
    throw new Error(`${key}=${raw} must be an integer between ${min} and ${max}`);
  }
  return val;
}

function parseBoolean(env: Record<string, string | undefined>, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${key}=${raw} must be 'true', 'false', '1', or '0'`);
}

function parseLowercaseSet(
  env: Record<string, string | undefined>,
  key: string,
  def: string,
): string[] {
  const raw = env[key];
  const src = raw ?? def;
  return src.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function validatePortSet(members: string[]): number[] {
  return members.map((m) => {
    if (!/^\d+$/.test(m)) {
      throw new Error(`DENIED_PORTS member "${m}" is not a valid port number`);
    }
    const port = Number(m);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`DENIED_PORTS member "${m}" is not a valid port number`);
    }
    return port;
  });
}

/** Allowed token characters: alphanumeric, underscore, hyphen. */
const TOKEN_RE = /^[a-zA-Z0-9_-]+$/;

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const mcpToken = env['MCP_TOKEN'] ?? '';
  const traefikProviderToken = env['TRAEFIK_PROVIDER_TOKEN'] ?? '';

  if (mcpToken.length < 32) {
    throw new Error('MCP_TOKEN must be at least 32 characters');
  }
  if (!TOKEN_RE.test(mcpToken)) {
    throw new Error('MCP_TOKEN contains invalid characters (only a-zA-Z0-9, underscore, hyphen allowed)');
  }
  if (traefikProviderToken.length < 32) {
    throw new Error('TRAEFIK_PROVIDER_TOKEN must be at least 32 characters');
  }
  if (!TOKEN_RE.test(traefikProviderToken)) {
    throw new Error('TRAEFIK_PROVIDER_TOKEN contains invalid characters (only a-zA-Z0-9, underscore, hyphen allowed)');
  }
  if (mcpToken === traefikProviderToken) {
    throw new Error('MCP_TOKEN and TRAEFIK_PROVIDER_TOKEN must be different');
  }

  const cloudflareZoneId = env['CLOUDFLARE_ZONE_ID'];
  const cloudflareApiToken = env['CLOUDFLARE_API_TOKEN'];
  const cloudflareCnameTarget = env['CLOUDFLARE_CNAME_TARGET'];
  const cloudflareProxied = parseBoolean(env, 'CLOUDFLARE_PROXIED', true);

  const cfProvided = [cloudflareZoneId, cloudflareApiToken, cloudflareCnameTarget]
    .filter((v) => v !== undefined && v !== '').length;

  if (cfProvided > 0 && cfProvided < 3) {
    throw new Error('Cloudflare configuration requires all three of CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN, and CLOUDFLARE_CNAME_TARGET');
  }

  let cloudflare: CloudflareConfig | null = null;
  if (cloudflareZoneId && cloudflareApiToken && cloudflareCnameTarget) {
    cloudflare = {
      zoneId: cloudflareZoneId,
      apiToken: cloudflareApiToken,
      cnameTarget: cloudflareCnameTarget,
      proxied: cloudflareProxied,
    };
  }

  const minPort = parseBoundedInt(env, 'MIN_PORT', 1024, 1, 65535);
  const maxPort = parseBoundedInt(env, 'MAX_PORT', 65535, 1, 65535);
  if (minPort > maxPort) {
    throw new Error(`MIN_PORT=${minPort} must not exceed MAX_PORT=${maxPort}`);
  }

  return {
    listenHost: env['LISTEN_HOST'] ?? '0.0.0.0',
    listenPort: parseBoundedInt(env, 'LISTEN_PORT', 3000, 1, 65535),
    databasePath: env['DATABASE_PATH'] ?? '/data/routes.sqlite',
    upstreamHost: env['UPSTREAM_HOST'] ?? 'opencode',
    publicDomain: env['PUBLIC_DOMAIN'] ?? 'tiamop23.de',
    middleware: env['TRAEFIK_MIDDLEWARE'] ?? 'dev-basic-auth@file',
    minPort,
    maxPort,
    deniedPorts: new Set(validatePortSet(parseLowercaseSet(env, 'DENIED_PORTS', '4096'))),
    reservedSlugs: new Set(parseLowercaseSet(env, 'RESERVED_SLUGS', 'opencode,code,auth,traefik,dockge,grafana')),
    maxRoutes: parseBoundedInt(env, 'MAX_ROUTES', 32, 1, 1000),
    probeTimeoutMs: parseBoundedInt(env, 'PROBE_TIMEOUT_MS', 1000, 100, 60000),
    cloudflareTimeoutMs: parseBoundedInt(env, 'CLOUDFLARE_TIMEOUT_MS', 5000, 100, 60000),
    mcpToken,
    traefikProviderToken,
    cloudflare,
  };
}
