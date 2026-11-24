mock_provider "aws" {
  mock_data "aws_vpc" {
    override_during = plan
    defaults        = { enable_dns_support = true, enable_dns_hostnames = true }
  }

  mock_data "aws_route_tables" {
    override_during = plan
    defaults        = { ids = [] }
  }

  mock_data "aws_route_table" {
    override_during = plan
    defaults        = { id = "rtb-0123456789abcdef0", routes = [{ gateway_id = "local" }] }
  }

  mock_data "aws_security_group" {
    override_during = plan
    defaults        = { vpc_id = "vpc-0123456789abcdef0" }
  }

  mock_data "aws_msk_bootstrap_brokers" {
    defaults = { bootstrap_brokers_sasl_iam = "boot-test.kafka-serverless.ap-southeast-1.amazonaws.com:9098" }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test-foundation-role" }
  }

  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef1" }
  }

  mock_resource "aws_eks_cluster" {
    defaults = { vpc_config = { cluster_security_group_id = "sg-0123456789abcdef2" } }
  }

  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", latest_version = 1 }
  }

  mock_resource "aws_msk_serverless_cluster" {
    defaults = { arn = "arn:aws:kafka:ap-southeast-1:123456789012:cluster/wss-test/11111111-2222-3333-4444-555555555555-s1" }
  }
}

variables {
  aws_region                 = "ap-southeast-1"
  aws_account_id             = "123456789012"
  environment                = "test"
  vpc_id                     = "vpc-0123456789abcdef0"
  private_subnet_ids         = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  operator_role_arn          = "arn:aws:iam::123456789012:role/test-operator"
  operator_security_group_id = "sg-0123456789abcdef0"
}

override_data {
  target          = data.aws_subnet.private["subnet-0123456789abcdef0"]
  override_during = plan
  values = {
    vpc_id                  = "vpc-0123456789abcdef0"
    availability_zone_id    = "apse1-az1"
    ipv6_native             = false
    map_public_ip_on_launch = false
  }
}

override_data {
  target          = data.aws_subnet.private["subnet-0123456789abcdef1"]
  override_during = plan
  values = {
    vpc_id                  = "vpc-0123456789abcdef0"
    availability_zone_id    = "apse1-az2"
    ipv6_native             = false
    map_public_ip_on_launch = false
  }
}

run "private_foundation" {
  command = apply

  variables {
    enable_pilot_ebs_csi = true
  }

  assert {
    condition     = aws_eks_cluster.foundation.vpc_config[0].endpoint_private_access && !aws_eks_cluster.foundation.vpc_config[0].endpoint_public_access
    error_message = "The Kubernetes API must be private only."
  }

  assert {
    condition     = !aws_eks_cluster.foundation.access_config[0].bootstrap_cluster_creator_admin_permissions
    error_message = "The Terraform caller must not inherit cluster administrator access."
  }

  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.outbox.policy).Statement[1].Action) == toset(["kafka-cluster:DescribeTopic", "kafka-cluster:WriteData"])
    error_message = "The relay role may describe and write its topic."
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.outbox.policy).Statement[1].Resource == "arn:aws:kafka:ap-southeast-1:123456789012:topic/wss-test/11111111-2222-3333-4444-555555555555-s1/wss.events.v1"
    error_message = "The relay topic grant must use the exact topic ARN."
  }

  assert {
    condition     = output.kafka_relay_environment.WSS_KAFKA_SECURITY == "iam" && endswith(output.kafka_relay_environment.WSS_KAFKA_BROKERS, ":9098")
    error_message = "The relay uses the private IAM broker endpoint."
  }

  assert {
    condition = aws_eks_addon.ebs_csi[0].addon_name == "aws-ebs-csi-driver" && anytrue([
      for identity in aws_eks_addon.ebs_csi[0].pod_identity_association : identity.service_account == "ebs-csi-controller-sa"
    ]) && endswith(aws_iam_role_policy_attachment.ebs_csi[0].policy_arn, "/AmazonEBSCSIDriverPolicyV2")
    error_message = "The storage add-on must use its own scoped service account and EBS policy."
  }
}

run "reject_public_subnet_route" {
  command = plan

  override_data {
    target          = data.aws_route_table.private["subnet-0123456789abcdef1"]
    override_during = plan
    values          = { routes = [{ gateway_id = "igw-0123456789abcdef0" }] }
  }

  expect_failures = [aws_eks_cluster.foundation]
}
