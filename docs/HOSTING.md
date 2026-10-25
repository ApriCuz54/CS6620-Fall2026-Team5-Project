# Shared AWS hosting — deployment and shutdown

The hosting stack preserves the project goals: JavaScript SAST merge gate, exact-commit results, private reports, errors never pass. This milestone hosts the dummy API/worker only; it is not the final scanner or the complete teammate handoff.

## Design

Public AWS-managed HTTPS URL → API Gateway HTTP API (2 requests/sec, burst 10) → VPC link → internal ALB → two private EC2 nodes across us-east-1a/us-east-1b. Each node runs separate non-root API and dummy-worker containers. API gets no Docker socket; no SSH ingress or public instance IP is configured. ALB accepts traffic only from the link security group; nodes accept port 3200 only from the ALB group. TLS ends at API Gateway; the link/ALB/node hop is HTTP inside the VPC. External callers need a service bearer token for job endpoints. Health/root endpoints contain no sensitive data.

Two public-subnet NAT gateways provide outbound bootstrap/ECR/SSM access, one per zone. S3/DynamoDB gateway endpoints avoid NAT for those services. The lab's existing LabInstanceProfile/LabRole is reused; custom least-privilege IAM roles cannot be created in this lab. IMDSv2 is required; hop limit 2 permits the AWS SDK in runtime containers to obtain the instance role. Submitted source never runs in either runtime container. A future real scan sandbox must have no network/metadata access.

Default trial size is two t3.micro nodes (1 GiB each), not an assertion that micro is enough for the final scanner. API and worker each have a 256 MiB memory ceiling, 0.5 CPU, read-only filesystem and small /tmp. T3 uses Standard CPU credits to avoid Unlimited surplus-credit charges. Measure host available memory, container RSS and OOM/restarts under workload. Upgrade only on evidence; final scanner memory must be tested independently. Two t3.small nodes are an available configuration if micro lacks headroom.

## Separate state and retained assets

- bootstrap/terraform.tfstate: state-bucket protections.
- storage/terraform.tfstate: persistent job storage/queues and data-bucket settings.
- artifacts/terraform.tfstate: private immutable ECR repository and 3-day runtime/API access logs.
- app/terraform.tfstate: disposable VPC, NAT, ALB, API Gateway, ASG and alarms.

Every backend is in the existing encrypted/versioned private state bucket with native lockfiles. Destroying app must not destroy storage, artifacts, token verifier or the state bucket. No assignment resources are managed by this stack.

## Authentication

Raw shared service token is generated in ignored .local/deployment-service-token with owner-only access. SSM SecureString /cs6620/team5/api-token-verifiers stores SHA256 hashes, not the raw token. The API reads/decrypts it using LabRole; values are never passed through Terraform variables/state, startup user-data or container environment. Cache lifetime is 60 seconds; failures after expiry fail closed. Readiness requires a valid verifier. Do not commit or print the raw token/presigned report URLs.

Initial provisioning is `npm run hosting:token` with AWS_PROFILE set. For rotation: `npm run hosting:token -- --rotate` writes a new local token and publishes new+previous verifier hashes. Update all authorized clients/GitHub secret, allow at least 60 seconds for caches to refresh, then `npm run hosting:token -- --retire-previous`. Previous local token backup remains ignored/private until securely removed. Do not retire overlap until clients have switched. GitHub repository secret provisioning is still a separate authorized step; no secret was automatically sent there.

## Build and deploy

Use a valid active Learner Lab session, export AWS_PROFILE=cs6620-lab and confirm identity. Provision the artifacts stack first, then publish the runtime image. The publisher builds linux/amd64 from the pinned lockfile, excludes .local/.env/state/credentials and records an immutable ECR digest in ignored .local/hosting-image.json. It uses an ECR login password only through stdin, then logs Docker out. Instance startup pulls that digest using its own LabRole, then logs out. No personal lab credentials are copied to EC2.

```sh
export AWS_PROFILE=cs6620-lab
npm run hosting:token
npm run hosting:publish
npm run hosting:prepare -- --instance-type t3.micro
terraform -chdir=infra/app init -backend-config=backend.hcl
npm run hosting:plan
# Review the account, two-instance cap, size and cost before applying.
npm run hosting:apply
npm run hosting:smoke
npm run hosting:demo
```

The app maximum capacity is two; rolling refresh replaces one node at a time. API containers dispatch accepted pending jobs from the shared index, so a node failure does not lose accepted state. Worker claims/lease fencing are backed by DynamoDB. No result in this deployment can approve a merge: mode=dummy, gate=NOT_EVALUATED, mergeAllowed=false. Real sandbox integration and GitHub checks remain separate work.

## Teammate calls without AWS credentials

