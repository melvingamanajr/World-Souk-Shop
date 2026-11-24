import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';

const isoTime = ms => new Date(ms).toISOString();

function envelope(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    occurredAt: row.occurred_at,
    schemaVersion: 1,
    payload: JSON.parse(row.payload)
  };
}

export function createOutboxRelay(db, transport, {
  clock = Date.now, batchSize = 100, leaseMs = 60000, retryBaseMs = 1000, retryMaxMs = 30000,
  onLeaseError = () => {}
} = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new RangeError('Use an outbox batch size between 1 and 1000.');
  if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new RangeError('Use an outbox lease of at least one second.');
  if (!Number.isInteger(retryBaseMs) || !Number.isInteger(retryMaxMs) || retryBaseMs < 1 || retryMaxMs < retryBaseMs) {
    throw new RangeError('Use positive outbox retry delays with a maximum at least as large as the starting delay.');
  }
  const state = db.prepare('SELECT * FROM outbox_relay_state WHERE singleton = 1');
  const readPending = db.prepare(`SELECT sequence,id,event_type,aggregate_id,payload,occurred_at
    FROM event_outbox WHERE published_at IS NULL ORDER BY sequence LIMIT ?`);
  const claim = db.prepare(`UPDATE outbox_relay_state SET lease_id = ?, lease_until_ms = ?
    WHERE singleton = 1 AND (lease_id IS NULL OR lease_until_ms <= ?) AND retry_at_ms <= ?`);
  const extend = db.prepare(`UPDATE outbox_relay_state SET lease_until_ms = ?
    WHERE singleton = 1 AND lease_id = ? AND lease_until_ms > ?`);
  const release = db.prepare(`UPDATE outbox_relay_state SET lease_id = NULL, lease_until_ms = 0,
    retry_at_ms = 0, consecutive_failures = 0, last_success_at = ? WHERE singleton = 1 AND lease_id = ?`);
  const postpone = db.prepare(`UPDATE outbox_relay_state SET lease_id = NULL, lease_until_ms = 0,
    retry_at_ms = ?, consecutive_failures = ? WHERE singleton = 1 AND lease_id = ?`);
  const mark = db.prepare(`UPDATE event_outbox SET published_at = ? WHERE sequence = ? AND published_at IS NULL`);
  const backlog = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM event_outbox WHERE published_at IS NULL) AS pending,
    (SELECT occurred_at FROM event_outbox WHERE published_at IS NULL ORDER BY sequence LIMIT 1) AS oldest
    FROM outbox_relay_state s WHERE singleton = 1`);

  function status() {
    const row = backlog.get();
    return {
      pending: row.pending, oldestPendingAt: row.oldest, lastSuccessAt: row.last_success_at,
      consecutiveFailures: row.consecutive_failures,
      retryAt: row.retry_at_ms ? isoTime(row.retry_at_ms) : null,
      leased: row.lease_until_ms > clock()
    };
  }

  async function runOnce() {
    if (!transport) throw new TypeError('A Kafka transport is required to publish events.');
    const leaseId = randomUUID();
    // The read-only check avoids taking a writer lock on an empty queue.
    if (!readPending.get(1)) return { status: 'idle', count: 0 };
    const batch = transaction(db, () => {
      const now = clock();
      const current = state.get();
      if (current.retry_at_ms > now) return { status: 'retry', count: 0, retryAt: isoTime(current.retry_at_ms) };
      if (!claim.run(leaseId, now + leaseMs, now, now).changes) return { status: 'busy', count: 0 };
      const rows = readPending.all(batchSize);
      if (!rows.length) {
        release.run(current.last_success_at, leaseId);
        return { status: 'idle', count: 0 };
      }
      return { rows, failures: current.consecutive_failures };
    });
    if (!batch.rows) return batch;

    const heartbeat = setInterval(() => {
      try {
        const now = clock();
        extend.run(now + leaseMs, leaseId, now);
      } catch { onLeaseError(); }
    }, Math.floor(leaseMs / 3));
    heartbeat.unref();

    try {
      await transport.publish(batch.rows.map(envelope));
    } catch {
      const failures = batch.failures + 1;
      const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(30, failures - 1));
      const retryAt = clock() + delay;
      if (!postpone.run(retryAt, failures, leaseId).changes) return { status: 'busy', count: 0 };
      return { status: 'retry', count: 0, retryAt: isoTime(retryAt), failed: true };
    } finally {
      clearInterval(heartbeat);
    }

    return transaction(db, () => {
      const timestamp = isoTime(clock());
      if (!release.run(timestamp, leaseId).changes) return { status: 'busy', count: 0 };
      for (const row of batch.rows) mark.run(timestamp, row.sequence);
      return { status: 'published', count: batch.rows.length };
    });
  }

  return { runOnce, status };
}
