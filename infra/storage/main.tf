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
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Supply the expected 12-digit Learner Lab account."
  }
}
variable "aws_region" {
  type    = string
  default = "us-east-1"
  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "This verified lab configuration targets us-east-1."
  }
}
provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]
  default_tags {
    tags = { Project = "cs6620-team5", ManagedBy = "Terraform", Stage = "storage-foundation" }
  }
}
locals {
  prefix = "cs6620-team5"
  buckets = {
    inputs  = { name = "${local.prefix}-inputs-${var.aws_account_id}", days = 1 }
    reports = { name = "${local.prefix}-reports-${var.aws_account_id}", days = 7 }
  }
}

# Bucket existence is a documented, repeatable bootstrap exception: the lab SCP
# denies the Object Lock read that the aws_s3_bucket resource always performs.
# scripts/prepare-cloud-storage.mjs provisions only these two uniquely named
# private buckets; their supported protections are managed below.
resource "aws_s3_bucket_public_access_block" "data" {
  for_each                = local.buckets
  bucket                  = each.value.name
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  for_each = local.buckets
  bucket   = each.value.name
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_policy" "tls" {
  for_each = local.buckets
  bucket   = each.value.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = ["arn:aws:s3:::${each.value.name}", "arn:aws:s3:::${each.value.name}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
resource "aws_s3_bucket_lifecycle_configuration" "data" {
  for_each = local.buckets
  bucket   = each.value.name
  rule {
    id     = "expire-development-artifacts"
    status = "Enabled"
    filter {
      prefix = ""
    }
    expiration {
      days = each.value.days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_dynamodb_table" "jobs" {
  name         = "${local.prefix}-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "dispatchKey"
    type = "S"
  }
  attribute {
    name = "dispatchAfter"
    type = "N"
  }
  global_secondary_index {
    name            = "dispatch-index"
    hash_key        = "dispatchKey"
    range_key       = "dispatchAfter"
    projection_type = "ALL"
    on_demand_throughput {
      max_read_request_units  = 20
      max_write_request_units = 20
    }
  }
  on_demand_throughput {
    max_read_request_units  = 20
    max_write_request_units = 20
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
resource "aws_sqs_queue" "dead" {
  name                      = "${local.prefix}-dead"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 604800
}
resource "aws_sqs_queue" "jobs" {
  name                       = "${local.prefix}-jobs"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 86400
  max_message_size           = 2048
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dead.arn, maxReceiveCount = 5 })
}
resource "aws_sqs_queue_redrive_allow_policy" "dead" {
  queue_url            = aws_sqs_queue.dead.url
  redrive_allow_policy = jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.jobs.arn] })
}
resource "aws_sqs_queue_policy" "tls" {
  for_each  = { jobs = aws_sqs_queue.jobs, dead = aws_sqs_queue.dead }
  queue_url = each.value.url
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "sqs:*", Resource = each.value.arn
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
output "connection" {
  description = "Non-secret identifiers for the development adapter; no credentials."
  value = {
    accountId    = var.aws_account_id
    region       = var.aws_region
    tableName    = aws_dynamodb_table.jobs.name
    queueUrl     = aws_sqs_queue.jobs.url
    deadQueueUrl = aws_sqs_queue.dead.url
    inputBucket  = local.buckets.inputs.name
    reportBucket = local.buckets.reports.name
  }
}
