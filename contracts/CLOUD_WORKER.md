# AWS worker contract (real scanner)

The worker now runs the supplied SAST engine in a fresh locked-down container per job (`services/scanner/launcher.mjs`) and computes the verdict in `services/scanner/report.mjs`. API-facing fields are defined in `README.md` (contract v2). The queue, lease and storage mechanics below are unchanged from the dummy milestone.

**Deployment layout.** The public API container has no Docker socket. The worker container is the trusted launcher: it gets the host Docker socket (and the Docker CLI) so it can start scan containers, and it never runs submitted code. Scan containers get no network, no credentials, no socket and no host files, and run with 0.5 CPU, 256 MiB, 64 PIDs, a read-only root, a 16 MiB `/tmp` and a 30-second deadline. A scan container that cannot start is retried; timeout, out-of-memory, crash and invalid output are terminal `FAILED` results.

## Accepted identity and generation

HTTP submissions use contracts/README.md. The job ID is SHA-256 of normalized repository:pullRequest:commitSha. A DynamoDB conditional put accepts one digest for that identity. The source digest covers the normalized JSON with sorted files. Different payload for an existing live identity is 409, not an overwrite.

Each accepted generation has a fresh UUID and a unique source key sources/<jobId>/<generation>.json. A new generation after logical job expiry must not be confused with an old message. Each report uses reports/<jobId>/<generation>/<leaseToken>.json so a stale owner cannot overwrite the authoritative report object.

## SQS envelope

Only these fields are sent, as JSON:

```json
{"schemaVersion":"1","jobId":"64 lowercase hex characters","generation":"UUID of the accepted source generation"}
```

No source text, service token, S3 presigned URL or AWS credentials belong in a queue message. Queue URL, table name and bucket names come from the deployment connection configuration; credentials use the standard AWS SDK chain (local profile now, instance role later). Verify the AWS account at process startup.

## DynamoDB record

Partition key pk=JOB#<jobId>. Fields: id, generation, digest, repository, pullRequest, commitSha, fileCount, sourceKey, status, createdAt, updatedAt, deadlineAt and expiresAt. The adapter sets a 15-minute deadline and 24-hour logical metadata expiry. Source stays in S3, not in the item.

Pending-dispatch records also contain dispatchKey=PENDING and dispatchAfter=<epoch milliseconds>. The dispatch-index GSI partitions by dispatchKey and sorts by dispatchAfter. Job acceptance and this outbox marker are one conditional write. Send to SQS before conditionally removing the marker; unknown send/ack outcomes can duplicate delivery. Repeated dispatch is safe only because worker claims are conditional. Expired markers are cleared even while physical TTL deletion is pending.

## Claim and finish

Read metadata consistently and match generation before processing. Missing/expired, stale-generation and terminal duplicates can be acknowledged. Claim QUEUED or RUNNING-with-expired-lease only if generation matches and the job remains within deadline/expiry. The atomic update assigns a random leaseToken, leaseUntil=now+30 seconds, RUNNING and an incremented attempts count.

SQS visibility is 60 seconds. Renew the lease every ten seconds under matching generation, RUNNING, live deadline and current ownership; extend SQS visibility too. Do not continue toward authoritative completion after renewal fails. A failed renewal aborts the running scan container and the result is discarded.

Read bounded source (at most 256 KiB JSON), revalidate the submission and compare its digest/identity with the accepted record. Never execute submitted JavaScript. The worker passes the validated files to one fresh bounded no-network scan container.

On a validated complete scan, upload the sanitized report under the lease-specific key, then conditionally set COMPLETED, verdict, summary, filesScanned, scanner and reportKey only if the same generation/token still owns a live RUNNING lease before deadline. Remove lease and outbox fields. On a failed scan, set FAILED, verdict ERROR and a fixed sanitized error, with no report. Delete the source best-effort and acknowledge SQS only after terminal completion. If acknowledgement fails, redelivery sees terminal state and can acknowledge without rerunning.

A stale worker can leave an orphan report, but cannot publish its key into current job metadata; lifecycle removes orphan reports later. Losing a claim must not delete another worker's source or acknowledge a nonterminal job. Transient failures leave the message for retry; after three claimed failures the worker attempts terminal FAILED. SQS redrive after five receives is a separate safeguard.

## Reports and retention

Local file adapter report links are relative and HMAC-signed. AWS-storage adapter links are absolute S3 presigned GET URLs for the committed reportKey, with 60-second requested lifetime and no-store caching. They may expire earlier when temporary credentials expire. Anyone holding the URL can read that report until expiration; never log it. Unsigned object access is denied.

Reports contain job identity, scanner and policy version, verdict, mergeAllowed, severity counts and sanitized findings (ruleId, severity, path, line, message) without source or evidence. Source lifecycle: one day, plus best-effort deletion at terminal processing. Reports: seven days. Metadata: unavailable after 24 hours, with eventual TTL deletion. Lifecycle/TTL are asynchronous, not exact deletion deadlines.

## Failure limits

Polling or dispatch marks an overdue job FAILED. A DLQ job without terminal metadata remains an operational problem; automated DLQ reconciliation, alarms and continuously deployed dispatch are still required. Current live tests run from the laptop, not two EC2 hosts. They prove cloud data-path permissions for the lab user, not LabInstanceProfile runtime permissions or host failover.
