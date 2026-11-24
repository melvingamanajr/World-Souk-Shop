variable "aws_region" {
  description = "AWS Region offering private EKS and MSK Serverless."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account allowed to run this stack."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Enter a 12-digit AWS account ID."
  }
}

variable "environment" {
  description = "Short environment name used in resource names and tags."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.environment))
    error_message = "Use 2 to 20 lowercase letters, digits, or hyphens, beginning with a letter."
  }
}

variable "vpc_id" {
  description = "ID of an existing VPC with DNS support and hostnames enabled."
  type        = string
}

variable "private_subnet_ids" {
  description = "Two or three private IPv4 subnets in separate Availability Zones for EKS and MSK."
  type        = set(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2 && length(var.private_subnet_ids) <= 3
    error_message = "Provide two or three private subnet IDs."
  }
}

variable "operator_role_arn" {
  description = "An existing same-account IAM role for cluster administration and Kafka topic bootstrap."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::${var.aws_account_id}:role/.+$", var.operator_role_arn))
    error_message = "Provide an IAM role ARN in the selected AWS account."
  }
}

variable "operator_security_group_id" {
  description = "An existing security group in the VPC for private operator clients."
  type        = string
}

variable "eks_version" {
  description = "Kubernetes version on standard support in the selected Region."
  type        = string
  default     = "1.36"
}

variable "node_instance_type" {
  description = "On-demand x86_64 EC2 instance type for the managed node group."
  type        = string
  default     = "m6i.large"
}

variable "enable_pilot_ebs_csi" {
  description = "Manage the EBS CSI add-on and its own IAM Pod Identity for the private pilot's persistent volume."
  type        = bool
  default     = false
}

variable "existing_eks_auth_endpoint_id" {
  description = "Existing EKS Auth interface endpoint with private DNS. Omit to create one in the supplied subnets."
  type        = string
  default     = null
}

variable "kafka_topic" {
  description = "Kafka topic authorized for the outbox relay. Keep this stable to preserve per-key partition assignment."
  type        = string
  default     = "wss.events.v1"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{0,99}$", var.kafka_topic))
    error_message = "Use 1 to 100 lowercase letters, digits, periods, underscores, or hyphens, starting with a letter or digit."
  }
}
