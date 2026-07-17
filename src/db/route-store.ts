import type { RouteRecord, RouteStatus } from '../domain.js';
import { RouteManagerError } from '../errors.js';
import type { DatabaseContext } from './client.js';

interface RouteRow {
  slug: string;
  port: number;
  description: string | null;
  status: string;
  cloudflare_record_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  retry_count: number;
  created_at: number;
  updated_at: number;
}

function rowToRecord(row: RouteRow): RouteRecord {
  return {
    slug: row.slug,
    port: row.port,
    description: row.description,
    status: row.status as RouteStatus,
    cloudflareRecordId: row.cloudflare_record_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    retryCount: row.retry_count,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const ROUTE_NOT_FOUND = new RouteManagerError('ROUTE_NOT_FOUND', 'route not found');

export interface RouteStore {
  count(): Promise<number>;
  get(slug: string): Promise<RouteRecord | null>;
  list(): Promise<RouteRecord[]>;
  listActive(): Promise<RouteRecord[]>;
  listPending(): Promise<RouteRecord[]>;
  insertCreating(input: { slug: string; port: number; description: string | null }): Promise<RouteRecord>;
  activate(slug: string, recordId: string | null): Promise<RouteRecord>;
  updateActive(slug: string, patch: { port?: number; description?: string | null }): Promise<RouteRecord>;
  markDeleting(slug: string): Promise<RouteRecord>;
  setCloudflareRecordId(slug: string, recordId: string): Promise<RouteRecord>;
  recordError(slug: string, error: { code: string; message: string }): Promise<void>;
  remove(slug: string): Promise<void>;
  ping(): Promise<boolean>;
}

export class SqliteRouteStore implements RouteStore {
  private sqlite: DatabaseContext['sqlite'];

  constructor(ctx: DatabaseContext) {
    this.sqlite = ctx.sqlite;
  }

  async count(): Promise<number> {
    const row = this.sqlite.prepare('SELECT COUNT(*) as count FROM routes').get() as { count: number };
    return row.count;
  }

  async get(slug: string): Promise<RouteRecord | null> {
    const row = this.sqlite.prepare('SELECT * FROM routes WHERE slug = ?').get(slug) as unknown as
      | RouteRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  async list(): Promise<RouteRecord[]> {
    const rows = this.sqlite.prepare('SELECT * FROM routes ORDER BY slug').all() as unknown as RouteRow[];
    return rows.map(rowToRecord);
  }

  async listActive(): Promise<RouteRecord[]> {
    const rows = this.sqlite
      .prepare("SELECT * FROM routes WHERE status = 'active' ORDER BY slug")
      .all() as unknown as RouteRow[];
    return rows.map(rowToRecord);
  }

  async listPending(): Promise<RouteRecord[]> {
    const rows = this.sqlite
      .prepare("SELECT * FROM routes WHERE status = 'deleting' ORDER BY slug")
      .all() as unknown as RouteRow[];
    return rows.map(rowToRecord);
  }

  async insertCreating(input: { slug: string; port: number; description: string | null }): Promise<RouteRecord> {
    const now = Date.now();
    this.sqlite.exec('BEGIN');
    try {
      this.sqlite
        .prepare(
          `INSERT INTO routes (slug, port, description, status, retry_count, created_at, updated_at)
           VALUES (?, ?, ?, 'creating', 0, ?, ?)`,
        )
        .run(input.slug, input.port, input.description, now, now);
      const row = this.sqlite.prepare('SELECT * FROM routes WHERE slug = ?').get(input.slug) as unknown as RouteRow;
      this.sqlite.exec('COMMIT');
      return rowToRecord(row);
    } catch (e: unknown) {
      this.sqlite.exec('ROLLBACK');
      if (e instanceof Error && 'code' in e && (e as any).code === 'ERR_SQLITE_ERROR' && e.message.includes('UNIQUE')) {
        throw new RouteManagerError('ROUTE_ALREADY_EXISTS', `route "${input.slug}" already exists`);
      }
      throw e;
    }
  }

  async activate(slug: string, recordId: string | null): Promise<RouteRecord> {
    const now = Date.now();
    this.sqlite.exec('BEGIN');
    try {
      const result = this.sqlite
        .prepare(
          `UPDATE routes SET status = 'active', cloudflare_record_id = ?,
           last_error_code = NULL, last_error_message = NULL,
           retry_count = 0, updated_at = ?
           WHERE slug = ?`,
        )
        .run(recordId, now, slug) as { changes: number; lastInsertRowid: number | bigint };
      if (result.changes === 0) {
        this.sqlite.exec('ROLLBACK');
        throw ROUTE_NOT_FOUND;
      }
      const row = this.sqlite.prepare('SELECT * FROM routes WHERE slug = ?').get(slug) as unknown as RouteRow;
      this.sqlite.exec('COMMIT');
      return rowToRecord(row);
    } catch (e: unknown) {
      if (e !== ROUTE_NOT_FOUND) {
        this.sqlite.exec('ROLLBACK');
      }
      throw e;
    }
  }

  async updateActive(slug: string, patch: { port?: number; description?: string | null }): Promise<RouteRecord> {
    const now = Date.now();
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.port !== undefined) {
      sets.push('port = ?');
      params.push(patch.port);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      params.push(patch.description);
    }
    sets.push('last_error_code = NULL');
    sets.push('last_error_message = NULL');
    sets.push('retry_count = 0');
    sets.push('updated_at = ?');
    params.push(now);
    params.push(slug);

    const sql = `UPDATE routes SET ${sets.join(', ')} WHERE slug = ? AND status = 'active'`;

    this.sqlite.exec('BEGIN');
    try {
      const result = this.sqlite.prepare(sql).run(...params) as { changes: number; lastInsertRowid: number | bigint };
      if (result.changes === 0) {
        this.sqlite.exec('ROLLBACK');
        throw ROUTE_NOT_FOUND;
      }
      const row = this.sqlite.prepare('SELECT * FROM routes WHERE slug = ?').get(slug) as unknown as RouteRow;
      this.sqlite.exec('COMMIT');
      return rowToRecord(row);
    } catch (e: unknown) {
      if (e !== ROUTE_NOT_FOUND) {
        this.sqlite.exec('ROLLBACK');
      }
      throw e;
    }
  }

  async markDeleting(slug: string): Promise<RouteRecord> {
    const now = Date.now();
    this.sqlite.exec('BEGIN');
    try {
      const result = this.sqlite
        .prepare('UPDATE routes SET status = \'deleting\', updated_at = ? WHERE slug = ?')
        .run(now, slug) as { changes: number; lastInsertRowid: number | bigint };
      if (result.changes === 0) {
        this.sqlite.exec('ROLLBACK');
        throw ROUTE_NOT_FOUND;
      }
      const row = this.sqlite.prepare('SELECT * FROM routes WHERE slug = ?').get(slug) as unknown as RouteRow;
      this.sqlite.exec('COMMIT');
      return rowToRecord(row);
    } catch (e: unknown) {
      if (e !== ROUTE_NOT_FOUND) {
        this.sqlite.exec('ROLLBACK');
      }
      throw e;
    }
  }

  async setCloudflareRecordId(slug: string, recordId: string): Promise<RouteRecord> {
    const now = Date.now();
    this.sqlite.exec('BEGIN');
    try {
      const result = this.sqlite
        .prepare('UPDATE routes SET cloudflare_record_id = ?, updated_at = ? WHERE slug = ?')
        .run(recordId, now, slug) as { changes: number; lastInsertRowid: number | bigint };
      if (result.changes === 0) {
        this.sqlite.exec('ROLLBACK');
        throw ROUTE_NOT_FOUND;
      }
      const row = this.sqlite.prepare('SELECT * FROM routes WHERE slug = ?').get(slug) as unknown as RouteRow;
      this.sqlite.exec('COMMIT');
      return rowToRecord(row);
    } catch (e: unknown) {
      if (e !== ROUTE_NOT_FOUND) {
        this.sqlite.exec('ROLLBACK');
      }
      throw e;
    }
  }

  async recordError(slug: string, error: { code: string; message: string }): Promise<void> {
    const now = Date.now();
    this.sqlite.exec('BEGIN');
    try {
      const result = this.sqlite
        .prepare(
          `UPDATE routes SET last_error_code = ?, last_error_message = ?,
           retry_count = retry_count + 1, updated_at = ?
           WHERE slug = ?`,
        )
        .run(error.code, error.message, now, slug) as { changes: number; lastInsertRowid: number | bigint };
      if (result.changes === 0) {
        this.sqlite.exec('ROLLBACK');
        throw ROUTE_NOT_FOUND;
      }
      this.sqlite.exec('COMMIT');
    } catch (e: unknown) {
      if (e !== ROUTE_NOT_FOUND) {
        this.sqlite.exec('ROLLBACK');
      }
      throw e;
    }
  }

  async remove(slug: string): Promise<void> {
    this.sqlite.prepare('DELETE FROM routes WHERE slug = ?').run(slug);
  }

  async ping(): Promise<boolean> {
    try {
      this.sqlite.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
}
