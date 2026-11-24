import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';
import { recordEvent } from '../../src/commerce.mjs';
import { openDatabase, transaction } from '../../src/database.mjs';
import { createOutboxRelay } from '../../src/outbox.mjs';
import { createKafkaTransport, readKafkaSettings } from './transport.mjs';

const env = { WSS_KAFKA_SECURITY: 'local', WSS_KAFKA_BROKERS: process.env.WSS_KAFKA_BROKERS || '127.0.0.1:19092' };
const { brokers, topic } = readKafkaSettings(env);
const db = openDatabase(':memory:');
const transport = createKafkaTransport(env);
const kafka = new Kafka({
  clientId: 'world-souk-kafka-smoke', brokers, connectionTimeout: 3000, requestTimeout: 10000,
  logLevel: logLevel.NOTHING, retry: { retries: 2 },
});
const aggregateId = randomUUID();
const consumer = kafka.consumer({ groupId: `wss-smoke-${aggregateId}`, allowAutoTopicCreation: false });

try {
  const expectedSteps = [1, 2];
  transaction(db, () => {
    for (const step of expectedSteps) recordEvent(db, 'smoke.delivery', aggregateId, { step });
  });

  const relay = createOutboxRelay(db, transport);
  assert.deepEqual(await relay.runOnce(), { status: 'published', count: 2 });
  assert.equal(relay.status().pending, 0);
  const publishedRows = db.prepare(`SELECT id, occurred_at FROM event_outbox WHERE published_at IS NOT NULL ORDER BY sequence`).all();
  assert.equal(publishedRows.length, 2);

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  const matched = [];
  let timeout;
  await new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Timed out reading the two smoke events from Kafka.')), 20000);
    consumer.run({ eachMessage: async ({ partition, message }) => {
      if (message.key?.toString() !== aggregateId) return;
      matched.push({ partition, event: JSON.parse(message.value.toString()), eventId: message.headers['event-id'].toString() });
      if (matched.length === 2) resolve();
    } }).catch(reject);
  }).finally(() => clearTimeout(timeout));

  assert.equal(matched[0].partition, matched[1].partition);
  for (const [index, result] of matched.entries()) {
    assert.deepEqual(result.event, {
      id: publishedRows[index].id, eventType: 'smoke.delivery', aggregateId,
      occurredAt: publishedRows[index].occurred_at, schemaVersion: 1,
      payload: { step: expectedSteps[index] },
    });
    assert.equal(result.eventId, result.event.id);
  }
  console.log('SQLite outbox smoke check published and consumed two ordered events.');
} finally {
  await Promise.allSettled([transport.close(), consumer.disconnect()]);
  db.close();
}
