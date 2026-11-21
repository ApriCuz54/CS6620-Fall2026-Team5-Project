// Tests for the GitHub gate client (scripts/github-client.mjs).
// Integration tests run the real local API, local worker and supplied scanner (in-process).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { evaluate, requestWithRetry, collectFiles, runGate, defaultGit, annotations, stepSummary, DEFAULTS } from '../scripts/github-client.mjs';
import { createApp } from '../services/gate/app.mjs';
import { createLocalStore } from '../services/gate/store.mjs';
import { createLocalWorker } from '../services/gate/worker.mjs';
import { createScanner } from '../services/scanner/scan.mjs';

const repository = 'ApriCuz54/CS6620-Fall2026-Team5-Project';
const sha = 'c'.repeat(40);
const expected = { repository, pullRequest: 7, commitSha: sha, fileCount: 1 };
const passing = { schemaVersion: '2', repository: repository.toLowerCase(), pullRequest: 7, commitSha: sha, status: 'COMPLETED', verdict: 'PASS', mergeAllowed: true, scanner: { policyVersion: 'high-blocks-v1' }, filesScanned: 1, summary: { high: 0, medium: 2, low: 0 } };

// ---- approval rule ----

test('evaluate passes only a complete PASS bound to the exact repository, PR and commit', () => {
  assert.equal(evaluate(passing, expected).pass, true);
  const blocked = [
    { ...passing, verdict: 'FAIL', mergeAllowed: false, summary: { high: 1, medium: 0, low: 0 } },
    { ...passing, summary: { high: 1, medium: 0, low: 0 } },
    { ...passing, status: 'FAILED', verdict: 'ERROR', error: { code: 'TIMEOUT' } },
    { ...passing, status: 'RUNNING' },
    { ...passing, commitSha: 'd'.repeat(40) },
    { ...passing, pullRequest: 8 },
    { ...passing, repository: 'someone/else' },
    { ...passing, scanner: { policyVersion: 'unknown' } },
    { ...passing, filesScanned: 0 },
    { ...passing, mergeAllowed: false },
    { ...passing, schemaVersion: '1', mode: 'dummy' },
    { ...passing, summary: undefined },
    undefined
  ];
  for (const job of blocked) assert.equal(evaluate(job, expected).pass, false, JSON.stringify(job));
});

// ---- retries ----

function fakeFetch(sequence) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    calls.push(init);
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    return { status: next.status, headers: new Headers(next.headers ?? {}), json: async () => next.body ?? {} };
  } };
}
const fastOptions = { ...DEFAULTS, backoffMs: [10, 20, 40, 80] };
function clock() { let t = 0; return { now: () => t, sleep: async ms => { t += ms; }, waits: [] }; }

test('retries network errors and 429/503 with the identical request, honoring Retry-After', async () => {
  const c = clock(); const waits = []; const sleep = async ms => { waits.push(ms); await c.sleep(ms); };
  const f = fakeFetch([new TypeError('fetch failed'), { status: 503 }, { status: 429, headers: { 'retry-after': '3' } }, { status: 202, body: { ok: true } }]);
  const r = await requestWithRetry('http://x/v1/jobs', { method: 'POST', body: 'same' }, { fetchImpl: f.fetchImpl, deadline: 60000, now: c.now, sleep, random: () => 0.5, options: fastOptions });
  assert.equal(r.status, 202); assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(call => call.body === 'same'));
  assert.ok(waits[2] >= 3000, 'Retry-After respected');
});

test('does not retry 400/401/409 and gives up after bounded attempts or the deadline', async () => {
  for (const status of [400, 401, 403, 404, 409, 413]) {
    const c = clock(); const f = fakeFetch([{ status }]);
    assert.equal((await requestWithRetry('http://x', {}, { fetchImpl: f.fetchImpl, deadline: 60000, now: c.now, sleep: c.sleep, options: fastOptions })).status, status);
    assert.equal(f.calls.length, 1);
  }
  const c = clock(); const f = fakeFetch(Array(10).fill({ status: 502 }));
  await assert.rejects(requestWithRetry('http://x', {}, { fetchImpl: f.fetchImpl, deadline: 60000, now: c.now, sleep: c.sleep, options: fastOptions }), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(f.calls.length, 5);
  const d = clock(); const g = fakeFetch(Array(10).fill({ status: 503, headers: { 'retry-after': '120' } }));
  await assert.rejects(requestWithRetry('http://x', {}, { fetchImpl: g.fetchImpl, deadline: 60000, now: d.now, sleep: d.sleep, options: fastOptions }), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(g.calls.length, 1, 'a wait past the deadline is not attempted');
});

// ---- source collection from a real git repository ----

function fakeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cs6620-pr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  const write = files => { for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); } };
  const commit = (files, remove = []) => { write(files); for (const p of remove) git('rm', '-q', p); git('add', '-A'); git('commit', '-qm', 'c', '--allow-empty'); return git('rev-parse', 'HEAD'); };
  return { dir, git, commit, branch: (name, from) => git('checkout', '-q', '-b', name, from) };
}

