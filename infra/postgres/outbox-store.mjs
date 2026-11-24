import { poolTransaction } from './transaction.mjs';

const iso = value => value ? new Date(value).toISOString() : null;
const relayState = 'wss.outbox_relay_state';

function requireState(row) {
  if (!row) throw new Error('The PostgreSQL outbox migration is required.');
  return row;
}

export function createPostgresOutboxStore(pool) {
  return {
    async claim({ leaseId, leaseMs, batchSize }) {
      const pending = await pool.query('SELECT 1 FROM wss.event_outbox WHERE published_at IS NULL LIMIT 1');
      if (!pending.rowCount) return { status: 'idle' };

      return poolTransaction(pool, async client => {
        const { rows: locked } = await client.query(`SELECT singleton FROM ${relayState} WHERE singleton FOR UPDATE`);
        requireState(locked[0]);
        const { rows } = await client.query(`SELECT lease_until > clock_timestamp() AS leased,
          CASE WHEN retry_at > clock_timestamp() THEN retry_at END AS retry_at, consecutive_failures
          FROM ${relayState} WHERE singleton`);
        const state = rows[0];
        if (state.leased) return { status: 'busy' };
        if (state.retry_at) return { status: 'retry', retryAt: iso(state.retry_at) };

        const batch = await client.query(`SELECT sequence,id,event_type,aggregate_id,payload,occurred_at
          FROM wss.event_outbox WHERE published_at IS NULL ORDER BY sequence LIMIT $1`, [batchSize]);
        if (!batch.rowCount) return { status: 'idle' };
        await client.query(`UPDATE ${relayState} SET lease_id = $1,
          lease_until = clock_timestamp() + $2::int * INTERVAL '1 millisecond' WHERE singleton`, [leaseId, leaseMs]);
        return { status: 'claimed', consecutiveFailures: state.consecutive_failures, rows: batch.rows.map(row => ({
          sequence: row.sequence, id: row.id, eventType: row.event_type, aggregateId: row.aggregate_id,
          occurredAt: iso(row.occurred_at), payload: row.payload
        })) };
      });
    },
    async renew({ leaseId, leaseMs }) {
      const result = await pool.query(`UPDATE ${relayState} SET
        lease_until = clock_timestamp() + $2::int * INTERVAL '1 millisecond'
        WHERE singleton AND lease_id = $1 AND lease_until > clock_timestamp()`, [leaseId, leaseMs]);
      return result.rowCount === 1;
    },
    async acknowledge({ leaseId, sequences }) {
      return poolTransaction(pool, async client => {
        const release = await client.query(`UPDATE ${relayState} SET lease_id = NULL, lease_until = NULL,
          retry_at = NULL, consecutive_failures = 0, last_success_at = clock_timestamp()
          WHERE singleton AND lease_id = $1 RETURNING last_success_at`, [leaseId]);
        if (!release.rowCount) return false;
        const marked = await client.query(`UPDATE wss.event_outbox SET published_at = $1
          WHERE sequence = ANY($2::bigint[]) AND published_at IS NULL`, [release.rows[0].last_success_at, sequences]);
        if (marked.rowCount !== sequences.length) throw new Error('The PostgreSQL outbox batch changed before acknowledgement.');
        return true;
      });
    },
    async postpone({ leaseId, consecutiveFailures, delayMs }) {
      const { rows } = await pool.query(`UPDATE ${relayState} SET lease_id = NULL, lease_until = NULL,
        retry_at = clock_timestamp() + $3::int * INTERVAL '1 millisecond', consecutive_failures = $2
        WHERE singleton AND lease_id = $1 RETURNING retry_at`, [leaseId, consecutiveFailures, delayMs]);
      return iso(rows[0]?.retry_at);
    },
    async status() {
      const { rows } = await pool.query(`SELECT lease_until > clock_timestamp() AS leased, retry_at, consecutive_failures, last_success_at,
        (SELECT COUNT(*) FROM wss.event_outbox WHERE published_at IS NULL) AS pending,
        (SELECT occurred_at FROM wss.event_outbox WHERE published_at IS NULL ORDER BY sequence LIMIT 1) AS oldest
        FROM ${relayState} WHERE singleton`);
      const row = requireState(rows[0]);
      const pending = Number(row.pending);
      if (!Number.isSafeInteger(pending)) throw new RangeError('The outbox count exceeds the supported range.');
      return { pending, oldestPendingAt: iso(row.oldest), lastSuccessAt: iso(row.last_success_at),
        consecutiveFailures: row.consecutive_failures, retryAt: iso(row.retry_at), leased: Boolean(row.leased) };
    }
  };
}
