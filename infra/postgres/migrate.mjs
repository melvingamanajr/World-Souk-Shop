import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { openPostgresPool } from './connection.mjs';
import { usingTransaction } from './transaction.mjs';

const source = new URL('./', import.meta.url);
const migrationLock = [192101, 21];

export async function applyPostgresMigrations(pool) {
  const names = (await readdir(source)).filter(name => /^\d+-[\w-]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(names.map(async name => {
    const sql = (await readFile(new URL(name, source), 'utf8')).replaceAll('\r\n', '\n');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout TO '5min'");
    await client.query('SELECT pg_advisory_lock($1,$2)', migrationLock);
    const { rows: [schema] } = await client.query(`SELECT to_regnamespace('wss') IS NOT NULL AS marketplace,
      to_regclass('wss_migrations.applied') IS NOT NULL AS tracked`);
    if (schema.marketplace && !schema.tracked) throw new Error('Existing PostgreSQL schema has no migration ledger. Use a fresh database or reconcile its migration history first.');
    await usingTransaction(client, async tx => {
      await tx.query('CREATE SCHEMA IF NOT EXISTS wss_migrations');
      await tx.query(`CREATE TABLE IF NOT EXISTS wss_migrations.applied (
        name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    });
    const { rows: applied } = await client.query('SELECT name,checksum FROM wss_migrations.applied ORDER BY name');
    for (let index = 0; index < applied.length; index++) {
      const prior = applied[index];
      if (migrations[index]?.name !== prior.name || migrations[index]?.checksum !== prior.checksum) {
        throw new Error(`Migration history mismatch at ${prior.name}. Restore the original migration before continuing.`);
      }
    }
    for (const migration of migrations.slice(applied.length)) {
      await usingTransaction(client, async tx => {
        await tx.query(migration.sql);
        await tx.query('INSERT INTO wss_migrations.applied(name,checksum) VALUES ($1,$2)', [migration.name, migration.checksum]);
      });
    }
    return { applied: migrations.slice(applied.length).map(migration => migration.name), total: migrations.length };
  } finally {
    // Dispose of the session and release its advisory lock even after a failed migration.
    client.release(true);
  }
}

if (import.meta.main) {
  let pool;
  try {
    pool = await openPostgresPool();
    console.log(JSON.stringify(await applyPostgresMigrations(pool)));
  } catch (error) {
    console.error('PostgreSQL migration failed.', error.code ?? error.message);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
