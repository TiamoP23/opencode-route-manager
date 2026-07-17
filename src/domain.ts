export type RouteStatus = 'creating' | 'active' | 'deleting';

export interface RouteRecord {
  slug: string;
  port: number;
  description: string | null;
  status: RouteStatus;
  cloudflareRecordId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublishInput { slug: string; port: number; description?: string | null }
export interface UpdateInput { slug: string; port?: number; description?: string | null }
export interface CloudflareConfig { zoneId: string; apiToken: string; cnameTarget: string; proxied: boolean }
export type PortProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;
export interface OwnedDnsRecord { id: string }
export interface DnsManager {
  assertAvailable(hostname: string, slug: string): Promise<void>;
  findOwnedRecord(hostname: string, slug: string): Promise<OwnedDnsRecord | null>;
  ensureRecord(hostname: string, slug: string): Promise<OwnedDnsRecord>;
  deleteRecord(route: RouteRecord, hostname: string): Promise<void>;
}
export interface ToolError { code: string; message: string; retryable: boolean }
