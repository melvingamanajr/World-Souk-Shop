import { stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDatabase } from './database.mjs';
import { createOutboxPublisher } from './outbox.mjs';
import { createSqliteOutboxStore } from './sqlite-outbox-store.mjs';

const { values } = parseArgs({ options: { once: { type: 'boolean' }, status: { type: 'boolean' }, health: { type: 'boolean' } } });
const healthFile = process.env.WSS_OUTBOX_HEALTH_FILE;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());

async function openStore() {
  if (process.env.WSS_POSTGRES_URL) {
    const [{ openPostgresPool }, { createPostgresOutboxStore }] = await Promise.all([
      import('../infra/postgres/connection.mjs'), import('../infra/postgres/outbox-store.mjs')
    ]);
    const pool = await openPostgresPool();
    return { store: createPostgresOutboxStore(pool), close: () => pool.end() };
  }
  const db = openDatabase(resolve(process.env.WSS_DB ?? 'data/world-souk.sqlite'));
  return { store: createSqliteOutboxStore(db), close: () => db.close() };
}

let close;
let transport;
try {
  if (Object.values(values).filter(Boolean).length > 1) throw new Error('Choose one outbox mode.');
  if (values.health) {
    if (!healthFile || Date.now() - (await stat(healthFile)).mtimeMs > 120000) throw new Error('Outbox worker heartbeat is missing or stale.');
  } else {
    const { store, close: closeStore } = await openStore();
    close = closeStore;
    if (!values.status) {
      const { createKafkaTransport } = await import('../infra/kafka/transport.mjs');
      transport = createKafkaTransport(process.env);
    }
    const relay = createOutboxPublisher(store, transport, {
      onLeaseError: () => console.error(JSON.stringify({ event: 'outbox.lease_heartbeat_failed' }))
    });
    if (values.status) console.log(JSON.stringify(await relay.status()));
    else {
      await relay.status();
      let nextHeartbeat = 0;
      while (!abort.signal.aborted) {
        if (healthFile && Date.now() >= nextHeartbeat) {
          await writeFile(healthFile, '', { mode: 0o600 });
          nextHeartbeat = Date.now() + 5000;
        }
        const result = await relay.runOnce();
        if (result.status === 'published') {
          console.log(JSON.stringify({ event: 'outbox.published', count: result.count }));
          continue;
        }
        if (result.failed) console.error(JSON.stringify({ event: 'outbox.retry_scheduled', retryAt: result.retryAt }));
        if (values.once) {
          if (result.status !== 'idle') {
            console.error(JSON.stringify({ event: 'outbox.drain_incomplete', status: result.status, retryAt: result.retryAt }));
            process.exitCode = 1;
          }
          break;
        }
        const delay = result.retryAt ? Math.max(250, Math.min(30000, Date.parse(result.retryAt) - Date.now())) : 1000;
        await sleep(delay, undefined, { signal: abort.signal });
      }
    }
  }
} catch (error) {
  if (!abort.signal.aborted || error.name !== 'AbortError') {
    console.error(JSON.stringify({ event: 'outbox.worker_failed', code: error.name, reason: error.code ?? 'WORKER_ERROR' }));
    process.exitCode = 1;
  }
} finally {
  try { await transport?.close(); }
  catch { console.error(JSON.stringify({ event: 'outbox.close_failed' })); process.exitCode = 1; }
  await close?.();
}
