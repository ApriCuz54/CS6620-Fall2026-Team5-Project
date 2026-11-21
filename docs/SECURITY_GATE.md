# The security-gate check

Every pull request gets a check called **security-gate**. It scans the JavaScript the PR changes and blocks the merge if it finds a HIGH severity problem.

## What it does

1. It takes the JavaScript files (`.js`, `.mjs`, `.cjs`) changed since the PR branched off `main`.
2. It sends them to our scanner on AWS, which runs them through the SAST rules in an isolated container. The code is only read, never run.
3. It waits for the result and passes only if the scan is complete, has no HIGH findings, and is for the exact commit at the head of the PR.

The workflow and the client script always run from `main`, not from the PR. So a PR can't edit the check to make itself pass.

## Reading the result

- **Passed:** no HIGH findings. MEDIUM and LOW findings still show up in the run summary as warnings, but they don't block.
- **Failed with findings:** each HIGH finding is shown as an error on its file and line in the PR's "Files changed" tab, and listed in the run summary.
- **Failed without findings:** the scan didn't complete (scanner down, timeout, files too big, unsupported file names). It never passes in that case. The summary says what went wrong. Usually re-running the check is enough.
- **Docs-only PRs** (no JavaScript changed) still get a check. It records an explicit zero-file scan and passes.

## Fixing a failure

1. Open the failed check and read the run summary, or look at the red annotations on the changed files.
2. Fix the code, for example move a hardcoded password into an environment variable.
3. Push a new commit. The check runs again on the new commit, and the old run is cancelled.

If a finding is a false positive, don't work around the scanner in the code. Ask for a reviewed exception in [`.github/security-gate.json`](../.github/security-gate.json). It has to be merged to `main` first, so a PR can't approve its own exception.

## Getting the full report

The run summary shows the job ID. The full report link expires after about 60 seconds, so it's usually dead by the time you click it. To get a fresh one, go to **Actions → Report link → Run workflow** and paste the job ID. The new link shows up in that run's summary. It also expires after about 60 seconds, so open it right away.

## Live demo

The security-gate check runs on every pull request while hosting is up.
