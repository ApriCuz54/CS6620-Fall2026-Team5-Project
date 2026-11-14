# Arvind: what changed and what's next (November 14, 2026)

Your original handoff is [ARVIND.md](ARVIND.md). This page covers what happened since then.

## What changed in your component

Your branch `feature/github-workflow` was merged into `integration/real-gate` together with Chengyuan's worker and the real-scanner integration. File names and the check name `security-gate` are the same. Most of `scripts/github-client.mjs` and parts of the workflow were rewritten, so please review them before building on them.

- **Trigger:** `pull_request_target` instead of `pull_request`.
  - The workflow and client always come from the base branch (`main`). The PR head is fetched with `git fetch` and read only with `git show <sha>:<path>`; no PR code runs.
  - Before, a PR could edit `github-client.mjs` to print "passed", and same-repo PRs could read `SCANNER_TOKEN`.
  - Side effect: the workflow only runs once it is on `main`.
- **API contract v2** (see [../../contracts/README.md](../../contracts/README.md)):
  - Requests use `schemaVersion: "2"` and have no `simulation` field.
  - Responses carry `verdict` (PENDING/PASS/FAIL/ERROR), `scanner.policyVersion` (`high-blocks-v1`), `filesScanned` and lowercase `summary`.
  - `mode` and `gate` are gone.
- **Approval rule:** `evaluate()` passes only if every one of these holds:
  - status is COMPLETED, verdict is PASS and `mergeAllowed` is true
  - repository, PR and SHA match
  - the policy version is supported
  - `filesScanned` equals the number of files sent
  - the report matches the job
- **Coverage:**
  - Only JavaScript changed since the merge base is scanned.
  - Exclusions come only from [../../.github/security-gate.json](../../.github/security-gate.json) (currently `node_modules`).
  - Oversized, too many or unsupported files block the check with an explicit list.
  - A PR with no JS changes now passes through an explicit zero-file scan; your version failed it.
- **Retries:** network errors, timeouts, 429 and 500/502/503/504. At most 5 attempts, backoff 1/2/4/8 s with jitter, honoring `Retry-After`, within a 15-minute overall deadline. Other 4xx responses are explained, not retried.
- **Output:** an `::error` annotation on each HIGH finding's file and line, plus a run summary table. The presigned report URL is never logged.
- **Tests:** [../../tests/github-client.test.mjs](../../tests/github-client.test.mjs) covers the approval rule, retries, file collection from a real git repo, and an end-to-end run against the real local API and scanner.

## Proven so far

- `npm test` passes (57/57 with Docker).
- `npm run e2e:local` runs your CLI the way Actions does: vulnerable blocks, fixed passes, docs-only passes, bad token refused.
- On AWS (Nov 14), the same CLI against the live endpoint gave the same four results, about 6 s each. Details: [../TEST_RESULTS_2026-11-14.md](../TEST_RESULTS_2026-11-14.md).
- **Not yet proven:** a real GitHub Actions run, because the workflow must be on `main` first.

## Your next steps

1. **Review** `scripts/github-client.mjs`, `.github/workflows/security-scan.yml` and the client tests. Comment on the integration PR with anything you disagree with.
2. **Report link refresh.** Add a manual `workflow_dispatch` workflow that takes a job ID, calls `GET /v1/jobs/{id}` with the token, and shows a fresh report link without rescanning (proposal, "Public report access"). Links expire after 60 s.
   - Keep the presigned URL out of logs.
   - A run summary written from trusted code is fine. Remember that anyone with repo read access can see summaries.
3. **Fork PR proposal.** Fork PRs can currently use the scanner. It's safe because no PR code runs, but it consumes lab capacity. Propose to the team whether to restrict it with `if: github.event.pull_request.head.repo.full_name == github.repository`.
4. **Next test window: live demo**, after Aditya merges to `main` and sets the secrets. Steps are in [../TEST_WINDOW.md](../TEST_WINDOW.md) step 4.
   - Vulnerable PR blocked, then a pushed fix passes.
   - A docs-only PR passes.
   - Several PRs at once (case 14).
   - Rapid pushes to one PR (case 15): only the newest commit's check may pass.
   - Record check-run links and screenshots as evidence.
5. **Developer docs:** a short "what the check means and how to fix a failure" section for the README.

## How to work

```sh
git fetch origin
git switch -c feature/<your-topic> origin/integration/real-gate
npm ci --ignore-scripts && npm test && npm run e2e:local
```

Open PRs into `integration/real-gate` until it is merged into `main`. No AWS credentials are needed for local work. Ask Aditya for a test window when you need the live endpoint.
