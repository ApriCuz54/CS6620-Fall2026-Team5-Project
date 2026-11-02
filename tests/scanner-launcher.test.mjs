// Tests for the scan launcher (services/scanner/launcher.mjs).
// The Docker tests need Docker running and the image built:
//   docker build -f Dockerfile.scanner -t cs6620-scanner:dev .
// Without them, those tests are skipped (not failed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildDockerArgs, validateComplete, runScanInContainer, DEFAULTS } from '../services/scanner/launcher.mjs';

const dockerReady =
  spawnSync('docker', ['image', 'inspect', DEFAULTS.image], { stdio: 'ignore' }).status === 0;
const skip = dockerReady ? false : `Docker or image ${DEFAULTS.image} not available`;

const NODE = '/usr/local/bin/node';
const vulnerableJob = { files: [{ path: 'src/app.js', content: 'const password = "demo-only-value";' }] };

// Simulate a misbehaving scan by running custom code inside the same locked-down container.
const simulate = (code, extra = {}) =>
  runScanInContainer(vulnerableJob, { entrypoint: NODE, command: ['-e', code], ...extra });

// True if no container with this name prefix is left behind.
function noLeftoverContainers() {
  const r = spawnSync('docker', ['ps', '-aq', '--filter', 'name=sast-scan-'], { encoding: 'utf8' });
  return r.stdout.trim() === '';
}

// ---------- Tests that do not need Docker ----------

test('docker args include every isolation limit', () => {
  const a = buildDockerArgs('sast-scan-test').join(' ');
  for (const flag of [
    '--network none', '--cpus 0.5', '--memory 256m', '--memory-swap 256m', '--pids-limit 64',
    '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 1000:1000',
  ]) assert.ok(a.includes(flag), `missing ${flag}`);
  assert.ok(a.includes('size=16m'));
  // Nothing sensitive is passed into the container.
  for (const bad of ['-v ', '--volume', 'docker.sock', '--privileged', '-e ', '--env']) {
    assert.ok(!a.includes(bad), `must not include ${bad}`);
  }
});

test('a partial or miscounted report is not accepted as complete', () => {
  const f = { ruleId: 'X', severity: 'HIGH', path: 'a.js', line: 1, message: 'm' };
  const ok = { filesRequested: 2, filesScanned: 2, summary: { HIGH: 1, MEDIUM: 0, LOW: 0 }, findings: [f] };
  assert.equal(validateComplete(ok, 2), true);
  assert.equal(validateComplete({ ...ok, filesScanned: 1 }, 2), false);              // partial scan
  assert.equal(validateComplete({ ...ok, summary: { HIGH: 0, MEDIUM: 0, LOW: 0 } }, 2), false); // wrong count
  assert.equal(validateComplete({ ...ok, findings: [{ ...f, evidence: 'secret' }] }, 2), false); // extra field
});

// ---------- Tests that run real containers ----------

test('real scan in a container finds the HIGH issue and cleans up', { skip }, async () => {
  const r = await runScanInContainer(vulnerableJob);
  assert.equal(r.status, 'COMPLETE');
  assert.equal(r.summary.HIGH, 1);
  assert.ok(noLeftoverContainers());
});

test('hang: killed at the deadline from outside, ERROR TIMEOUT', { skip }, async () => {
  const start = Date.now();
  const r = await simulate('setInterval(() => {}, 1000)', { timeoutMs: 3000 });
  assert.equal(r.status, 'ERROR');
  assert.equal(r.error.code, 'TIMEOUT');
  assert.ok(Date.now() - start < 15_000);
  assert.ok(noLeftoverContainers());
});

test('CPU stress: busy loop is stopped by the deadline, ERROR TIMEOUT', { skip }, async () => {
  const r = await simulate('for (;;) {}', { timeoutMs: 3000 });
  assert.equal(r.error?.code, 'TIMEOUT');
  assert.ok(noLeftoverContainers());
});

test('out of memory: killed by the memory limit, ERROR OUT_OF_MEMORY', { skip }, async () => {
  // Buffers live outside the JS heap, so the container memory limit is what stops this.
  const r = await simulate('const a = []; for (;;) a.push(Buffer.alloc(16 * 1024 * 1024, 1));');
  assert.equal(r.status, 'ERROR');
  assert.equal(r.error.code, 'OUT_OF_MEMORY');
  assert.ok(noLeftoverContainers());
});

test('crash: non-zero exit without output, ERROR CRASHED', { skip }, async () => {
  const r = await simulate('process.exit(3)');
  assert.equal(r.error?.code, 'CRASHED');
  assert.ok(noLeftoverContainers());
});

test('invalid output and fake "COMPLETE" results never pass', { skip }, async () => {
  const bad = await simulate('console.log("not json")');
  assert.equal(bad.error?.code, 'BAD_RUNNER_OUTPUT');
  const fake = '{"status":"COMPLETE","filesRequested":1,"filesScanned":0,"summary":{"HIGH":0,"MEDIUM":0,"LOW":0},"findings":[]}';
  const r = await simulate(`console.log(${JSON.stringify(fake)})`);
  assert.equal(r.status, 'ERROR');
});

test('oversized output is cut off, ERROR OUTPUT_TOO_LARGE', { skip }, async () => {
  const r = await simulate('process.stdout.write("x".repeat(2 * 1024 * 1024))');
  assert.equal(r.error?.code, 'OUTPUT_TOO_LARGE');
  assert.ok(noLeftoverContainers());
});

test('cancellation (e.g. lost lease) kills the container, ERROR CANCELLED', { skip }, async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1000);
  const r = await simulate('setInterval(() => {}, 1000)', { signal: ac.signal });
  assert.equal(r.error?.code, 'CANCELLED');
  assert.ok(noLeftoverContainers());
});

test('network is blocked inside the scan container', { skip }, () => {
  const args = buildDockerArgs('sast-scan-nettest', {
    entrypoint: NODE,
    command: ['-e', "fetch('http://169.254.169.254/').then(() => console.log('OPEN')).catch(() => console.log('BLOCKED'))"],
  });
  args.splice(1, 0, '--rm');
  const r = spawnSync('docker', args, { encoding: 'utf8', input: '', timeout: 20_000 });
  assert.equal(r.stdout.trim(), 'BLOCKED');
});
