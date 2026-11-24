# World Souk & Shop Project Status

Phase 1 foundation code is in place and verified locally as of 25 November 2026. The marketplace demo remains available. AWS provisioning and live MSK verification are pending.

## Phase 1 Foundations

| Workstream | Delivered | Verification |
| --- | --- | --- |
| AWS infrastructure | Terraform for private EKS, MSK Serverless, and scoped IAM roles. [Terraform runbook](infra/terraform/README.md) | Terraform formatting, validation, and two mocked tests passed with the pinned AWS provider. |
| Kafka delivery | SQLite outbox relay with acknowledgement tracking, retry and lease recovery, a development broker, and MSK IAM support. [Kafka runbook](infra/README.md#kafka-event-delivery) | Apache Kafka 4.1.2 accepted two local events. Both were consumed in partition order with their original IDs. |
| Authentication | Initial administrator bootstrap, persistent login throttling, upgraded password hashing, password changes, session revocation, and an audit log. [Operator setup](README.md#authentication-and-membership) | Automated identity tests and browser account workflows passed. |
| Membership pre-screening | Recorded checks for all three tiers, safe submission retries, and reviewer attestation before granting business roles. [Membership workflow](README.md#authentication-and-membership) | Tests covered screening, duplicate submissions, legacy applications, and session revocation after approval. Chromium exercised a manufacturer application through approval and sign-in. |
| Data migrations | SQLite migrations for the running application and PostgreSQL migrations for the target schema. [Data design](infra/README.md#postgresql) | All three PostgreSQL migrations and both materialized view refreshes passed in PostgreSQL 18.7 through PGlite. CI is configured to check PostgreSQL 16. |

The full suite passed 24 automated tests. Chromium also checked checkout, shipment tracking, keyboard navigation, and desktop and mobile layouts. [Run the demo](README.md#run-the-demo)

## Deployment and later phases

- Review an account-specific Terraform plan using the intended AWS account, region, VPC, private subnets, and state backend. Live EKS, MSK authentication and delivery, Docker Compose, and hosted CI execution still need verification.
- Connect the application and relay to PostgreSQL before scaling the service across nodes. The local SQLite relay delivers at least once. Consumers need to deduplicate by event ID. [Data and event contract](infra/README.md)
- Live payments, customs and tax, carrier integrations, production identity controls, and release audits remain in the [launch backlog](README.md#launch-backlog).
