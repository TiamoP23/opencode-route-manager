import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DatabaseContext {
  sqlite: DatabaseSync;
  close: () => void;
}

export function openDatabase(path: string, migrationsFolder: string): DatabaseContext {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  runMigrations(sqlite, migrationsFolder);
  return {
    sqlite,
    close: () => { sqlite.close(); },
  };
}

function runMigrations(sqlite: DatabaseSync, migrationsFolder: string): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`);

  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  const journal: { entries: Array<{ idx: number; tag: string; when: number }> } = JSON.parse(
    readFileSync(journalPath, 'utf-8'),
  );

  const checkStmt = sqlite.prepare('SELECT id FROM __drizzle_migrations WHERE hash = ?');
  const insertStmt = sqlite.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
  );

  for (const entry of journal.entries) {
    const existing = checkStmt.get(entry.tag);
    if (!existing) {
      const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
      const sql = readFileSync(sqlPath, 'utf-8');
      sqlite.exec(sql);
      insertStmt.run(entry.tag, Date.now());
    }
  }
}