Once the endpoint is verified, an authorized teammate can set SCANNER_URL and SCANNER_TOKEN in her/his ignored local .env file, then run `npm run hosting:demo`. Share only the scanner service token privately, never the lab credentials. The client uses Node's standard library and does not read Terraform state or call AWS APIs when SCANNER_URL is supplied. The owner fallback reads the endpoint from Terraform and token from ignored .local/deployment-service-token. A future GitHub workflow stores SCANNER_TOKEN as a repository secret. No secret is automatically shared by cloning the repo.

## Pause/teardown before ending the lab session

Stopping instances manually is not the correct shutdown: the ASG can replace them, and NAT/ALB continue charging. To remove the hourly hosting resources while retaining storage and images:

```sh
export AWS_PROFILE=cs6620-lab
npm run hosting:down
```

Review the destroy plan and enter yes only for the intended app-stack resources. This removes the HTTPS endpoint, two ASG nodes, ALB, VPC link, NAT gateways and their Elastic IPs/network. The endpoint can change when recreated; publish the new URL to clients after redeployment. Stateful services and raw local token remain separate. Ending the lab timer is not equivalent to destroying the stack. Lab budget reporting can lag 8-12 hours.

## Cost estimate (us-east-1; checked October 25, 2026)

Two micro instances: 2 × $0.0104/hr = $0.0208/hr. Two NAT gateways: 2 × $0.045/hr = $0.09/hr. Two NAT public IPv4 addresses: 2 × $0.005/hr = $0.01/hr. Internal ALB base: $0.0225/hr. Two 8 GiB gp3 disks at an assumed $0.08/GB-month: about $0.0018/hr. Baseline roughly $0.145/hr ($3.48/day); round to $0.15/hr before usage. Two small instances instead add $0.0208/hr, about $0.50/day.

Additional charges: ALB LCUs ($0.008/LCU-hour), NAT data processing, API requests, logs/alarms, ECR storage, existing S3/DynamoDB/SQS use and any data transfer. No interface endpoints, reserved instances, Spot instances or public IPv4 addresses on the nodes/ALB are used. A few hours of light testing fit the last-reported $45; leaving the stack running continuously is not the intended development practice. This is an estimate, not a budget enforcement mechanism or a live balance reading.

Sources:
- https://docs.aws.amazon.com/prescriptive-guidance/latest/optimize-costs-microsoft-workloads/right-size-selection.html
- https://aws.amazon.com/vpc/pricing/
- https://aws.amazon.com/elasticloadbalancing/pricing/
- https://aws.amazon.com/ebs/pricing/

## Deployment validation required

Confirm two healthy ALB targets in different AZs, no instance public IPs/SSH ingress, SSM and ECR pulls using the instance role, API token acceptance/rejection over HTTPS, real AWS-hosted dummy jobs and private reports, memory/restart measurements on both micros, controlled node replacement/recovery and a clean Terraform plan. Alarms are visible in CloudWatch; no human notification subscription is created automatically. Final real-worker resource exhaustion, report validation, GitHub gating and complete operational handoff remain outstanding.

## Verified first deployment

The deployed URL is https://b0dx4i7jcl.execute-api.us-east-1.amazonaws.com. Two t3.micro nodes were healthy in different AZs, with no public addresses. Public HTTPS health, rejected unauthenticated submission, authenticated clean/HIGH/error dummy jobs, duplicate requests and private reports passed. No laptop worker was running during those hosted checks.

Initial observed memory before the hosted test: API containers about 65-71 MiB; workers about 35-37 MiB; host available memory about 409-418 MiB on 913 MiB usable RAM. No OOM or automatic container restarts. This supports micros for the present dummy workload, not the final scanner. The first fresh Standard-credit nodes had zero CPU credits; package install made startup slow (about eight minutes). Keep sufficient bootstrap grace and do not mistake cold installation time for a steady-state memory shortage.

`npm run hosting:diagnostics` collects read-only measurements via SSM on exactly the two project nodes. `npm run hosting:failover` is an opt-in reversible application outage drill: it temporarily suspends ASG health/replacement processes, stops API/worker on one node, checks the HTTPS flow through the other, restores the node and resumes processes in a finally block. It does not terminate EC2 instances or prove automatic host replacement/AZ failure. Do not run it during someone else's testing. Check the final state has two healthy targets and no suspended processes.

Post-test evidence: a submission at the 128 KiB source limit passed the dummy flow. A client with AWS environment credentials removed and shared credential/config files disabled completed through the public API using only URL/service token. After the reversible one-node application outage, both targets returned healthy and ASG HealthCheck/ReplaceUnhealthy processes were resumed. Host available memory was 415-419 MiB, with API about 40-66 MiB, workers about 29-39 MiB, no OOM and no automatic restarts. A normal Terraform app plan reported no changes. This was not a terminated-host or full-AZ failure test, and it does not establish memory requirements for real SAST.
