import { randomUUID } from 'node:crypto';
import { createSqliteOutboxStore } from './sqlite-outbox-store.mjs';

export function createOutboxRelay(db, transport, { clock = Date.now, ...options } = {}) {
  return createOutboxPublisher(createSqliteOutboxStore(db, clock), transport, options);
}

export function createOutboxPublisher(store, transport, {
  batchSize = 100, leaseMs = 60000, retryBaseMs = 1000, retryMaxMs = 30000,
  onLeaseError = () => {}
} = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new RangeError('Use an outbox batch size between 1 and 1000.');
  if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new RangeError('Use an outbox lease of at least one second.');
  if (!Number.isInteger(retryBaseMs) || !Number.isInteger(retryMaxMs) || retryBaseMs < 1 || retryMaxMs < retryBaseMs) {
    throw new RangeError('Use positive outbox retry delays with a maximum at least as large as the starting delay.');
  }

  async function runOnce() {
    if (!transport) throw new TypeError('A Kafka transport is required to publish events.');
    const leaseId = randomUUID();
    const batch = await store.claim({ leaseId, leaseMs, batchSize });
    const blocked = { status: 'busy', count: 0 };
    if (batch.status !== 'claimed') return { count: 0, ...batch };

    let renewal;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = Promise.resolve().then(() => store.renew({ leaseId, leaseMs }))
        .catch(onLeaseError).finally(() => { renewal = undefined; });
    }, Math.floor(leaseMs / 3));
    heartbeat.unref();

    let delivered = false;
    try {
      await transport.publish(batch.rows.map(({ sequence, ...event }) => ({ ...event, schemaVersion: 1 })));
      delivered = true;
    } catch {
      // A broker failure or partial acknowledgement must leave the entire batch available for retry.
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }

    if (!delivered) {
      const consecutiveFailures = batch.consecutiveFailures + 1;
      const delayMs = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(30, consecutiveFailures - 1));
      const retryAt = await store.postpone({ leaseId, consecutiveFailures, delayMs });
      return retryAt ? { status: 'retry', count: 0, retryAt, failed: true } : blocked;
    }

    const acknowledged = await store.acknowledge({ leaseId, sequences: batch.rows.map(row => row.sequence) });
    return acknowledged ? { status: 'published', count: batch.rows.length } : blocked;
  }

  return { runOnce, status: () => store.status() };
}
