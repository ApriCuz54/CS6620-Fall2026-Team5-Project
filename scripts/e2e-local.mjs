// Local end-to-end demo of the whole gate, no AWS needed:
//   real job API + real worker + supplied scanner  <-  GitHub client CLI (as Actions runs it)
// It builds a throwaway git repo with a vulnerable PR commit, its corrected commit and a
// docs-only PR, then checks: vulnerable blocks, corrected passes, docs-only passes.
// Scanner isolation: containers when the cs6620-scanner:dev image exists (build it with
//   docker build -f Dockerfile.scanner -t cs6620-scanner:dev .), otherwise in-process.
//   Force one with SCANNER_ISOLATION=container|in-process.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp } from '../services/gate/app.mjs';
import { createLocalStore } from '../services/gate/store.mjs';
import { createLocalWorker } from '../services/gate/worker.mjs';
import { createScanner } from '../services/scanner/scan.mjs';
import { DEFAULTS as LAUNCHER } from '../services/scanner/launcher.mjs';

const client = fileURLToPath(new URL('./github-client.mjs', import.meta.url));
const repository = 'ApriCuz54/CS6620-Fall2026-Team5-Project';
const imageReady = spawnSync('docker', ['image', 'inspect', LAUNCHER.image], { stdio: 'ignore' }).status === 0;
const isolation = process.env.SCANNER_ISOLATION ?? (imageReady ? 'container' : 'in-process');
const scanner = createScanner({ isolation });

const work = mkdtempSync(join(tmpdir(), 'cs6620-e2e-'));
const store = createLocalStore(join(work, 'store'));
const token = randomBytes(32).toString('hex');
const app = createApp({ store, token, signingKey: randomBytes(32), allowedRepository: repository });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const worker = createLocalWorker({ store, scanner }); worker.start(e => console.error('Worker error:', e.message));
const url = `http://127.0.0.1:${server.address().port}`;

const repo = join(work, 'repo');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
execFileSync('git', ['init', '-q', repo]); git('config', 'user.email', 'demo@example.com'); git('config', 'user.name', 'Demo');
const commit = (files, msg) => { for (const [p, c] of Object.entries(files)) writeFileSync(join(repo, p), c); git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
const base = commit({ 'README.md': '# demo app\n', 'app.js': 'export const greet = name => `hi ${name}`;\n' }, 'base');
git('checkout', '-q', '-b', 'feature');
const vulnerable = commit({ 'login.js': 'const password = "letmein-demo-only";\nexport const login = user => user.password === password;\n' }, 'add login (vulnerable)');
const corrected = commit({ 'login.js': 'export const login = user => user.password === process.env.LOGIN_PASSWORD;\n' }, 'read key from environment');
git('checkout', '-q', '-b', 'docs', base);
const docsOnly = commit({ 'README.md': '# demo app\nMore documentation.\n' }, 'docs only');

async function gate(name, pr, headSha, expectPass, extraEnv = {}) {
  const summary = join(work, `summary-${pr}-${headSha.slice(0, 7)}.md`);
  const env = { ...process.env, SCANNER_URL: url, SCANNER_TOKEN: token, REPOSITORY: repository, PR_NUMBER: String(pr), BASE_SHA: base, HEAD_SHA: headSha, GIT_DIR_ROOT: repo, GITHUB_STEP_SUMMARY: summary, ...extraEnv };
  const r = await promisify(execFile)(process.execPath, [client], { env, encoding: 'utf8' }).then(x => ({ code: 0, ...x }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const ok = (r.code === 0) === expectPass;
  console.log(`\n${ok ? 'OK  ' : 'FAIL'} ${name}: exit ${r.code} (expected ${expectPass ? 'pass' : 'block'})`);
  console.log(r.stdout.trim().split('\n').map(l => `     ${l}`).join('\n'));
  let s = ''; try { s = readFileSync(summary, 'utf8'); } catch {}
  if (s.includes('letmein-demo-only') || r.stdout.includes('letmein-demo-only')) { console.log('FAIL source text leaked into output'); return false; }
  return ok;
}

let allOk = true;
try {
  console.log(`Local job API ${url}; scanner isolation: ${isolation}${isolation === 'in-process' ? ' (no container limits; build the scanner image to test isolation)' : ''}`);
  allOk &= await gate('PR #1 vulnerable commit', 1, vulnerable, false);
  allOk &= await gate('PR #1 corrected commit', 1, corrected, true);
  allOk &= await gate('PR #2 docs-only change', 2, docsOnly, true);
  allOk &= await gate('PR #1 wrong token', 1, corrected, false, { SCANNER_TOKEN: 'f'.repeat(64) });
  console.log(`\n${allOk ? 'END-TO-END PASS' : 'END-TO-END FAILURE'}: vulnerable blocked, corrected passed, docs-only passed, bad token refused.`);
} finally {
  await worker.stop(); await new Promise(r => server.close(r)); store.close(); rmSync(work, { recursive: true, force: true });
}
process.exitCode = allOk ? 0 : 1;
