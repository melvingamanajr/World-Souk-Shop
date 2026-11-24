const defaultTopic = 'wss.events.v1';
const requestTimeout = 10000;
const loopbackHosts = new Set(['127.0.0.1', 'localhost']);

function parseBrokers(setting) {
  if (!setting) throw new Error('Set WSS_KAFKA_BROKERS to a comma-separated list of broker host:port pairs.');
  return setting.split(',').map(value => {
    const broker = value.trim();
    const match = /^([a-z\d](?:[a-z\d.-]*[a-z\d])?):([1-9]\d{0,4})$/i.exec(broker);
    if (!match || Number(match[2]) > 65535) throw new Error('WSS_KAFKA_BROKERS contains an invalid broker host:port.');
    return { address: broker, host: match[1].toLowerCase() };
  });
}

export function readKafkaSettings(env) {
  const security = env.WSS_KAFKA_SECURITY || 'local';
  const brokers = parseBrokers(env.WSS_KAFKA_BROKERS);
  const topic = env.WSS_KAFKA_TOPIC || defaultTopic;
  if (!/^[a-z\d][a-z\d._-]{0,248}$/i.test(topic)) throw new Error('WSS_KAFKA_TOPIC is invalid.');
  if (!['local', 'iam', 'scram'].includes(security)) throw new Error('WSS_KAFKA_SECURITY must be local, iam, or scram.');
  if (security === 'local' && brokers.some(({ host }) => !loopbackHosts.has(host))) {
    throw new Error('Plaintext Kafka bootstrap brokers must use localhost or 127.0.0.1.');
  }
  if (security === 'iam' && !/^[a-z]{2}(?:-[a-z\d]+)+-\d+$/.test(env.WSS_KAFKA_AWS_REGION || '')) {
    throw new Error('Set WSS_KAFKA_AWS_REGION to the MSK cluster AWS region.');
  }
  if (security === 'scram' && (!env.WSS_KAFKA_USERNAME || !env.WSS_KAFKA_PASSWORD)) {
    throw new Error('Set WSS_KAFKA_USERNAME and WSS_KAFKA_PASSWORD for SCRAM authentication.');
  }
  return { brokers: brokers.map(({ address }) => address), security, topic };
}

async function loadModule(name) {
  try {
    return await import(name);
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('Kafka dependencies are missing. Run npm ci --prefix infra/kafka.', { cause: error });
  }
}

async function createKafkaClient(settings, env, clientId) {
  const { Kafka, logLevel } = await loadModule('kafkajs');
  let sasl;

  if (settings.security === 'iam') {
    const { generateAuthToken } = await loadModule('aws-msk-iam-sasl-signer-js');
    sasl = {
      mechanism: 'oauthbearer',
      async oauthBearerProvider() {
        const { token } = await generateAuthToken({ region: env.WSS_KAFKA_AWS_REGION });
        return { value: token };
      },
    };
  }
  if (settings.security === 'scram') {
    sasl = { mechanism: 'scram-sha-512', username: env.WSS_KAFKA_USERNAME, password: env.WSS_KAFKA_PASSWORD };
  }

  return new Kafka({
    clientId,
    brokers: settings.brokers,
    ssl: settings.security === 'local' ? false : { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    sasl,
    connectionTimeout: 3000,
    authenticationTimeout: 5000,
    requestTimeout,
    retry: { retries: 2, initialRetryTime: 250, maxRetryTime: 1000 },
    logLevel: logLevel.NOTHING,
  });
}

async function connectProducer(settings, env) {
  const kafka = await createKafkaClient(settings, env, 'world-souk-outbox');
  const producer = kafka.producer({ allowAutoTopicCreation: false, maxInFlightRequests: 1 });
  try {
    await producer.connect();
    return producer;
  } catch (error) {
    await producer.disconnect().catch(() => {});
    throw error;
  }
}

export async function ensureKafkaTopic(env = process.env) {
  const settings = readKafkaSettings(env);
  const partitions = Number(env.WSS_KAFKA_PARTITIONS || '3');
  if (!Number.isInteger(partitions) || partitions < 1 || partitions > 1024) {
    throw new Error('WSS_KAFKA_PARTITIONS must be an integer between 1 and 1024.');
  }
  const kafka = await createKafkaClient(settings, env, 'world-souk-topic-operator');
  const admin = kafka.admin();
  try {
    await admin.connect();
    const created = await admin.createTopics({ topics: [{ topic: settings.topic, numPartitions: partitions }] });
    return { topic: settings.topic, created };
  } finally {
    await admin.disconnect();
  }
}

export function createKafkaTransport(env = process.env) {
  const settings = readKafkaSettings(env);
  let connection;

  return {
    async publish(events) {
      if (!events.length) return;
      connection ??= connectProducer(settings, env).catch(error => {
        connection = undefined;
        throw error;
      });
      const producer = await connection;
      await producer.send({
        topic: settings.topic,
        acks: -1,
        timeout: requestTimeout,
        messages: events.map(event => ({
          key: event.aggregateId,
          value: JSON.stringify(event),
          headers: { 'event-id': event.id, 'event-type': event.eventType, 'content-type': 'application/json' },
        })),
      });
    },
    async close() {
      if (!connection) return;
      const producer = await connection.catch(() => undefined);
      connection = undefined;
      if (producer) await producer.disconnect();
    },
  };
}
