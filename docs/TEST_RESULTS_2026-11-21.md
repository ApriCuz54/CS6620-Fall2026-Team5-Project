# Live GitHub gate results: November 21, 2026

First end-to-end run of the real `security-gate` check on GitHub pull requests, scanning on AWS. `main` at `17eed29` (PR #1 merged, including Chengyuan's `LAUNCH_FAILED` fix and Arvind's PR #2). Deployed by Aditya to the team Learner Lab account in us-east-1, then torn down. Runbook: [TEST_WINDOW.md](TEST_WINDOW.md). Earlier AWS checks: [TEST_RESULTS_2026-11-14.md](TEST_RESULTS_2026-11-14.md).

## Setup

- Same hosting as Nov 14: two private t3.micro nodes, Terraform creates 46 resources and destroys the same 46.
- New runtime image `runtime-4e707a2985d69995` (merged code). Scanner image unchanged (`scanner-55002785517fb72b`).
- Repository secrets `SCANNER_URL` and `SCANNER_TOKEN` set in GitHub. `SCANNER_URL` changes on every redeploy and must be updated.
- The security gate runs from `.github/workflows/security-scan.yml` on `main` (`pull_request_target`), so a PR cannot change the check that judges it.

## Before the GitHub runs

| Check | Result |
|---|---|
| `npm test` (with Docker, after merging both teammates' branches) | 67/67 pass, none skipped |
| `npm run e2e:local` | Pass |
| `terraform validate` (infra/app) | Valid |
| `npm run hosting:smoke` (each deploy) | Pass: high → FAIL, clean → PASS, empty → PASS, all in isolated scan containers |

## On GitHub (live)

| Case | Commit | Result | Run |
|---|---|---|---|
| PR #3, vulnerable login (`password = "..."`) | `8f92c0e` | ❌ NOT APPROVED. 1 HIGH: `HARDCODED_SECRET` at `demo/login.js:1`, annotated on the line | [44960180912](https://github.com/ApriCuz54/CS6620-Fall2026-Team5-Project/actions/runs/44960180912) |
| PR #4, docs-only change | `0e63ca5` | ✅ Passed (explicit zero-file scan), 18 s | [44960201059](https://github.com/ApriCuz54/CS6620-Fall2026-Team5-Project/actions/runs/44960201059) |
| PR #3, fixed commit (password from environment) with a stale `SCANNER_URL` | `7a01973` | ❌ NOT APPROVED: "scanner service unreachable". Fails closed as designed | [44965670941 attempt 1](https://github.com/ApriCuz54/CS6620-Fall2026-Team5-Project/actions/runs/44965670941/attempts/1) |
| PR #3, same fixed commit, re-run after updating `SCANNER_URL` | `7a01973` | ✅ PASS. Complete scan of 1 file, no HIGH findings, 18 s | [44965670941](https://github.com/ApriCuz54/CS6620-Fall2026-Team5-Project/actions/runs/44965670941) |
| Report link workflow (manual) with the vulnerable job's ID | `main` | ✅ Fresh link in the run summary only (not the log), expiring in about 60 s; summary shows the HIGH finding | [44966117339](https://github.com/ApriCuz54/CS6620-Fall2026-Team5-Project/actions/runs/44966117339) |

Each gate run took 15–30 s in total, of which the scan itself is a few seconds.

## Findings

1. **`SCANNER_URL` must be updated after every redeploy.** The API Gateway address changes when hosting is recreated. With the old address the gate fails closed ("unreachable"), which is safe but blocks every PR. Updating the secret and re-running the job fixes it.
2. **GitHub is changing `pull_request_target`.** Every run shows: from December 2, 2026, `pull_request_target` is restricted on public repositories by default. The repository's Actions policy must allow it, or the security gate will stop running.
3. **Node 20 deprecation warning.** `actions/checkout@v4` and `actions/setup-node@v4` are forced onto Node 24. Harmless for now; update the action versions later.
4. **The check is not yet required.** Branch protection on `main` is not enabled, so a failing check is visible but does not disable the merge button.

## Still open

- Branch protection (required `security-gate` check), after a decision on how PRs behave while hosting is down.
- From earlier: the findings cap (ERROR instead of FAIL), allowlist cases 04–06, drills 12/15/19/20, wrong repository returns 400 instead of 403.
