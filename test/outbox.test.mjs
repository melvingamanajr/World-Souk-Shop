import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../src/commerce.mjs';
import { openDatabase, transaction } from '../src/database.mjs';
import { createOutboxRelay } from '../src/outbox.mjs';

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'wss-outbox-test-'));
  const filename = join(directory, 'outbox.sqlite');
  const db = openDatabase(filename);
  const second = openDatabase(filename);
  context.after(() => {
    second.close();
    db.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(filename + suffix, { force: true });
    rmdirSync(directory);
  });
  return { db, second };
}

test('relay delivers committed events in sequence, waits for acknowledgement and holds an exclusive lease', async context => {
  const { db, second } = fixture(context);
  const time = '2026-10-12T00:00:00.000Z';
  assert.throws(() => transaction(db, () => {
    recordEvent(db, 'RolledBack', 'draft', {}, time);
    throw new Error('transaction aborted');
  }), /aborted/);
  transaction(db, () => {
    recordEvent(db, 'order.created', 'example-order', { orderId: 'example-order' }, time);
    recordEvent(db, 'order.paid', 'example-order', { orderId: 'example-order' }, time);
  });
  const ack = Promise.withResolvers();
  const sent = Promise.withResolvers();
  const relay = createOutboxRelay(db, { publish(events) { sent.resolve(events); return ack.promise; } });
  const alternative = createOutboxRelay(second, { publish() { assert.fail('Other worker already holds the lease'); } });
  const inflight = relay.runOnce();
  const events = await sent.promise;
  assert.deepEqual(events.map(event => event.eventType), ['order.created', 'order.paid']);
  assert.deepEqual(events[0], { id: events[0].id, eventType: 'order.created', aggregateId: 'example-order', occurredAt: time,
    schemaVersion: 1, payload: { orderId: 'example-order' } });
  assert.equal(relay.status().pending, 2);
  assert.equal(relay.status().oldestPendingAt, time);
  assert.equal(relay.status().leased, true);
  assert.equal((await alternative.runOnce()).status, 'busy');

  // The API can append rows while the publisher is waiting on Kafka.
  recordEvent(second, 'ShipmentAssigned', 'example-shipment', { shipmentId: 'example-shipment' }, time);
  ack.resolve();
  assert.deepEqual(await inflight, { status: 'published', count: 2 });
  assert.equal(relay.status().pending, 1);
  assert.equal(relay.status().leased, false);
  assert.ok(relay.status().lastSuccessAt);
});

test('relay persists retry delay and repeats a failed event with the same ID', async context => {
  const { db, second } = fixture(context);
  let now = Date.parse('2026-10-12T00:00:00.000Z');
  const options = { clock: () => now, retryBaseMs: 100, retryMaxMs: 1000 };
  const ids = [];
  recordEvent(db, 'MembershipSubmitted', 'application-id', { applicationId: 'application-id' });
  const failing = createOutboxRelay(db, { publish(events) { ids.push(events[0].id); throw new Error('Broker offline'); } }, options);
  const recovering = createOutboxRelay(second, { async publish(events) { ids.push(events[0].id); } }, options);
  const first = await failing.runOnce();
  assert.equal(first.status, 'retry');
  assert.equal(first.failed, true);
  assert.equal(recovering.status().consecutiveFailures, 1);
  assert.deepEqual(await recovering.runOnce(), { status: 'retry', count: 0, retryAt: first.retryAt });
  now += 100;
  assert.deepEqual(await recovering.runOnce(), { status: 'published', count: 1 });
  assert.equal(ids[0], ids[1]);
  assert.equal(recovering.status().pending, 0);
  assert.equal(recovering.status().consecutiveFailures, 0);
  assert.equal((await recovering.runOnce()).status, 'idle');
});

test('an expired lease can be recovered and a stale acknowledgement cannot alter newer relay state', async context => {
  const { db, second } = fixture(context);
  let now = Date.parse('2026-10-12T00:00:00.000Z');
  const options = { clock: () => now, leaseMs: 1000 };
  recordEvent(db, 'ProductListed', 'product-id', {});
  const ack = Promise.withResolvers();
  const abandoned = createOutboxRelay(db, { publish() { return ack.promise; } }, options);
  const inflight = abandoned.runOnce();
  now += 1001;
  const successor = createOutboxRelay(second, { async publish() {} }, options);
  assert.equal((await successor.runOnce()).status, 'published');
  const published = successor.status().lastSuccessAt;
  now += 500;
  ack.resolve();
  assert.equal((await inflight).status, 'busy');
  assert.equal(successor.status().lastSuccessAt, published);
  assert.equal(successor.status().pending, 0);
});
