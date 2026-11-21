# Runbook: real-gate test window (owner: Aditya)

Takes about 60–90 minutes with an active Learner Lab session. Hosting costs about $0.15/hour (two t3.micro nodes, two NAT gateways, internal ALB) until `npm run hosting:down`, or about $0.17/hour with t3.small. Ending the lab timer does **not** stop NAT/ALB charges.

## 0. On your Mac first (no AWS)

Docker Desktop running, Node 24.

```sh
git fetch origin && git switch integration/real-gate
npm ci --ignore-scripts
npm run scanner:build          # builds cs6620-scanner:dev from Dockerfile.scanner
npm test                       # all tests, including the 9 Docker isolation tests (none skipped now)
npm run e2e:local              # should print "scanner isolation: container" and END-TO-END PASS
```

If any Docker test fails, stop and fix it before deploying: those tests are the evidence for sandbox limits (timeout, out-of-memory, no network, cleanup).

## 1. Merge into main

`pull_request_target` workflows only run from the default branch, so the gate does nothing until `.github/workflows/security-scan.yml` is on `main`.

```sh
git push -u origin integration/real-gate
gh pr create --base main --head integration/real-gate --title "Integrate real scanner, contract v2 and trusted GitHub gate"
# review, then merge (this PR itself is not gated yet: the workflow isn't on main)
```

`main` currently holds only the setup commit; this PR brings in the whole foundation, both teammate branches and the integration.

## 2. Deploy

```sh
export AWS_PROFILE=cs6620-lab
aws sts get-caller-identity          # confirm the lab account
npm run hosting:token                # reuses the existing token if it still matches SSM
npm run hosting:publish              # builds BOTH images for linux/amd64 and pins their digests
npm run hosting:prepare -- --instance-type t3.micro   # or t3.small for more memory headroom
terraform -chdir=infra/app init -backend-config=backend.hcl
npm run hosting:plan                 # expect: launch template change + new variable scanner_image_uri
npm run hosting:apply
npm run hosting:smoke                # high → FAIL, clean → PASS, empty → PASS, all isolation=container
npm run hosting:demo -- high
```

What changed in the deployment: each node also pulls the scanner image by digest. The worker container gets the Docker socket and CLI so it can launch one no-network, 256 MiB, 30-second scan container per job. The API container still has no socket.

Note memory headroom: on Oct 25 each node had about 415 MiB free with the dummy worker. A real scan adds up to one 256 MiB container per node. If `hosting:smoke` shows `OUT_OF_MEMORY` or nodes restart, re-run `hosting:prepare -- --instance-type t3.small` and apply again.

If something is wrong on a node, check CloudWatch log group `/cs6620/team5/runtime` (streams `api-*`, `worker-*`) and run `npm run hosting:diagnostics`.

## 3. Connect GitHub

```sh
gh secret set SCANNER_URL --body "$(terraform -chdir=infra/app output -raw endpoint)"
gh secret set SCANNER_TOKEN < .local/deployment-service-token
```

## 4. Demo pull requests (the original final demo)

```sh
git switch main && git pull
git switch -c demo/vulnerable-login
mkdir -p demo && printf 'const password = "letmein-demo-only";\nexport const login = user => user.password === password;\n' > demo/login.js
git add demo/login.js && git commit -m "Add demo login" && git push -u origin demo/vulnerable-login
gh pr create --title "Demo: vulnerable login" --body "Expect the security-gate check to fail."
gh pr checks --watch                 # security-gate fails; the run summary lists HARDCODED_SECRET at demo/login.js:1
printf 'export const login = user => user.password === process.env.LOGIN_PASSWORD;\n' > demo/login.js
git commit -am "Read password from environment" && git push
gh pr checks --watch                 # security-gate passes for the new head commit
```

Also open a docs-only PR (edit a `.md` file). The check passes with "No JavaScript changed; recording an explicit zero-file scan".

The supplied scanner is regex-based. Use a pattern it detects (e.g. `password = "..."`). Some realistic-looking keys are not detected: `apiKey = "sk_live_0123456789abcdef0123"` has too few characters for its Stripe rule.

## 5. Make the check required

Only after step 4 shows fail → pass on real scans:

```sh
gh api -X PUT repos/ApriCuz54/CS6620-Fall2026-Team5-Project/branches/main/protection \
  --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["security-gate"]},
 "enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}
JSON
```

Re-run the vulnerable PR and confirm the merge button is blocked.

## 6. Collect evidence, then tear down

Record job IDs, check-run links and screenshots for the acceptance cases you exercised (see `docs/INTEGRATION_NOTES.md` for which ones are covered). Then:

```sh
npm run hosting:down     # review the destroy plan; storage, images and the token stay
```

After teardown the required check cannot run, so PRs will wait or fail until the next test window. That is expected (proposal: "accepting unavailable checks").
