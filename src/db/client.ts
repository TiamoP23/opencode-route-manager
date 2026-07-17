import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';

export interface DatabaseContext {
  sqlite: DatabaseSync;
  db: NodeSQLiteDatabase;
  close: () => void;
}

export function openDatabase(path: string, migrationsFolder: string): DatabaseContext {
  const sqlite = new DatabaseSync(path);
  try {
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec('PRAGMA busy_timeout = 5000');
    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder });
    return {
      sqlite,
      db,
      close: () => { sqlite.close(); },
    };
  } catch (e) {
    sqlite.close();
    throw e;
  }
}
