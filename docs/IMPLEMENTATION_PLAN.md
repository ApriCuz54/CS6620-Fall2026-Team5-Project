# Build order and ownership

## Goal stays the same

One repository, JavaScript SAST using the supplied code, GitHub PR merge gate based on the exact commit, HIGH findings block, corrected commit passes, private redacted S3 report via an expiring link. Errors/timeouts/incomplete work never produce a passing security result. Pentesting, extra languages, multi-tenancy and a custom dashboard are outside the required build.

## Aditya Chatterjee: foundation first

1. Finish all feasibility and setup gates in FEASIBILITY.md, including budget and HTTPS. Domain-free HTTPS through API Gateway, a VPC link and internal ALB was deployed and tested; see HOSTING.md for evidence, cost estimates and remaining gates.
2. Configure the team repository and shared Terraform state. Build AWS application infrastructure as code: API Gateway default public HTTPS endpoint, VPC link to an internal ALB, two private EC2 ASG nodes across two AZs, approved instance profile, security groups, outbound paths, S3/DynamoDB endpoints, SQS/DLQ, DynamoDB, encrypted S3 inputs/reports, logs/alarms. The dummy hosting infrastructure is implemented and has passed hosted tests; it remains disposable between testing sessions.
3. Define versioned request/job/result contracts and sample fixtures. Fix input size/file/path limits, severity policy, request identity (repository/PR/exact SHA), retry/time budgets, job lifecycle and ownership/lease behavior. Publish examples and a mock adapter; endpoint names are not frozen by this setup.
4. Implement the Express API, token verification, source validation/storage, durable submission/idempotency/outbox, job status and authorized report links. API never receives the Docker socket.
5. Implement a clearly labeled dummy worker with deterministic example results. Prove the request → queued → processing → terminal status → report roundtrip on AWS. The dummy result is development-only and must never enable the real required check.
6. Give both teammates a runnable foundation, exact contracts, mocks, examples and troubleshooting instructions. Complete HANDOFF_CHECKLIST.md.
7. Lead deployment, integration and shared incident/runbook work. Own service-token provisioning and rotation.

## Arvind Dharmesh Parekh: GitHub workflow/client

After the same foundation handoff, independently implement code collection, authenticated submit/poll, bounded retries/backoff, per-PR cancellation, exact-SHA required check, pass/fail/error presentation and expiring report links. Add end-to-end workflow tests for vulnerable/clean PRs, simultaneous pushes, superseded commits and temporary failures. Document how developers use and troubleshoot it. Use the mock API while Chengyuan builds the real worker.

## Chengyuan Sun: real worker and sandbox

After the same handoff, independently implement the provided SAST wrapper/image, SQS claim/visibility renewal, DynamoDB leases/conditional completion, duplicate delivery and crashed-worker recovery. Run every job in a fixed non-root container with CPU/RAM/PID/wall-clock bounds, dropped capabilities, read-only filesystem, bounded writable space and no network/host credentials/socket. Never execute submitted JavaScript. Sanitize reports, upload bounded results and always clean up. Test timeout, malformed input, resource exhaustion, duplicate delivery and recovery. Use contract fixtures while Arvind builds the client.

## Integration: all three, Aditya leads

Each owner fixes their component. Replace the dummy worker, run the full PR gate, burst/duplicate/cancellation/resource/failover cases, rotation drill and final demo. Two EC2 nodes remain the baseline; queueing handles busy workers so requests need not be rejected just because a scan is active. Infrastructure and security updates do not change our final project goals.
