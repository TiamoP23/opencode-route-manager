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
    const [row] = await this.db.select({ value: count() }).from(routes);
    return row!.value;
  }

  async get(slug: string): Promise<RouteRecord | null> {
    const [row] = await this.db.select().from(routes).where(eq(routes.slug, slug)).limit(1);
    return row ? rowToRecord(row) : null;
  }

  async list(): Promise<RouteRecord[]> {
    const rows = await this.db.select().from(routes).orderBy(routes.slug);
    return rows.map(rowToRecord);
  }

  async listActive(): Promise<RouteRecord[]> {
    const rows = await this.db
      .select()
      .from(routes)
      .where(eq(routes.status, 'active'))
      .orderBy(routes.slug);
    return rows.map(rowToRecord);
  }

  async listPending(): Promise<RouteRecord[]> {
    const rows = await this.db
      .select()
      .from(routes)
      .where(eq(routes.status, 'deleting'))
      .orderBy(routes.slug);
    return rows.map(rowToRecord);
  }

  async insertCreating(input: { slug: string; port: number; description: string | null }): Promise<RouteRecord> {
    const now = new Date();
    try {
      const [row] = await this.db
        .insert(routes)
        .values({
          slug: input.slug,
          port: input.port,
          description: input.description,
          status: 'creating',
          retryCount: 0,
          createdAt: now,
          updatedAt: now,
        } satisfies RouteInsert)
        .returning();
      return rowToRecord(row!);
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
    const [row] = await this.db
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
      .returning();
    if (!row) throw ROUTE_NOT_FOUND;
    return rowToRecord(row);
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

    const [row] = await this.db
      .update(routes)
      .set(values)
      .where(and(eq(routes.slug, slug), eq(routes.status, 'active')))
      .returning();
    if (!row) throw ROUTE_NOT_FOUND;
    return rowToRecord(row);
  }

  async markDeleting(slug: string): Promise<RouteRecord> {
    const now = new Date();
    const [row] = await this.db
      .update(routes)
      .set({ status: 'deleting', updatedAt: now })
      .where(eq(routes.slug, slug))
      .returning();
    if (!row) throw ROUTE_NOT_FOUND;
    return rowToRecord(row);
  }

  async setCloudflareRecordId(slug: string, recordId: string): Promise<RouteRecord> {
    const now = new Date();
    const [row] = await this.db
      .update(routes)
      .set({ cloudflareRecordId: recordId, updatedAt: now })
      .where(eq(routes.slug, slug))
      .returning();
    if (!row) throw ROUTE_NOT_FOUND;
    return rowToRecord(row);
  }

  async recordError(slug: string, error: { code: string; message: string }): Promise<void> {
    const now = new Date();
    const result = await this.db
      .update(routes)
      .set({
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        retryCount: sql`retry_count + 1`,
        updatedAt: now,
      })
      .where(eq(routes.slug, slug))
      .returning();
    if (result.length === 0) throw ROUTE_NOT_FOUND;
  }

  async remove(slug: string): Promise<void> {
    await this.db.delete(routes).where(eq(routes.slug, slug));
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.db.get(sql`SELECT 1`);
      return result !== undefined && result !== null;
    } catch {
      return false;
    }
  }
}
