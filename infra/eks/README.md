# Private EKS pilot

The Helm chart runs one API instance on a retained SQLite volume and exposes a private ClusterIP service on port 3000. A private TLS proxy supplies the browser-facing origin. The optional outbox sidecar publishes events from the same SQLite database to MSK. Deployment uses `Recreate` and a single-writer volume so SQLite has one API writer instance during upgrades. A deployment upgrade has a brief outage. [Kubernetes ReadWriteOncePod](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)

## Prerequisites

- Provision the private [Terraform foundation](../terraform/README.md). Use a Kubernetes context for the selected private EKS cluster and an operator with the necessary namespace permissions. Use the `wss` namespace for the Terraform-created relay identity.
- Set `enable_pilot_ebs_csi = true` in the Terraform values to install the EBS CSI add-on with its own storage IAM role, or use an existing configured add-on. Have the operator provision an encrypted gp3 PVC with `ReadWriteOncePod` and a `Retain` storage class. [Example storage manifests](storage.example.yaml) · [EKS EBS CSI](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html)
- Build and publish the API and, if needed, the `outbox` image to the account's image registry. Reference the published image digests in the pilot values. Worker nodes need permission and network access to pull the images.
- Provision an existing Kubernetes Secret in `wss`. The entry named `key` must contain the base64 encoding of 32 random bytes without a line ending. Back up that key independently of SQLite and restrict Kubernetes Secret access. [Operator MFA setup](../../README.md#operator-mfa)
- Set up a private TLS reverse proxy or ingress managed by the platform team. Point its upstream to the ClusterIP service and set `api.publicOrigin` to the exact HTTPS origin users open. The chart exposes no public load balancer or ingress.

## Render and deploy

Copy [the sample values](values.example.yaml) to `values.local.yaml` and replace the sample image, origin, secret, and claim names. Enable the relay only after the event topic exists. Copy its broker, region, and topic from the [Terraform output](../terraform/README.md#create-the-event-topic).

```sh
helm lint infra/eks/pilot --strict -f infra/eks/values.local.yaml
helm template world-souk infra/eks/pilot -n wss -f infra/eks/values.local.yaml
```

Review the rendered resources and destination cluster before rolling out the release. After installation, wait for the API Deployment to report ready, then provision the operator from a private TTY.

```sh
helm upgrade --install world-souk infra/eks/pilot -n wss -f infra/eks/values.local.yaml --wait
kubectl -n wss rollout status deployment/world-souk
kubectl -n wss exec -it deploy/world-souk -c api -- node scripts/bootstrap-admin.mjs --email operator@example.test --name 'Marketplace Operator'
kubectl -n wss exec -it deploy/world-souk -c api -- node scripts/enroll-operator-mfa.mjs --email operator@example.test
```

The optional relay changes the Pod service account to `wss-outbox`. Its MSK producer role is scoped to the configured topic. Both containers share the Pod's AWS credential trust boundary, so treat the two images and all containers on the Pod as one workload identity. The API does not need broker access when the relay is disabled. [EKS Pod Identity credential isolation](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)

The API readiness probe checks database access. The relay checks its processing heartbeat independently so a broker outage can accumulate durable events while the API remains available. Check the worker logs and status and investigate a growing backlog. [Kafka operations](../README.md#kafka-event-delivery)

Before changing the image or SQLite schema, take a verified snapshot and retain the matching MFA key. A Helm rollback changes the image and configuration. It cannot roll back data migrations. Test restoration before publishing a new image. The optional PostgreSQL relay is a separate process for a PostgreSQL outbox and does not read the pilot's SQLite events. [PostgreSQL relay](../README.md#postgresql-outbox)
