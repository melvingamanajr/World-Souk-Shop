import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createOutboxPublisher } from '../../src/outbox.mjs';
import { openPostgresPool } from './connection.mjs';
import { applyPostgresMigrations } from './migrate.mjs';
import { createPostgresOutboxStore } from './outbox-store.mjs';
import { poolTransaction } from './transaction.mjs';

export async function testPostgresOutbox(pool, broker) {
  const initial = await applyPostgresMigrations(pool);
  assert.ok(initial.total >= 5);
  assert.deepEqual((await applyPostgresMigrations(pool)).applied, []);
  const store = createPostgresOutboxStore(pool);
  assert.equal((await store.status()).pending, 0, 'Use a disposable database with no pending events.');
  const aggregateId = randomUUID();
  const append = (client, kind) => client.query('SELECT wss.record_outbox_event($1,$2,$3) AS id',
    [kind, aggregateId, { orderId: aggregateId }]);

  try {
    await assert.rejects(poolTransaction(pool, async client => {
      await append(client, 'order.rolledback');
      throw new Error('cancel test transaction');
    }), /cancel test transaction/);
    assert.equal((await store.status()).pending, 0);

    const ids = await poolTransaction(pool, async client => [
      (await append(client, 'order.created')).rows[0].id,
      (await append(client, 'order.paid')).rows[0].id
    ]);
    const dropped = [];
    const unavailable = createOutboxPublisher(store, { async publish(events) {
      dropped.push(...events);
      throw new Error('simulated broker outage');
    } }, { retryBaseMs: 50 });
    assert.equal((await unavailable.runOnce()).status, 'retry');
    assert.equal((await store.status()).consecutiveFailures, 1);
    assert.equal((await store.status()).pending, 2);
    await sleep(65);

    const ack = Promise.withResolvers();
    const sent = Promise.withResolvers();
    const publisher = createOutboxPublisher(store, { async publish(events) {
      sent.resolve(events);
      await ack.promise;
      await broker?.publish(events);
    } });
    const recorded = publisher.runOnce();
    const events = await Promise.race([sent.promise, recorded.then(result => {
      throw new Error(`The publisher did not send a batch (${result.status}).`);
    })]);
    try {
      assert.deepEqual(events, dropped, 'Retries preserve the complete envelope and event IDs.');
      assert.deepEqual(events.map(event => event.id), ids);
      assert.deepEqual(events.map(event => event.eventType), ['order.created', 'order.paid']);
      assert.equal(events[0].aggregateId, aggregateId);
      assert.equal((await store.status()).leased, true);
      const second = createOutboxPublisher(store, { async publish() { assert.fail('Another publisher currently holds the lease.'); } });
      assert.equal((await second.runOnce()).status, 'busy');
      assert.equal((await store.status()).pending, 2);
    } finally { ack.resolve(); await recorded; }
    assert.deepEqual(await recorded, { status: 'published', count: 2 });
    const final = await store.status();
    assert.equal(final.pending, 0);
    assert.equal(final.consecutiveFailures, 0);
    assert.ok(final.lastSuccessAt);
    console.log(`PostgreSQL migrations and outbox smoke passed (rollback, retry, lease, and ${broker ? 'Kafka' : 'test broker'} acknowledgement).`);
  } finally {
    await pool.query('DELETE FROM wss.event_outbox WHERE aggregate_id = $1', [aggregateId]);
  }
}

if (import.meta.main) {
  let pool;
  let broker;
  try {
    if (!process.env.WSS_POSTGRES_TEST_URL) throw new Error('Set WSS_POSTGRES_TEST_URL to an isolated test database.');
    pool = await openPostgresPool({ ...process.env, WSS_POSTGRES_URL: process.env.WSS_POSTGRES_TEST_URL });
    if (process.env.WSS_KAFKA_TEST_BROKERS) {
      const { createKafkaTransport } = await import('../kafka/transport.mjs');
      broker = createKafkaTransport({ WSS_KAFKA_BROKERS: process.env.WSS_KAFKA_TEST_BROKERS, WSS_KAFKA_SECURITY: 'local' });
    }
    await testPostgresOutbox(pool, broker);
  } catch (error) {
    console.error('PostgreSQL outbox smoke failed.', error.code ?? error.message);
    process.exitCode = 1;
  } finally {
    try { await broker?.close(); }
    finally { await pool?.end(); }
  }
}
