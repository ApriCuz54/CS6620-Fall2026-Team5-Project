# Terraform state bootstrap (Learner Lab compatible)

The project keeps Terraform state in a separate private, encrypted, versioned S3 bucket with S3 native state locking. It is not the reports/source bucket. Use the permitted lab profile, us-east-1 and the existing LabRole/LabInstanceProfile for later compute resources. Never put credentials or service tokens in Terraform inputs/state.

## Why bucket creation is a separate bootstrap step

The lab organization policy explicitly denies s3:GetBucketObjectLockConfiguration. The Terraform AWS provider's base aws_s3_bucket resource reads that configuration even when Object Lock is not enabled, so a normal bucket create can succeed and then fail on refresh. ignore_changes would not stop that read. We do not change the lab policy or enable Object Lock.

The base state bucket is bootstrapped once outside the base Terraform bucket resource. Terraform manages its four supported protections: public access blocking, versioning, AES256 default encryption and HTTPS-only bucket policy. The removed block with destroy=false preserves the bucket from the initial failed attempt and discards only its unsupported base-resource tracking. It does not delete data. Do not reimport it into aws_s3_bucket while this lab restriction remains.

The bucket itself is intentionally outside Terraform lifecycle management: inventory it separately and never delete it during application teardown. Object Lock is unrelated to Terraform's S3 .tflock locking; the latter uses normal S3 objects.

## Existing project

The configured project bucket is recorded in ignored infra/bootstrap/terraform.tfvars. First inspect current state and run a new plan. Obsolete bootstrap/repair plans were archived under ignored .local; do not reuse them after migration. A private local backup was saved under .local before the repair. See docs/SETUP_STATUS.md for the latest verified status.

```sh
export AWS_PROFILE=cs6620-lab
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap plan -out=review.tfplan
# Review the plan, then apply it only if expected.
terraform -chdir=infra/bootstrap apply review.tfplan
```

## Reproducing in a fresh lab account

Each fresh account needs its own uniquely named bucket and independent state. A teammate's individual lab credentials do not grant access to this project's bucket.

1. Verify session identity and expected account. Copy terraform.tfvars.example to terraform.tfvars and set aws_account_id, aws_region and a unique bucket_name. Keep these and all state out of Git.
2. Create the base bucket once using the supported S3 CLI. For us-east-1 (replace the placeholder):

```sh
aws s3api create-bucket --bucket YOUR_UNIQUE_STATE_BUCKET --region us-east-1
```

Use this only for a genuinely new bucket in your account; do not recreate or delete an existing project bucket. The command relies on the selected AWS_PROFILE. Other regions require the appropriate LocationConstraint.

3. For a fresh account, temporarily move bootstrap/backend.tf outside the stack (for example into ignored .local) before initializing; restore it at step 4. If reusing an already-initialized checkout, use a fresh checkout for the new account so cached backend configuration cannot target the old account. With no backend.tf present, initialize this stack and plan/apply the four protections. The removed block is harmless in a fresh state where the base resource was never tracked. Verify all four settings before using the bucket for remote state.
4. Restore bootstrap/backend.tf, or copy bootstrap/backend.tf.example to bootstrap/backend.tf if it does not yet exist. Copy backend.hcl.example to bootstrap/backend.hcl and set the exact bucket/region, key bootstrap/terraform.tfstate, encrypt=true and use_lockfile=true.
5. Run terraform -chdir=infra/bootstrap init -migrate-state -backend-config=backend.hcl. Inspect the destination before accepting migration. Keep a private local backup until the remote state is verified. Never overwrite another deployment's state.
6. Verify terraform state list, a no-change plan, bucket versioning/encryption/public-access/policy, and the remote state object. Do not print/download state into chat or commit it.

## Application infrastructure

infra/app remains a placeholder. Build and review the API Gateway/VPC link/internal ALB/two private ASG nodes and supporting resources only after lab feasibility and cost checks. Use the same state bucket but a distinct key app/terraform.tfstate. Never mix application and bootstrap keys.

Commit .terraform.lock.hcl, not .terraform/, backend.hcl, tfvars, state or binary plans. All authorized operators of one deployment must use its same state/key and lockfile. Individual lab deployments require separate state. Avoid Terraform destroy on the bootstrap stack; it protects long-lived state rather than disposable application infrastructure.

References:
- https://developer.hashicorp.com/terraform/language/state/remove
- https://developer.hashicorp.com/terraform/language/backend/s3
- https://github.com/hashicorp/terraform-provider-aws/blob/main/internal/service/s3/bucket.go
