// GitHub security gate client.
// Collects the JavaScript files a pull request changes (read from the exact PR head
// commit as text, never executed), submits them to the scanner API, polls until a
// terminal result, and passes only a complete PASS verdict bound to that exact commit.
// Library functions are exported for tests; running this file directly is the CLI.
import { execFile } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = '2';
export const SUPPORTED_POLICIES = new Set(['high-blocks-v1']);
export const LIMITS = { files: 25, fileBytes: 64 * 1024, sourceBytes: 128 * 1024 };
export const DEFAULTS = { deadlineMs: 15 * 60 * 1000, pollMs: 5000, httpTimeoutMs: 30000, maxAttempts: 5, backoffMs: [1000, 2000, 4000, 8000] };
const PATH_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:js|mjs|cjs)$/;
const JS_FILE = /\.(?:js|mjs|cjs)$/i;
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

export class GateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---- Source collection -------------------------------------------------------

export function defaultGit(cwd) {
  const run = promisify(execFile);
  return async (...args) => (await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })).stdout;
}

// policy: { excludeDirectories: ["node_modules"], excludePaths: ["exact/path.js"] }
export function isExcluded(path, policy = {}) {
  const parts = path.split('/');
  return (policy.excludeDirectories ?? []).some(dir => parts.slice(0, -1).includes(dir)) || (policy.excludePaths ?? []).includes(path);
}

// Returns { files, excluded, problems }. Any problem means the scan would be
// incomplete, so the gate must not pass; nothing is silently dropped.
export async function collectFiles({ git, baseSha, headSha, policy = {} }) {
  const changed = (await git('diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', `${baseSha}...${headSha}`)).split('\0').filter(Boolean);
  const files = []; const excluded = []; const problems = [];
  let total = 0;
  for (const path of changed.filter(p => JS_FILE.test(p))) {
    if (isExcluded(path, policy)) { excluded.push(path); continue; }
    if (!PATH_PATTERN.test(path) || path.length > 200 || path.split('/').some(x => x === '.' || x === '..')) { problems.push(`${safe(path)}: path is not supported by the scanner (use letters, digits, _ . - and /).`); continue; }
    const content = await git('show', `${headSha}:${path}`);
    const bytes = Buffer.byteLength(content);
    if (content.includes('\0')) { problems.push(`${path}: binary content cannot be scanned.`); continue; }
    if (bytes > LIMITS.fileBytes) { problems.push(`${path}: ${bytes} bytes exceeds the 64 KiB per-file limit.`); continue; }
    total += bytes;
    files.push({ path, content });
  }
  if (files.length > LIMITS.files) problems.push(`${files.length} JavaScript files changed; the scanner accepts at most ${LIMITS.files} per commit.`);
  if (total > LIMITS.sourceBytes) problems.push(`Changed JavaScript totals ${total} bytes; the limit is 128 KiB.`);
  return { files, excluded, problems };
}

// ---- HTTP with bounded retries --------------------------------------------------

function retryAfterMs(headers) {
  const value = headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

// Retries only network errors, timeouts, 429 and 500/502/503/504, with the identical
// request, at most maxAttempts times and never past the overall deadline.
export async function requestWithRetry(url, init, { fetchImpl = fetch, deadline, now = Date.now, sleep = delay, random = Math.random, options = DEFAULTS, log = () => {} }) {
  let lastProblem = 'no attempt made';
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    let response; let hinted;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.min(options.httpTimeoutMs, remaining)) });
    } catch (error) {
      lastProblem = error?.name === 'TimeoutError' ? 'request timed out' : 'scanner service unreachable';
    }
    if (response) {
      const body = await response.json().catch(() => undefined);
      if (!TRANSIENT.has(response.status)) return { status: response.status, body };
      lastProblem = `HTTP ${response.status}`;
      hinted = retryAfterMs(response.headers);
    }
    if (attempt === options.maxAttempts) break;
    const base = options.backoffMs[Math.min(attempt - 1, options.backoffMs.length - 1)];
    const wait = Math.max(hinted ?? 0, base * (0.5 + random()));
    if (now() + wait >= deadline) break;
    log(`Transient problem (${lastProblem}); retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${options.maxAttempts}).`);
    await sleep(wait);
  }
  throw new GateError('SERVICE_UNAVAILABLE', `Scanner service did not respond successfully (${lastProblem}).`);
}

