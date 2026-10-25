import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../services/gate/app.mjs';
import { createLocalStore } from '../services/gate/store.mjs';
import { createDummyWorker } from '../services/gate/dummy-worker.mjs';

const repository = 'ApriCuz54/CS6620-Fall2026-Team5-Project';
const submission = overrides => ({ schemaVersion: '1', repository, pullRequest: 1, commitSha: 'a'.repeat(40), simulation: 'clean', files: [{ path: 'src/example.js', content: 'const password = "DO_NOT_LEAK_THIS_SOURCE";' }], ...overrides });
async function harness(t, { maxJobs = 100 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cs6620-gate-'));
  let clock = Date.UTC(2026, 0, 1);
  const now = () => clock;
  const store = createLocalStore(directory, { now, maxJobs });
  const token = randomBytes(32).toString('hex');
  const app = createApp({ store, token, signingKey: randomBytes(32), allowedRepository: repository, now });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const worker = createDummyWorker({ store, now, delayMs: 100 });
  t.after(async () => { worker.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const r = await fetch(new URL(path, base), { method, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    return { status: r.status, headers: r.headers, body: await r.json() };
  }
  return { store, worker, directory, now, request, advance: ms => { clock += ms; }, submit: body => request('/v1/jobs', { method: 'POST', body }) };
}

test('job routes require the service token and do not reflect credentials', async t => {
  const h = await harness(t);
  const unauthenticated = await h.request('/v1/jobs', { method: 'POST', body: submission(), auth: false });
  assert.equal(unauthenticated.status, 401);
  const wrong = await h.request('/v1/jobs/unknown', { headers: { Authorization: 'Bearer INCORRECT' } });
  assert.equal(wrong.status, 401);
  assert.equal(JSON.stringify(wrong.body).includes('INCORRECT'), false);
  assert.equal((await h.request('/health', { auth: false })).body.mode, 'dummy');
});

test('submit, queue, run, report: even clean dummy results cannot approve a merge', async t => {
  const h = await harness(t);
  const accepted = await h.submit(submission()); assert.equal(accepted.status, 202);
  assert.equal(accepted.body.status, 'QUEUED'); assert.equal(accepted.body.mergeAllowed, false);
  assert.equal(JSON.stringify(accepted.body).includes('DO_NOT_LEAK_THIS_SOURCE'), false);
  h.worker.step();
  assert.equal((await h.request(accepted.body.statusUrl)).body.status, 'RUNNING');
  h.advance(101); h.worker.step();
  const done = await h.request(accepted.body.statusUrl);
  assert.equal(done.body.status, 'COMPLETED'); assert.equal(done.body.gate, 'NOT_EVALUATED');
  assert.equal(done.body.mergeAllowed, false); assert.equal(done.body.summary.high, 0);
  const report = await h.request(done.body.report.url, { auth: false });
  assert.equal(report.status, 200); assert.equal(report.body.mergeAllowed, false);
  assert.equal(report.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(report.body).includes('DO_NOT_LEAK_THIS_SOURCE'), false);
  assert.equal(readFileSync(join(h.directory, 'jobs.json'), 'utf8').includes('DO_NOT_LEAK_THIS_SOURCE'), false);
});

test('duplicate submissions reuse one job; same exact SHA with changed source is a conflict', async t => {
  const h = await harness(t);
  const first = await h.submit(submission()); const again = await h.submit(submission());
  assert.equal(again.status, 200); assert.equal(again.body.reused, true); assert.equal(first.body.jobId, again.body.jobId);
  const conflict = await h.submit(submission({ files: [{ path: 'src/example.js', content: 'changed' }] }));
  assert.equal(conflict.status, 409); assert.equal(conflict.body.mergeAllowed, false);
  assert.equal((await h.request(first.body.statusUrl)).body.commitSha, 'a'.repeat(40));
  assert.equal((await h.submit(submission({ commitSha: 'b'.repeat(40) }))).status, 202);
});

test('file ordering and repository/SHA case do not duplicate a submission', async t => {
  const h = await harness(t);
  const files = [{ path: 'b.js', content: '' }, { path: 'a.js', content: '' }];
  const first = await h.submit(submission({ files }));
  const second = await h.submit(submission({ repository: repository.toUpperCase(), commitSha: 'A'.repeat(40), files: [...files].reverse() }));
  assert.equal(second.body.jobId, first.body.jobId); assert.equal(second.status, 200);
});

test('rejects traversal, unsupported files, invalid metadata, duplicate paths and wrong repositories', async t => {
  const h = await harness(t);
  for (const body of [
    submission({ files: [{ path: '../secret.js', content: '' }] }),
    submission({ files: [{ path: '/absolute.js', content: '' }] }),
    submission({ files: [{ path: 'src\\file.js', content: '' }] }),
    submission({ files: [{ path: 'app.py', content: '' }] }),
    submission({ files: [{ path: 'app.js', content: '' }, { path: 'app.js', content: '' }] }),
    submission({ files: [{ path: 'app.js', content: 'é'.repeat(40000) }] }),
    submission({ files: [] }), submission({ commitSha: 'main' }), submission({ pullRequest: 1.5 }),
    submission({ repository: 'someone/else' }), submission({ extra: true }), submission({ simulation: 'pass' })
  ]) assert.equal((await h.submit(body)).status, 400);
});

test('rejects malformed, oversized and non-JSON requests safely', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/v1/jobs', { method: 'POST', body: '{broken' })).status, 400);
  assert.equal((await h.request('/v1/jobs', { method: 'POST', body: JSON.stringify({ content: 'x'.repeat(300000) }) })).status, 413);
  assert.equal((await h.request('/v1/jobs', { method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' } })).status, 415);
});

test('signed report links reject missing, altered, cross-job and expired signatures', async t => {
  const h = await harness(t);
  const a = await h.submit(submission()); h.worker.step(); h.advance(101); h.worker.step();
  const done = await h.request(a.body.statusUrl); const url = done.body.report.url;
  assert.equal((await h.request(`${a.body.statusUrl}/report`, { auth: false })).status, 403);
  assert.equal((await h.request(url.replace(/signature=./, 'signature=z'), { auth: false })).status, 403);
  const b = await h.submit(submission({ commitSha: 'b'.repeat(40) }));
  assert.equal((await h.request(url.replace(a.body.jobId, b.body.jobId), { auth: false })).status, 403);
  h.advance(61000);
  assert.equal((await h.request(url, { auth: false })).body.error.code, 'EXPIRED_REPORT_LINK');
  const fresh = await h.request(a.body.statusUrl);
  assert.equal((await h.request(fresh.body.report.url, { auth: false })).status, 200);
});

test('simulated high findings and worker errors remain non-passing', async t => {
  const h = await harness(t);
  const high = await h.submit(submission({ simulation: 'high' })); h.worker.step(); h.advance(101); h.worker.step();
  const result = await h.request(high.body.statusUrl);
  assert.equal(result.body.summary.high, 1); assert.equal(result.body.mergeAllowed, false);
  const failed = await h.submit(submission({ simulation: 'error', commitSha: 'b'.repeat(40) })); h.worker.step(); h.advance(101); h.worker.step();
  const failure = await h.request(failed.body.statusUrl);
  assert.equal(failure.body.status, 'FAILED'); assert.equal(failure.body.mergeAllowed, false);
  assert.equal(failure.body.report, undefined); assert.equal(failure.body.error.code, 'SIMULATED_FAILURE');
  assert.equal(JSON.stringify(h.store.get(failed.body.jobId)).includes('DO_NOT_LEAK_THIS_SOURCE'), false);
});

test('a busy worker queues more jobs; capacity exhaustion is explicit and retryable', async t => {
  const h = await harness(t, { maxJobs: 2 });
  const a = await h.submit(submission()); h.worker.step();
  const b = await h.submit(submission({ commitSha: 'b'.repeat(40) }));
  assert.equal(b.status, 202); assert.equal(b.body.status, 'QUEUED');
  assert.equal((await h.request(a.body.statusUrl)).body.status, 'RUNNING');
  const full = await h.submit(submission({ commitSha: 'c'.repeat(40) }));
  assert.equal(full.status, 503); assert.equal(full.headers.get('retry-after'), '2'); assert.equal(full.body.mergeAllowed, false);
});

test('local store persists jobs and safely requeues an interrupted dummy job on restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cs6620-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = createLocalStore(directory);
  const canonical = submission(); canonical.repository = repository.toLowerCase();
  const first = store.submit({ canonical, identity: 'test-identity', digest: 'test-digest' });
  store.update(first.job.id, j => { j.status = 'RUNNING'; j.startedAtMs = Date.now(); });
  assert.throws(() => createLocalStore(directory), { code: 'EEXIST' });
  store.close(); store = createLocalStore(directory);
  assert.equal(store.get(first.job.id).status, 'QUEUED');
  assert.equal(store.submit({ canonical, identity: 'test-identity', digest: 'test-digest' }).job.id, first.job.id);
  store.close();
  writeFileSync(join(directory, 'jobs.json'), '{corrupt');
  assert.throws(() => createLocalStore(directory));
  assert.equal(existsSync(join(directory, 'writer.lock')), false);
  assert.equal(readFileSync(join(directory, 'jobs.json'), 'utf8'), '{corrupt');
});

test('expired local jobs become unavailable and capacity is reclaimed on submission', async t => {
  const h = await harness(t, { maxJobs: 1 });
  const first = await h.submit(submission());
  h.advance(24 * 60 * 60 * 1000);
  assert.equal((await h.request(first.body.statusUrl)).status, 404);
  assert.equal((await h.submit(submission({ commitSha: 'b'.repeat(40) }))).status, 202);
});

test('API awaits asynchronous adapters and sanitizes rejected storage promises', async t => {
  const h = await harness(t);
  const original = h.store.submit.bind(h.store);
  h.store.submit = async (...args) => { await Promise.resolve(); return original(...args); };
  const job = await h.submit(submission());
  assert.equal(job.status, 202);
  h.store.get = async () => { throw new Error('PRIVATE_INTERNAL_STORAGE_DETAIL'); };
  const failure = await h.request(job.body.statusUrl);
  assert.equal(failure.status, 500);
  assert.equal(failure.body.mergeAllowed, false);
  assert.equal(JSON.stringify(failure.body).includes('PRIVATE_INTERNAL_STORAGE_DETAIL'), false);
});
