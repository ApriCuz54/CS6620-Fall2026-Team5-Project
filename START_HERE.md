# Team project: start here

Team: Aditya Chatterjee, Arvind Dharmesh Parekh, Chengyuan Sun.

## What is ready

A fresh clone of the course repository, the original SAST and pentest code, a local Docker scanner configuration, repeatable setup/smoke checks, a working encrypted/versioned S3 Terraform state backend with a documented Learner Lab bootstrap exception, setup and handoff checklists, and our updated proposal. The original course README is unchanged.

This is the setup baseline. A shared HTTPS dummy API has been deployed and tested on two private AWS instances; availability depends on whether hosting is currently deployed; see docs/HOSTING.md. The production scanner worker, real GitHub merge gate and full handoff acceptance remain to be built. Local-only and laptop/AWS-storage development adapters remain available. A passing local scanner check does not mean the foundation is ready for teammate handoff.

## 1. Open the project

```sh
cd "$HOME/Desktop/CloudComputing/Team Project"
cp .env.example .env
npm ci --ignore-scripts
npm run preflight
npm test
```

The original scanner smoke script uses the standard library. The new local job API and its foundation tests require the pinned root Express dependency; install it with npm ci --ignore-scripts. Use Node.js 24.x. Git, npm, Docker Desktop with Compose, Terraform >=1.10 and <2, and AWS CLI v2 are needed for the complete setup. Open Docker Desktop and wait until its engine is running if preflight reports Docker unavailable.

## 2. Start the local scanner

```sh
npm run local:up
npm run test:http
# When finished:
npm run local:down
```

Docker downloads a base image and installs the supplied scanner dependencies inside the image. The scanner is reachable only on this computer at http://127.0.0.1:3000. No AWS account is needed for these steps. This development HTTP service is not the production per-job sandbox; the worker must enforce a wall-clock limit and no network for every scan. See docs/IMPLEMENTATION_PLAN.md.

If port 3000 is occupied, use `SAST_PORT=3100 npm run local:up` and `SAST_PORT=3100 npm run test:http` in the same way. The Node HTTP smoke test does not automatically read .env; pass SAST_PORT explicitly when overriding it.

## Local job API milestone

The new local-only Express API and embedded dummy worker provide submit/status/expiring-report examples on port 3100. Run `npm run api:dev`, then `npm run api:demo` in another terminal. Use `npm run api:demo -- high` and `npm run api:demo -- error` for simulated outcomes. See docs/LOCAL_API.md. This is a development mock; every result has mergeAllowed=false. It does not replace the original scanner or satisfy the cloud handoff. Foundation changes are on the local foundation/local-api branch for review.

## AWS storage development milestone

Real S3, DynamoDB and SQS resources are now deployed and tested; the API and dummy worker still run on your laptop. With a valid Learner Lab session, run `export AWS_PROFILE=cs6620-lab`, then `npm run cloud:smoke` for an automatic synthetic end-to-end check. See docs/CLOUD_FOUNDATION.md for the separate API/worker/client terminals and cost/retention details. Do not infer real security approval from dummy results.

## Shared HTTPS hosting milestone

The first verified deployment used https://b0dx4i7jcl.execute-api.us-east-1.amazonaws.com for the dummy API and worker. That address may be unavailable after teardown; get the current address from terraform -chdir=infra/app output -raw endpoint after applying. Read docs/HOSTING.md before using or shutting it down: it incurs hourly network/compute costs until app teardown. Run `npm run hosting:demo` with the owner profile, or set SCANNER_URL and the privately supplied SCANNER_TOKEN for a client that needs no AWS credentials. Raw owner token is in ignored .local/deployment-service-token. No dummy result permits a merge.

## 3. What Aditya needs to supply

1. Start the AWS Academy Learner Lab and configure its temporary credentials, including the session token, in a local AWS CLI profile named `cs6620-lab`. See docs/AWS_SETUP.md. Do not paste credentials into chat or the repository.
2. Confirm the lab region, available credit, existing instance profile, EC2 types and service permissions using docs/FEASIBILITY.md. A successful identity check alone is insufficient.
3. The team GitHub remote is configured. Confirm all three members have access; the initial setup was pushed, and the working foundation is on foundation/local-api. See docs/GIT_SETUP.md.
4. The proposed domain-free HTTPS entry point is an API Gateway default URL connected through a VPC link to an internal load balancer. No owned domain is currently required for that design. Creation permissions were demonstrated by deployment; see docs/HOSTING.md for cost estimates and validation.
5. The project state bucket and remote backend are already working. Read infra/README.md for the lab restriction, recovery and fresh-account instructions. Do not recreate the existing bucket or reuse archived plans. Application infrastructure is implemented separately in infra/app; review the plan and cost before each deployment.

## 4. Continue in this order

Read docs/IMPLEMENTATION_PLAN.md. Aditya resolves feasibility and builds the complete API/dummy-worker baseline first. Only after docs/HANDOFF_CHECKLIST.md passes do Arvind and Chengyuan implement their independent components. Our final goal remains the JavaScript SAST GitHub merge gate: vulnerable PR fails, corrected commit passes, private redacted report, incomplete scan never passes.

## References

- README.md: original assignment requirements
- docs/proposal/: previous team-split proposal PPTX and PDF. These copies predate the proposed API Gateway entry-point change; use docs/HOSTING.md for the implemented infrastructure and docs/IMPLEMENTATION_PLAN.md for ownership.
- docs/FEASIBILITY.md: lab and cost gates
- docs/SETUP_STATUS.md: what was checked on this machine
- docs/GIT_SETUP.md: team repository setup
- infra/README.md: Terraform bootstrap and shared state

The upstream repository includes tracked node_modules directories. Ignore rules do not untrack those files. Do not commit dependency churn; agree a separate cleanup commit after the team remote is configured. Do not run arbitrary fixture source code; submit it to the scanner as text.
