import { localSecrets } from './secrets.mjs';
import { resolve } from 'node:path';
import { createApp } from './app.mjs';
import { createLocalStore } from './store.mjs';
import { createDummyWorker } from './dummy-worker.mjs';

const { token, signingKey, local } = localSecrets();
const port = Number(process.env.SCANNER_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SCANNER_PORT.');
const store = createLocalStore(resolve(local, 'gate'));
const app = createApp({ store, token, signingKey, allowedRepository: process.env.SCANNER_REPOSITORY ?? 'ApriCuz54/CS6620-Fall2026-Team5-Project' });
const worker = createDummyWorker({ store });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Local dummy job API: http://127.0.0.1:${port}`);
  console.log('Development only: all results have mergeAllowed=false. Token is stored in ignored .local/dev-api-token.');
  worker.start(() => { console.error('Dummy worker stopped after an internal error.'); shutdown(1); });
});
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return; stopping = true; worker.stop();
  server.close(() => { store.close(); process.exitCode = code; });
}
server.on('error', error => { console.error(`Could not start local API (${error.code ?? 'unknown'}).`); worker.stop(); store.close(); process.exitCode = 1; });
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
