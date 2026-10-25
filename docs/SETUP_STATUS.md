# Setup status — October 25, 2026

Location: ~/Desktop/CloudComputing/Team Project
Source: git@github.com:aanchan/cs6620.git
Cloned source revision: 9df1cf6 (main).

## Verified

- Fresh remote clone completed; original clone under Desktop/Repos was left intact.
- Node.js 24.3.0, npm 11.4.2, Git, Docker CLI/Compose, Terraform 1.16.6 and AWS CLI v2 are installed.
- Provided scanner smoke test passes: HIGH finding detected in vulnerable input, clean input has no HIGH findings.
- Original Express service tested briefly on a local test port: health and both scan cases pass. Test server stopped afterward.
- Setup scripts pass JavaScript syntax checks; Docker Compose configuration parses successfully.
- Terraform starter formatting checked. State bootstrap passes Terraform validation with AWS provider 6.70.0; provider lockfile included.

## Latest evidence and pending checks

- Local Docker image build, healthy container startup and HTTP smoke tests passed, as reported by Aditya. Docker is running.
- Local AWS profile identity passed. Region: us-east-1. Remaining budget reported: $45. LabRole through LabInstanceProfile confirmed. Six Availability Zones listed. S3/SQS/DynamoDB/SSM/ACM/API Gateway list requests succeeded. Creation and EC2 runtime permissions remain unverified.
- Three older t3.micro instances were running; Aditya is stopping them. No load balancers, NAT gateways or Auto Scaling groups were listed. Existing assignment bucket must be preserved.
- No owned domain confirmed. Proposed entry point: API Gateway default HTTPS endpoint via VPC link to an internal ALB. This replaces the public-ALB certificate requirement; creation permissions and full cost estimate remain to be validated.
- Team remote origin is git@github.com:ApriCuz54/CS6620-Fall2026-Team5-Project.git; instructor source is retained as upstream. Remote access succeeded and no refs were listed. Repository root moved to ~/Desktop/CloudComputing/Team Project. Collaborator invitations are not verified. Reviewed setup committed as 9a9597f and pushed to team origin/main. New local API foundation is on the local foundation/local-api branch for review.
- State bootstrap initial create partially succeeded but the provider refresh hit a lab SCP denial for s3:GetBucketObjectLockConfiguration. The base bucket was retained using a removed block with destroy=false; four supported security resources were successfully applied. Versioning, AES256 encryption, public-access blocking and HTTPS-only policy were independently verified. Local state was backed up and migrated to S3 at bootstrap/terraform.tfstate with native lockfiles. Final normal locked remote plan succeeded with no changes, and four supported security resources are tracked. Application infrastructure remains unbuilt.
- Local-only authenticated Express job API, persistent single-writer file store, embedded dummy worker, v1 mock contract, signed report links and demos are implemented. Twenty-five local/offline regression tests and the original scanner smoke test pass. End-to-end server/demo runs for clean, HIGH and failure simulations pass. All dummy results explicitly prohibit merge approval. AWS-backed development adapter and separate dummy worker are implemented and live-tested using the laptop lab identity: real S3 source/report operations, DynamoDB pending-dispatch state and conditional claims, SQS duplicate handling, signed report access and immediate source cleanup. Simulated failed enqueue recovery passed. The actual API and dummy workers are now hosted on two private t3.micro nodes with LabInstanceProfile. ECR pulls, CloudWatch logs, SSM verifier reads and the hosted job/report flow using the instance role are verified. Full EC2 host replacement and real scanner recovery remain unverified.
- Public HTTPS API/dummy-worker roundtrip is verified at the URL in docs/HOSTING.md. Production worker contract approval, real scanner sandbox and GitHub merge gate remain unimplemented; handoff gates remain open. See docs/CLOUD_FOUNDATION.md for the earlier hybrid laptop/AWS milestone and a storage-only cost allowance. All new foundation work remains local/uncommitted for review.

The state bucket plus the storage foundation are deployed. Storage foundation: two new private project input/report buckets; 14 Terraform-managed settings/resources covering their protections, one on-demand DynamoDB table/index, jobs queue, DLQ and queue policies. A final normal plan reports no changes. Hosting assets (ECR, two 3-day log groups) and 46 app/network resources were created: two private t3.micro ASG nodes, two NAT gateways/EIPs, internal ALB, API Gateway/VPC link, gateway endpoints, SGs and three alarms. Raw deployment token stays local; encrypted verifiers were provisioned outside Terraform. No assignment resources were modified; reviewed setup was pushed to GitHub. Subsequent local API foundation changes remain uncommitted on foundation/local-api for review. See START_HERE.md for your next steps.

## Shared hosting milestone verified

Public endpoint: https://b0dx4i7jcl.execute-api.us-east-1.amazonaws.com. Two private t3.micro nodes in different AZs, LabInstanceProfile, internal ALB and API Gateway VPC link. No SSH or instance public IP configured. SSM stores encrypted verifier hashes; raw deployment service token is only in ignored .local/deployment-service-token. 25 automated tests pass. Hosted auth/clean/HIGH/error/duplicate/report tests, 128 KiB input and HTTP-only client without AWS credentials pass. Reversible application outage on one node passed through the remaining node; both were restored and ASG processes resumed. No actual EC2 termination or AZ outage was tested. Normal Terraform app plan has no changes. Post-test available memory 415-419 MiB per node; no OOM or automatic restarts. Micros fit this dummy workload, not proven for real scanner. Hourly hosting remains active until app teardown (about $0.15/hour base plus usage). New source/IaC changes remain uncommitted on foundation/local-api for review.
