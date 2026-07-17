import { eq, and, count, sql } from 'drizzle-orm';
import type { RouteRecord, RouteStatus } from '../domain.js';
import { RouteManagerError } from '../errors.js';
import type { DatabaseContext } from './client.js';
import { routes } from './schema.js';

type RouteInsert = typeof routes.$inferInsert;
type RouteSelect = typeof routes.$inferSelect;

function rowToRecord(row: RouteSelect): RouteRecord {
  return {
    slug: row.slug,
    port: row.port,
    description: row.description,
    status: row.status as RouteStatus,
    cloudflareRecordId: row.cloudflareRecordId,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    retryCount: row.retryCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
  private db: DatabaseContext['db'];

  constructor(ctx: DatabaseContext) {
    this.db = ctx.db;
  }

  async count(): Promise<number> {
    const [row] = this.db.select({ value: count() }).from(routes).all();
    return row!.value;
  }

  async get(slug: string): Promise<RouteRecord | null> {
    const row = this.db.select().from(routes).where(eq(routes.slug, slug)).limit(1).get() as RouteSelect | undefined;
    return row ? rowToRecord(row) : null;
  }

  async list(): Promise<RouteRecord[]> {
    const rows = this.db.select().from(routes).orderBy(routes.slug).all() as RouteSelect[];
    return rows.map(rowToRecord);
  }

  async listActive(): Promise<RouteRecord[]> {
    const rows = this.db
      .select()
      .from(routes)
      .where(eq(routes.status, 'active'))
      .orderBy(routes.slug)
      .all() as RouteSelect[];
    return rows.map(rowToRecord);
  }

  async listPending(): Promise<RouteRecord[]> {
    const rows = this.db
      .select()
      .from(routes)
      .where(sql`${routes.status} IN ('creating', 'deleting')`)
      .orderBy(routes.slug)
      .all() as RouteSelect[];
    return rows.map(rowToRecord);
  }

  async insertCreating(input: { slug: string; port: number; description: string | null }): Promise<RouteRecord> {
    const now = new Date();
    try {
      return this.db.transaction((tx) => {
        const [row] = tx
          .insert(routes)
          .values({
            slug: input.slug,
            port: input.port,
            description: input.description,
            status: 'creating' satisfies RouteStatus,
            retryCount: 0,
            createdAt: now,
            updatedAt: now,
          } satisfies RouteInsert)
          .returning()
          .all() as RouteSelect[];
        return rowToRecord(row!);
      });
    } catch (e: unknown) {
      const cause = (e as any).cause;
      if (cause?.code === 'ERR_SQLITE_ERROR' && cause?.message?.includes('UNIQUE')) {
        throw new RouteManagerError('ROUTE_ALREADY_EXISTS', `route "${input.slug}" already exists`);
      }
      throw e;
    }
  }

  async activate(slug: string, recordId: string | null): Promise<RouteRecord> {
    const now = new Date();
    return this.db.transaction((tx) => {
      const row = tx
        .update(routes)
        .set({
          status: 'active',
          cloudflareRecordId: recordId,
          lastErrorCode: null,
          lastErrorMessage: null,
          retryCount: 0,
          updatedAt: now,
        })
        .where(eq(routes.slug, slug))
        .returning()
        .get() as RouteSelect | undefined;
      if (!row) throw ROUTE_NOT_FOUND;
      return rowToRecord(row);
    });
  }

  async updateActive(slug: string, patch: { port?: number; description?: string | null }): Promise<RouteRecord> {
    const now = new Date();
    const values: Partial<RouteInsert> & { updatedAt: Date; lastErrorCode: null; lastErrorMessage: null; retryCount: 0 } = {
      updatedAt: now,
      lastErrorCode: null,
      lastErrorMessage: null,
      retryCount: 0,
    };
    if (patch.port !== undefined) values.port = patch.port;
    if (patch.description !== undefined) values.description = patch.description;

    return this.db.transaction((tx) => {
      const row = tx
        .update(routes)
        .set(values)
        .where(and(eq(routes.slug, slug), eq(routes.status, 'active')))
        .returning()
        .get() as RouteSelect | undefined;
      if (!row) throw ROUTE_NOT_FOUND;
      return rowToRecord(row);
    });
  }

  async markDeleting(slug: string): Promise<RouteRecord> {
    const now = new Date();
    return this.db.transaction((tx) => {
      const row = tx
        .update(routes)
        .set({ status: 'deleting', updatedAt: now })
        .where(eq(routes.slug, slug))
        .returning()
        .get() as RouteSelect | undefined;
      if (!row) throw ROUTE_NOT_FOUND;
      return rowToRecord(row);
    });
  }

  async setCloudflareRecordId(slug: string, recordId: string): Promise<RouteRecord> {
    const now = new Date();
    return this.db.transaction((tx) => {
      const row = tx
        .update(routes)
        .set({ cloudflareRecordId: recordId, updatedAt: now })
        .where(eq(routes.slug, slug))
        .returning()
        .get() as RouteSelect | undefined;
      if (!row) throw ROUTE_NOT_FOUND;
      return rowToRecord(row);
    });
  }

  async recordError(slug: string, error: { code: string; message: string }): Promise<void> {
    const now = new Date();
    this.db.transaction((tx) => {
      const result = tx
        .update(routes)
        .set({
          lastErrorCode: error.code,
          lastErrorMessage: error.message,
          retryCount: sql`retry_count + 1`,
          updatedAt: now,
        })
        .where(eq(routes.slug, slug))
        .returning()
        .all() as RouteSelect[];
      if (result.length === 0) throw ROUTE_NOT_FOUND;
    });
  }

  async remove(slug: string): Promise<void> {
    this.db.transaction((tx) => {
      tx.delete(routes).where(eq(routes.slug, slug)).run();
    });
  }

  async ping(): Promise<boolean> {
    try {
      const result = this.db.get(sql`SELECT 1`);
      return result !== undefined && result !== null;
    } catch {
      return false;
    }
  }
}
