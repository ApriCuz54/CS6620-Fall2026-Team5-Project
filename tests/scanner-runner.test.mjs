// Tests for the one-shot SAST runner (services/scanner/runner.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runJob, LIMITS } from '../services/scanner/runner.mjs';

const RUNNER = fileURLToPath(new URL('../services/scanner/runner.mjs', import.meta.url));

// Run the runner as a separate process, feeding JSON on stdin.
function runCli(input) {
  const r = spawnSync(process.execPath, [RUNNER], { input, encoding: 'utf8', timeout: 10000 });
  return { status: r.status, out: JSON.parse(r.stdout) };
}

test('vulnerable fixture produces a sanitized HIGH finding', () => {
  const result = runJob({ files: [{ path: 'src/vulnerable.js', content: 'const password = "demo-only-value";' }] });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.filesScanned, 1);
  const f = result.findings.find((x) => x.ruleId === 'HARDCODED_SECRET');
  assert.ok(f);
  assert.deepEqual(Object.keys(f).sort(), ['line', 'message', 'path', 'ruleId', 'severity']);
  assert.equal(f.path, 'src/vulnerable.js');
  // No source text may leak into the report.
  assert.ok(!JSON.stringify(result).includes('demo-only-value'));
});

test('clean fixture has no HIGH findings', () => {
  const result = runJob({ files: [{ path: 'clean.js', content: 'export const add = (a, b) => a + b;' }] });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.summary.HIGH, 0);
});

test('summary counts match findings', () => {
  const result = runJob({ files: [
    { path: 'a.js', content: 'const password = "abcd1234";\nconsole.log(password);' },
    { path: 'b.js', content: 'const n = Math.random();' },
  ] });
  const total = result.summary.HIGH + result.summary.MEDIUM + result.summary.LOW;
  assert.equal(total, result.findings.length);
  assert.equal(result.filesScanned, 2);
});

test('submitted code is never executed', () => {
  // If this code ran, it would throw and also create a global marker.
  const evil = 'globalThis.__ran = true; throw new Error("executed");';
  const result = runJob({ files: [{ path: 'evil.js', content: evil }] });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(globalThis.__ran, undefined);
});

test('rejects unsafe paths, duplicates and unsupported files', () => {
  for (const path of ['../x.js', '/etc/x.js', 'a\\b.js', 'readme.md', 'a//b.js']) {
    assert.throws(() => runJob({ files: [{ path, content: '' }] }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => runJob({ files: [{ path: 'a.js', content: '' }, { path: 'a.js', content: '' }] }), { code: 'INVALID_INPUT' });
});

test('rejects inputs over the file and size limits', () => {
  const tooMany = Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => ({ path: `f${i}.js`, content: '' }));
  assert.throws(() => runJob({ files: tooMany }), { code: 'INPUT_TOO_LARGE' });
  const big = 'x'.repeat(LIMITS.maxFileBytes + 1);
  assert.throws(() => runJob({ files: [{ path: 'big.js', content: big }] }), { code: 'INPUT_TOO_LARGE' });
});

test('CLI: valid job exits 0 with COMPLETE', () => {
  const { status, out } = runCli(JSON.stringify({ files: [{ path: 'clean.js', content: 'const a = 1;' }] }));
  assert.equal(status, 0);
  assert.equal(out.status, 'COMPLETE');
});

test('CLI: malformed JSON exits non-zero with ERROR, never COMPLETE', () => {
  const { status, out } = runCli('{not json');
  assert.notEqual(status, 0);
  assert.equal(out.status, 'ERROR');
  assert.equal(out.error.code, 'INVALID_INPUT');
});
