# Gate A: Aditya resolves all feasibility before handoff

Record evidence, date, region and outcome for each item. Do not mark a gate verified solely because the tool is installed.

- [x] Local temporary-session identity passed; selected region us-east-1 (recheck after credential refresh).
- [ ] Available credits, expected active hours and teardown budget are recorded. Obtain a regional estimate for ALB, two EC2 nodes, two NAT gateways, storage, queues and logs. Do not assume the old single-instance cost estimate applies.
- [ ] Existing lab instance role/profile can be attached and has the needed access; confirm PassRole and any restrictions without creating replacement IAM roles.
- [ ] Two AZs, VPC/subnet/route/security-group creation, public IPv4/NAT/EIP quotas and outbound package/image access are feasible.
- [ ] Verify proposed API Gateway default HTTPS endpoint, VPC link and internal ALB integration. No purchased domain is required for this proposed alternative. List access is confirmed; create/integration permissions remain unverified.
- [ ] EC2 launch template and ASG can run two nodes across two private subnets and recover a terminated node.
- [ ] S3, SQS/DLQ, DynamoDB conditional writes, CloudWatch, SSM SecureString and required KMS behavior are permitted.
- [ ] Shared S3 state allows encryption, versioning and lock-object access; all deployers can use the agreed profile/role.
- [x] Supplied scanner handles clean/vulnerable smoke fixtures locally and in Docker; production timeout/resource limits remain to be measured.
- [ ] Team repository and all three collaborators are ready.

Read-only discovery and a successful plan help, but neither proves that a deployment will succeed. Use controlled, minimal lab experiments where needed; record the result and clean up test resources. Resolve any denied service/role, budget or HTTPS issue before handing work to teammates. Any replacement design should be agreed and documented without changing the original end product.

## Lab constraints confirmed from supplied instructions

Use us-east-1 or us-west-2; current target is us-east-1. Reuse LabRole and LabInstanceProfile; ordinary IAM users/groups/roles cannot be created. Document the broad existing role as a lab restriction, rather than claim custom least-privilege roles. EC2 supports listed nano through large sizes, On-Demand only, at most nine running instances and 32 vCPUs per region. Resources persist but EC2 stops at session end and restarts with the next session. Budget reporting lags. Verify controlled ASG shutdown/resume and ongoing ALB/NAT charges before calling the shared API continuously available. ECR: console identity can push; LabRole read-only. The lab cannot register a domain.
