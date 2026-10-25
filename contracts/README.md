# Job API v1 — local dummy adapter, not a production worker contract

## Submit

POST /v1/jobs, application/json, Authorization: Bearer <service-token>.
All six fields in examples/submit-clean.json are required; unknown fields are rejected.

- schemaVersion: string "1".
- repository: the one configured owner/repository (case insensitive).
- pullRequest: positive integer.
- commitSha: exact 40-hex commit SHA, not a branch name.
- simulation: clean, high or error. This field exists only in the dummy contract.
- files: nonempty bounded list of path/content objects. Limits: 25 files, 64 KiB per file, 128 KiB combined, 256 KiB HTTP body. JS/MJS/CJS only; relative ASCII paths with no traversal or backslashes, at most 200 characters; unique paths.

A new job returns 202 with Location and statusUrl. An identical normalized repository/PR/SHA payload returns 200 and reused=true with the same jobId. Case and file ordering are normalized. Changed content, filenames or simulation for the same identity returns 409. Different commits create independent jobs; this milestone does not cancel superseded jobs.

## Poll

GET /v1/jobs/:jobId, same bearer header. Returns 200 and schemaVersion, jobId, repository, pullRequest, commitSha, status, createdAt, updatedAt and statusUrl. States: QUEUED → RUNNING → COMPLETED or FAILED. On local recovery RUNNING can return to QUEUED. Failed jobs contain a sanitized error and no report. Unknown/expired jobs return 404.

Every response describing a job or error explicitly sets mode="dummy", gate="NOT_EVALUATED", mergeAllowed=false. A completed simulated clean report is NOT a passing security result.

Completed jobs include summary={high,medium,low} and report={url,expiresAt}. The URL is relative locally; clients should resolve it against the configured service base. The AWS-storage development adapter now returns an absolute, 60-second S3 URL; see CLOUD_WORKER.md for its draft worker/storage contract. Do not assume a URL stays valid indefinitely.

## Report

GET the returned report.url without a service header. Its signature grants access only to the named job and expires after 60 seconds. Missing/modified/expired signatures return 403. Reports contain job identity, mode/gate/mergeAllowed, summary and findings. Findings have ruleId, severity, path, line and message; no source/evidence fields. Dummy HIGH findings use ruleId DUMMY_HIGH. These are synthetic, not the supplied scanner's findings.

## Error shape and behavior

JSON shape: {schemaVersion:"1",mode:"dummy",gate:"NOT_EVALUATED",mergeAllowed:false,error:{code,message}}.

- 400: invalid JSON/schema/input.
- 401: missing/incorrect bearer token on protected routes.
- 403: invalid/expired report capability.
- 404: unknown endpoint/job or expired job.
- 409: conflicting payload or unavailable report.
- 413: request body exceeds limit.
- 415: unsupported Content-Type.
- 503: local capacity exhausted, Retry-After: 2.
- 500: unexpected internal failure, without internal details or source.

Never interpret HTTP success, completed status or zero HIGH count alone as merge approval. Production schema must explicitly require a real scanner result, exact repository/PR/SHA match and a reviewed PASS verdict. Do not enable a real required GitHub check against dummy mode.

The draft AWS-storage envelope, dispatch and lease behavior is documented in CLOUD_WORKER.md and implemented for dummy jobs. Scanner policy versioning, cancellation, production report sanitation and real-worker acceptance remain to be reviewed with Chengyuan/Arvind before handoff.
