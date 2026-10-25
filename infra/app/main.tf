terraform {
  required_version = ">= 1.10, < 2.0"
  backend "s3" {}
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
variable "aws_account_id" { type = string }
variable "image_uri" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/cs6620-team5-runtime@sha256:[a-f0-9]{64}$", var.image_uri))
    error_message = "Use the immutable digest of the project ECR image in us-east-1."
  }
}
variable "instance_type" {
  type    = string
  default = "t3.micro"
  validation {
    condition     = contains(["t3.micro", "t3.small", "t3.medium"], var.instance_type)
    error_message = "Choose an explicitly reviewed lab instance size."
  }
}
provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]
  default_tags {
    tags = { Project = "cs6620-team5", ManagedBy = "Terraform", Stage = "hosting" }
  }
}
locals {
  azs = { a = "us-east-1a", b = "us-east-1b" }
  cidrs = {
    a = { public = "10.66.0.0/24", private = "10.66.10.0/24" }
    b = { public = "10.66.1.0/24", private = "10.66.11.0/24" }
  }
  state_bucket    = "cs6620-team-state-${var.aws_account_id}-us-east-1"
  token_parameter = "/cs6620/team5/api-token-verifiers"
}
data "terraform_remote_state" "storage" {
  backend = "s3"
  config  = { bucket = local.state_bucket, key = "storage/terraform.tfstate", region = "us-east-1" }
}
data "terraform_remote_state" "artifacts" {
  backend = "s3"
  config  = { bucket = local.state_bucket, key = "artifacts/terraform.tfstate", region = "us-east-1" }
}
data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}
data "aws_iam_instance_profile" "lab" { name = "LabInstanceProfile" }
resource "aws_vpc" "project" {
  cidr_block           = "10.66.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "cs6620-team5" }
}
resource "aws_internet_gateway" "project" { vpc_id = aws_vpc.project.id }
resource "aws_subnet" "public" {
  for_each                = local.azs
  vpc_id                  = aws_vpc.project.id
  availability_zone       = each.value
  cidr_block              = local.cidrs[each.key].public
  map_public_ip_on_launch = false
  tags                    = { Name = "cs6620-team5-public-${each.key}" }
}
resource "aws_subnet" "private" {
  for_each                = local.azs
  vpc_id                  = aws_vpc.project.id
  availability_zone       = each.value
  cidr_block              = local.cidrs[each.key].private
  map_public_ip_on_launch = false
  tags                    = { Name = "cs6620-team5-private-${each.key}" }
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.project.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.project.id
  }
}
resource "aws_route_table_association" "public" {
  for_each       = local.azs
  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public.id
}
resource "aws_eip" "nat" {
  for_each = local.azs
  domain   = "vpc"
}
resource "aws_nat_gateway" "project" {
  for_each      = local.azs
  subnet_id     = aws_subnet.public[each.key].id
  allocation_id = aws_eip.nat[each.key].id
  depends_on    = [aws_internet_gateway.project, aws_route_table_association.public]
}
resource "aws_route_table" "private" {
  for_each = local.azs
  vpc_id   = aws_vpc.project.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.project[each.key].id
  }
}
resource "aws_route_table_association" "private" {
  for_each       = local.azs
  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}
resource "aws_vpc_endpoint" "gateway" {
  for_each          = toset(["s3", "dynamodb"])
  vpc_id            = aws_vpc.project.id
  service_name      = "com.amazonaws.us-east-1.${each.value}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for r in aws_route_table.private : r.id]
}
resource "aws_security_group" "link" {
  name_prefix = "cs6620-team5-link-"
  description = "API Gateway private-link network interfaces"
  vpc_id      = aws_vpc.project.id
}
resource "aws_security_group" "alb" {
  name_prefix = "cs6620-team5-alb-"
  description = "Internal load balancer; inbound only from API Gateway VPC link"
  vpc_id      = aws_vpc.project.id
}
resource "aws_security_group" "node" {
  name_prefix = "cs6620-team5-node-"
  description = "Private nodes; inbound API traffic only from internal ALB, no SSH"
  vpc_id      = aws_vpc.project.id
}
resource "aws_vpc_security_group_egress_rule" "link_alb" {
  security_group_id            = aws_security_group.link.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}
