# Handoff for Arvind Dharmesh Parekh

Prepared October 25, 2026. Your component: GitHub workflow and scanner client.

## Your goal in simple words

When a developer opens or updates a pull request, send its JavaScript files to the scanner, show progress in GitHub, and show whether that exact version of the code is safe to merge. A HIGH finding blocks merging. A corrected commit can pass only after a real scan succeeds. Errors, missing files and unfinished scans must never look like a pass.

You can build the client against the local mock now. You do not need Chengyuan's real scanner or a running AWS lab to begin. The mock returns synthetic results; a successful mock integration test is different from a passing security check.

## Starting code and ownership

Working baseline: branch `foundation/local-api`, commit `faa1d75`. These handoff files are a later local addition until Aditya publishes them. Do not assume `main` contains the foundation yet.

Create your branch from the baseline:

```sh
git clone git@github.com:ApriCuz54/CS6620-Fall2026-Team5-Project.git
cd CS6620-Fall2026-Team5-Project
git switch --track origin/foundation/local-api
git switch -c feature/github-workflow
npm ci --ignore-scripts
npm test
```

If you already have a clone, commit or save your own changes first, fetch origin, and branch from `origin/foundation/local-api`. Node.js 24.x and Git are enough for the local API/client path; Docker, Terraform and AWS credentials are not needed for this path.

Your suggested new files are `.github/workflows/security-scan.yml`, `scripts/github-client.mjs`, and `tests/github-client.test.mjs`. These files do not exist yet. Own the workflow, source collection, HTTP client, developer-facing status and client tests. Keep reusable client logic separate from the workflow YAML so it can be tested locally. Coordinate edits to package.json and contracts with Aditya.

Read these existing files first:

- `contracts/README.md`: current mock request, response and error formats.
- `contracts/examples/submit-clean.json`: runnable input example.
- `scripts/api-demo.mjs`: local authentication, submission, polling and report retrieval.
- `scripts/hosting-demo.mjs`: shared HTTPS client example; no AWS credentials needed when URL/token are supplied.
- `tests/gate.test.mjs`: API examples and failure cases.

## First local run

Terminal 1, from the repo root:

```sh
npm run api:dev
```

Terminal 2, from the same root:

```sh
npm run api:demo
npm run api:demo -- high
npm run api:demo -- error
```

The local API is `http://127.0.0.1:3100`. Its first start creates an ignored `.local/dev-api-token`; the demo reads it automatically. This token is different from the shared AWS token. Keep both private. Stop the server with Ctrl+C when finished.

The examples use fixed commit SHAs: repeats may immediately return the old job. For new tests, use a new synthetic SHA; never change source for the same repository/PR/SHA and expect a new job.

Expected outcomes: clean and high simulations reach COMPLETED; error reaches FAILED. All three remain `mode=dummy`, `gate=NOT_EVALUATED`, `mergeAllowed=false`. Simulation is chosen by the request, not by analysis of its source.

## API your client can use today

Submit JSON to `POST /v1/jobs` with `Authorization: Bearer <token>` and `Content-Type: application/json`. Example:

```json
{
  "schemaVersion": "1",
  "repository": "ApriCuz54/CS6620-Fall2026-Team5-Project",
  "pullRequest": 1,
  "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "simulation": "clean",
  "files": [{"path": "src/example.js", "content": "export const add = (a, b) => a + b;"}]
}
```

All six fields are required today; extra fields are rejected. New jobs return HTTP 202; identical submissions return 200 with `reused=true`. Poll `statusUrl` with the same token. QUEUED and RUNNING mean keep waiting; COMPLETED and FAILED are terminal. Resolve relative status/report URLs against the configured base URL.

Limits: 1–25 unique JS/MJS/CJS files, 64 KiB per file, 128 KiB combined source, 256 KiB JSON body, relative ASCII paths up to 200 characters, no traversal/backslashes. Use UTF-8 byte counts. Never silently omit an oversized or unsupported required scan input and claim full coverage; show an explicit non-passing explanation. Agree the intended source roots/exclusions with Aditya before the final workflow. Exclude vendored dependencies, generated files and test fixtures only through an explicit reviewed policy.

