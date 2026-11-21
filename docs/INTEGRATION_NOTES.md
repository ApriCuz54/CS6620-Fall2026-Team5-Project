# Integration notes (November 14, 2026)

Branch `integration/real-gate` = `foundation/local-api` + `feature/real-sast-worker` (Chengyuan) + `feature/github-workflow` (Arvind) + the integration work below. It replaces the dummy pipeline with the real scanner end to end. Read `contracts/README.md` for the new API and `docs/TEST_WINDOW.md` for deploying it. It was deployed and tested on AWS on November 14: see [TEST_RESULTS_2026-11-14.md](TEST_RESULTS_2026-11-14.md). Per-person next steps: [handoffs/ARVIND_NEXT.md](handoffs/ARVIND_NEXT.md), [handoffs/CHENGYUAN_NEXT.md](handoffs/CHENGYUAN_NEXT.md); those supersede the "For Arvind" and "For Chengyuan" lists below.

## What changed

**Contract v2 (`services/gate/contract.mjs`, `contracts/README.md`).** `simulation` is gone; requests use `schemaVersion: "2"` and v1 requests are rejected. Responses carry `verdict` (`PENDING`/`PASS`/`FAIL`/`ERROR`), `scanner {engine, version, policyVersion, isolation}`, `filesScanned` and lowercase `summary {high, medium, low}`. `mergeAllowed` is true only for a COMPLETED job with verdict PASS under policy `high-blocks-v1`; one function (`mergeAllowedFor`) decides it. `mode`/`gate` fields are removed. An empty `files` list is now valid and records an explicit zero-file scan (case 07).

**Verdicts are computed in one place (`services/scanner/report.mjs`).** It takes the launcher result, re-validates it (counts, file count, finding fields, findings only for submitted paths), maps `HIGH/MEDIUM/LOW` to the API's lowercase summary, and builds the sanitized report. Anything unexpected becomes FAILED with a fixed error code.

**Real workers.** `services/gate/worker.mjs` (local) and `services/cloud/worker.mjs` (AWS) now scan with `services/scanner/scan.mjs`. That uses Chengyuan's container launcher by default; `SCANNER_ISOLATION=in-process` runs the same engine without a container, for development only, and is refused when `CLOUD_DEPLOYED=1`. In the cloud worker, a failed lease renewal aborts the scan container. A container that cannot start is retried (attempts budget unchanged); timeout, out-of-memory, crash and bad output are terminal FAILED.

**Deployment (`infra/app`, `Dockerfile.hosting`, `scripts/publish-runtime.mjs`, `scripts/prepare-hosting.mjs`).** New Terraform variable `scanner_image_uri` (digest-pinned, same ECR repo). Nodes pull the scanner image at boot. The worker container is the trusted launcher: it gets the Docker CLI and socket plus the socket's group. The API container still gets none. The launcher adds `--pull never`, so scans only use the pre-pulled pinned image.

**GitHub gate (`.github/workflows/security-scan.yml`, `scripts/github-client.mjs`, `.github/security-gate.json`).**
- The workflow now uses `pull_request_target`: the workflow and client always come from the base branch, and the PR head commit is fetched only as data. Before, a PR could edit `github-client.mjs` or the workflow to print "passed", and same-repo PRs could read `SCANNER_TOKEN`.
- Coverage: JavaScript files changed since the merge base, read with `git show <head>:<path>`. Exclusions come only from the reviewed policy file (currently `node_modules`). Oversized, too many or unsupported paths fail with an explicit list; nothing is silently skipped.
- A PR with no JavaScript changes now passes via an explicit zero-file scan instead of failing.
- Bounded retries: network errors, timeouts, 429 and 500/502/503/504; at most 5 attempts; backoff 1/2/4/8 s with jitter, honoring `Retry-After`; overall 15-minute deadline. 4xx responses are explained, not retried.
- Approval requires status COMPLETED, verdict PASS, `mergeAllowed`, matching repository/PR/SHA, a supported policy version, `filesScanned` equal to the files sent, and a report that matches the job.
- Output: `::error` annotations on each HIGH finding's file and line, plus a run summary table. The presigned report URL is never logged.