resource "aws_vpc_security_group_ingress_rule" "alb_link" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.link.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}
resource "aws_vpc_security_group_egress_rule" "alb_node" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.node.id
  ip_protocol                  = "tcp"
  from_port                    = 3200
  to_port                      = 3200
}
resource "aws_vpc_security_group_ingress_rule" "node_alb" {
  security_group_id            = aws_security_group.node.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3200
  to_port                      = 3200
}
resource "aws_vpc_security_group_egress_rule" "node_web" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.node.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}
resource "aws_vpc_security_group_egress_rule" "node_dns" {
  for_each          = toset(["tcp", "udp"])
  security_group_id = aws_security_group.node.id
  cidr_ipv4         = aws_vpc.project.cidr_block
  ip_protocol       = each.value
  from_port         = 53
  to_port           = 53
}
resource "aws_lb" "api" {
  name               = "cs6620-team5-api"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for s in aws_subnet.private : s.id]
}
resource "aws_lb_target_group" "api" {
  name                 = "cs6620-team5-api"
  port                 = 3200
  protocol             = "HTTP"
  vpc_id               = aws_vpc.project.id
  deregistration_delay = 15
  health_check {
    path                = "/health"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}
resource "aws_lb_listener" "api" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
resource "aws_launch_template" "node" {
  name_prefix   = "cs6620-team5-"
  image_id      = data.aws_ssm_parameter.ami.value
  instance_type = var.instance_type
  iam_instance_profile { name = data.aws_iam_instance_profile.lab.name }
  vpc_security_group_ids = [aws_security_group.node.id]
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }
  credit_specification { cpu_credits = "standard" }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "cs6620-team5-node", Project = "cs6620-team5", Stage = "hosting" }
  }
  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    image_uri         = var.image_uri
    registry          = split("/", var.image_uri)[0]
    connection_base64 = base64encode(jsonencode(data.terraform_remote_state.storage.outputs.connection))
    token_parameter   = local.token_parameter
    log_group         = data.terraform_remote_state.artifacts.outputs.runtime_log_group
  }))
}
resource "aws_autoscaling_group" "nodes" {
  name                      = "cs6620-team5-nodes"
  min_size                  = 2
  desired_capacity          = 2
  max_size                  = 2
  vpc_zone_identifier       = [for s in aws_subnet.private : s.id]
  target_group_arns         = [aws_lb_target_group.api.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 600
  wait_for_capacity_timeout = "15m"
  wait_for_elb_capacity     = 2
  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
      max_healthy_percentage = 100
      instance_warmup        = 90
    }
  }
  tag {
    key                 = "Project"
    value               = "cs6620-team5"
    propagate_at_launch = true
  }
  depends_on = [aws_route_table_association.private, aws_vpc_endpoint.gateway, aws_lb_listener.api]
}
resource "aws_apigatewayv2_vpc_link" "api" {
  name               = "cs6620-team5"
  security_group_ids = [aws_security_group.link.id]
  subnet_ids         = [for s in aws_subnet.private : s.id]
}
resource "aws_apigatewayv2_api" "api" {
  name          = "cs6620-team5"
  protocol_type = "HTTP"
}
resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = aws_lb_listener.api.arn
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.api.id
  payload_format_version = "1.0"
  timeout_milliseconds   = 29000
  request_parameters     = { "overwrite:path" = "$request.path" }
}
resource "aws_apigatewayv2_route" "api" {
  for_each  = toset(["GET /", "GET /health", "POST /v1/jobs", "GET /v1/jobs/{id}"])
  api_id    = aws_apigatewayv2_api.api.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}
resource "aws_apigatewayv2_stage" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 2
  }
  access_log_settings {
    destination_arn = data.terraform_remote_state.artifacts.outputs.gateway_log_group_arn
    format          = jsonencode({ requestId = "$context.requestId", route = "$context.routeKey", status = "$context.status", latency = "$context.responseLatency" })
  }
}
resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  alarm_name          = "cs6620-team5-api-capacity"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 2
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
}
resource "aws_cloudwatch_metric_alarm" "dead" {
  alarm_name          = "cs6620-team5-dead-queue"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = "cs6620-team5-dead" }
}
output "endpoint" { value = aws_apigatewayv2_api.api.api_endpoint }
output "asg_name" { value = aws_autoscaling_group.nodes.name }
output "target_group_arn" { value = aws_lb_target_group.api.arn }
output "instance_type" { value = var.instance_type }
output "vpc_id" { value = aws_vpc.project.id }
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "cs6620-team5-job-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 120
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = "cs6620-team5-jobs" }
}
