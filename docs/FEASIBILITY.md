# Gate A: Aditya resolves all feasibility before handoff

Record evidence, date, region and outcome for each item. Do not mark a gate verified solely because the tool is installed.

- [x] Local temporary-session identity passed; selected region us-east-1 (recheck after credential refresh).
- [x] Last-reported credits $45 and regional hosting estimate recorded in HOSTING.md: about $0.15/hr base for two micros, internal ALB, two NAT/EIPs and disks, plus usage. Teardown instructions preserve storage. Live balance and test-session duration remain owner responsibilities.
- [x] LabInstanceProfile attached to both nodes; ECR pulls, CloudWatch logging, SSM verifier decryption and hosted S3/SQS/DynamoDB job flow verified without personal credentials on EC2. Existing broad LabRole is a documented lab constraint.
- [x] New two-AZ VPC/private nodes, SGs, two public NAT/EIPs, S3/DynamoDB gateway endpoints and package/image bootstrap are deployed and verified.
- [x] API Gateway default HTTPS endpoint, VPC link and internal ALB are deployed; authenticated requests and rejected unauthenticated submissions verified. No owned domain needed.
- [x] Launch template/ASG run two healthy private micros across two AZs; reversible one-node application outage passed.
- [ ] Actual terminated-instance replacement and interrupted real-worker recovery still require separate validation.
- [x] S3, SQS/DLQ, DynamoDB conditional writes, CloudWatch and SSM SecureString using default AWS-managed encryption are permitted and tested in the hosted dummy flow; no custom KMS key created.
- [ ] Shared S3 state allows encryption, versioning and lock-object access; all deployers can use the agreed profile/role.
- [x] Supplied scanner handles clean/vulnerable smoke fixtures locally and in Docker; production timeout/resource limits remain to be measured.
- [ ] Team repository and all three collaborators are ready.

Read-only discovery and a successful plan help, but neither proves that a deployment will succeed. Use controlled, minimal lab experiments where needed; record the result and clean up test resources. Resolve any denied service/role, budget or HTTPS issue before handing work to teammates. Any replacement design should be agreed and documented without changing the original end product.

## Lab constraints confirmed from supplied instructions

Use us-east-1 or us-west-2; current target is us-east-1. Reuse LabRole and LabInstanceProfile; ordinary IAM users/groups/roles cannot be created. Document the broad existing role as a lab restriction, rather than claim custom least-privilege roles. EC2 supports listed nano through large sizes, On-Demand only, at most nine running instances and 32 vCPUs per region. Resources persist but EC2 stops at session end and restarts with the next session. Budget reporting lags. Verify controlled ASG shutdown/resume and ongoing ALB/NAT charges before calling the shared API continuously available. ECR: console identity can push; LabRole read-only. The lab cannot register a domain.
