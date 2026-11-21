// Turns a launcher/runner result into the stored job outcome and the private report.
// This is the only place a verdict is computed. Anything unexpected becomes FAILED.
import { validateComplete } from './launcher.mjs';
import { SCHEMA_VERSION, SCANNER_ENGINE, SCANNER_VERSION, POLICY_VERSION } from '../gate/contract.mjs';

const ERROR_MESSAGES = {
  TIMEOUT: 'Scan exceeded the time limit.',
  OUT_OF_MEMORY: 'Scan exceeded the memory limit.',
  CANCELLED: 'Scan was cancelled before completion.',
  CRASHED: 'Scan process crashed.',
  LAUNCH_FAILED: 'Scan container could not be started.',
  OUTPUT_TOO_LARGE: 'Scan output exceeded the limit.',
  BAD_RUNNER_OUTPUT: 'Scan produced an invalid result.',
  INPUT_TOO_LARGE: 'Scan input exceeded a limit.',
  INVALID_INPUT: 'Scan input was rejected.',
  INCOMPLETE_SCAN: 'Not every submitted file was scanned.'
};

export function failure(code) {
  const safe = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'SCAN_FAILED';
  return { status: 'FAILED', verdict: 'ERROR', error: { code: safe, message: ERROR_MESSAGES[safe] ?? 'Scan did not complete.' } };
}

export function scannerInfo(isolation) {
  return { engine: SCANNER_ENGINE, version: SCANNER_VERSION, policyVersion: POLICY_VERSION, isolation };
}

// job: {id, repository, pullRequest, commitSha}; files: the validated submitted files.
export function buildOutcome(job, files, scanResult, { isolation, now = Date.now } = {}) {
  if (scanResult?.status !== 'COMPLETE') return failure(scanResult?.error?.code);
  if (!validateComplete(scanResult, files.length)) return failure('BAD_RUNNER_OUTPUT');
  const submitted = new Set(files.map(f => f.path));
  if (!scanResult.findings.every(f => submitted.has(f.path))) return failure('BAD_RUNNER_OUTPUT');
  const summary = { high: scanResult.summary.HIGH, medium: scanResult.summary.MEDIUM, low: scanResult.summary.LOW };
  const verdict = summary.high > 0 ? 'FAIL' : 'PASS';
  const scanner = scannerInfo(isolation);
  const findings = scanResult.findings.map(({ ruleId, severity, path, line, message }) => ({ ruleId, severity, path, line, message }));
  const report = {
    schemaVersion: SCHEMA_VERSION, jobId: job.id, repository: job.repository, pullRequest: job.pullRequest, commitSha: job.commitSha,
    scanner, verdict, mergeAllowed: verdict === 'PASS', filesScanned: scanResult.filesScanned, summary, findings,
    completedAt: new Date(now()).toISOString()
  };
  return { status: 'COMPLETED', verdict, summary, filesScanned: scanResult.filesScanned, scanner, report };
}
