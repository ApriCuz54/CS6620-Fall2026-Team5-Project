// Scan launcher: runs one scan job in a fresh, locked-down container.
// The launcher (trusted, on the host) owns the clock: it enforces the
// wall-clock deadline from OUTSIDE the container, kills the container on
// timeout or cancellation, and always removes it afterwards.
// Any failure becomes a non-passing ERROR result; it never becomes COMPLETE.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const DEFAULTS = {
  image: process.env.SCANNER_IMAGE || 'cs6620-scanner:dev',
  timeoutMs: Number(process.env.SCAN_TIMEOUT_MS) || 30_000, // wall-clock deadline
  cpus: '0.5',
  memory: '256m',
  pidsLimit: 64,
  tmpfsSize: '16m',
  maxOutputBytes: 1024 * 1024, // 1 MiB result JSON
  docker: 'docker',
};

const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'];
const FINDING_KEYS = ['line', 'message', 'path', 'ruleId', 'severity'];

// Build the exact `docker run` arguments. Exported so tests can check every limit.
export function buildDockerArgs(name, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const args = [
    'run', '-i',
    '--name', name,
    '--network', 'none',                              // no network, no EC2 metadata
    '--cpus', o.cpus,
    '--memory', o.memory, '--memory-swap', o.memory,  // no extra swap
    '--pids-limit', String(o.pidsLimit),
    '--read-only',                                    // read-only root filesystem
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=${o.tmpfsSize}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '1000:1000',                            // non-root
    '--log-driver', 'none',                           // keep no host-side copy of output
  ];
  // Test-only hook: replace the program inside the container to simulate failures.
  if (o.entrypoint) args.push('--entrypoint', o.entrypoint);
  args.push(o.image, ...(o.command || []));
  return args;
}

// Fixed-text error result; never includes submitted source or raw output.
function errorResult(code, message) {
  return { schemaVersion: '1', status: 'ERROR', error: { code, message } };
}

// Check a COMPLETE result before trusting it: all files scanned, counts match, fields allowed.
export function validateComplete(result, expectedFiles) {
  if (result.filesRequested !== expectedFiles || result.filesScanned !== expectedFiles) return false;
  if (!Array.isArray(result.findings) || !result.summary) return false;
  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of result.findings) {
    if (!f || JSON.stringify(Object.keys(f).sort()) !== JSON.stringify(FINDING_KEYS)) return false;
    if (!SEVERITIES.includes(f.severity) || !Number.isInteger(f.line) || f.line < 1) return false;
    counts[f.severity] += 1;
  }
  return SEVERITIES.every((s) => result.summary[s] === counts[s]);
}

// Run a docker CLI command synchronously and quietly (used for kill/inspect/remove).
function dockerSync(o, args) {
  return spawnSync(o.docker, args, { encoding: 'utf8', timeout: 15_000 });
}

// Run one job. Returns a result object; never throws for scan failures.
// opts.signal (AbortSignal) cancels the scan, e.g. when the worker loses its lease.
export async function runScanInContainer(job, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const name = `sast-scan-${randomBytes(8).toString('hex')}`; // unique per job
  const expectedFiles = Array.isArray(job?.files) ? job.files.length : -1;

  let reason = null; // why we stopped the container ourselves: TIMEOUT / CANCELLED / OUTPUT_TOO_LARGE
  const chunks = [];
  let outBytes = 0;

  try {
    const exitCode = await new Promise((resolve) => {
      const child = spawn(o.docker, buildDockerArgs(name, o), { stdio: ['pipe', 'pipe', 'ignore'] });

      // Stop the container from outside. The child process exits once the container dies.
      const stop = (why) => {
        if (reason) return;
        reason = why;
        dockerSync(o, ['kill', name]);
      };

      const timer = setTimeout(() => stop('TIMEOUT'), o.timeoutMs);
      const onAbort = () => stop('CANCELLED');
      if (o.signal?.aborted) onAbort();
      o.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (buf) => {
        outBytes += buf.length;
        if (outBytes > o.maxOutputBytes) return stop('OUTPUT_TOO_LARGE'); // bounded output
        chunks.push(buf);
      });

      child.on('error', () => resolve(-1)); // docker CLI missing, etc.
      child.on('close', (code) => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        resolve(code);
      });

      child.stdin.on('error', () => {}); // container may exit before reading all input
      child.stdin.end(JSON.stringify(job));
    });

    if (reason === 'TIMEOUT') return errorResult('TIMEOUT', 'Scan exceeded the time limit.');
    if (reason === 'CANCELLED') return errorResult('CANCELLED', 'Scan was cancelled.');
    if (reason === 'OUTPUT_TOO_LARGE') return errorResult('OUTPUT_TOO_LARGE', 'Scan output exceeded the limit.');
    if (exitCode === -1) return errorResult('LAUNCH_FAILED', 'Could not start the scan container.');

    // Was it killed for using too much memory?
    const oom = dockerSync(o, ['inspect', '--format', '{{.State.OOMKilled}}', name]).stdout?.trim();
    if (oom === 'true') return errorResult('OUT_OF_MEMORY', 'Scan exceeded the memory limit.');

    let result;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return exitCode === 0
        ? errorResult('BAD_RUNNER_OUTPUT', 'Scan produced invalid output.')
        : errorResult('CRASHED', 'Scan process crashed.');
    }

    if (result?.status === 'COMPLETE') {
      // A pass must come from a clean exit AND a fully valid, complete report.
      if (exitCode !== 0 || !validateComplete(result, expectedFiles)) {
        return errorResult('BAD_RUNNER_OUTPUT', 'Scan result failed validation.');
      }
      return result;
    }
    if (result?.status === 'ERROR' && typeof result.error?.code === 'string') {
      return errorResult(result.error.code, 'Runner rejected the job.'); // keep code, fixed message
    }
    return errorResult(exitCode === 0 ? 'BAD_RUNNER_OUTPUT' : 'CRASHED', 'Scan produced invalid output.');
  } finally {
    // Clean up in every outcome: success, error, timeout, cancellation.
    dockerSync(o, ['rm', '-f', name]);
  }
}