**Tests.** 57 total (48 run everywhere; 9 need the scanner image and Docker). New: `tests/github-client.test.mjs` (approval rule, retries, file collection from a real git repo, end-to-end against the real local API and scanner), real-scan gate tests, and cloud worker success/launch-failure/timeout tests. `npm run e2e:local` runs the CLI exactly as Actions does, against a throwaway repo: vulnerable blocks, corrected passes, docs-only passes, bad token refused.

## For Arvind

Your workflow/client was kept in place and rewritten around the same flow: same file names, check name `security-gate`, per-PR concurrency with cancel-in-progress, 20-minute job timeout. Please review `scripts/github-client.mjs` and its tests. Still open for you:
1. A manual `workflow_dispatch` workflow that gets a fresh report link for an existing job without rescanning (proposal: "Public report access").
2. Decide with the team whether fork PRs may use the scanner. They are safe (no PR code runs) but consume lab capacity; restrict with `if: github.event.pull_request.head.repo.full_name == github.repository` if not.
3. Run the live demo PRs in the test window (`docs/TEST_WINDOW.md` step 4), including several PRs at once (case 14) and rapid pushes to one PR (case 15).

## For Chengyuan

Your runner and launcher are used unchanged except for `--pull never` (and its test assertion). Integration lives in `services/scanner/report.mjs` and `services/scanner/scan.mjs`. Still open for you:
1. Run `npm run scanner:build && npm test` on a machine with Docker and confirm all 9 container tests pass, including on a `linux/amd64` build (`docker buildx build --platform linux/amd64 -f Dockerfile.scanner .`).
2. In the test window, measure scan container and host memory on a node (`hosting:diagnostics`) and record whether t3.micro is enough.
3. Live worker-crash evidence (case 12): stop a worker container mid-scan and show the job is reclaimed after lease/visibility expiry.

## Acceptance cases: where they stand

| Case | Status |
|---|---|
| 01 vulnerable fails · 02 corrected passes · 03 MEDIUM-only passes · 07 no JS | Automated tests + local e2e. 01, 02 and 07 passed on AWS through the gate client (Nov 14). Live GitHub Actions demo pending. |
| 04–06 approved / invalid / expired exceptions | Not implemented (no allowlist yet). |
| 08 oversized/malformed | API 400/413 tests; client lists unscannable files explicitly. |
| 09 missing token / wrong repo | 401 tested. Wrong repository returns 400, not the 403 the proposal lists. |
| 10 sandbox deadline/memory | Launcher Docker tests (run on a Docker machine); worker maps to FAILED (tested). |
| 11 API node fails | `hosting:failover` passed with the real worker (Nov 14). Actual instance termination not tested. |
| 12 worker dies mid-scan | Lease/visibility mechanics tested with fakes. On AWS, a job submitted with all workers stopped stayed QUEUED and completed after restart (Nov 14). Mid-scan kill drill pending. |
| 13 duplicate message / POST | Tested locally and in `cloud:smoke`. |
| 14 several PRs · 15 repeated pushes | 14 passed on AWS: 8 PRs at once, all correct in 3–5 s (Nov 14). 15 in place (per-PR concurrency + SHA binding); live run pending. |
| 16 429/503 | Client retry tests. |
| 17 S3/DynamoDB commit fails | Conditional commit + lease fencing tested with fakes. |
| 18 expired report URL | On AWS, the old link was refused after 60 s and a fresh status call issued a working link (Nov 14). Refresh workflow not built (Arvind). |
| 19 token rotation | Verifier overlap tests; rotation drill pending (`hosting:token -- --rotate`). |
| 20 concurrent Terraform apply | S3 native lockfile configured; not drilled. |