// ---- Verdict --------------------------------------------------------------------

// The single client-side approval rule. Every field must match; anything else blocks.
export function evaluate(job, expected) {
  const fail = reason => ({ pass: false, reason });
  if (!job || typeof job !== 'object') return fail('Scanner returned no job.');
  if (job.schemaVersion !== SCHEMA_VERSION) return fail('Scanner returned an unsupported response version.');
  if (String(job.repository).toLowerCase() !== expected.repository.toLowerCase() || job.pullRequest !== expected.pullRequest || String(job.commitSha).toLowerCase() !== expected.commitSha.toLowerCase()) return fail('Scanner returned a result for a different repository, PR or commit; refusing it.');
  if (job.status === 'FAILED') return fail(`Scan failed (${job.error?.code ?? 'unknown error'}). Re-run this check; an incomplete scan cannot pass.`);
  if (job.status !== 'COMPLETED') return fail(`Scan is not complete (status ${job.status}).`);
  if (!SUPPORTED_POLICIES.has(job.scanner?.policyVersion)) return fail('Scanner used an unsupported policy version.');
  if (job.filesScanned !== expected.fileCount) return fail(`Scanner reports ${job.filesScanned} files scanned, expected ${expected.fileCount}.`);
  const s = job.summary;
  if (!s || ![s.high, s.medium, s.low].every(n => Number.isInteger(n) && n >= 0)) return fail('Scanner returned an invalid summary.');
  if (job.verdict === 'FAIL' || s.high > 0) return fail(`${s.high} HIGH finding(s) block this merge.`);
  if (job.verdict !== 'PASS' || job.mergeAllowed !== true) return fail('Scanner did not return a passing verdict.');
  return { pass: true, reason: `Complete scan of ${expected.fileCount} file(s): no HIGH findings.` };
}

// ---- Orchestration ------------------------------------------------------------

export async function runGate({ url, token, repository, pullRequest, baseSha, headSha, git, policy, fetchImpl = fetch, now = Date.now, sleep = delay, random = Math.random, options = DEFAULTS, log = console.log }) {
  for (const [name, value] of Object.entries({ url, token, repository, baseSha, headSha })) if (!value) throw new GateError('CONFIGURATION', `${name} is not configured; the scan cannot run, so this PR is not approved.`);
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) throw new GateError('CONFIGURATION', 'Pull request number is missing.');
  if (!/^[a-f0-9]{40}$/i.test(headSha)) throw new GateError('CONFIGURATION', 'Head commit SHA is invalid.');
  const deadline = now() + options.deadlineMs;
  const http = (path, init = {}) => requestWithRetry(new URL(path, url), init, { fetchImpl, deadline, now, sleep, random, options, log });
  const auth = { Authorization: `Bearer ${token}` };

  const { files, excluded, problems } = await collectFiles({ git, baseSha, headSha, policy });
  if (excluded.length) log(`Excluded by the reviewed policy: ${excluded.join(', ')}`);
  if (problems.length) return { pass: false, reason: `Some changed JavaScript cannot be scanned:\n- ${problems.join('\n- ')}`, files };
  log(files.length ? `Scanning ${files.length} changed JavaScript file(s) at ${headSha.slice(0, 12)}:\n  ${files.map(f => f.path).join('\n  ')}` : 'No JavaScript changed; recording an explicit zero-file scan for this commit.');

  const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, repository, pullRequest, commitSha: headSha.toLowerCase(), files });
  const submitted = await http('/v1/jobs', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body });
  if (submitted.status !== 200 && submitted.status !== 202) return { pass: false, reason: explainHttp(submitted, 'Submit') };
  let job = submitted.body;
  log(`Job ${job?.jobId}: ${job?.status}${job?.reused ? ' (reused existing result for this exact commit)' : ''}`);
  let lastStatus = job?.status;
  while (job && (job.status === 'QUEUED' || job.status === 'RUNNING')) {
    if (now() + options.pollMs >= deadline) return { pass: false, reason: `Scan did not finish within ${options.deadlineMs / 60000} minutes (job ${job.jobId}). Re-run this check; it will reuse the same job.` };
    await sleep(options.pollMs);
    const polled = await http(job.statusUrl, { headers: auth });
    if (polled.status !== 200) return { pass: false, reason: explainHttp(polled, 'Status check') };
    job = polled.body;
    if (job?.status !== lastStatus) { log(`Job ${job?.jobId}: ${job?.status}`); lastStatus = job?.status; }
  }
  const expected = { repository, pullRequest, commitSha: headSha, fileCount: files.length };
  let report;
  if (job?.status === 'COMPLETED' && job.report?.url) {
    // The report link is a short-lived capability: fetch it without the service token, never log it.
    const fetched = await http(new URL(job.report.url, url).toString(), {});
    if (fetched.status !== 200) return { pass: false, reason: 'The private report could not be retrieved; not approved.', job };
    report = fetched.body;
    if (report?.jobId !== job.jobId || String(report?.commitSha).toLowerCase() !== headSha.toLowerCase() || report?.verdict !== job.verdict) return { pass: false, reason: 'Report does not match the job result; refusing it.', job };
  }
  return { ...evaluate(job, expected), job, report, files };
}

