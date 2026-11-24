import { transaction } from './database.mjs';

const isoTime = ms => new Date(ms).toISOString();

export function createSqliteOutboxStore(db, clock = Date.now) {
  const state = db.prepare('SELECT * FROM outbox_relay_state WHERE singleton = 1');
  const readPending = db.prepare(`SELECT sequence,id,event_type,aggregate_id,payload,occurred_at
    FROM event_outbox WHERE published_at IS NULL ORDER BY sequence LIMIT ?`);
  const claim = db.prepare(`UPDATE outbox_relay_state SET lease_id = ?, lease_until_ms = ?
    WHERE singleton = 1 AND (lease_id IS NULL OR lease_until_ms <= ?) AND retry_at_ms <= ?`);
  const extend = db.prepare(`UPDATE outbox_relay_state SET lease_until_ms = ?
    WHERE singleton = 1 AND lease_id = ? AND lease_until_ms > ?`);
  const release = db.prepare(`UPDATE outbox_relay_state SET lease_id = NULL, lease_until_ms = 0,
    retry_at_ms = 0, consecutive_failures = 0, last_success_at = ? WHERE singleton = 1 AND lease_id = ?`);
  const defer = db.prepare(`UPDATE outbox_relay_state SET lease_id = NULL, lease_until_ms = 0,
    retry_at_ms = ?, consecutive_failures = ? WHERE singleton = 1 AND lease_id = ?`);
  const mark = db.prepare(`UPDATE event_outbox SET published_at = ? WHERE sequence = ? AND published_at IS NULL`);
  const backlog = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM event_outbox WHERE published_at IS NULL) AS pending,
    (SELECT occurred_at FROM event_outbox WHERE published_at IS NULL ORDER BY sequence LIMIT 1) AS oldest
    FROM outbox_relay_state s WHERE singleton = 1`);

  return {
    claim({ leaseId, leaseMs, batchSize }) {
      if (!readPending.get(1)) return { status: 'idle' };
      return transaction(db, () => {
        const now = clock();
        const current = state.get();
        if (current.retry_at_ms > now) return { status: 'retry', retryAt: isoTime(current.retry_at_ms) };
        if (!claim.run(leaseId, now + leaseMs, now, now).changes) return { status: 'busy' };
        const rows = readPending.all(batchSize).map(row => ({
          sequence: row.sequence, id: row.id, eventType: row.event_type, aggregateId: row.aggregate_id,
          occurredAt: row.occurred_at, payload: JSON.parse(row.payload)
        }));
        if (!rows.length) {
          release.run(current.last_success_at, leaseId);
          return { status: 'idle' };
        }
        return { status: 'claimed', rows, consecutiveFailures: current.consecutive_failures };
      });
    },
    renew({ leaseId, leaseMs }) {
      const now = clock();
      return extend.run(now + leaseMs, leaseId, now).changes === 1;
    },
    acknowledge({ leaseId, sequences }) {
      return transaction(db, () => {
        const timestamp = isoTime(clock());
        if (!release.run(timestamp, leaseId).changes) return false;
        for (const sequence of sequences) mark.run(timestamp, sequence);
        return true;
      });
    },
    postpone({ leaseId, consecutiveFailures, delayMs }) {
      const retryAt = clock() + delayMs;
      return defer.run(retryAt, consecutiveFailures, leaseId).changes ? isoTime(retryAt) : null;
    },
    status() {
      const row = backlog.get();
      return {
        pending: row.pending, oldestPendingAt: row.oldest, lastSuccessAt: row.last_success_at,
        consecutiveFailures: row.consecutive_failures,
        retryAt: row.retry_at_ms ? isoTime(row.retry_at_ms) : null,
        leased: row.lease_until_ms > clock()
      };
    }
  };
}
