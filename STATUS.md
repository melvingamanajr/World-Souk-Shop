# World Souk & Shop Project Status

The marketplace demo runs locally. Phase 1 of the proposal covers infrastructure as code, Kafka event delivery, authentication, and membership pre-screening.

| Workstream | Current status | Verification |
| --- | --- | --- |
| Marketplace demo | Implemented | The demo exercise covers checkout, orders, account roles, and shipment tracking. [Run the demo](README.md#run-the-demo) |
| AWS infrastructure | In progress | The target is a private EKS and MSK foundation. Cloud provisioning requires the deployment account, region, and network. |
| Kafka delivery | In progress | The application writes durable outbox events. Phase 1 adds the broker relay and acknowledgement tracking. |
| Authentication | In progress | The demo already has session and role checks. Phase 1 adds an operator bootstrap and account lifecycle controls. |
| Membership pre-screening | In progress | The demo accepts consumer, manufacturer, and freight applications. Phase 1 adds persistent screening results and a manual verification record. |

The deployment backlog includes the PostgreSQL runtime adapter, live payment and carrier providers, and release audits. [Launch backlog](README.md#launch-backlog)