function explainHttp({ status, body }, what) {
  const code = body?.error?.code ? ` ${body.error.code}` : '';
  const hint = { 400: 'the scanner rejected the request', 401: 'the SCANNER_TOKEN secret is missing or wrong', 403: 'access was refused', 404: 'the job was not found or expired', 409: 'this commit already has a different submission', 413: 'the request is too large', 415: 'unsupported request type' }[status] ?? 'unexpected response';
  return `${what} failed: HTTP ${status}${code} (${hint}). Not approved.`;
}

// ---- GitHub output ------------------------------------------------------------

const escapeData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = s => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const safe = s => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
const cell = s => String(s).replace(/\|/g, '\\|');

export function annotations(report) {
  return (report?.findings ?? []).filter(f => f.severity === 'HIGH').map(f => `::error file=${escapeProperty(f.path)},line=${Number(f.line)},title=${escapeProperty(`${f.ruleId} (HIGH)`)}::${escapeData(f.message)}`);
}

export function stepSummary(result, { headSha }) {
  const lines = [`## Security gate: ${result.pass ? '✅ PASS' : '❌ NOT APPROVED'}`, '', `Commit \`${String(headSha).slice(0, 12)}\` — ${result.reason}`, ''];
  const job = result.job;
  if (job?.summary) lines.push(`| HIGH | MEDIUM | LOW | Files scanned | Policy |`, `|---|---|---|---|---|`, `| ${job.summary.high} | ${job.summary.medium} | ${job.summary.low} | ${job.filesScanned} | ${job.scanner?.policyVersion ?? '?'} |`, '');
  const findings = result.report?.findings ?? [];
  if (findings.length) {
    lines.push('| Severity | Rule | File | Line |', '|---|---|---|---|');
    for (const f of findings.slice(0, 100)) lines.push(`| ${cell(f.severity)} | ${cell(f.ruleId)} | ${cell(f.path)} | ${Number(f.line)} |`);
    if (findings.length > 100) lines.push('', `…and ${findings.length - 100} more.`);
    lines.push('');
  }
  if (job?.jobId) lines.push(`Job ID: \`${job.jobId}\`. Fix HIGH findings and push a new commit; MEDIUM and LOW are warnings.`);
  return lines.join('\n') + '\n';
}

// ---- CLI ------------------------------------------------------------------------

async function main() {
  const env = process.env;
  const root = fileURLToPath(new URL('../', import.meta.url));
  let policy = {};
  try { policy = JSON.parse(await readFile(new URL('../.github/security-gate.json', import.meta.url), 'utf8')); } catch { /* no policy file: nothing excluded */ }
  let result;
  try {
    result = await runGate({ url: env.SCANNER_URL?.trim(), token: env.SCANNER_TOKEN?.trim(), repository: env.REPOSITORY, pullRequest: Number(env.PR_NUMBER), baseSha: env.BASE_SHA, headSha: env.HEAD_SHA, git: defaultGit(env.GIT_DIR_ROOT ?? root), policy });
  } catch (error) {
    result = { pass: false, reason: error instanceof GateError ? error.message : 'Unexpected client failure; not approved.' };
  }
  for (const line of annotations(result.report)) console.log(line);
  console.log(result.pass ? `Security gate passed: ${result.reason}` : `::error title=Security gate::${escapeData(result.reason)}`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, stepSummary(result, { headSha: env.HEAD_SHA })).catch(() => {});
  process.exitCode = result.pass ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
