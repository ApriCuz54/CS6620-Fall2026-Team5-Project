import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
const connection = JSON.parse(await readFile(new URL('../.local/cloud-connection.json', import.meta.url), 'utf8'));
const options = { region: connection.region, maxAttempts: 2 };
const sts = new STSClient(options); const ssm = new SSMClient(options);
const path = '/cs6620/team5/api-token-verifiers';
const file = new URL('../.local/deployment-service-token', import.meta.url);
const hash = token => createHash('sha256').update(token).digest('hex');
try {
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (identity.Account !== connection.accountId) throw new Error('AWS account mismatch.');
  let remote; let token;
  try { remote = JSON.parse((await ssm.send(new GetParameterCommand({ Name: path, WithDecryption: true }))).Parameter.Value); }
  catch (error) { if (error.name !== 'ParameterNotFound') throw error; }
  try { token = (await readFile(file, 'utf8')).trim(); if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local deployment token.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (remote && !process.argv.includes('--rotate') && !process.argv.includes('--retire-previous')) {
    if (!token || !remote.hashes?.includes(hash(token))) throw new Error('Existing remote verifier has no matching local token. Restore the private token or explicitly rotate it.');
    console.log('Existing deployment token matches the encrypted verifier. No change.');
  } else {
    if (process.argv.includes('--rotate')) {
      if (token) await writeFile(new URL('../.local/deployment-service-token.previous', import.meta.url), token, { mode: 0o600 });
      token = undefined;
    }
    if (!token) {
      if (process.argv.includes('--retire-previous')) throw new Error('Cannot retire overlap without the current local token.');
      token = randomBytes(32).toString('hex');
      await mkdir(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 });
      await writeFile(file, token, { mode: 0o600 }); await chmod(file, 0o600);
    }
    const hashes = [hash(token)];
    if (!process.argv.includes('--retire-previous')) for (const old of remote?.hashes ?? []) if (!hashes.includes(old) && hashes.length < 2) hashes.push(old);
    await ssm.send(new PutParameterCommand({ Name: path, Type: 'SecureString', Tier: 'Standard', Value: JSON.stringify({ schemaVersion: '1', hashes }), Overwrite: Boolean(remote), Description: 'CS6620 API bearer-token SHA256 verifiers; no raw token.' }));
    console.log('Encrypted verifier provisioned. Raw token stays only in ignored .local/deployment-service-token.');
    console.log('API verifier cache refreshes within 60 seconds. Do not retire overlap until clients use the new token.');
  }
} finally { sts.destroy(); ssm.destroy(); }
