# Kafka delivery

The outbox relay reads committed events from the application's SQLite database and uses this adapter to publish them to Kafka. The app and demo run without these dependencies. Install this package separately on the relay host with Node.js 24.12+.

```sh
npm ci --prefix infra/kafka
```

## Local broker

Start the single-node KRaft broker with Docker Compose. Its host port is available on loopback. The second command creates the topic explicitly and returns after initialization.

```sh
docker compose -f infra/kafka/compose.yml up -d broker
docker compose -f infra/kafka/compose.yml run --rm topic-init
npm run test:broker --prefix infra/kafka
```

The broker smoke check uses a fresh in-memory SQLite database. It commits two synthetic events, runs the relay, confirms that the outbox acknowledged them, and reads them back with their original event IDs and ordering on a single partition. It writes to the local broker only. Stop the Compose project with `docker compose -f infra/kafka/compose.yml down`. Its named volume keeps the local log across restarts.

## Connection settings

| Setting | Purpose |
| --- | --- |
| `WSS_KAFKA_BROKERS` | Comma-separated `host:port` addresses. Use `127.0.0.1:19092` for the Compose broker. |
| `WSS_KAFKA_TOPIC` | Destination topic. Defaults to `wss.events.v1`. Provision the topic before running the relay. |
| `WSS_KAFKA_SECURITY` | `local` for loopback plaintext, `iam` for MSK IAM over TLS, or `scram` for SASL/SCRAM-SHA-512 over TLS. Defaults to `local`. |
| `WSS_KAFKA_AWS_REGION` | MSK cluster region for IAM mode. |
| `WSS_KAFKA_USERNAME`, `WSS_KAFKA_PASSWORD` | Credentials for SCRAM mode. Inject these through the deployment's secret manager. |

For an MSK Serverless deployment, set `WSS_KAFKA_SECURITY=iam`, use the cluster's IAM bootstrap broker output from Terraform, and set the correct region. The AWS SDK default credential chain supports a role supplied through EKS Pod Identity. Provision the topic with a separate operator role and grant the relay role connection, topic describe, and topic write permissions on that cluster and topic. The client uses verified TLS certificates. [AWS MSK IAM signer](https://github.com/aws/aws-msk-iam-sasl-signer-js) · [MSK IAM permissions](https://docs.aws.amazon.com/msk/latest/developerguide/kafka-actions.html)

## Delivery behavior

The JSON message envelope carries `id`, `eventType`, `aggregateId`, `occurredAt`, `schemaVersion`, and `payload`. `aggregateId` is the Kafka key. Consumers can use `id` or the `event-id` header to deduplicate. Keep partition assignments stable when ordering across an aggregate's history matters. [KafkaJS producer configuration](https://kafka.js.org/docs/producing)

The producer waits for all in-sync replicas and disables automatic topic creation. A crash or interrupted response between Kafka accepting a record and the relay marking it published can result in replay. Consumers should persist processed event IDs in the same transaction as their projection updates. Monitor pending event count, age of the oldest pending event, consecutive publishing failures, and gaps in successful publication.
