// Report link refresh.
// Report links from the scanner are presigned URLs that expire after about 60 seconds,
// so the link from a security-gate run is usually dead by the time someone opens it.
// This fetches a fresh link for an existing job without rescanning anything.
//
// The link is a short-lived capability to read the private report. It is written only
// to the run summary (visible to people with repo read access), never to the log.
import { appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { requestWithRetry, GateError, SCHEMA_VERSION, DEFAULTS } from './github-client.mjs';

// The API issues random UUIDs; checking the shape first means a typo or a pasted URL
// never turns into a request to some other path on the scanner.
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTIONS = { ...DEFAULTS, deadlineMs: 2 * 60 * 1000 };

export async function refreshReportLink({ url, token, repository, jobId, fetchImpl = fetch, now = Date.now, sleep = delay, random = Math.random, options = OPTIONS, log = console.log }) {
  for (const [name, value] of Object.entries({ url, token, repository })) if (!value) throw new GateError('CONFIGURATION', `${name} is not configured.`);
  const id = String(jobId ?? '').trim();
  if (!JOB_ID.test(id)) throw new GateError('BAD_JOB_ID', 'That is not a job ID. Copy the "Job ID" value from the security-gate run summary.');

  const deadline = now() + options.deadlineMs;
  const http = (target, init = {}) => requestWithRetry(target, init, { fetchImpl, deadline, now, sleep, random, options, log });

  const res = await http(new URL(`/v1/jobs/${id}`, url), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new GateError('UNAUTHORIZED', 'The scanner refused the SCANNER_TOKEN secret.');
  if (res.status === 404) throw new GateError('NOT_FOUND', 'No such job, or it has expired. Re-run the security-gate check to scan again.');
  if (res.status !== 200) throw new GateError('UNEXPECTED', `Status check failed with HTTP ${res.status}.`);

  const job = res.body;
  if (job?.schemaVersion !== SCHEMA_VERSION) throw new GateError('UNEXPECTED', 'The scanner returned an unsupported response version.');
  // The token is shared by the whole deployment, so make sure this job is ours before
  // handing out a link to its report.
  if (String(job.repository).toLowerCase() !== repository.toLowerCase()) throw new GateError('WRONG_REPOSITORY', 'That job belongs to a different repository.');
  if (job.status === 'FAILED') throw new GateError('NO_REPORT', `That scan failed (${job.error?.code ?? 'unknown error'}), so it has no report.`);
  if (job.status !== 'COMPLETED') throw new GateError('NOT_READY', `That scan is not finished yet (status ${job.status}). Try again in a few seconds.`);
  if (!job.report?.url) throw new GateError('UNEXPECTED', 'The scanner did not return a report link.');

  const reportUrl = new URL(job.report.url, url).toString();
  // Fetch it once (no service token, like any reader would) to prove the link works
  // and the report really is this job's, before telling anyone to open it.
  const fetched = await http(reportUrl, {});
  if (fetched.status !== 200) throw new GateError('UNEXPECTED', `The fresh link did not work (HTTP ${fetched.status}).`);
  const report = fetched.body;
  if (report?.jobId !== job.jobId || String(report?.commitSha).toLowerCase() !== String(job.commitSha).toLowerCase()) throw new GateError('UNEXPECTED', 'The report does not match the job; refusing it.');

  log(`Job ${job.jobId}: ${job.status}, verdict ${job.verdict} for PR #${job.pullRequest} at ${String(job.commitSha).slice(0, 12)}. Fresh link written to the run summary.`);
  return { job, report, reportUrl, expiresAt: job.report.expiresAt };
}

const cell = s => String(s).replace(/\|/g, '\\|');

export function summary({ job, report, reportUrl, expiresAt }) {
  const lines = [
    `## Report for PR #${job.pullRequest} (${job.verdict})`, '',
    `Commit \`${String(job.commitSha).slice(0, 12)}\`, job \`${job.jobId}\`.`, '',
    `**[Open the report](${reportUrl})**. The link stops working at ${expiresAt} (about 60 seconds). Run this workflow again for a new one.`, '',
    '| HIGH | MEDIUM | LOW | Files scanned | Policy |', '|---|---|---|---|---|',
    `| ${job.summary?.high ?? '?'} | ${job.summary?.medium ?? '?'} | ${job.summary?.low ?? '?'} | ${job.filesScanned ?? '?'} | ${job.scanner?.policyVersion ?? '?'} |`, '',
  ];
  const findings = report?.findings ?? [];
  if (findings.length) {
    lines.push('| Severity | Rule | File | Line |', '|---|---|---|---|');
    for (const f of findings.slice(0, 100)) lines.push(`| ${cell(f.severity)} | ${cell(f.ruleId)} | ${cell(f.path)} | ${Number(f.line)} |`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const env = process.env;
  try {
    const result = await refreshReportLink({ url: env.SCANNER_URL?.trim(), token: env.SCANNER_TOKEN?.trim(), repository: env.REPOSITORY, jobId: env.JOB_ID });
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary(result));
  } catch (error) {
    const message = error instanceof GateError ? error.message : 'Unexpected failure while getting the report link.';
    console.log(`::error title=Report link::${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
