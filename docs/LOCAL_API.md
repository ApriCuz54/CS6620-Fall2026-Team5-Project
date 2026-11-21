# Local API and dummy worker: development foundation

This is the next local milestone, not the cloud handoff. Nothing here creates AWS resources. The provided SAST service still runs separately on port 3000. This job API uses Express, runs on port 3100 and simulates results instead of scanning code. Every job, error and report contains mode=dummy, gate=NOT_EVALUATED and mergeAllowed=false. Never use a completed dummy job to satisfy the real security merge check.

## Start and try it

From the project root:

```sh
npm ci --ignore-scripts
npm run test:foundation
npm run api:dev
```

Keep that terminal open. In a second terminal in the same project root:

```sh
npm run api:demo
npm run api:demo -- high
npm run api:demo -- error
```

Open http://127.0.0.1:3100/ for a short API description or /health for its health check. Stop with Ctrl+C. No AWS credentials are needed. SCANNER_PORT overrides 3100; SCANNER_REPOSITORY overrides the allowed owner/repository. Set the same overrides for the server and demo.

The first start generates a random service token in ignored .local/dev-api-token and an independent signing key in .local/dev-report-signing-key. Both files have owner-only access and are never printed. The demo reads the token automatically. They are local development secrets, not the future deployed SSM/GitHub secrets. Delete neither key while the server is running; changing the signing key invalidates previous report links.

## Request/result contract

See ../contracts/README.md and ../contracts/examples/submit-clean.json. Submit with POST /v1/jobs and Authorization: Bearer <local-token>. Poll GET /v1/jobs/:jobId using the same header. The completed status includes a 60-second signed report URL. That link is a temporary bearer capability: anyone possessing it can read that one report until expiration. It does not also require the service header. All responses prohibit caching.

The dummy report omits source text and evidence. A client must inspect mode, gate and mergeAllowed, not just HTTP 200, job completion or the HIGH count. No dummy result permits merging. The local API has no original /scan/file or /scan/directory route and never accepts host filesystem paths.

## Persistence and worker behavior

The local adapter stores one bounded JSON document in .local/gate/jobs.json using a temporary file and atomic rename. Submission records both the job and queued state together; queued jobs are discovered from that same record. There is one local API process, with an embedded dummy worker processing one job at a time. Additional requests queue rather than receiving a busy reply. A duplicate repository/PR/exact-SHA submission with matching normalized payload returns the same job; changing that payload returns 409. Terminal jobs drop submitted source; expired jobs return 404 and are physically removed on the next successful new submission.

The file store has a single-writer lock and is deliberately unsuitable for multiple API instances or workers. Graceful shutdown removes the lock. If the process is force-killed, jobs remain but a stale writer.lock can remain. Confirm the PID recorded in that file is no longer running before removing only that lock file and restarting. Never delete jobs.json just to hide a failure. Startup requeues interrupted RUNNING dummy jobs; this is not a distributed lease/recovery implementation. Disk corruption fails startup instead of silently discarding jobs. Atomic rename is useful locally but is not a cloud durability guarantee.

## Limits

JSON body: 256 KiB; 1-25 unique JS/MJS/CJS files; each source file <=64 KiB UTF-8; all source <=128 KiB; relative ASCII paths <=200 characters, no traversal or backslashes; 100 retained local jobs; 24-hour local job lifetime. Capacity exhaustion returns 503 with Retry-After: 2. The client should retry transient 503/network failures within a deadline, not retry invalid input or conflicting submissions. A report link can be refreshed through the authenticated status endpoint.

The worker simulates clean/high/error fixtures without executing or evaluating source. Production process isolation, no-network sandboxes, per-scan wall deadlines, distributed claims, bounded production retry policy and actual SAST reports still need implementation. This file-based adapter uses no SQS, DynamoDB or S3 report upload. A separate AWS-storage development adapter is now available: see CLOUD_FOUNDATION.md. Neither adapter yet supplies cloud token rotation, PR cancellation or a public AWS-hosted API.

## Teammate use

Arvind can start using this local mock API to prototype submit/poll/report handling and unhappy paths. It can also be started in a GitHub runner for isolated integration tests, without AWS credentials; no workflow is installed yet. Chengyuan can use the submission/report examples to discuss the scanner adapter. Cloud worker lease/outbox contracts are intentionally not frozen by this local implementation. Aditya still owes the real cloud API/dummy-worker roundtrip and all handoff gates before either teammate depends on the shared deployment.
