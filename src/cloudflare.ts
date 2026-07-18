import type { CloudflareConfig, DnsManager, OwnedDnsRecord, RouteRecord } from './domain.js';
import { RouteManagerError } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

/**
 * Typed HTTP error used internally to distinguish a true HTTP 404 from other
 * Cloudflare API errors. Never exposed to callers.
 */
class CloudflareHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Cloudflare responded with HTTP ${status}`);
    this.name = 'CloudflareHttpError';
    this.status = status;
  }
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string | null;
}

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export class CloudflareDnsManager implements DnsManager {
  private config: CloudflareConfig;
  private baseUrl: string;
  private fetchFn: typeof fetch;
  private timeoutMs: number;

  constructor(
    config: CloudflareConfig,
    opts?: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number },
  ) {
    this.config = config;
    this.baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = opts?.fetch ?? globalThis.fetch;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private ownershipComment(slug: string): string {
    return `opencode-route-manager:${slug}`;
  }

  private isOwned(record: CloudflareDnsRecord, slug: string): boolean {
    return (
      record.type === 'CNAME' &&
      record.content === this.config.cnameTarget &&
      record.comment === this.ownershipComment(slug)
    );
  }

  /**
   * Low-level request against the Cloudflare API.
   * Returns the full parsed envelope so callers can inspect `result_info`
   * for pagination. Never exposes raw HTTP bodies or headers in public
   * messages.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<CloudflareApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiToken}`,
      'Content-Type': 'application/json',
    };

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;

    try {
      response = await this.fetchFn(url, init);
    } catch {
      throw new RouteManagerError('DNS_UNAVAILABLE', 'Cloudflare DNS is temporarily unavailable');
    }

    // Map auth / permission errors
    if (response.status === 401 || response.status === 403) {
      throw new RouteManagerError('CONFIGURATION_ERROR', 'Cloudflare credentials were rejected');
    }

    // Map rate-limit / server errors
    if (response.status === 429 || response.status >= 500) {
      throw new RouteManagerError('DNS_UNAVAILABLE', 'Cloudflare DNS is temporarily unavailable');
    }

    // Any other non-ok status (including 404, 400, 405, etc.) is wrapped in a
    // typed HTTP error so callers can distinguish 404 from other failures.
    if (!response.ok) {
      throw new CloudflareHttpError(response.status);
    }

    // Parse body
    let bodyJson: CloudflareApiResponse<T>;
    try {
      bodyJson = (await response.json()) as CloudflareApiResponse<T>;
    } catch {
      throw new RouteManagerError('DNS_CONFLICT', 'Cloudflare rejected the DNS change');
    }

    // 200-level response with success:false is a Cloudflare-domain error
    if (!bodyJson.success) {
      throw new RouteManagerError('DNS_CONFLICT', 'Cloudflare rejected the DNS change');
    }

    return bodyJson;
  }

  /**
   * Fetch a single DNS record by ID, returning `null` when the record does
   * not exist (HTTP 404 only). All other non-ok HTTP statuses (400, 405,
   * etc.) are converted to DNS_CONFLICT so they surface as typed errors.
   */
  private async fetchRecordById(recordId: string): Promise<CloudflareDnsRecord | null> {
    try {
      const resp = await this.request<CloudflareDnsRecord>(
        'GET',
        `/zones/${this.config.zoneId}/dns_records/${recordId}`,
      );
      return resp.result;
    } catch (err) {
      if (err instanceof CloudflareHttpError) {
        if (err.status === 404) return null; // idempotent absence
        // Any other non-ok HTTP status → DNS_CONFLICT
        throw new RouteManagerError('DNS_CONFLICT', 'Cloudflare rejected the DNS change');
      }
      throw err; // RouteManagerError propagates unchanged
    }
  }

  /**
   * List all DNS records for a given hostname via exact-name filtering.
   * Follows `result_info.total_pages` from the Cloudflare API.
   */
  private async listRecords(hostname: string): Promise<CloudflareDnsRecord[]> {
    const allRecords: CloudflareDnsRecord[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const path =
        `/zones/${this.config.zoneId}/dns_records?name.exact=${encodeURIComponent(hostname)}&per_page=100&page=${page}`;

      const resp = await this.request<CloudflareDnsRecord[]>('GET', path);

      if (Array.isArray(resp.result)) {
        allRecords.push(...resp.result);
      }

      // Use total_pages from the API response for subsequent iterations
      totalPages = Math.max(totalPages, resp.result_info?.total_pages ?? page);
      page++;
    }

    return allRecords;
  }

  /**
   * Return the subset of records that match ownership criteria.
   */
  private ownedRecords(
    records: CloudflareDnsRecord[],
    slug: string,
  ): CloudflareDnsRecord[] {
    return records.filter((r) => this.isOwned(r, slug));
  }

  /**
   * True when the complete exact-name result set consists of exactly one
   * record that is owned. Mixed sets (owned + unowned) are rejected.
   */
  private soleOwnedRecord(
    records: CloudflareDnsRecord[],
    slug: string,
  ): CloudflareDnsRecord | null {
    if (records.length !== 1) return null;
    const candidate = records[0]!;
    return this.isOwned(candidate, slug) ? candidate : null;
  }

  // ---------------------------------------------------------------------------
  // DnsManager implementation
  // ---------------------------------------------------------------------------

  async assertAvailable(hostname: string, slug: string): Promise<void> {
    const records = await this.listRecords(hostname);
    if (records.length === 0) return;

    // Allow only when the complete set is exactly one owned record
    if (this.soleOwnedRecord(records, slug) !== null) return;

    throw new RouteManagerError(
      'DNS_CONFLICT',
      `Hostname ${hostname} has existing DNS records`,
    );
  }

  async findOwnedRecord(hostname: string, slug: string): Promise<OwnedDnsRecord | null> {
    const records = await this.listRecords(hostname);

    if (records.length === 0) return null;

    // Reject mixed sets — the complete result set must be exactly one owned
    // record for findOwnedRecord to return its ID.
    const sole = this.soleOwnedRecord(records, slug);
    if (sole !== null) return { id: sole.id };

    // Multiple owned records
    const owned = this.ownedRecords(records, slug);
    if (owned.length > 1) {
      throw new RouteManagerError(
        'OWNERSHIP_MISMATCH',
        `Multiple owned records found for ${hostname}`,
      );
    }

    // Records exist but none are owned, or they are mixed
    throw new RouteManagerError(
      'DNS_CONFLICT',
      `Hostname ${hostname} has unowned DNS records`,
    );
  }

  async ensureRecord(hostname: string, slug: string): Promise<OwnedDnsRecord> {
    const records = await this.listRecords(hostname);

    // Adopt when the complete set is exactly one owned record
    const sole = this.soleOwnedRecord(records, slug);
    if (sole !== null) return { id: sole.id };

    // Reject ambiguity
    const owned = this.ownedRecords(records, slug);
    if (owned.length > 1) {
      throw new RouteManagerError(
        'OWNERSHIP_MISMATCH',
        `Multiple owned records found for ${hostname}`,
      );
    }

    // Reject any existing records (unowned or mixed)
    if (records.length > 0) {
      throw new RouteManagerError(
        'DNS_CONFLICT',
        `Hostname ${hostname} has existing DNS records`,
      );
    }

    // Create new record
    const resp = await this.request<CloudflareDnsRecord>(
      'POST',
      `/zones/${this.config.zoneId}/dns_records`,
      {
        type: 'CNAME',
        name: hostname,
        content: this.config.cnameTarget,
        proxied: this.config.proxied,
        ttl: 1,
        comment: this.ownershipComment(slug),
      },
    );

    return { id: resp.result.id };
  }

  async deleteRecord(route: RouteRecord, hostname: string): Promise<void> {
    const recordId = route.cloudflareRecordId;
    if (recordId === null) {
      throw new RouteManagerError('INTERNAL_ERROR', 'No Cloudflare record ID to delete');
    }

    // GET the record by ID — only genuine HTTP 404 is treated as
    // already-deleted. 400, 403, 405, etc. all propagate as errors.
    const record = await this.fetchRecordById(recordId);

    if (record === null) {
      // Already gone — idempotent success
      return;
    }

    // Verify every ownership field matches
    if (
      record.id !== recordId ||
      record.name !== hostname ||
      record.type !== 'CNAME' ||
      record.content !== this.config.cnameTarget ||
      record.comment !== this.ownershipComment(route.slug)
    ) {
      throw new RouteManagerError(
        'OWNERSHIP_MISMATCH',
        'DNS record ownership mismatch',
      );
    }

    // Issue DELETE
    await this.request<void>(
      'DELETE',
      `/zones/${this.config.zoneId}/dns_records/${recordId}`,
    );
  }
}
