# Handoff for Chengyuan Sun

Prepared October 25, 2026. Your component: real SAST worker and per-scan isolation.

## Your goal in simple words

Replace simulated scans with the supplied JavaScript scanner. Each scan gets its own short-lived container with strict resource limits, so one slow or faulty scan cannot consume the host indefinitely. Return a sanitized report and clean up afterward. Submitted JavaScript is text to inspect; never run it.

You can build and test the scanner container on your laptop without Arvind's workflow, AWS credentials or deployed hosting. Aditya owns the shared API, infrastructure, deployment and final integration. Arvind owns GitHub submit/poll/check behavior. You own the scanner adapter, isolation, worker execution and worker acceptance tests.

## Starting code and ownership

Working baseline: branch `foundation/local-api`, commit `faa1d75`. These handoff files are a later local addition until Aditya publishes them. Do not assume `main` contains the foundation yet.

```sh
git clone git@github.com:ApriCuz54/CS6620-Fall2026-Team5-Project.git
cd CS6620-Fall2026-Team5-Project
git switch --track origin/foundation/local-api
git switch -c feature/real-sast-worker
npm ci --ignore-scripts
npm test
```

If you already cloned, save your own changes, fetch origin and branch from `origin/foundation/local-api`. Use Node.js 24.x and Docker Desktop for local scanner development. Terraform/AWS CLI are not needed for the first local milestone.

Start by reading:

- `sast/backend/scanner.js`: supplied engine; `scanCode(content, filename)` returns findings.
- `scripts/scanner-smoke.mjs`: small vulnerable and clean examples using that engine.
- `Dockerfile.sast` and `compose.yaml`: existing local HTTP service, not the final per-job scanner container.
- `services/cloud/worker.mjs`: existing dummy worker claims, heartbeat and completion logic.
- `services/cloud/store.mjs`: bounded source reader, report upload and source deletion.
- `contracts/CLOUD_WORKER.md`: current dummy queue/lease/storage conventions; some historical deployment notes are stale, so use docs/HOSTING.md for hosting evidence.
- `tests/cloud.test.mjs`: dependency-injected cloud worker/storage examples.

Suggested new paths: `services/scanner/` for the one-shot runner/adapter, `Dockerfile.scanner` for its image, and `tests/scanner-worker.test.mjs` for acceptance tests. These do not exist yet. Coordinate edits to shared worker/contracts/package.json with Aditya; do not replace the supplied detection engine or add pentesting.

## First local checks

```sh
npm test
npm run local:up
npm run test:http
npm run local:down
```

The HTTP service is optional background context: it checks the existing scanner works in Docker. It stays running between requests, has networking, and is not the required fresh no-network container for every job. Do not treat its passing smoke test as proof of per-job isolation.

Use these text fixtures first:

```js
// Vulnerable input: synthetic example, never execute it.
const password = "demo-only-value";
```

```js
// Clean input for the supplied HIGH rules.
export const add = (a, b) => a + b;
```

The vulnerable example should include HIGH/HARDCODED_SECRET; the clean example should contain no HIGH finding. This scanner uses pattern matching; do not describe zero findings as a guarantee that code has no vulnerabilities.

## Build in this order

1. Build a one-shot runner that reads bounded path/content JSON, calls the supplied `scanCode` for every file and emits one bounded JSON result. It must not import, eval, require or run submitted files. Keep input/output formats testable independently of AWS.
2. Run that runner in a fresh fixed-image container for each job, with the limits below. Enforce a wall-clock timeout from outside the scanning process, terminate the container on timeout or cancellation, and remove containers/temp files in all outcomes.
3. Map supplied findings into the sanitized report format. Verify required files were all scanned and counts match findings. Invalid/truncated output and partial scans fail; they never become a clean result.
4. Integrate the runner into the existing claim/heartbeat/completion flow with Aditya. Reuse its cloud state mechanics rather than starting a second independent queue implementation.
5. Run cloud tests during a coordinated deployment window. Measure memory before deciding whether the current t3.micro hosts need an upgrade.

## Initial isolation settings to implement and measure

Suggested starting per-scan bounds: 1 active scan per node, 0.5 CPU, 256 MiB memory with no extra swap allowance, 64 PIDs, 30-second wall-clock deadline, at most 16 MiB temporary writable storage and at most 1 MiB result JSON. These are proposed starting settings, not limits already implemented for real scans; report measurements before finalizing them. If 256 MiB is insufficient, fail explicitly and coordinate the container/host budget with Aditya instead of removing limits.

Run as non-root; read-only root filesystem; drop all capabilities; no-new-privileges; default container syscall restrictions; no privileged mode or host namespaces. Disable networking, including access to EC2 metadata. Do not pass AWS credentials, service tokens, a Docker socket or a host home directory into the scan container. Use stdin/read-only job input and bounded output; create job-specific temporary paths and never accept host paths from a request.

Aditya still needs to provide a deployment arrangement that can launch containers without granting the public API a Docker socket. The current dummy-worker container has no socket either; do not assume it can launch sibling scan containers. A trusted worker-side launcher is an integration decision for Aditya and you. Only that trusted control component may access what is needed to launch containers; the scanner container itself must not.

