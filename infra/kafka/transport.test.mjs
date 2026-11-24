import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createKafkaTransport, readKafkaSettings } from './transport.mjs';

test('loopback plaintext is available without loading broker dependencies', async () => {
  const env = { WSS_KAFKA_BROKERS: '127.0.0.1:19092, localhost:9092' };
  assert.deepEqual(readKafkaSettings(env), {
    brokers: ['127.0.0.1:19092', 'localhost:9092'], security: 'local', topic: 'wss.events.v1',
  });
  const transport = createKafkaTransport(env);
  await transport.publish([]);
  await transport.close();
});

test('transport rejects non-loopback plaintext, malformed broker pairs, and an invalid topic', () => {
  assert.throws(() => readKafkaSettings({ WSS_KAFKA_BROKERS: 'example.com:9092' }), /Plaintext Kafka/);
  for (const brokers of ['', 'localhost:0', 'localhost:65536', 'http://localhost:9092', 'localhost:19092,']) {
    assert.throws(() => readKafkaSettings({ WSS_KAFKA_BROKERS: brokers }), /WSS_KAFKA_BROKERS/);
  }
  assert.throws(() => readKafkaSettings({ WSS_KAFKA_BROKERS: 'localhost:9092', WSS_KAFKA_TOPIC: '../private' }), /WSS_KAFKA_TOPIC/);
});

test('IAM validates a region and SCRAM requires both credentials', () => {
  const broker = 'msk.example.com:9098';
  const env = { WSS_KAFKA_BROKERS: broker, WSS_KAFKA_SECURITY: 'iam' };
  assert.throws(() => readKafkaSettings(env), /WSS_KAFKA_AWS_REGION/);
  assert.deepEqual(readKafkaSettings({ ...env, WSS_KAFKA_AWS_REGION: 'ap-southeast-1' }), {
    brokers: [broker], security: 'iam', topic: 'wss.events.v1',
  });
  assert.throws(() => readKafkaSettings({ ...env, WSS_KAFKA_SECURITY: 'scram' }), /WSS_KAFKA_USERNAME/);
  assert.equal(readKafkaSettings({ ...env, WSS_KAFKA_SECURITY: 'scram', WSS_KAFKA_USERNAME: 'relay', WSS_KAFKA_PASSWORD: 'example' }).security, 'scram');
});
