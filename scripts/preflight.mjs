import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
let failures = 0;
function check(label, command, args, optional = false) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
  const ok = r.status === 0;
  console.log(`${ok ? 'OK' : optional ? 'PENDING' : 'FIX'}: ${label}`);
  if (!ok && !optional) failures++;
  return ok;
}
console.log('Local checks (credentials and tokens are never printed)');
if (Number(process.versions.node.split('.')[0]) !== 24) { console.log('FIX: use Node.js 24.x'); failures++; }
else console.log('OK: Node.js 24.x');
check('Git', 'git', ['--version']);
check('npm', 'npm', ['--version']);
check('Docker engine running', 'docker', ['info', '--format', '{{.ServerVersion}}']);
check('Docker Compose', 'docker', ['compose', 'version']);
check('Terraform', 'terraform', ['version']);
check('AWS CLI', 'aws', ['--version']);
if (existsSync('.env')) console.log('OK: local .env exists');
else console.log('PENDING: copy .env.example to .env (defaults work without it)');
if (process.argv.includes('--aws')) {
  check('AWS session identity valid', 'aws', ['sts', 'get-caller-identity', '--no-cli-pager']);
  console.log('Identity check does not prove permission to create resources. Complete docs/FEASIBILITY.md.');
} else console.log('PENDING: run npm run check:aws after configuring the Learner Lab session');
process.exitCode = failures ? 1 : 0;
