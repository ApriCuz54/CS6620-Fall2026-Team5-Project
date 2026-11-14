// Local single-process worker: scans queued jobs with the real supplied scanner.
// Source text is deleted from the local store as soon as the job is terminal.
import { buildOutcome } from '../scanner/report.mjs';

export function createLocalWorker({ store, scanner, now = Date.now, intervalMs = 100 }) {
  let timer; let active = null;
  async function handle(job) {
    store.update(job.id, j => { j.status = 'RUNNING'; });
    let outcome;
    try { outcome = buildOutcome(job, job.files, await scanner.scan(job.files), { isolation: scanner.isolation, now }); }
    catch { outcome = buildOutcome(job, job.files, null); }
    store.update(job.id, j => { Object.assign(j, outcome); delete j.files; });
    return outcome.status;
  }
  return {
    // Processes at most one queued job; resolves to its terminal status or undefined.
    async step() {
      if (active) return active;
      const job = store.next();
      if (!job) return undefined;
      active = handle(job).finally(() => { active = null; });
      return active;
    },
    start(onError = () => {}) {
      if (timer) throw new Error('Worker already started.');
      timer = setInterval(() => { if (!active) this.step().catch(e => { this.stop(); onError(e); }); }, intervalMs);
    },
    async stop() { clearInterval(timer); timer = undefined; await active?.catch(() => {}); }
  };
}
