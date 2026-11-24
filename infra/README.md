# Production data and deployment foundation

The local application runs on SQLite. The PostgreSQL migration defines the target relational schema and reporting views for a future server adapter. Cloud resources, event delivery, and payments require separate implementation and deployment.

## PostgreSQL

Apply the initial migration once to a fresh PostgreSQL 16+ database using a dedicated schema owner and migration runner.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f infra/postgres/001-marketplace.sql
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

Transactional writes already append events to the outbox. An initial relay can publish committed events to `wss.events.v1` using the aggregate UUID as the partition key and the stable outbox UUID as the message ID. Carry `id`, `eventType`, `aggregateId`, `occurredAt`, `schemaVersion`, and `payload` in the envelope. Preserve event order within each aggregate. Exclude contact data, addresses, and payment secrets from event payloads.

Mark an event published after Kafka acknowledges it. A relay crash before that update can repeat a publish, so consumers should persist event IDs and update their projections in one transaction. Start with one relay or an ordered change-data capture connector. If scaling a polling relay, coordinate competing workers so messages for one key cannot reorder. Track backlog age, retry counts, and dead-lettered messages. [Apache Kafka producer configuration](https://kafka.apache.org/33/configuration/producer-configs/)

## Deployment sequence

1. Add and test the PostgreSQL adapter against a disposable database. Verify concurrent checkout, pool expiry, idempotency, and margin reconciliation. Load-test the catalog and reservation path before scaling it.
2. Deploy the API and publisher independently on EKS with reproducible Terraform and a private PostgreSQL and Kafka network. Use workload identities, managed secrets, TLS, scoped broker permissions, structured logs, and readiness and liveness probes.
3. Introduce Redis caching and search projections when load warrants them. Use Airflow for replayable reporting jobs. Keep customer, financial, settlement, and inventory records in PostgreSQL.
4. Integrate hosted payment and freight providers behind verified, replay-safe webhooks. Reconcile authorizations, captures, refunds, and disbursements before accepting real orders. Validate target-market trade, tax, privacy, and accessibility requirements before launch.
