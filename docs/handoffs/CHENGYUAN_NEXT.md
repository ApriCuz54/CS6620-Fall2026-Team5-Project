# Chengyuan: what changed and what's next (November 14, 2026)

Your original handoff is [CHENGYUAN.md](CHENGYUAN.md). This page covers what happened since then.

## What changed in your component

Your branch `feature/real-sast-worker` (runner, scanner image and launcher) was merged into `integration/real-gate`. Your code is used unchanged except for one launcher flag, `--pull never`, and its test assertion: scans may only use the pre-pulled, digest-pinned image.

The integration around it:

- **`services/scanner/report.mjs`** is the only place a verdict is computed.
  - It re-validates your launcher result: counts, file count, finding fields, and findings only for submitted paths.
  - It maps `HIGH/MEDIUM/LOW` to the API's lowercase `summary`, sets verdict FAIL if any HIGH and PASS otherwise, and builds the private report.
  - Any error code becomes FAILED with a fixed message.
- **`services/scanner/scan.mjs`** chooses the isolation mode.
  - `container` (your launcher) is the default.
  - `in-process` runs the same `runJob` without a container. It is for local development only and is refused when `CLOUD_DEPLOYED=1`.
- **Workers.** `services/gate/worker.mjs` (local) and `services/cloud/worker.mjs` (AWS) now call the scanner.
  - In the cloud worker, a failed lease renewal aborts your container through the `signal` option, which ends as CANCELLED.
  - `LAUNCH_FAILED` is retried as a host problem.
  - TIMEOUT, OUT_OF_MEMORY, CRASHED and bad output are terminal FAILED.
- **Deployment.** The worker container is the trusted launcher: it gets the Docker CLI and the host Docker socket. The API container still gets neither. Each node pulls your scanner image by digest at boot.

## Proven so far

- `npm test`: 57/57, including all 9 Docker isolation tests, on a Mac with Docker.
- linux/amd64 image: builds, and all 11 launcher tests pass against it (emulated on Apple Silicon).
- On AWS (Nov 14), real container scans on two t3.micro nodes:
  - Correct verdicts for high, clean and empty fixtures.
  - 8 simultaneous near-limit jobs completed in 3–5 s.
  - About 400 MiB still available per node; no OOM kills; no restarts.
  - Details: [../TEST_RESULTS_2026-11-14.md](../TEST_RESULTS_2026-11-14.md).

## Your next steps

1. **Review** `services/scanner/report.mjs` and `scan.mjs`, plus the worker changes in `services/cloud/worker.mjs`. Check that they use your runner and launcher the way you intended, and comment on the integration PR.
2. **Decide on the findings cap.** On AWS, files with about 3,500 findings ended as `ERROR OUTPUT_TOO_LARGE` because the runner caps a report at 1,000 findings. That's safe (non-passing), but such a file never gets a proper FAIL verdict. Options:
   - Keep it as an error.
   - When the cap is hit, return FAIL if a HIGH was already seen, with a truncated-findings flag.
   - Report counts only, past the cap.

   Agree the choice with Aditya, since the verdict contract is shared, then implement it with tests.
3. **Measure peak scan memory.** On AWS each scan finished before diagnostics could sample it. Locally, run a near-limit input (25 files, 128 KiB) through the container while watching `docker stats`, and record the peak against the 256 MiB limit. This settles whether t3.micro is enough.
4. **Worker crash drill (case 12), next test window.** Stop a worker container in the middle of a scan; one way is a slow input under a raised `SCAN_TIMEOUT_MS`. Show that the job is reclaimed after the lease and visibility expire, and that only one result is recorded. Record the job ID and timings.
5. **Allowlist (cases 04–06), if the team assigns it to you.** Suppression for an exact file, rule and finding fingerprint, with reason and expiry, in trusted config. Suppressed findings are listed separately in the report. This needs a stable finding fingerprint from the runner; agree the design with Aditya first.

## How to work

```sh
git fetch origin
git switch -c feature/<your-topic> origin/integration/real-gate
npm ci --ignore-scripts
npm run scanner:build && npm test
```

Open PRs into `integration/real-gate` until it is merged into `main`. No AWS credentials are needed for local work. Ask Aditya for a test window for live drills; don't run a worker against the shared queue from your laptop.
