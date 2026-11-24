# Phase 1 AWS foundation

This Terraform stack provisions a private EKS control plane and AL2023 managed node group, an EKS Auth interface endpoint, and an IAM-authenticated MSK Serverless cluster in an existing VPC. It associates an IAM producer role with the `wss` namespace and `wss-outbox` service account. The role can write the configured event topic. A separate role can create that topic. EKS API and audit logs have 30-day retention. Managed nodes use encrypted disks and IMDSv2 with hop limit one. [Amazon EKS security](https://docs.aws.amazon.com/eks/latest/best-practices/security.html) · [MSK IAM resource permissions](https://docs.aws.amazon.com/msk/latest/developerguide/kafka-actions.html)

The stack covers AWS infrastructure and workload identity. Set `enable_pilot_ebs_csi = true` to install the EBS CSI add-on with a dedicated Pod Identity for the application's volume. The [Helm pilot](../eks/README.md) uses that foundation to run one API replica on retained SQLite storage and optionally run the Kafka relay alongside it.

## Inputs and network

- Use a commercial AWS account and a Region that offers EKS and MSK Serverless. `allowed_account_ids` in the provider checks the destination account. The example uses Singapore and the default EKS version is 1.36. Review version support for the selected Region before planning. [MSK Serverless availability](https://docs.aws.amazon.com/msk/latest/developerguide/serverless.html) · [EKS version lifecycle](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html)
- Supply two or three private IPv4 subnets in distinct Availability Zones of a DNS-enabled VPC. The stack checks each effective route table, including subnets associated with the main route table. Node subnets need working egress to ECR, S3, and EC2 through VPC endpoints or a controlled egress path. Ensure enough IPv4 capacity for the nodes, pods, EKS network interfaces, and MSK endpoints. When the VPC already has private EKS Auth, pass `existing_eks_auth_endpoint_id` and ensure its network rules permit the worker source. [Private EKS cluster networking](https://docs.aws.amazon.com/eks/latest/userguide/private-clusters.html)
- Supply a same-account platform operator IAM role and the security group of a private operator host or runner in the VPC. The role receives Kubernetes cluster admin access. TCP 443 reaches the Kubernetes API and TCP 9098 reaches the private Kafka listener from that security group. The AWS role running Terraform needs provisioning permissions, including IAM role management and pass role. The operator role alone owns the initial Kubernetes access entry.
- Use a dedicated, versioned S3 state bucket with encryption, block public access and tightly scoped read/write access to the state and `.tflock` objects. The backend enables encryption and S3 locking. Use a unique state path for each environment. Keep plan and state files private and use ambient short-lived AWS credentials. [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3)

## Validate and plan

Run the following from `infra/terraform` with Terraform 1.11 or later. Initialization downloads the pinned AWS provider. Tests use a mocked provider and need no AWS session.

```sh
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
terraform test
```

Copy the `.example` inputs to `foundation.tfvars` and `backend.s3.tfbackend`, then replace the example values. With the intended AWS role active, review a plan before provisioning. EKS, EC2, MSK, the endpoint, logs, and data transfer incur charges. [AWS EKS pricing](https://aws.amazon.com/eks/pricing/) · [AWS MSK pricing](https://aws.amazon.com/msk/pricing/)

```sh
terraform init -reconfigure -backend-config=backend.s3.tfbackend
terraform plan -var-file=foundation.tfvars -out=foundation.tfplan
```

Review the target account, region, network visibility, IAM policies, and costs before applying that plan. Keep administrative Kubernetes and Kafka commands on the private operator host.

## Create the event topic

MSK Serverless topic creation uses Kafka's admin protocol. From the VPC-based operator host, configure a named AWS profile that assumes the role in `kafka_topic_operator_role_arn` with the platform operator profile as its source. Use the temporary credentials from this profile for the topic creation command. [AWS Serverless topic guide](https://docs.aws.amazon.com/msk/latest/developerguide/msk-serverless-create-topic.html)

From the repository root, read the `kafka_relay_environment` output and export its four values in the current shell. The output contains connection settings and the topic name.

```sh
terraform -chdir=infra/terraform output -json kafka_relay_environment
npm ci --prefix infra/kafka
AWS_PROFILE=wss-topic-operator npm run topic:ensure --prefix infra/kafka
```

Configure the relay with the same output environment, use the `wss` namespace and `wss-outbox` service account on EKS, and allow the SDK to resolve credentials via Pod Identity. Choose the partition count before the initial create and keep it stable so an aggregate key keeps its partition. Route topic creation commands through the operator role, then use the producer role for steady-state delivery.
