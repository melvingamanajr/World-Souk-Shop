resource "aws_iam_role" "eks" {
  name = "${local.name}-eks"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["sts:AssumeRole", "sts:TagSession"]
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks" {
  role       = aws_iam_role.eks.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_cloudwatch_log_group" "eks" {
  name              = "/aws/eks/${local.name}/cluster"
  retention_in_days = 30
}

resource "aws_eks_cluster" "foundation" {
  name                          = local.name
  role_arn                      = aws_iam_role.eks.arn
  version                       = var.eks_version
  bootstrap_self_managed_addons = false
  enabled_cluster_log_types     = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    security_group_ids      = [aws_security_group.eks_operator.id]
    endpoint_private_access = true
    endpoint_public_access  = false
  }

  depends_on = [aws_iam_role_policy_attachment.eks, aws_cloudwatch_log_group.eks]

  lifecycle {
    precondition {
      condition     = data.aws_vpc.foundation.enable_dns_support && data.aws_vpc.foundation.enable_dns_hostnames
      error_message = "Enable DNS support and DNS hostnames on the VPC."
    }

    precondition {
      condition = alltrue([
        for subnet in data.aws_subnet.private : subnet.vpc_id == var.vpc_id && !subnet.map_public_ip_on_launch && !subnet.ipv6_native
      ]) && length(toset([for subnet in data.aws_subnet.private : subnet.availability_zone_id])) == length(var.private_subnet_ids)
      error_message = "Supply subnets in the selected VPC with IPv4 support, public IPv4 auto-assignment disabled, and one subnet per Availability Zone."
    }

    precondition {
      condition = alltrue(flatten([
        for table in data.aws_route_table.private : [for route in table.routes : !try(startswith(route.gateway_id, "igw-"), false)]
      ]))
      error_message = "Use subnets without direct routes to an Internet Gateway."
    }
  }
}

resource "aws_eks_access_entry" "operator" {
  cluster_name  = aws_eks_cluster.foundation.name
  principal_arn = var.operator_role_arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "operator" {
  cluster_name  = aws_eks_access_entry.operator.cluster_name
  principal_arn = aws_eks_access_entry.operator.principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }
}

resource "aws_iam_role" "nodes" {
  name = "${local.name}-nodes"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "nodes" {
  for_each = toset(["AmazonEKSWorkerNodePolicy", "AmazonEC2ContainerRegistryPullOnly"])

  role       = aws_iam_role.nodes.name
  policy_arn = "arn:aws:iam::aws:policy/${each.value}"
}

locals {
  pod_identity_roles = {
    cni    = { namespace = "kube-system", service_account = "aws-node" }
    outbox = { namespace = "wss", service_account = "wss-outbox" }
  }
}

resource "aws_iam_role" "pod" {
  for_each = local.pod_identity_roles
  name     = "${local.name}-${each.key}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["sts:AssumeRole", "sts:TagSession"]
      Principal = { Service = "pods.eks.amazonaws.com" }
      Condition = {
        StringEquals = {
          "aws:RequestTag/eks-cluster-name"           = local.name
          "aws:RequestTag/kubernetes-namespace"       = each.value.namespace
          "aws:RequestTag/kubernetes-service-account" = each.value.service_account
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cni" {
  role       = aws_iam_role.pod["cni"].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_eks_addon" "pod_identity" {
  cluster_name = aws_eks_cluster.foundation.name
  addon_name   = "eks-pod-identity-agent"
}

resource "aws_eks_addon" "cni" {
  cluster_name = aws_eks_cluster.foundation.name
  addon_name   = "vpc-cni"

  pod_identity_association {
    role_arn        = aws_iam_role.pod["cni"].arn
    service_account = local.pod_identity_roles.cni.service_account
  }

  depends_on = [aws_eks_addon.pod_identity, aws_iam_role_policy_attachment.cni]
}

resource "aws_launch_template" "nodes" {
  name_prefix = "${local.name}-nodes-"

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      encrypted             = true
      volume_type           = "gp3"
      volume_size           = 30
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
}

resource "aws_eks_node_group" "foundation" {
  cluster_name    = aws_eks_cluster.foundation.name
  node_group_name = "phase-one"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = var.private_subnet_ids
  ami_type        = "AL2023_x86_64_STANDARD"
  instance_types  = [var.node_instance_type]
  version         = aws_eks_cluster.foundation.version

  launch_template {
    id      = aws_launch_template.nodes.id
    version = aws_launch_template.nodes.latest_version
  }

  scaling_config {
    min_size     = 2
    desired_size = 2
    max_size     = 3
  }

  update_config {
    max_unavailable = 1
  }

  depends_on = [
    aws_iam_role_policy_attachment.nodes,
    aws_eks_addon.cni,
    aws_vpc_endpoint.eks_auth,
    aws_vpc_security_group_ingress_rule.eks_auth_workers,
  ]

  lifecycle {
    precondition {
      condition = var.existing_eks_auth_endpoint_id == null || try(
        data.aws_vpc_endpoint.eks_auth[0].vpc_id == var.vpc_id &&
        data.aws_vpc_endpoint.eks_auth[0].service_name == local.eks_auth_service &&
        data.aws_vpc_endpoint.eks_auth[0].vpc_endpoint_type == "Interface" &&
        data.aws_vpc_endpoint.eks_auth[0].private_dns_enabled &&
        data.aws_vpc_endpoint.eks_auth[0].state == "available",
        false
      )
      error_message = "The existing endpoint must be an available, private-DNS EKS Auth interface endpoint in the selected VPC."
    }
  }
}

resource "aws_eks_addon" "system" {
  for_each     = toset(["coredns", "kube-proxy"])
  cluster_name = aws_eks_cluster.foundation.name
  addon_name   = each.value

  depends_on = [aws_eks_node_group.foundation]
}
