import { SSMClient } from '@aws-sdk/client-ssm';
import { createApp } from '../gate/app.mjs';
import { localSecrets } from '../gate/secrets.mjs';
import { loadCloud } from './config.mjs';
import { createParameterVerifier } from './verifier.mjs';

const deployed = process.env.CLOUD_DEPLOYED === '1';
const cloud = await loadCloud();
let ssm; let auth;
if (deployed) {
  ssm = new SSMClient({ region: cloud.config.region, maxAttempts: 2, requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 } });
  const verifier = createParameterVerifier({ client: ssm, name: process.env.CLOUD_TOKEN_PARAMETER });
  await verifier.ready();
  auth = { verifyToken: token => verifier.verify(token), checkReady: () => verifier.ready() };
} else {
  const { token, signingKey } = localSecrets();
  auth = { token, signingKey };
}
const port = Number(process.env.CLOUD_API_PORT ?? 3200);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CLOUD_API_PORT.');
const app = createApp({ store: cloud.store, ...auth, allowedRepository: process.env.SCANNER_REPOSITORY ?? 'ApriCuz54/CS6620-Fall2026-Team5-Project' });
let stopping = false; let busy = false; let active = Promise.resolve();
const timer = setInterval(() => {
  if (busy || stopping) return; busy = true;
  active = cloud.store.flushOutbox().catch(() => console.error('Pending dispatch retry failed; accepted jobs remain recorded.')).finally(() => { busy = false; });
}, 5000);
const server = app.listen(port, deployed ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(deployed ? 'Deployed dummy API ready; verifier loaded from SSM.' : `Local API using AWS storage: http://127.0.0.1:${port}`);
  console.log('Dummy results only; merge approval is prohibited.');
});
async function shutdown(code = 0) {
  if (stopping) return; stopping = true; clearInterval(timer);
  server.close(async () => { await active; cloud.close(); ssm?.destroy(); process.exitCode = code; });
}
server.on('error', () => { console.error('Could not start the AWS-backed API.'); shutdown(1); });
process.on('SIGINT', () => shutdown()); process.on('SIGTERM', () => shutdown());
