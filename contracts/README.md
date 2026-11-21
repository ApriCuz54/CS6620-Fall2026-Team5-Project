# Job API — contract v2 (real scanner results)

Version 2 replaces the dummy v1 contract. Requests and responses use `schemaVersion: "2"`; routes stay under `/v1/`. Version 1 requests (including any `simulation` field) are rejected with 400. Callers can no longer choose an outcome: every verdict comes from the supplied SAST engine run by the worker.

## Submit

`POST /v1/jobs`, `Content-Type: application/json`, `Authorization: Bearer <service-token>`. Exactly these fields; unknown fields are rejected:

| Field | Rule |
|---|---|
| `schemaVersion` | `"2"` |
| `repository` | the one configured `owner/repository` (case-insensitive) |
| `pullRequest` | positive integer |
| `commitSha` | exact 40-hex commit SHA, not a branch name |
| `files` | 0–25 `{path, content}` objects; 64 KiB per file, 128 KiB combined, 256 KiB body. JS/MJS/CJS only; relative ASCII paths (`A-Z a-z 0-9 _ . -` and `/`), no traversal, no backslashes, at most 200 characters, unique. |

An empty `files` list is valid: it records an explicit, complete zero-file scan for a commit that changes no JavaScript (acceptance case 07).

A new job returns `202` with `Location` and `statusUrl`. An identical normalized repository/PR/SHA payload returns `200`, `reused: true` and the same `jobId`. Case and file order are normalized. Different content for the same repository/PR/SHA returns `409`. Different commits create independent jobs.

## Poll

`GET /v1/jobs/:jobId` with the same bearer header. Response fields:

| Field | Meaning |
|---|---|
| `status` | `QUEUED` → `RUNNING` → `COMPLETED` or `FAILED`. Recovery can move `RUNNING` back to `QUEUED`. |
| `verdict` | `PENDING` while queued/running; `PASS` or `FAIL` when completed; `ERROR` when failed. |
| `mergeAllowed` | `true` only when `status=COMPLETED`, `verdict=PASS` and `scanner.policyVersion` is the supported policy. |
| `repository`, `pullRequest`, `commitSha` | the job identity; clients must check it matches what they submitted. |
| `scanner` | completed only: `{engine:"cs6620-sast", version, policyVersion:"high-blocks-v1", isolation}`. Deployed workers always report `isolation:"container"`. |
| `filesScanned` | completed only: must equal the number of files submitted. |
| `summary` | completed only: `{high, medium, low}` counts. |
| `report` | completed only: `{url, expiresAt}` private link (see below). |
| `error` | failed only: `{code, message}` with fixed text. |

### Policy `high-blocks-v1`

A complete, validated scan with **any HIGH finding → `FAIL`**. No HIGH → `PASS`; MEDIUM and LOW stay visible in the summary and report but do not block. Timeout, out-of-memory, crash, invalid or oversized scanner output, a file-count mismatch, findings for unsubmitted paths, lost leases and retry exhaustion are all `FAILED` / `ERROR` and never pass. Approved exceptions (acceptance cases 04–06) are not implemented in this version.

Failed-job error codes: `TIMEOUT`, `OUT_OF_MEMORY`, `CRASHED`, `OUTPUT_TOO_LARGE`, `BAD_RUNNER_OUTPUT`, `INPUT_TOO_LARGE`, `INVALID_INPUT`, `INCOMPLETE_SCAN`, `JOB_DEADLINE_EXCEEDED`, `WORKER_RETRY_EXHAUSTED`, `SCAN_FAILED`.

## Report

GET `report.url` **without** the service header. Locally it is a relative HMAC-signed link; on AWS it is an absolute S3 presigned URL. Both expire after about 60 seconds; poll the status endpoint again for a fresh link. Never log the URL.

Report body: `schemaVersion, jobId, repository, pullRequest, commitSha, scanner, verdict, mergeAllowed, filesScanned, summary, findings, completedAt`. Each finding has exactly `ruleId, severity, path, line, message`; `message` is the scanner's fixed rule name. No source text, snippets or evidence are ever stored in a report.

## Errors

Shape: `{schemaVersion:"2", verdict:"ERROR", mergeAllowed:false, error:{code, message}}`.

- 400 invalid JSON/schema/input · 401 missing/incorrect token · 403 invalid/expired report link · 404 unknown endpoint/job or expired job · 409 conflicting payload or report not ready · 413 body too large · 415 wrong Content-Type · 503 capacity or cloud temporarily unavailable (`Retry-After`) · 500 unexpected internal failure (no internal details).

Clients retry only network errors, 429 and 500/502/503/504, with the identical request. A non-2xx response, a non-terminal status, an identity mismatch, an unsupported policy version or a `filesScanned` mismatch must never be treated as a pass.

See `CLOUD_WORKER.md` for the queue, lease and storage mechanics behind this API.
