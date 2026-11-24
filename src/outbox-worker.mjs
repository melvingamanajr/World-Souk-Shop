import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDatabase } from './database.mjs';
import { createOutboxRelay } from './outbox.mjs';

const { values } = parseArgs({ options: { once: { type: 'boolean' }, status: { type: 'boolean' } } });
const filename = resolve(process.env.WSS_DB ?? 'data/world-souk.sqlite');
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());

let db;
let transport;
try {
  db = openDatabase(filename);
  if (!values.status) {
    const { createKafkaTransport } = await import('../infra/kafka/transport.mjs');
    transport = createKafkaTransport(process.env);
  }
  const relay = createOutboxRelay(db, transport, {
    onLeaseError: () => console.error(JSON.stringify({ event: 'outbox.lease_heartbeat_failed' }))
  });
  if (values.status) console.log(JSON.stringify(relay.status()));
  else while (!abort.signal.aborted) {
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
} catch (error) {
  if (!abort.signal.aborted || error.name !== 'AbortError') {
    console.error(JSON.stringify({ event: 'outbox.worker_failed', code: error.name, reason: error.code ?? 'WORKER_ERROR' }));
    process.exitCode = 1;
  }
} finally {
  try { await transport?.close(); }
  catch { console.error(JSON.stringify({ event: 'outbox.close_failed' })); process.exitCode = 1; }
  db?.close();
}
