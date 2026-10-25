import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
const root = new URL('../', import.meta.url);
const token = (await readFile(new URL('.local/dev-api-token', root), 'utf8')).trim();
const fixture = JSON.parse(await readFile(new URL('contracts/examples/submit-clean.json', root), 'utf8'));
fixture.simulation = process.argv[2] ?? 'clean';
fixture.commitSha = ({clean:'a',high:'b',error:'c'}[fixture.simulation] ?? 'd').repeat(40);
fixture.repository = process.env.SCANNER_REPOSITORY ?? fixture.repository;
const base = `http://127.0.0.1:${process.env.SCANNER_PORT ?? 3100}`;
async function request(path, body, auth = true) {
  const response = await fetch(new URL(path, base), { method: body ? 'POST' : 'GET', headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Request failed: HTTP ${response.status}`);
  return response.json();
}
try {
  let job = await request('/v1/jobs', fixture);
  for (let n = 0; n < 50; n++) {
    console.log(`${job.status}: ${job.jobId}; mode=${job.mode}; mergeAllowed=${job.mergeAllowed}`);
    if (job.status === 'COMPLETED' || job.status === 'FAILED') break;
    await wait(200); job = await request(job.statusUrl);
  }
  if (job.status === 'COMPLETED') {
    const report = await request(job.report.url, undefined, false);
    console.log(JSON.stringify({ mode: report.mode, gate: report.gate, mergeAllowed: report.mergeAllowed, summary: report.summary }, null, 2));
  } else if (job.status === 'FAILED') console.log('Expected simulated failure; it cannot approve a merge.');
  else throw new Error('Polling deadline exceeded.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
