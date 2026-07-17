import http from 'http';
import type { AddressInfo } from 'net';

export interface RecordedCall {
  method: string;
  path: string;
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
  setNextError: (status: number) => void;
  setListResponse: (records: FakeDnsRecord[], status?: number) => void;
  destroy: () => Promise<void>;
}

export function createCloudflareServer(initialRecords: FakeDnsRecord[] = []): Promise<CloudflareFakeServer> {
  let records = [...initialRecords];
  const calls: RecordedCall[] = [];
  let nextError: number | null = null;
  let listOverride: { records: FakeDnsRecord[]; status?: number | undefined } | null = null;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyStr = Buffer.concat(chunks).toString('utf-8');

    const path = req.url ?? '/';
    const queryIdx = path.indexOf('?');
    const pathname = queryIdx >= 0 ? path.slice(0, queryIdx) : path;
    const queryStr = queryIdx >= 0 ? path.slice(queryIdx) : '';
    const queryParams = new URLSearchParams(queryStr);

    const auth = (req.headers['authorization'] as string) ?? null;

    calls.push({
      method: req.method ?? 'GET',
      path: pathname,
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

    if (req.method === 'GET' && !recordId) {
      // List records - support name.exact filtering
      const exactName = queryParams.get('name.exact');
      const source = listOverride ?? { records };
      let filtered = source.records;
      if (exactName) {
        filtered = filtered.filter(r => r.name === exactName);
      }
      listOverride = null;

      res.statusCode = source.status ?? 200;
      res.end(JSON.stringify({
        success: (source.status ?? 200) < 400,
        errors: [],
        messages: [],
        result: filtered,
        result_info: {
          page: 1,
          per_page: 100,
          total_pages: 1,
          count: filtered.length,
          total_count: filtered.length,
        },
      }));
    } else if (req.method === 'GET' && recordId) {
      // Get by ID
      const record = records.find(r => r.id === recordId);
      if (!record) {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, errors: [{ code: 1003, message: 'Not found' }], messages: [], result: null }));
      } else {
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, errors: [], messages: [], result: record }));
      }
    } else if (req.method === 'POST' && !recordId) {
      // Create record
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
    } else if (req.method === 'DELETE' && recordId) {
      const idx = records.findIndex(r => r.id === recordId);
      if (idx >= 0) {
        records.splice(idx, 1);
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, errors: [], messages: [], result: { id: recordId } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, errors: [{ code: 1003, message: 'Not found' }], messages: [], result: null }));
      }
    } else {
      res.statusCode = 405;
      res.end(JSON.stringify({ success: false, errors: [{ code: 1003, message: 'Method not allowed' }], messages: [], result: null }));
    }
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
        destroy: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
      });
    });
    server.on('error', reject);
  });
}
