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
- Team remote origin is git@github.com:ApriCuz54/CS6620-Fall2026-Team5-Project.git; instructor source is retained as upstream. Remote access succeeded and no refs were listed. Repository root moved to ~/Desktop/CloudComputing/Team Project. Collaborator invitations are not verified. No project changes have been committed or pushed.
- State bootstrap initial create partially succeeded but the provider refresh hit a lab SCP denial for s3:GetBucketObjectLockConfiguration. The base bucket was retained using a removed block with destroy=false; four supported security resources were successfully applied. Versioning, AES256 encryption, public-access blocking and HTTPS-only policy were independently verified. Local state was backed up and migrated to S3 at bootstrap/terraform.tfstate with native lockfiles. Final normal locked remote plan succeeded with no changes, and four supported security resources are tracked. Application infrastructure remains unbuilt.
- Asynchronous API, dummy-worker foundation, agreed contracts, real worker and GitHub merge gate are not implemented.

Only the project state bucket and its four protection settings have been created. No application EC2, ALB, NAT gateway or API Gateway resources were created; no GitHub changes were pushed. Added setup files remain uncommitted for review. See START_HERE.md for your next steps.
