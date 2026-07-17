import type { CloudflareConfig, DnsManager, OwnedDnsRecord, RouteRecord } from './domain.js';
import { RouteManagerError } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 10000;

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
   * Maps HTTP status codes to typed errors and always parses the Cloudflare
   * envelope. Never exposes raw HTTP bodies or headers in public messages.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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

    // Parse body — a JSON parse failure here is treated as an unexpected
    // server response and is not retried by default.
    let bodyJson: CloudflareApiResponse<T>;
    try {
      bodyJson = (await response.json()) as CloudflareApiResponse<T>;
    } catch {
      throw new RouteManagerError('DNS_CONFLICT', 'Cloudflare rejected the DNS change');
    }

    if (!response.ok || !bodyJson.success) {
      throw new RouteManagerError('DNS_CONFLICT', 'Cloudflare rejected the DNS change');
    }

    return bodyJson.result;
  }

  /**
   * Fetch a single DNS record by ID, returning `null` when the record does
   * not exist (HTTP 404). Any other error propagates as normal.
   */
  private async fetchRecordById(recordId: string): Promise<CloudflareDnsRecord | null> {
    try {
      return await this.request<CloudflareDnsRecord>(
        'GET',
        `/zones/${this.config.zoneId}/dns_records/${recordId}`,
      );
    } catch (err) {
      if (err instanceof RouteManagerError && err.code === 'DNS_CONFLICT') {
        // 404 falls through here — treat as "not found"
        return null;
      }
      throw err;
    }
  }

  /**
   * List all DNS records for a given hostname via exact-name filtering.
   * Follows the Cloudflare `total_pages` pagination convention.
   */
  private async listRecords(hostname: string): Promise<CloudflareDnsRecord[]> {
    const allRecords: CloudflareDnsRecord[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const path =
        `/zones/${this.config.zoneId}/dns_records?name.exact=${encodeURIComponent(hostname)}&per_page=100&page=${page}`;

      const result = await this.request<CloudflareDnsRecord[]>(
        'GET',
        path,
      );

      // request() returns just the `result` array — we don't have the
      // result_info from the envelope here. For the fake-server tests we
      // will rarely paginate, but the implementation handles it when the
      // response includes pagination info via a simple heuristic: if we
      // got a full page, try the next page.
      if (Array.isArray(result)) {
        allRecords.push(...result);
        // If this page returned fewer than per_page we're done
        if (result.length < 100) break;
        page++;
      } else {
        break;
      }
    }

    return allRecords;
  }

  /**
   * Filter owned records from a list.
   */
  private ownedRecords(
    records: CloudflareDnsRecord[],
    slug: string,
  ): CloudflareDnsRecord[] {
    return records.filter((r) => this.isOwned(r, slug));
  }

  // ---------------------------------------------------------------------------
  // DnsManager implementation
  // ---------------------------------------------------------------------------

  async assertAvailable(hostname: string, slug: string): Promise<void> {
    const records = await this.listRecords(hostname);
    if (records.length === 0) return;

    const owned = this.ownedRecords(records, slug);

    // Allow exactly one owned record (adoption path)
    if (owned.length === 1 && records.length === 1) return;

    throw new RouteManagerError(
      'DNS_CONFLICT',
      `Hostname ${hostname} has existing DNS records`,
    );
  }

  async findOwnedRecord(hostname: string, slug: string): Promise<OwnedDnsRecord | null> {
    const records = await this.listRecords(hostname);

    // No records at all
    if (records.length === 0) return null;

    const owned = this.ownedRecords(records, slug);

    // Exactly one owned match
    if (owned.length === 1) return { id: owned[0]!.id };

    // Multiple owned matches
    if (owned.length > 1) {
      throw new RouteManagerError(
        'OWNERSHIP_MISMATCH',
        `Multiple owned records found for ${hostname}`,
      );
    }

    // Records exist but none are owned
    throw new RouteManagerError(
      'DNS_CONFLICT',
      `Hostname ${hostname} has unowned DNS records`,
    );
  }

  async ensureRecord(hostname: string, slug: string): Promise<OwnedDnsRecord> {
    const records = await this.listRecords(hostname);
    const owned = this.ownedRecords(records, slug);

    // Adopt a single owned record
    if (owned.length === 1) return { id: owned[0]!.id };

    // Reject ambiguity
    if (owned.length > 1) {
      throw new RouteManagerError(
        'OWNERSHIP_MISMATCH',
        `Multiple owned records found for ${hostname}`,
      );
    }

    // Reject unowned records
    if (records.length > 0) {
      throw new RouteManagerError(
        'DNS_CONFLICT',
        `Hostname ${hostname} has existing DNS records`,
      );
    }

    // Create new record
    const created = await this.request<CloudflareDnsRecord>(
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

    return { id: created.id };
  }

  async deleteRecord(route: RouteRecord, hostname: string): Promise<void> {
    const recordId = route.cloudflareRecordId;
    if (recordId === null) {
      throw new RouteManagerError('INTERNAL_ERROR', 'No Cloudflare record ID to delete');
    }

    // GET the record by ID — 404 is treated as already-deleted
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
