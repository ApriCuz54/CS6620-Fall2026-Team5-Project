# Disposable application hosting

This stack implements API Gateway managed HTTPS, a VPC link, an internal ALB, two private EC2 Auto Scaling nodes across two availability zones, outbound NAT gateways, gateway endpoints, security groups and CloudWatch alarms. Runtime containers currently provide the dummy API and worker; they cannot approve merges.

Use app/terraform.tfstate, separate from bootstrap, storage and artifacts. Storage/queues are in ../storage; images/log groups are in ../artifacts. Reuse the existing LabInstanceProfile. Generated backend.hcl and terraform.tfvars stay ignored.

Read ../../docs/HOSTING.md for setup, token rotation, tests, cost estimates and teardown. npm run hosting:down destroys only this disposable hosting stack; persistent data, images, state and token verifier remain. Wait for Destroy complete before assuming teardown succeeded. The next apply can produce a different endpoint.
