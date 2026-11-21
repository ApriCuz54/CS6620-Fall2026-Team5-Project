import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { fixture } from './fixtures.mjs';
const root = new URL('../', import.meta.url);
const token = (await readFile(new URL('.local/dev-api-token', root), 'utf8')).trim();
const example = JSON.parse(await readFile(new URL('contracts/examples/submit-clean.json', root), 'utf8'));
const name = process.argv[2] ?? 'clean';
const { files, verdict: expected } = fixture(name);
const body = { ...example, commitSha: randomBytes(20).toString('hex'), files, repository: process.env.SCANNER_REPOSITORY ?? example.repository };
const base = `http://127.0.0.1:${process.env.SCANNER_PORT ?? 3100}`;
async function request(path, body, auth = true) {
  const response = await fetch(new URL(path, base), { method: body ? 'POST' : 'GET', headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Request failed: HTTP ${response.status}`);
  return response.json();
}
try {
  let job = await request('/v1/jobs', body);
  for (let n = 0; n < 300; n++) {
    console.log(`${job.status}: ${job.jobId}; verdict=${job.verdict}; mergeAllowed=${job.mergeAllowed}`);
    if (job.status === 'COMPLETED' || job.status === 'FAILED') break;
    await wait(200); job = await request(job.statusUrl);
  }
  if (job.status === 'COMPLETED') {
    const report = await request(job.report.url, undefined, false);
    console.log(JSON.stringify({ verdict: report.verdict, mergeAllowed: report.mergeAllowed, summary: report.summary, findings: report.findings }, null, 2));
    if (report.verdict !== expected) throw new Error(`Expected verdict ${expected} for the ${name} fixture.`);
  } else if (job.status === 'FAILED') throw new Error(`Scan failed: ${job.error?.code}`);
  else throw new Error('Polling deadline exceeded.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
