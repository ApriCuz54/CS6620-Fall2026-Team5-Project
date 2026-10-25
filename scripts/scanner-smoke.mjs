// Run supplied regex scanner in a bounded child process. Source fixtures are never executed.
import { spawnSync } from 'node:child_process';
const code = `
import assert from 'node:assert/strict';
import { scanCode } from './sast/backend/scanner.js';
const bad = scanCode('const password = "demo-only-value";', 'vulnerable.js');
assert.ok(bad.some(x => x.severity === 'HIGH' && x.id === 'HARDCODED_SECRET'));
const good = scanCode('export const add = (a, b) => a + b;', 'clean.js');
assert.equal(good.filter(x => x.severity === 'HIGH').length, 0);
console.log('PASS: supplied scanner detects a HIGH issue and accepts the clean fixture.');
`;
const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 });
if (r.stdout) process.stdout.write(r.stdout);
if (r.error || r.status !== 0) { console.error('FAIL: scanner smoke test', r.error?.message || r.stderr); process.exitCode = 1; }
