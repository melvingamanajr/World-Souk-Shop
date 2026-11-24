import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const migrations = new URL('../db/', import.meta.url);

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 5000 });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT`);

    for (const name of readdirSync(migrations).filter(name => /^\d+-.+\.sql$/.test(name)).sort()) {
      const sql = readFileSync(new URL(name, migrations), 'utf8');
      const checksum = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
      transaction(db, () => {
        const previous = db.prepare('SELECT checksum FROM schema_migrations WHERE name = ?').get(name);
        if (previous && previous.checksum !== checksum) throw new Error(`Migration changed since application: ${name}`);
        if (previous) return;
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)').run(name, checksum);
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
