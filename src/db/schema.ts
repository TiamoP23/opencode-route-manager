import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const routes = sqliteTable('routes', {
  slug: text('slug').primaryKey(),
  port: integer('port').notNull(),
  description: text('description'),
  status: text('status', { enum: ['creating', 'active', 'deleting'] }).notNull(),
  cloudflareRecordId: text('cloudflare_record_id'),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  retryCount: integer('retry_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  check('routes_status_check', sql`${table.status} in ('creating', 'active', 'deleting')`),
  check('routes_port_check', sql`${table.port} between 1 and 65535`),
]);
