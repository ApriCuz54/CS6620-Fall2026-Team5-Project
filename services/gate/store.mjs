import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, LIMITS } from './contract.mjs';

// A single-process local adapter, not a replacement for DynamoDB/SQS.
export function createLocalStore(directory, { now = Date.now, maxJobs = LIMITS.jobs } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'writer.lock');
  const file = join(directory, 'jobs.json');
  const fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  let closed = false;
  let state;
  function write(next) {
    if (closed) throw new Error('Store is closed.');
    const temp = join(directory, `.jobs-${randomUUID()}.tmp`);
    try { writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(temp, file); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
    state = next;
  }
  function mutate(fn) { const next = structuredClone(state); const result = fn(next); write(next); return structuredClone(result); }
  try {
    state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, jobs: [] };
    if (state.version !== 1 || !Array.isArray(state.jobs) || !state.jobs.every(j => j && typeof j.id === 'string' && ['QUEUED','RUNNING','COMPLETED','FAILED'].includes(j.status))) throw new Error('Invalid local store; preserve it and investigate instead of resetting it.');
    // Only our process holds the writer lock. A previous interrupted run must retry its local dummy job.
    if (state.jobs.some(j => j.status === 'RUNNING')) mutate(next => { for (const j of next.jobs) if (j.status === 'RUNNING') { j.status = 'QUEUED'; delete j.startedAtMs; j.updatedAt = new Date(now()).toISOString(); } });
  } catch (error) { unlinkSync(lock); throw error; }
  return {
    submit({ canonical, identity, digest }) {
      const existing = state.jobs.find(j => j.identity === identity && now() - j.createdAtMs < LIMITS.retentionMs);
      if (existing) {
        if (existing.digest !== digest) throw new ApiError(409, 'COMMIT_PAYLOAD_CONFLICT', 'This repository/PR/commit already has a different submission.');
        return { job: structuredClone(existing), reused: true };
      }
      return mutate(next => {
        next.jobs = next.jobs.filter(j => now() - j.createdAtMs < LIMITS.retentionMs);
        if (next.jobs.length >= maxJobs) throw new ApiError(503, 'QUEUE_CAPACITY', 'Local job capacity reached. Retry later.');
        const date = new Date(now()).toISOString();
        const job = { id: randomUUID(), identity, digest, repository: canonical.repository, pullRequest: canonical.pullRequest, commitSha: canonical.commitSha, simulation: canonical.simulation, files: canonical.files, status: 'QUEUED', createdAt: date, updatedAt: date, createdAtMs: now() };
        next.jobs.push(job); return { job, reused: false };
      });
    },
    get(id) { const job = state.jobs.find(j => j.id === id && now() - j.createdAtMs < LIMITS.retentionMs); return job ? structuredClone(job) : undefined; },
    next() { const running = state.jobs.find(j => j.status === 'RUNNING'); return structuredClone(running ?? state.jobs.find(j => j.status === 'QUEUED')); },
    update(id, fn) { return mutate(next => { const job = next.jobs.find(j => j.id === id); if (!job) throw new Error('Job disappeared.'); fn(job); job.updatedAt = new Date(now()).toISOString(); return job; }); },
    close() { if (!closed) { closed = true; unlinkSync(lock); } }
  };
}
