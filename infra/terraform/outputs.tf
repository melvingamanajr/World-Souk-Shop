output "eks_cluster_name" {
  value = aws_eks_cluster.foundation.name
}

output "eks_private_api_endpoint" {
  value = aws_eks_cluster.foundation.endpoint
}

output "eks_worker_security_group_id" {
  description = "Security group used by the managed nodes. Allow it on externally managed service endpoints."
  value       = local.cluster_sg
}

output "kafka_cluster_arn" {
  value = aws_msk_serverless_cluster.foundation.arn
}

output "kafka_topic_operator_role_arn" {
  description = "Assume this role from an allowed private network location to create the relay topic."
  value       = aws_iam_role.topic_operator.arn
}

output "kafka_relay_environment" {
  description = "Non-secret relay configuration for the wss/wss-outbox service account."
  value = {
    WSS_KAFKA_BROKERS    = data.aws_msk_bootstrap_brokers.foundation.bootstrap_brokers_sasl_iam
    WSS_KAFKA_SECURITY   = "iam"
    WSS_KAFKA_AWS_REGION = var.aws_region
    WSS_KAFKA_TOPIC      = var.kafka_topic
  }
}