On completion, retrieve the report URL without forwarding the service Authorization header. Links expire after about 60 seconds; fetch fresh authenticated job status to obtain another link. Do not print tokens, raw source or signed URL query strings in logs. Decide with Aditya how an authorized developer will obtain a fresh report after a GitHub link expires; permanent artifact publication is not implemented.

## Build in this order

1. Write a testable client that accepts repository/PR/exact head SHA/files, submits once, handles reused jobs and polls. Read source from the exact PR head revision, not whatever happens to be in the checkout. Never execute submitted source or install dependencies from that source.
2. Add clear progress and failure messages: queued, scanning, HIGH findings, scanner failure, timeout, authentication failure and unavailable hosting.
3. Add bounded retry tests, then a workflow that invokes the client. Test workflow integration against a local mock without production secrets.
4. Add a stable check name and concurrency per repository/PR. Cancel superseded workflow runs; do not let an older successful commit approve a newer head. Server-side scan cancellation does not exist yet, so cancelled workflows can leave jobs running until completion/deadline.
5. Integrate real verdicts only after the production contract is agreed and implemented. Aditya enables the required branch check only after real vulnerable/fixed PR demonstrations pass.

Suggested client defaults to agree with Aditya: overall deadline 15 minutes including retries; individual HTTP timeout at most 30 seconds and bounded by remaining time; poll every 5 seconds; at most 5 attempts per transient HTTP operation, using jittered exponential backoff (1, 2, 4, 8 seconds before retries) and honoring Retry-After within the overall deadline. These are proposed new-client settings, not guarantees of the current demo scripts. A client may expire before the server finishes; that outcome cannot pass.

Retry network timeouts, 429 and temporary 500/502/503/504 responses within those bounds. Retried submissions must use identical bytes/meaning and identity. Do not repeatedly retry 400/401/403/404/409/413/415 as transient failures; explain them. The gateway may throttle concurrent callers. The application queues accepted jobs instead of returning busy solely because a worker is occupied.

## Security check and trust boundary

Current API views hard-code dummy verdicts. Zero HIGH findings, HTTP 200, COMPLETED, or a successful demo process exit are insufficient for a security pass. Validate response/report identity against the expected repository, PR and exact SHA, validate schema and severity totals, and require an explicitly supported real scanner/policy version and PASS verdict. Until those fields are implemented and agreed, the security check must remain non-passing for dummy results. A mock-client test can pass while asserting that refusal.

Use least-privilege GitHub permissions. Keep any credential-bearing submission in trusted workflow code; do not expose secrets to arbitrary PR code. Fork PR secrets and privileged workflow behavior need a design review with Aditya before enabling them. Do not solve this by running untrusted PR code in a privileged workflow. This is an outstanding decision, not an implemented trust policy.

## Shared AWS testing, later

Aditya provides a currently deployed HTTPS URL and a service token privately. Add `SCANNER_URL` and `SCANNER_TOKEN` to your ignored `.env`; `npm run hosting:demo` reads them. A plain custom Node script must explicitly load .env or receive environment variables. Your individual Learner Lab credentials cannot access Aditya's AWS account, and you should never need his AWS credentials for HTTP calls.

Hosting was last reported as being torn down. Ask Aditya to deploy for a coordinated test window; do not rely on the old URL or run Terraform against his stack. Local work can continue while it is off. Aditya provisions GitHub secrets later; secret values are not in Git.

## Completion checks

- [ ] Clean/high/error mock flows, duplicate requests and 409 conflict handling tested.
- [ ] Authentication, throttling, network errors, polling timeout and expired report handling tested.
- [ ] Source collection is pinned to the PR head SHA; unsupported/oversized coverage is explicit.
- [ ] A newer push cancels the old workflow and cannot reuse an old result as its own.
- [ ] Dummy, malformed, incomplete and mismatched-identity results never pass the security check.
- [ ] Final real scan blocks a vulnerable PR and permits the corrected exact commit after integration.
- [ ] Logs contain no service token, source evidence or signed URL query strings.
- [ ] Setup instructions and automated client tests accompany your branch/PR.

## What Aditya still owes you

The production request/result contract (including removal of simulation, scanner/policy version and verdict rules), scan coverage policy, final workflow trust design, GitHub secret setup, current endpoint for test windows and branch protection configuration. You can implement the mock client and its tests before these are finished. Chengyuan supplies the real scanner result through the shared service; you should not call her worker or AWS queue directly.
