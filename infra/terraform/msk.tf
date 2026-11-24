resource "aws_security_group" "msk" {
  name        = "${local.name}-msk"
  description = "Allow TLS Kafka traffic from WSS workers and the Kafka topic operator"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "msk" {
  for_each = {
    nodes    = local.cluster_sg
    operator = data.aws_security_group.operator.id
  }

  security_group_id            = aws_security_group.msk.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 9098
  to_port                      = 9098
}

resource "aws_msk_serverless_cluster" "foundation" {
  cluster_name = local.name

  client_authentication {
    sasl {
      iam {
        enabled = true
      }
    }
  }

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.msk.id]
  }

  depends_on = [aws_vpc_security_group_ingress_rule.msk]
}

data "aws_msk_bootstrap_brokers" "foundation" {
  cluster_arn = aws_msk_serverless_cluster.foundation.arn
}

locals {
  kafka_cluster_arn = aws_msk_serverless_cluster.foundation.arn
  kafka_topic_arn   = "${replace(local.kafka_cluster_arn, ":cluster/", ":topic/")}/${var.kafka_topic}"
}

resource "aws_iam_role_policy" "outbox" {
  name = "publish-one-topic"
  role = aws_iam_role.pod["outbox"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster", "kafka-cluster:WriteDataIdempotently"]
        Resource = local.kafka_cluster_arn
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:DescribeTopic", "kafka-cluster:WriteData"]
        Resource = local.kafka_topic_arn
      }
    ]
  })
}

resource "aws_eks_pod_identity_association" "outbox" {
  cluster_name    = aws_eks_cluster.foundation.name
  namespace       = local.pod_identity_roles.outbox.namespace
  service_account = local.pod_identity_roles.outbox.service_account
  role_arn        = aws_iam_role.pod["outbox"].arn

  depends_on = [aws_eks_addon.pod_identity, aws_iam_role_policy.outbox]
}

resource "aws_iam_role" "topic_operator" {
  name = "${local.name}-topic-operator"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = var.operator_role_arn }
    }]
  })
}

resource "aws_iam_role_policy" "topic_operator" {
  name = "bootstrap-one-topic"
  role = aws_iam_role.topic_operator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster"]
        Resource = local.kafka_cluster_arn
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:CreateTopic", "kafka-cluster:DescribeTopic", "kafka-cluster:DescribeTopicDynamicConfiguration"]
        Resource = local.kafka_topic_arn
      }
    ]
  })
}
