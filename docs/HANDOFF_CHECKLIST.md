# Gate B: ready for Arvind and Chengyuan

Aditya must demonstrate all of these before calling the foundation ready:

- [ ] Lab/service/role/TLS/budget decisions resolved and documented.
- [ ] Team repository, branches and local setup instructions work on a second machine.
- [ ] Terraform state is shared, versioned, encrypted, private and locked; restore/lock procedures documented.
- [ ] Cloud baseline deployed with API Gateway public HTTPS endpoint, VPC link, internal ALB and two private nodes; API has no Docker socket.
- [ ] Frozen versioned input/job/result contracts, fixtures, mock adapters and error examples committed.
- [ ] Real authenticated API submits a job and returns status/report using the dummy worker; dummy mode unmistakable and disabled for real merge approval.
- [ ] Upload limits, idempotency, durable dispatch/outbox, terminal-state ownership and cleanup contracts demonstrated.
- [ ] Arvind receives endpoint URL, secret provisioning instructions, poll/retry budgets, developer-message expectations and acceptance cases.
- [ ] Chengyuan receives queue/storage/state conventions, job/result examples, lease/recovery rules, sandbox limits and worker acceptance cases.
- [ ] Both can run their component tests without waiting for the other component.

Do not check off items based on the proposal alone. The supplied local scanner container and Terraform bootstrap do not satisfy this gate by themselves.
