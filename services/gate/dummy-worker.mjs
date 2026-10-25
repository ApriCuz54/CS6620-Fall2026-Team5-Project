export function buildDummyReport(job, files) {
  const high = job.simulation === 'high';
  return { schemaVersion: '1', mode: 'dummy', gate: 'NOT_EVALUATED', mergeAllowed: false, jobId: job.id, repository: job.repository, pullRequest: job.pullRequest, commitSha: job.commitSha, summary: { high: high ? 1 : 0, medium: 0, low: 0 }, findings: high ? [{ ruleId: 'DUMMY_HIGH', severity: 'HIGH', path: files[0].path, line: 1, message: 'Simulated finding. This is not a security scan.' }] : [] };
}

export function createDummyWorker({ store, now = Date.now, delayMs = 500 }) {
  let timer;
  return {
    step() {
      const job = store.next();
      if (!job) return;
      if (job.status === 'QUEUED') {
        store.update(job.id, j => { j.status = 'RUNNING'; j.startedAtMs = now(); });
        return;
      }
      if (now() - job.startedAtMs < delayMs) return;
      store.update(job.id, j => {
        if (j.simulation === 'error') {
          j.status = 'FAILED'; j.error = { code: 'SIMULATED_FAILURE', message: 'Development worker simulated a failure.' };
        } else {
          j.status = 'COMPLETED';
          j.report = buildDummyReport(j, j.files);
        }
        // Never include submitted source or regex evidence in the dummy report.
        delete j.files; delete j.startedAtMs;
      });
    },
    start(onError = () => {}) { if (timer) throw new Error('Worker already started.'); timer = setInterval(() => { try { this.step(); } catch (e) { this.stop(); onError(e); } }, 100); },
    stop() { clearInterval(timer); timer = undefined; }
  };
}
