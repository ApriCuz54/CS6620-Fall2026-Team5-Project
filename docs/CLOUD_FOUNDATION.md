# AWS queue/storage milestone

The API and dummy worker still run on your laptop, but can now use AWS for source objects, durable job state, queueing and private reports. This is not a public cloud deployment and is not ready for teammate handoff. Dummy results always have mode=dummy, gate=NOT_EVALUATED and mergeAllowed=false. The original supplied scanner service is unchanged and separate.

## What is being deployed

One DynamoDB on-demand jobs table with a pending-dispatch index, one SQS queue and DLQ, and two dedicated project S3 data buckets with encryption, public-access blocking, HTTPS-only policies and expiry rules. Terraform state has a separate storage/terraform.tfstate key in the original project state bucket. No assignment bucket is reused. Bucket existence is an automated CLI bootstrap exception to the lab's Object Lock restriction; supported settings remain managed by Terraform.

No EC2, ALB, NAT gateway, VPC link, public API Gateway endpoint, new IAM role or custom KMS key is created by this milestone. SSM/GitHub deployment token provisioning is not done. Local tokens stay in ignored .local files.

## Run the AWS-backed development flow

Start the Learner Lab and refresh the local cs6620-lab credentials if necessary. From the project root:

```sh
export AWS_PROFILE=cs6620-lab
npm ci --ignore-scripts
node scripts/write-cloud-connection.mjs
npm run cloud:smoke
```

cloud:smoke uses synthetic source, temporarily starts a loopback API on an available port and runs dummy consumers. It deliberately simulates a lost enqueue attempt, then exercises pending dispatch recovery, duplicate/conflicting submissions, duplicate queue deliveries, private report access and source cleanup. It stops its local processes/clients afterward. It performs real AWS requests and leaves a few synthetic terminal job records/reports for inspection; those expire automatically. It never prints presigned URLs, tokens, source or credential values.

For interactive testing, open three terminals in the project folder. Set AWS_PROFILE in both cloud-process terminals:

```sh
# Terminal 1: API, using the same local development token as the local adapter.
export AWS_PROFILE=cs6620-lab
npm run api:cloud
```

```sh
# Terminal 2: separate dummy worker. Stop with Ctrl+C when finished.
export AWS_PROFILE=cs6620-lab
npm run worker:cloud
```

```sh
# Terminal 3: client; this makes HTTP calls and does not require AWS credentials.
npm run cloud:demo
npm run cloud:demo -- high
npm run cloud:demo -- error
```

The API is still http://127.0.0.1:3200, available only on your laptop. Stop both long-running processes with Ctrl+C after testing so they do not keep polling AWS. Your existing local file-based API on port 3100 can remain separate, but neither is a shared internet endpoint.

## Submission, dispatch and claims

1. The API validates the same bounded JavaScript submission and exact repository/PR/SHA identity. It uploads source under a unique generation-specific key. Submitted JavaScript is never executed.
2. A conditional DynamoDB write creates one job with a PENDING dispatch marker in the same record. That record is the durable outbox. If a write response is lost, the adapter reconciles with a strongly consistent read and does not delete possibly accepted source.
3. The API sends only version/jobId/generation to SQS, then clears the marker conditionally. A crash after send can duplicate delivery, not silently lose the recorded job. The API retries pending markers through the index every five seconds while it is running. There is no independently deployed always-on dispatcher yet.
4. Separate workers claim the job using a conditional update and a unique lease token. One claim wins. Visibility is 60 seconds; leases are 30 seconds, renewed every ten seconds with a visibility extension. A stale owner cannot commit completion.
5. The worker checks source integrity against the accepted digest, builds a dummy result, uploads it under a lease-specific report key and conditionally marks the job terminal. It then attempts source deletion and acknowledges the message. Redelivery of a terminal job is harmless; obsolete generations are ignored.
6. The authenticated status endpoint issues a 60-second S3 presigned URL for the recorded report key. Temporary lab credentials can make the URL expire sooner. Reports contain metadata and synthetic findings, not source/evidence. Possession of the signed URL grants temporary access to that report. Unsigned reads remain denied.

Sources have one-day lifecycle expiration, with immediate best-effort deletion after terminal processing. Reports expire after seven days. Metadata becomes logically unavailable after 24 hours, then DynamoDB TTL eventually removes it. Jobs have a 15-minute development processing deadline; polling or dispatch attempts make overdue jobs explicitly FAILED, not passing. DLQ redrive is after five receives; transient worker errors are bounded to three claimed attempts. A job that reaches the DLQ without terminal metadata requires investigation; there is no automated DLQ reconciler or alarm yet.

## Cost assumptions, not a spending guarantee

No new hourly compute/network resource is used in this stage. Charges are requests, stored bytes and any data transfer. For a small test envelope, reserve $1 of the last reported $45 for storage-only development. This is a planning allowance, not an enforced dollar cap or a current balance reading.

Illustrative monthly envelope: 10,000 DynamoDB write units and 10,000 read units total including the index; 10,000 standard SQS requests; 10,000 S3 PUT/LIST operations and 10,000 GET operations; 1 GB-month S3 Standard and 1 GB-month total DynamoDB/index storage. Ignoring free tiers, the request/storage arithmetic is about $0.34: DynamoDB requests $0.0075, SQS $0.004, S3 requests $0.054, S3 storage $0.023 and DynamoDB storage $0.25. Allow extra for transfers and setup/teardown requests. Actual item sizes, index writes, retries and polling determine billable units. Stop testing processes when idle. This estimate excludes existing account resources and the later compute/network architecture.

Rate evidence checked October 25, 2026: regional AWS public S3 price list (published October 15) and SQS list (published September 11), plus DynamoDB US East on-demand pricing examples. S3 Standard: $0.023/GB-month, PUT/LIST $0.005/1,000, GET $0.0004/1,000. Standard SQS first paid tier: $0.40/million requests. DynamoDB Standard: $0.625/million write units, $0.125/million read units, storage $0.25/GB-month. No free-tier credit is assumed.

Sources:
- https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json
- https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSQueueService/current/us-east-1/index.json
- https://aws.amazon.com/dynamodb/pricing/
- https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html

## Still required before a shared cloud handoff

The public HTTPS entry point and private two-node deployment; EC2 LabInstanceProfile permission proof; deployable API/worker images; SSM verifier provisioning/rotation; independent dispatcher operation; rate/admission controls before public exposure; real scanner sandboxes; production worker contracts; DLQ reconciliation/alarms; cost estimate for ALB, EC2, NAT and endpoints; controlled session shutdown/restart; cancellation/required GitHub checks; failure/lease recovery drills on actual instances. The smoke test proves the laptop identity can use the AWS services, not that the instance role can or that an AWS host survives failure.
