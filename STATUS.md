# World Souk & Shop Project Status

Phase 1 foundation code, operator MFA, and the private pilot package are in place and verified locally as of 25 November 2026. The marketplace demo remains available. AWS provisioning and live MSK verification are pending.

## Phase 1 Foundations

| Workstream | Delivered | Verification |
| --- | --- | --- |
| AWS infrastructure | Terraform for private EKS, MSK Serverless, scoped IAM roles, and optional EBS CSI. The Helm pilot runs one SQLite API replica with an optional MSK sidecar. [Terraform runbook](infra/terraform/README.md) · [Helm pilot](infra/eks/README.md) | Terraform validation and two mocked tests passed. Helm lint and rendering passed with and without the sidecar. |
| Kafka delivery | SQLite and PostgreSQL outbox relay backends with acknowledgement tracking, retries, lease recovery, and MSK IAM support. [Kafka runbook](infra/README.md#kafka-event-delivery) | Apache Kafka 4.1.2 acknowledged events from both backends. The PostgreSQL smoke check also verified rollback, retry, and competing lease handling. |
| Authentication | Operator MFA with encrypted authenticator seeds, single-use recovery codes, and verified sessions. The account controls include bootstrap, throttling, password changes, and session revocation. [Operator setup](README.md#operator-mfa) | Automated tests verified replay protection, recovery, and admin access. Chromium exercised the MFA prompt and entry to the operations workspace. |
| Membership pre-screening | Recorded checks for all three tiers, safe submission retries, and reviewer attestation before granting business roles. [Membership workflow](README.md#authentication-and-membership) | Tests covered screening, duplicate submissions, legacy applications, and session revocation after approval. Chromium exercised a manufacturer application through approval and sign-in. |
| Data migrations | SQLite migrations for the running application and a checksum-tracked PostgreSQL migration runner. [Data design](infra/README.md#postgresql) | All five PostgreSQL migrations and the relay passed through the PostgreSQL wire driver with PGlite's PostgreSQL 19 engine. CI targets PostgreSQL 16. |

The full suite passed 34 automated tests. Chromium also checked checkout, shipment tracking, keyboard navigation, and desktop and mobile layouts. [Run the demo](README.md#run-the-demo)

## Deployment and later phases

- Review an account-specific Terraform plan using the intended AWS account, region, VPC, private subnets, and state backend. Live EKS and MSK, container builds, Docker Compose, and hosted CI still need verification.
- Move marketplace writes to PostgreSQL before scaling the API across nodes. The API and the optional pilot sidecar share one SQLite database. The independent PostgreSQL relay consumes the outbox in its configured database and delivers at least once. Consumers need to deduplicate by event ID. [Data and event contract](infra/README.md)
- Live payments, customs and tax, carrier integrations, password recovery, and release audits remain in the [launch backlog](README.md#launch-backlog).
