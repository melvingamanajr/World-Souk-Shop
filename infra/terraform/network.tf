data "aws_vpc" "foundation" {
  id = var.vpc_id
}

data "aws_subnet" "private" {
  for_each = var.private_subnet_ids
  id       = each.value
}

data "aws_route_tables" "subnet" {
  for_each = var.private_subnet_ids
  vpc_id   = var.vpc_id

  filter {
    name   = "association.subnet-id"
    values = [each.value]
  }
}

data "aws_route_table" "main" {
  vpc_id = var.vpc_id

  filter {
    name   = "association.main"
    values = ["true"]
  }
}

data "aws_route_table" "private" {
  for_each       = var.private_subnet_ids
  route_table_id = coalesce(one(data.aws_route_tables.subnet[each.value].ids), data.aws_route_table.main.id)
}

data "aws_security_group" "operator" {
  id = var.operator_security_group_id
}

data "aws_vpc_endpoint" "eks_auth" {
  count = var.existing_eks_auth_endpoint_id == null ? 0 : 1
  id    = var.existing_eks_auth_endpoint_id
}

locals {
  name             = "wss-${var.environment}"
  eks_auth_service = "com.amazonaws.${var.aws_region}.eks-auth"
  cluster_sg       = aws_eks_cluster.foundation.vpc_config[0].cluster_security_group_id
}

resource "aws_security_group" "eks_operator" {
  name        = "${local.name}-eks-operator"
  description = "Allow private Kubernetes API access from the operator security group"
  vpc_id      = var.vpc_id

  lifecycle {
    precondition {
      condition     = data.aws_security_group.operator.vpc_id == var.vpc_id
      error_message = "The operator security group must belong to the selected VPC."
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "eks_operator" {
  security_group_id            = aws_security_group.eks_operator.id
  referenced_security_group_id = data.aws_security_group.operator.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_security_group" "eks_auth" {
  count       = var.existing_eks_auth_endpoint_id == null ? 1 : 0
  name        = "${local.name}-eks-auth"
  description = "Allow EKS workers to use the private EKS Auth endpoint"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "eks_auth_workers" {
  count                        = var.existing_eks_auth_endpoint_id == null ? 1 : 0
  security_group_id            = aws_security_group.eks_auth[0].id
  referenced_security_group_id = local.cluster_sg
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_endpoint" "eks_auth" {
  count               = var.existing_eks_auth_endpoint_id == null ? 1 : 0
  vpc_id              = var.vpc_id
  service_name        = local.eks_auth_service
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.eks_auth[0].id]
  private_dns_enabled = true
}
