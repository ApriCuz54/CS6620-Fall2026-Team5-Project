import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Non-secret local configuration only; never reads or prints credential values.
const root = fileURLToPath(new URL('../', import.meta.url));
const index = process.argv.indexOf('--account');
const expected = index >= 0 ? process.argv[index + 1] : undefined;
if (!/^\d{12}$/.test(expected ?? '')) throw new Error('Pass --account followed by the expected Learner Lab account ID.');
const region = 'us-east-1';
function aws(args, allowError = false) {
  const r = spawnSync('aws', [...args, '--region', region, '--no-cli-pager'], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0 && !allowError) throw new Error(`AWS ${args.slice(0, 2).join(' ')} failed. ${r.stderr || r.error?.message || ''}`);
  return r;
}
const actual = aws(['sts','get-caller-identity','--query','Account','--output','text']).stdout.trim();
if (actual !== expected) throw new Error('AWS account mismatch. No resources changed.');
for (const purpose of ['inputs','reports']) {
  const bucket = `cs6620-team5-${purpose}-${expected}`;
  const head = aws(['s3api','head-bucket','--bucket',bucket,'--expected-bucket-owner',expected], true);
  if (head.status !== 0) {
    if (!head.stderr.includes('(404)') && !head.stderr.includes('Not Found')) throw new Error(`Cannot verify ownership/access for ${bucket}. Stop and inspect the AWS error.`);
    if (!process.argv.includes('--create-buckets')) throw new Error(`Missing ${bucket}. Review the scope, then rerun with --create-buckets.`);
    aws(['s3api','create-bucket','--bucket',bucket]);
    console.log(`Created private project ${purpose} bucket.`);
  }
  const location = JSON.parse(aws(['s3api','get-bucket-location','--bucket',bucket,'--expected-bucket-owner',expected,'--output','json']).stdout);
  if (location.LocationConstraint !== null) throw new Error('Bucket is outside us-east-1; stop.');
}
const dir = join(root, 'infra/storage'); mkdirSync(dir, { recursive: true });
function save(name, content) {
  const file = join(dir, name);
  if (existsSync(file) && readFileSync(file,'utf8') !== content) throw new Error(`${name} already exists with different contents. Inspect it before changing accounts/configuration.`);
  writeFileSync(file, content, { mode: 0o600 });
}
save('terraform.tfvars', `aws_account_id = "${expected}"\naws_region = "${region}"\n`);
save('backend.hcl', `bucket = "cs6620-team-state-${expected}-us-east-1"\nkey = "storage/terraform.tfstate"\nregion = "${region}"\nencrypt = true\nuse_lockfile = true\n`);
console.log('Prepared ignored storage config using an independent storage/terraform.tfstate key.');
