# Storage and queue foundation only

This stack manages one on-demand DynamoDB jobs table with a pending-dispatch index, one SQS jobs queue, a DLQ, queue policies, and supported protections/lifecycle rules for two separately bootstrapped project S3 buckets. It creates no EC2, API Gateway, ALB, NAT, new IAM roles or custom KMS keys.

State uses storage/terraform.tfstate in the existing private state bucket. Do not use the bootstrap key. The input/report buckets are distinct from the state bucket and all assignment buckets. The CLI bootstrap is required by the verified lab Object Lock read restriction; do not add aws_s3_bucket resources that reintroduce it.

After confirming AWS_PROFILE=cs6620-lab and a current session, run from the repository root (replace ACCOUNT with the expected 12-digit account):

```sh
node scripts/prepare-cloud-storage.mjs --account ACCOUNT --create-buckets
terraform -chdir=infra/storage init -backend-config=backend.hcl
terraform -chdir=infra/storage validate
terraform -chdir=infra/storage plan -out=storage.tfplan
# Review resource names, account and additions before applying.
terraform -chdir=infra/storage apply storage.tfplan
```

Then export the non-secret connection output to ignored .local/cloud-connection.json using scripts/write-cloud-connection.mjs. The scripts never store credentials in the repository. Each separate account needs its own state bootstrap/configuration, not access to Aditya's state.

Inputs expire through S3 lifecycle after one day, reports after seven days; expiration is asynchronous. Successful dummy jobs also try to delete their source immediately. DynamoDB records expire logically after 24 hours and are later deleted by TTL. Queue retention is one day and DLQ seven days. Default S3 encryption is AES256; SQS uses SQS-managed encryption; DynamoDB uses its default encryption. No public read policy is installed. These are development retention choices, not long-term audit storage.

Cost: request-based storage/queue operations only, plus stored bytes; no new hourly compute/network resources. DynamoDB has on-demand request ceilings of 20 read/write units per second on both table and index, but these are not a dollar budget or account-wide cap. Stop the local API/outbox/worker when not testing. See docs/CLOUD_FOUNDATION.md for current evidence and constraints.

Teardown: review a storage-stack destroy plan separately from compute. It can remove the table and queues (including their records/messages). Bucket security/lifecycle settings are Terraform-managed, but base bucket deletion and object purging are explicit manual inventory steps because their base resources are not managed. Never delete the Terraform state bucket or assignment buckets as part of this teardown.
