# Production data and deployment foundation

The marketplace API runs on SQLite. The outbox relay can independently publish from SQLite or PostgreSQL. The [AWS Terraform stack](terraform/README.md) and [Helm pilot](eks/README.md) define the private infrastructure and single-instance deployment. [Project status](../STATUS.md)

## PostgreSQL

Give a dedicated migration role access to a fresh PostgreSQL 16+ database. Set its `WSS_POSTGRES_URL` through the environment's secret manager. The runner applies migrations in order, serializes schema changes with an advisory lock, and tracks each checksum in `wss_migrations.applied`. Each migration and its ledger entry commit together.

```sh
npm ci --prefix infra/postgres
npm run migrate --prefix infra/postgres
```

An existing schema provisioned by older manual instructions requires a migration-history reconciliation before using the runner. Review the deployed schema and migration checksums on a restored copy, then record the verified history before permitting further migrations. Give publishing, writing, reporting, and migration roles separate credentials. Store release data and backups in the selected environment.

The schema uses native UUIDs, timestamp-aware columns, integer cents, currency codes, and relational constraints. A SQLite import requires consistent ID mapping for every foreign key and event payload that uses a demo slug. Convert epoch-based session expiry and textual dates before validation. Demo identities and sessions belong in the local environment. The SQL adapter must translate SQLite placeholders, Boolean predicates, row ordering, and insert syntax before it can use this schema.

The checkout transaction should claim the idempotency key, lock the relevant pool row, and reserve inventory in product ID order with a guarded `UPDATE ... WHERE quantity_available >= requested_quantity`. Confirm that each update affected a row. Write immutable line prices and costs, commission allocations, and outbox events in the same transaction. Use the same lock order for expiry and restocking. Apply retry limits to serialization failures and deadlocks and preserve the original checkout key across retries. Redis can cache public catalog reads. PostgreSQL owns the inventory invariant. [PostgreSQL explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html)

## Reporting

`wss.mv_shareholder_defect_baseline` groups posted sales by manufacturer and currency. It assigns exact commission cents across product lines using a stable cumulative allocation. It separately groups settled freight amounts and defects by the same dimensions before joining them, so multiple order lines or freight bills cannot multiply revenue or adjustments.

`wss.mv_freight_remittances_by_region` reports pending and settled amounts per freight partner, region, and currency. Net freight equals the billed amount less defect allowance. Manufacturer margin deducts cost of goods, allocated commission, and settled net freight. Keep reporting totals within currency and count orders from the order grain when combining manufacturers.

Schedule refreshes through Airflow or an equivalent job runner. Track the last successful refresh and expose its timestamp with reports. The migration populates both views and creates the unique indexes required for concurrent refresh. Serialize refreshes per view. [PostgreSQL materialized view refresh](https://www.postgresql.org/docs/16/sql-refreshmaterializedview.html)

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY wss.mv_shareholder_defect_baseline;
REFRESH MATERIALIZED VIEW CONCURRENTLY wss.mv_freight_remittances_by_region;
```

## Kafka event delivery

Business transactions append records to `event_outbox`. Run the relay as a separate process against the same SQLite file. The relay delivers to `wss.events.v1` using the aggregate ID as the partition key. Each envelope carries `id`, `eventType`, `aggregateId`, `occurredAt`, `schemaVersion`, and `payload`. Use that event ID to deduplicate deliveries. Event payloads exclude contact data, shipment addresses, credentials, and payment secrets.

The relay takes a renewable database lease, reads events in insertion order, and records completion after Kafka acknowledges the batch. A crash between broker acknowledgement and the local update can produce a duplicate, as can a retry after a partial broker acknowledgement. Consumers should persist processed event IDs and commit projection changes with that deduplication record. Failure leaves the oldest batch pending and the relay backs off up to 30 seconds. The worker logs batch counts and retry times without printing payloads. [Apache Kafka producer configuration](https://kafka.apache.org/41/configuration/producer-configs/)

From the repository root, start the development Kafka broker and create the topic. [Kafka transport and security modes](kafka/README.md)

```sh
npm ci --prefix infra/kafka
docker compose -f infra/kafka/compose.yml up -d --wait broker
docker compose -f infra/kafka/compose.yml run --rm topic-init
```

Point the worker at the same database as the running demo. The host broker uses loopback plaintext for development. MSK uses the IAM mode and TLS. [Amazon MSK client setup](https://docs.aws.amazon.com/msk/latest/developerguide/configure-clients-for-iam-access-control.html)

```powershell
$env:WSS_DB = 'data/demo.sqlite'
$env:WSS_KAFKA_BROKERS = '127.0.0.1:19092'
npm run outbox
```

`npm run outbox -- --once` drains available batches and exits with a failure status if the lease is held or a retry is scheduled. `npm run outbox:status` reads pending count, age inputs, last success, active lease, and retry state without contacting Kafka. A sustained backlog calls for checking broker reachability, topic permissions, and worker health. The [Terraform outputs](terraform/README.md#create-the-event-topic) provide the relay environment for MSK. Build the worker container with `docker build --target outbox -t world-souk-outbox .` and give the API and relay access to the same durable database volume when using SQLite.

### PostgreSQL outbox

Migration 005 adds the relay lease and `wss.record_outbox_event(kind, entity, data)`. A PostgreSQL writer calls the function in the same transaction as its business write. The function locks the aggregate before assigning a sequence, so concurrent transactions for the same aggregate publish in commit order. Transactions touching multiple aggregates should acquire their locks in consistent order. The existing marketplace writes its separate SQLite outbox. [PostgreSQL advisory locks](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS)

Set `WSS_POSTGRES_URL` on the outbox worker to select PostgreSQL. Set `WSS_POSTGRES_CA_FILE` to the provider's CA bundle as needed. The driver verifies the server certificate by default and accepts plaintext only with `WSS_POSTGRES_TLS=local` and a literal loopback host. Use connection URLs without query parameters. [node-postgres TLS configuration](https://node-postgres.com/features/ssl)

Grant the worker schema usage, `SELECT` on the outbox and relay state, `UPDATE (published_at)` on the outbox, and `UPDATE` on the relay state. The worker uses short database transactions and releases them before publishing to Kafka. A migrated PostgreSQL database with its own writers is required for PostgreSQL delivery.

Run `npm run test:integration --prefix infra/postgres` with `WSS_POSTGRES_TEST_URL` set to a disposable database. Set `WSS_KAFKA_TEST_BROKERS` to the isolated local Kafka endpoint to verify actual broker acknowledgements in that test. The worker's optional `WSS_OUTBOX_HEALTH_FILE` records progress. `node src/outbox-worker.mjs --health` checks that heartbeat without reaching the broker or database.

## Deployment sequence

1. Add and test the PostgreSQL adapter against a disposable database. Verify concurrent checkout, pool expiry, idempotency, and margin reconciliation. Load-test the catalog and reservation path before scaling it.
2. Review an account-specific plan for the private EKS and MSK Terraform stack. Provision the foundation and verify IAM topic creation and event delivery. Deploy the API and publisher with workload identities, managed secrets, TLS, scoped permissions, structured logs, and readiness and liveness probes.
3. Introduce Redis caching and search projections when load warrants them. Use Airflow for replayable reporting jobs. Keep customer, financial, settlement, and inventory records in PostgreSQL.
4. Integrate hosted payment and freight providers behind verified, replay-safe webhooks. Reconcile authorizations, captures, refunds, and disbursements before accepting real orders. Validate target-market trade, tax, privacy, and accessibility requirements before launch.
