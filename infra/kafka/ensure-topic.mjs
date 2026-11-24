import { ensureKafkaTopic } from './transport.mjs';

try {
  const { topic, created } = await ensureKafkaTopic();
  console.log(created ? `Created Kafka topic ${topic}.` : `Kafka topic ${topic} already exists.`);
} catch (error) {
  if (error.constructor === Error) console.error(error.message);
  else console.error(`Kafka topic setup failed (${error.name}). Check broker reachability and topic permissions.`);
  process.exitCode = 1;
}
