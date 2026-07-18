import http from 'http';
import type { AddressInfo } from 'net';

export interface RecordedCall {
  method: string;
  path: string;
  /** Query string without leading `?`; empty string when absent. */
  query: string;
  authorization: string | null;
  body: unknown;
}

export interface FakeDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string | null;
}

export interface CloudflareFakeServer {
  url: string;
  calls: readonly RecordedCall[];
  setRecords: (records: FakeDnsRecord[]) => void;
  /** Next single request returns this HTTP status instead of normal handling. */
  setNextError: (status: number) => void;
  /** Override the response for the next list request. */
  setListResponse: (records: FakeDnsRecord[], status?: number) => void;
  /** When a GET-by-ID matches the given recordId, return this HTTP status. */
  setRecordError: (recordId: string, status: number) => void;
  /** Next POST create returns this status (one-shot). */
  setCreateError: (status: number) => void;
  /** Next DELETE returns this status (one-shot). */
  setDeleteError: (status: number) => void;
  destroy: () => Promise<void>;
}

export function createCloudflareServer(initialRecords: FakeDnsRecord[] = []): Promise<CloudflareFakeServer> {
  let records = [...initialRecords];
  const calls: RecordedCall[] = [];
  let nextError: number | null = null;
  let createError: number | null = null;
  let deleteError: number | null = null;
  let listOverride: { records: FakeDnsRecord[]; status?: number | undefined } | null = null;
  const recordErrors: Record<string, number> = {};

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyStr = Buffer.concat(chunks).toString('utf-8');

    const rawUrl = req.url ?? '/';
    const queryIdx = rawUrl.indexOf('?');
    const pathname = queryIdx >= 0 ? rawUrl.slice(0, queryIdx) : rawUrl;
    const queryStr = queryIdx >= 0 ? rawUrl.slice(queryIdx + 1) : '';
    const queryParams = new URLSearchParams(queryStr);

    const auth = (req.headers['authorization'] as string) ?? null;

    calls.push({
      method: req.method ?? 'GET',
      path: pathname,
      query: queryStr,
      authorization: auth,
      body: bodyStr ? JSON.parse(bodyStr) : null,
    });

    res.setHeader('Content-Type', 'application/json');

    // If nextError is set, use it for this request
    if (nextError !== null) {
      const status = nextError;
      nextError = null;
      res.statusCode = status;
      res.end(JSON.stringify({
        success: false,
        errors: [{ code: status, message: http.STATUS_CODES[status] ?? 'Error' }],
        messages: [],
        result: null,
      }));
      return;
    }

    // Parse path: /client/v4/zones/{zoneId}/dns_records[/{id}]
    const match = pathname.match(/^\/client\/v4\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);

    if (!match) {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ code: 1003, message: 'Not found' }], messages: [], result: null }));
      return;
    }

    const recordId = match[2];

    // GET by ID (single record fetch) — may have per-record error overrides
    if (req.method === 'GET' && recordId) {
      const errorStatus = recordErrors[recordId];
      if (errorStatus) {
        res.statusCode = errorStatus;
        res.end(JSON.stringify({
          success: false,
          errors: [{ code: errorStatus, message: http.STATUS_CODES[errorStatus] ?? 'Error' }],
          messages: [],
          result: null,
        }));
        return;
      }

      const record = records.find(r => r.id === recordId);
      if (!record) {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, errors: [{ code: 1003, message: 'Not found' }], messages: [], result: null }));
      } else {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, errors: [], messages: [], result: record }));
      }
      return;
    }

    // List records — support name.exact filtering and pagination
    if (req.method === 'GET' && !recordId) {
      const exactName = queryParams.get('name.exact');
      const source = listOverride ?? { records };
      let filtered = source.records;
      if (exactName) {
        filtered = filtered.filter(r => r.name === exactName);
      }
      listOverride = null;

      const page = Math.max(1, parseInt(queryParams.get('page') ?? '1', 10) || 1);
      const perPage = Math.max(1, parseInt(queryParams.get('per_page') ?? '100', 10) || 100);
      const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
      const start = (page - 1) * perPage;
      const pageRecords = filtered.slice(start, start + perPage);

      res.statusCode = source.status ?? 200;
      res.end(JSON.stringify({
        success: (source.status ?? 200) < 400,
        errors: [],
        messages: [],
        result: pageRecords,
        result_info: {
          page,
          per_page: perPage,
          total_pages: totalPages,
          count: pageRecords.length,
          total_count: filtered.length,
        },
      }));
      return;
    }

    // Create record
    if (req.method === 'POST' && !recordId) {
      if (createError !== null) {
        const status = createError;
        createError = null;
        res.statusCode = status;
        res.end(JSON.stringify({
          success: false,
          errors: [{ code: status, message: http.STATUS_CODES[status] ?? 'Error' }],
          messages: [],
          result: null,
        }));
        return;
      }

      const body = JSON.parse(bodyStr);
      const newRecord: FakeDnsRecord = {
        id: `fake-cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: body.type,
        name: body.name,
        content: body.content,
        proxied: body.proxied ?? false,
        ttl: body.ttl ?? 1,
        comment: body.comment ?? null,
      };
      records.push(newRecord);

      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, errors: [], messages: [], result: newRecord }));
      return;
    }

    // Delete record
    if (req.method === 'DELETE' && recordId) {
      if (deleteError !== null) {
        const status = deleteError;
        deleteError = null;
        res.statusCode = status;
        res.end(JSON.stringify({
          success: false,
          errors: [{ code: status, message: http.STATUS_CODES[status] ?? 'Error' }],
          messages: [],
          result: null,
        }));
        return;
      }

      const idx = records.findIndex(r => r.id === recordId);
      if (idx >= 0) {
        records.splice(idx, 1);
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, errors: [], messages: [], result: { id: recordId } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, errors: [{ code: 1003, message: 'Not found' }], messages: [], result: null }));
      }
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ success: false, errors: [{ code: 1003, message: 'Method not allowed' }], messages: [], result: null }));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}/client/v4`;

      resolve({
        url,
        calls,
        setRecords(newRecords: FakeDnsRecord[]) {
          records = [...newRecords];
        },
        setNextError(status: number) {
          nextError = status;
        },
        setListResponse(overrideRecords: FakeDnsRecord[], status?: number) {
          listOverride = { records: overrideRecords, status };
        },
        setRecordError(recordId: string, status: number) {
          recordErrors[recordId] = status;
        },
        setCreateError(status: number) {
          createError = status;
        },
        setDeleteError(status: number) {
          deleteError = status;
        },
        destroy: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
      });
    });
    server.on('error', reject);
  });
}