test('collects only changed JS from the exact head commit; excluded, oversized and unsupported files are explicit', async t => {
  const r = fakeRepo(t);
  const base = r.commit({ 'old.js': 'export const a = 1;', 'gone.js': 'x', 'README.md': '#' });
  r.branch('pr', base);
  const head = r.commit({ 'src/new.js': 'export const b = 2;', 'old.js': 'export const a = 3;', 'node_modules/dep/index.js': 'x', 'notes.md': 'y' }, ['gone.js']);
  writeFileSync(join(r.dir, 'src/new.js'), 'UNCOMMITTED WORKING TREE');
  const got = await collectFiles({ git: defaultGit(r.dir), baseSha: base, headSha: head, policy: { excludeDirectories: ['node_modules'] } });
  assert.deepEqual(got.files.map(f => f.path).sort(), ['old.js', 'src/new.js']);
  assert.equal(got.files.find(f => f.path === 'src/new.js').content, 'export const b = 2;');
  assert.deepEqual(got.excluded, ['node_modules/dep/index.js']); assert.deepEqual(got.problems, []);

  const big = r.commit({ 'big.js': 'x'.repeat(70 * 1024), 'my file.js': 'x' });
  const bad = await collectFiles({ git: defaultGit(r.dir), baseSha: base, headSha: big, policy: {} });
  assert.equal(bad.problems.length, 2);
  const many = r.commit(Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`m/f${i}.js`, 'x'])));
  assert.ok((await collectFiles({ git: defaultGit(r.dir), baseSha: base, headSha: many })).problems.some(p => p.includes('at most 25')));
});

// ---- end-to-end against the real local API and scanner ----

async function api(t, { scanner = createScanner({ isolation: 'in-process' }) } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cs6620-gate-'));
  const store = createLocalStore(directory);
  const token = randomBytes(32).toString('hex');
  const app = createApp({ store, token, signingKey: randomBytes(32), allowedRepository: repository });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const worker = createLocalWorker({ store, scanner, intervalMs: 20 }); worker.start();
  t.after(async () => { await worker.stop(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${server.address().port}`, token };
}
const quick = { ...DEFAULTS, pollMs: 50, deadlineMs: 20000, backoffMs: [10, 20, 40, 80] };

test('e2e: vulnerable PR is blocked, corrected commit passes, docs-only PR passes with a zero-file scan', async t => {
  const s = await api(t); const r = fakeRepo(t);
  const base = r.commit({ 'README.md': '# demo', 'lib.js': 'export const one = 1;' });
  r.branch('pr', base);
  const vulnerable = r.commit({ 'src/login.js': 'const password = "hunter2-demo";\nexport default password;' });
  const fixed = r.commit({ 'src/login.js': 'export const password = process.env.LOGIN_PASSWORD;' });
  r.branch('docs', base);
  const docs = r.commit({ 'README.md': '# demo\nmore docs' });
  const gate = headSha => runGate({ url: s.url, token: s.token, repository, pullRequest: 3, baseSha: base, headSha, git: defaultGit(r.dir), options: quick, log: () => {} });

  const blocked = await gate(vulnerable);
  assert.equal(blocked.pass, false); assert.match(blocked.reason, /HIGH/);
  assert.ok(blocked.report.findings.some(f => f.severity === 'HIGH' && f.path === 'src/login.js'));
  assert.equal(JSON.stringify(blocked.report).includes('hunter2-demo'), false);
  assert.ok(annotations(blocked.report)[0].startsWith('::error file=src/login.js,line=1,'));
  assert.match(stepSummary(blocked, { headSha: vulnerable }), /NOT APPROVED/);

  const passed = await gate(fixed);
  assert.equal(passed.pass, true, passed.reason); assert.equal(passed.job.commitSha, fixed);
  assert.match(stepSummary(passed, { headSha: fixed }), /PASS/);

  const zero = await gate(docs);
  assert.equal(zero.pass, true, zero.reason); assert.equal(zero.job.filesScanned, 0);

  const again = await gate(vulnerable);
  assert.equal(again.pass, false, 'a re-run reuses the same commit result and stays blocked');
});

test('e2e: wrong token, unreachable service and scanner failures never pass', async t => {
  const s = await api(t); const r = fakeRepo(t);
  const base = r.commit({ 'a.js': 'export const a = 1;' }); r.branch('pr', base);
  const head = r.commit({ 'b.js': 'export const b = 1;' });
  const run = over => runGate({ url: s.url, token: s.token, repository, pullRequest: 4, baseSha: base, headSha: head, git: defaultGit(r.dir), options: quick, log: () => {}, ...over });
  const wrong = await run({ token: 'x'.repeat(64) });
  assert.equal(wrong.pass, false); assert.match(wrong.reason, /401/);
  await assert.rejects(run({ url: 'http://127.0.0.1:9' }), { code: 'SERVICE_UNAVAILABLE' });
  await assert.rejects(run({ token: '' }), { code: 'CONFIGURATION' });

  const broken = await api(t, { scanner: { isolation: 'test', scan: async () => ({ status: 'ERROR', error: { code: 'TIMEOUT' } }) } });
  const timedOut = await run({ url: broken.url, token: broken.token });
  assert.equal(timedOut.pass, false); assert.match(timedOut.reason, /TIMEOUT/);
});
