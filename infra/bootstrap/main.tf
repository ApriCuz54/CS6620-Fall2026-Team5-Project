terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]
  default_tags {
    tags = { Project = "cs6620-security-gate", ManagedBy = "Terraform" }
  }
}

variable "aws_account_id" {
  type        = string
  description = "Expected Learner Lab AWS account; prevents deployment to a different account"
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Supply the 12-digit Learner Lab account ID."
  }
}

variable "aws_region" {
  type        = string
  description = "Verified Learner Lab region"
}

variable "bucket_name" {
  type        = string
  description = "Globally unique private Terraform state bucket name"
  validation {
    condition     = length(var.bucket_name) >= 3 && length(var.bucket_name) <= 63 && can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.bucket_name))
    error_message = "Use an S3-compatible unique bucket name, 3-63 characters."
  }
}

# The Learner Lab SCP denies the Object Lock read performed by aws_s3_bucket.
# Preserve the already-created bucket and stop managing its base lifecycle.
# Bootstrap bucket creation is documented in ../README.md; supported security
# settings below remain managed by Terraform. Never destroy this state bucket.
removed {
  from = aws_s3_bucket.state
  lifecycle {
    destroy = false
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = var.bucket_name
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = var.bucket_name
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = var.bucket_name
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "tls_only" {
  bucket = var.bucket_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = ["arn:aws:s3:::${var.bucket_name}", "arn:aws:s3:::${var.bucket_name}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

output "state_bucket" {
  value = var.bucket_name
}
