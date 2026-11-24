# Production data and deployment foundation

The application and outbox relay run on SQLite. PostgreSQL migrations define the target relational schema and reporting views for a future server adapter. The [AWS Terraform stack](terraform/README.md) defines a private EKS and MSK foundation. [Project status](../STATUS.md) records which paths have been verified.

## PostgreSQL

Apply the migrations once in file order to a fresh PostgreSQL 16+ database using a dedicated schema owner and migration runner. Migration 002 adds membership screening and replay keys. Migration 003 adds identity throttling and audit tables.

```sh
for migration in infra/postgres/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$migration" || exit
done
```

Give the application and reporting jobs separate database credentials with grants for their specific operations in the `wss` schema. Keep migration privileges with the release runner. Use encrypted connections and managed backups. Test restoration before moving production data.

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

## Deployment sequence

1. Add and test the PostgreSQL adapter against a disposable database. Verify concurrent checkout, pool expiry, idempotency, and margin reconciliation. Load-test the catalog and reservation path before scaling it.
2. Review an account-specific plan for the private EKS and MSK Terraform stack. Provision the foundation and verify IAM topic creation and event delivery. Deploy the API and publisher with workload identities, managed secrets, TLS, scoped permissions, structured logs, and readiness and liveness probes.
3. Introduce Redis caching and search projections when load warrants them. Use Airflow for replayable reporting jobs. Keep customer, financial, settlement, and inventory records in PostgreSQL.
4. Integrate hosted payment and freight providers behind verified, replay-safe webhooks. Reconcile authorizations, captures, refunds, and disbursements before accepting real orders. Validate target-market trade, tax, privacy, and accessibility requirements before launch.
