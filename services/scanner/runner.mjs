// One-shot SAST runner.
// Reads one JSON job from stdin, scans every file with the supplied engine,
// and writes one sanitized JSON result to stdout.
// Submitted code is treated as plain text: it is never imported, evaluated or run.

import { scanCode } from '../../sast/backend/scanner.js';

// ---- Limits (from the handoff) ----
export const LIMITS = {
  maxInputBytes: 256 * 1024,      // whole stdin payload
  maxFiles: 25,
  maxFileBytes: 64 * 1024,        // per file
  maxTotalBytes: 128 * 1024,      // all files combined
  maxFindings: 1000,
  maxOutputBytes: 1024 * 1024,    // result JSON
};

const SCHEMA_VERSION = '1';
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'];
const ALLOWED_EXT = /\.(js|mjs|cjs)$/i;

// A runner error: message is fixed text, never copied from submitted source.
class RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Reject absolute paths, "..", backslashes and unsupported extensions.
function validatePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 256) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  if (p.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  return ALLOWED_EXT.test(p);
}

// Check the job shape and size limits before scanning anything.
export function validateJob(job) {
  if (!job || typeof job !== 'object' || !Array.isArray(job.files)) {
    throw new RunnerError('INVALID_INPUT', 'Job must be an object with a files array.');
  }
  if (job.files.length > LIMITS.maxFiles) {
    throw new RunnerError('INPUT_TOO_LARGE', `Too many files (max ${LIMITS.maxFiles}).`);
  }
  const seen = new Set();
  let total = 0;
  for (const f of job.files) {
    if (!f || !validatePath(f.path) || typeof f.content !== 'string') {
      throw new RunnerError('INVALID_INPUT', 'Each file needs a safe .js/.mjs/.cjs path and string content.');
    }
    if (seen.has(f.path)) throw new RunnerError('INVALID_INPUT', 'Duplicate file path.');
    seen.add(f.path);
    const size = Buffer.byteLength(f.content, 'utf8');
    if (size > LIMITS.maxFileBytes) throw new RunnerError('INPUT_TOO_LARGE', 'A file exceeds the per-file limit.');
    total += size;
  }
  if (total > LIMITS.maxTotalBytes) throw new RunnerError('INPUT_TOO_LARGE', 'Files exceed the combined size limit.');
}

// Keep only approved fields; drop evidence/snippets/columns.
function sanitizeFinding(raw, path) {
  if (!SEVERITIES.includes(raw.severity)) throw new RunnerError('BAD_SCANNER_OUTPUT', 'Unknown severity.');
  if (!Number.isInteger(raw.line) || raw.line < 1) throw new RunnerError('BAD_SCANNER_OUTPUT', 'Invalid line number.');
  if (typeof raw.id !== 'string' || !/^[A-Z_]{1,64}$/.test(raw.id)) {
    throw new RunnerError('BAD_SCANNER_OUTPUT', 'Invalid rule id.');
  }
  return {
    ruleId: raw.id,
    severity: raw.severity,
    path,                                  // validated submitted path, not scanner's echo
    line: raw.line,
    message: typeof raw.name === 'string' ? raw.name : raw.id, // fixed rule name text
  };
}

// Scan every file and build the sanitized result.
export function runJob(job) {
  validateJob(job);
  const findings = [];
  let filesScanned = 0;

  for (const f of job.files) {
    const raw = scanCode(f.content, f.path);
    if (!Array.isArray(raw)) throw new RunnerError('BAD_SCANNER_OUTPUT', 'Scanner did not return an array.');
    for (const r of raw) {
      findings.push(sanitizeFinding(r, f.path));
      if (findings.length > LIMITS.maxFindings) {
        // Fail explicitly instead of silently truncating a report.
        throw new RunnerError('OUTPUT_TOO_LARGE', 'Too many findings.');
      }
    }
    filesScanned += 1;
  }

  // Completeness check: every submitted file must have been scanned.
  if (filesScanned !== job.files.length) throw new RunnerError('INCOMPLETE_SCAN', 'Not all files were scanned.');

  const summary = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const x of findings) summary[x.severity] += 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'COMPLETE',
    filesRequested: job.files.length,
    filesScanned,
    summary,
    findings,
  };
}

// Read all of stdin, but stop if it grows past the input limit.
async function readStdinBounded() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > LIMITS.maxInputBytes) throw new RunnerError('INPUT_TOO_LARGE', 'Input exceeds limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Write exactly one JSON object; error results always use status ERROR (never passing).
function emit(obj) {
  let text = JSON.stringify(obj);
  if (Buffer.byteLength(text, 'utf8') > LIMITS.maxOutputBytes) {
    obj = { schemaVersion: SCHEMA_VERSION, status: 'ERROR', error: { code: 'OUTPUT_TOO_LARGE', message: 'Result too large.' } };
    text = JSON.stringify(obj);
  }
  process.stdout.write(text + '\n');
  return obj.status === 'COMPLETE' ? 0 : 1;
}

async function main() {
  try {
    const text = await readStdinBounded();
    let job;
    try {
      job = JSON.parse(text);
    } catch {
      throw new RunnerError('INVALID_INPUT', 'Input is not valid JSON.');
    }
    process.exitCode = emit(runJob(job));
  } catch (err) {
    const code = err instanceof RunnerError ? err.code : 'INTERNAL_ERROR';
    const message = err instanceof RunnerError ? err.message : 'Unexpected runner failure.';
    process.exitCode = emit({ schemaVersion: SCHEMA_VERSION, status: 'ERROR', error: { code, message } });
  }
}

// Run main() only when executed directly, so tests can import runJob().
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runner.mjs')) {
  main();
}
