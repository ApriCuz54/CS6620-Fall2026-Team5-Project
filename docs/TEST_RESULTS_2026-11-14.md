# AWS test window results: November 14, 2026

Branch `integration/real-gate` (commit `af6a836`), deployed to the team Learner Lab account in us-east-1 by Aditya, then torn down the same day. Runbook: [TEST_WINDOW.md](TEST_WINDOW.md).

## Setup that was tested

- Two private t3.micro nodes (us-east-1a and us-east-1b), each running the API container and the worker container.
- The worker launches one scan container per job from the digest-pinned scanner image. Each scan container gets no network, 0.5 CPU, 256 MiB, 64 PIDs and a 30 s deadline.
- Both images were built for linux/amd64 and pushed to ECR (`runtime-ae8a4caf4092ae23`, `scanner-55002785517fb72b`).
- Terraform created 46 resources and destroyed the same 46 at the end. Storage, queues, ECR images, the SSM token verifier and Terraform state were kept.

## Before deploying (on a Mac with Docker)

| Check | Result |
|---|---|
| `npm test` with the scanner image built | 57/57 pass, none skipped |
| `npm run e2e:local` with container isolation | Pass: vulnerable blocked, corrected passed, docs-only passed, bad token refused |
| Scanner image built with `--platform linux/amd64` | Builds; all 11 launcher tests pass against it (emulated) |

## On AWS

| Check | Result |
|---|---|
| `npm run hosting:smoke` | Pass. high → FAIL, clean → PASS, empty → PASS; duplicate submissions reuse the job; `isolation=container`; report private and free of source text |
| `scripts/github-client.mjs` run as Actions runs it, against the live endpoint, with a throwaway git repo as the PR | Pass. Vulnerable commit blocked with an annotation for `HARDCODED_SECRET` (`login.js:2`); fixed commit passed; docs-only passed via a zero-file scan; wrong token refused (401). About 6 s per check |
| `npm run hosting:demo -- high` | Pass. Redacted HIGH finding returned |
| 8 different PRs submitted at once, each 4 files of about 31 KiB (case 14) | Pass. All 202, all COMPLETED with verdict FAIL (4 HIGH each) within 3–5 s |
| Memory on t3.micro (`hosting:diagnostics`, before and after the burst) | About 400 MiB available per node; API about 75 MiB, worker about 63 MiB; no OOM kills; 0 restarts. A single scan's peak memory was not captured: scans finished faster than the diagnostics could sample them. t3.micro looks sufficient. |
| `npm run hosting:failover` (case 11) | Pass. With one node's application stopped, the other node served the whole scan and report flow; both nodes were healthy again afterwards |
| Report link expiry (case 18) | Pass. The link worked on completion and was refused (403) after its 60 s lifetime; a fresh status call issued a new working link |
| Workers stopped on both nodes, then a job submitted (queue side of case 12) | Pass. Accepted with 202, stayed QUEUED for 69 s without failing, and completed 2 s after the workers were restarted |
| CloudWatch alarms, job queue, dead-letter queue | All 3 alarms OK; both queues empty after testing |
| Runtime logs | Every worker log line matches a test above; no unexplained errors |

## Findings

1. **Too many findings gives an error, not a verdict.** A burst whose files had about 3,500 findings ended as `FAILED / ERROR OUTPUT_TOO_LARGE`. The runner caps a report at 1,000 findings. This is safe (non-passing), but such a file never gets a FAIL verdict. Owner to decide: Chengyuan (see her next steps).
2. **The real GitHub Actions run is not yet proven.** The workflow uses `pull_request_target`, which only runs from `main`, so it could not run before the branch is merged.
3. **Not exercised in this window:**
   - Worker killed mid-scan (case 12 proper)
   - Rapid pushes to one PR (case 15)
   - Token rotation drill (case 19)
   - Concurrent Terraform apply (case 20)
   - Allowlist cases 04–06 (not implemented)

The burst, report-expiry and stopped-worker drills were run with short scratch scripts that are not in the repository. They only use the public HTTPS API and read-only or reversible SSM commands.
