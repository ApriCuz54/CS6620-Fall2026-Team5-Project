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
variable "aws_account_id" {
  type = string
}
provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]
  default_tags {
    tags = { Project = "cs6620-team5", ManagedBy = "Terraform", Stage = "hosting-assets" }
  }
}
resource "aws_ecr_repository" "runtime" {
  name                 = "cs6620-team5-runtime"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  encryption_configuration {
    encryption_type = "AES256"
  }
}
resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/cs6620/team5/runtime"
  retention_in_days = 3
}
resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/cs6620/team5/gateway"
  retention_in_days = 3
}
output "repository_url" {
  value = aws_ecr_repository.runtime.repository_url
}
output "runtime_log_group" {
  value = aws_cloudwatch_log_group.runtime.name
}
output "gateway_log_group_arn" {
  value = aws_cloudwatch_log_group.gateway.arn
}