Build/test the final image for linux/amd64 because the shared EC2 nodes are x86; Apple Silicon local success alone is insufficient deployment evidence. Aditya publishes the approved image/digest and changes infrastructure startup configuration.

## Existing cloud mechanics to preserve

The API persists source privately in S3 and metadata in DynamoDB, then dispatches an SQS message. A durable pending marker allows retry if queue delivery fails. A queue message contains only:

```json
{"schemaVersion":"1","jobId":"64 lowercase hex characters","generation":"UUID of the accepted source generation"}
```

Configuration provides account/region/queue/table/buckets. Do not hard-code credentials or publish `.local/cloud-connection.json`. The current loader verifies account identity at startup. Local tests can use injected fake clients; EC2 uses its instance role.

- Job identity is normalized repository/PR/exact commit SHA. A separate generation UUID distinguishes later accepted incarnations. Never let an old message act on a new generation.
- Claim atomically in DynamoDB only for the matching generation, nonexpired job and QUEUED or expired RUNNING lease. Use a random leaseToken; do not replace conditional updates with read-then-write.
- Current lease: 30 seconds; renew every 10 seconds and extend the SQS visibility window of 60 seconds. A renewal failure must stop the real scan and prevent publication.
- Source JSON is stream-bounded to 256 KiB, revalidated and checked against accepted digest/identity. Per-file source limits remain 25 files, 64 KiB each, 128 KiB combined.
- Upload a sanitized result to `reports/<jobId>/<generation>/<leaseToken>.json`, then commit its reference only if the same live lease still owns the job before deadline. Upload alone is not authoritative completion.
- Delete source best-effort and acknowledge SQS after terminal completion. Terminal duplicates may be acknowledged without rescanning. Losing a nonterminal claim must not acknowledge another worker's message or delete her/his source.
- Transient failure leaves the message available for retry; the dummy currently attempts FAILED after 3 claimed attempts. SQS redrive after 5 receives is separate. Final real failure classification and DLQ reconciliation remain shared decisions with Aditya.

Current job deadline is 15 minutes; metadata logically expires after 24 hours; source lifecycle is one day with earlier best-effort deletion; report lifecycle is seven days. Lifecycle/TTL cleanup is asynchronous. Aditya owns infrastructure lifecycle settings, API outbox dispatch and operational reconciliation.

## Scanner output and real-verdict boundary

The supplied scanner returns fields including `id`, severity, file/line information and source evidence. Inspect its actual output rather than assuming it already matches our report schema. Map `id` to `ruleId`, validated submitted file identity to `path`, and retain only approved fields: ruleId, severity, path, line and a fixed safe message. Drop snippets/evidence and avoid copying source into error messages. Allow only supported severities and valid line/path values; bound finding count/output. Overflow fails explicitly rather than silently truncating a passing report.

A report also needs schema version, repository/PR/exact SHA, job identity, scanner/policy version, severity summary and final verdict. The precise production schema is not implemented/frozen. Current views and reports hard-code `mode=dummy`, `gate=NOT_EVALUATED`, `mergeAllowed=false`; simply changing the worker will not make a real passing API result. Agree production changes with Aditya before wiring real output into shared job state. Arvind must consume that same agreed schema.

Required policy stays: a complete valid real scan with any HIGH finding blocks; no HIGH can pass only after all required inputs were successfully scanned and result validation succeeds. MEDIUM/LOW remain visible. Timeout, OOM, crash, bad output, missing files, lost lease and partial scans cannot pass. Production submissions must not let callers select a synthetic outcome using `simulation`.

## Completion checks

- [ ] Vulnerable and clean fixtures exercise the supplied scanner, not synthetic findings.
- [ ] Every scan gets a separate container; two jobs cannot read each other's files.
- [ ] CPU, memory, PID, temporary storage, output and wall-clock bounds are enforced.
- [ ] Network/metadata access denied; no credentials/socket/host filesystem exposed to the scan.
- [ ] Submitted code with side effects is inspected as text and never executed.
- [ ] Timeout, OOM, crash, invalid/oversized output and incomplete scans produce non-passing errors.
- [ ] Redacted findings retain useful rule/path/line information and correct counts without source evidence.
- [ ] Duplicate delivery, worker crash, expired lease and stale completion are tested.
- [ ] Cancellation/lost lease kills the container; all temporary resources are cleaned up.
- [ ] linux/amd64 image works and measured resource use is documented.
- [ ] Queue/source/report integration passes during an Aditya-managed deployment window.

## What Aditya still owes you

The final production schema and policy version, an approved container-launch arrangement, coordinated edits to shared API/store/worker code, cloud deployment and image publication, and a test window with appropriate configuration. You do not need his AWS credentials for local work. Your own Learner Lab account is separate; its credentials will not access his queues/buckets. A service API token permits HTTP submissions, not queue consumption or report uploads.

Hosting was last reported as being torn down. Keep developing locally. Do not start a competing worker on the shared queue with a personal laptop profile; cloud worker integration happens under Aditya's controlled deployment. No need to wait for Arvind's workflow to complete your local acceptance tests.
