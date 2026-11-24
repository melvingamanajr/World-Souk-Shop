import { readFileSync } from 'node:fs';

export function postgresConnectionOptions(env = process.env) {
  let url;
  try { url = new URL(env.WSS_POSTGRES_URL); }
  catch { throw new Error('Set WSS_POSTGRES_URL to the PostgreSQL connection URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.search || url.hash) {
    throw new Error('Use a PostgreSQL URL without query parameters or fragments.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : 5432;
  let user;
  let password;
  let database;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { throw new Error('The PostgreSQL URL contains invalid percent encoding.'); }
  if (!user || !database || database.includes('/') || port < 1 || port > 65535) {
    throw new Error('Specify the PostgreSQL username, database, and a valid port.');
  }
  const mode = env.WSS_POSTGRES_TLS ?? 'verify-full';
  if (!['verify-full', 'local'].includes(mode)) throw new Error('WSS_POSTGRES_TLS must be verify-full or local.');
  if (mode === 'local' && (!['127.0.0.1', '::1'].includes(host) || env.WSS_POSTGRES_CA_FILE)) {
    throw new Error('Local PostgreSQL plaintext requires a literal loopback address and no CA file.');
  }
  const ssl = mode === 'local' ? false : { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  if (ssl && env.WSS_POSTGRES_CA_FILE) {
    try { ssl.ca = readFileSync(env.WSS_POSTGRES_CA_FILE, 'utf8'); }
    catch { throw new Error('Unable to read WSS_POSTGRES_CA_FILE.'); }
  }
  return { host, port, user, password, database, ssl, application_name: 'world-souk-outbox',
    max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000 };
}

export async function openPostgresPool(env = process.env) {
  const options = postgresConnectionOptions(env);
  const { Pool } = await import('pg');
  const pool = new Pool(options);
  pool.on('error', error => console.error(JSON.stringify({ event: 'postgres.idle_connection_error', code: error.code ?? 'PG_CONNECTION' })));
  return pool;
}
