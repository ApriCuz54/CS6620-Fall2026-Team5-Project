// Tests for the report link refresh (scripts/report-link.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshReportLink, summary } from '../scripts/report-link.mjs';

const repository = 'ApriCuz54/CS6620-Fall2026-Team5-Project';
const url = 'https://scanner.example';
const jobId = '2de7e366-ec07-476a-af38-2a0ef2e685da';
const sha = 'c'.repeat(40);
const job = {
  schemaVersion: '2', jobId, repository: repository.toLowerCase(), pullRequest: 7, commitSha: sha,
  status: 'COMPLETED', verdict: 'FAIL', mergeAllowed: false, scanner: { policyVersion: 'high-blocks-v1' },
  filesScanned: 1, summary: { high: 1, medium: 0, low: 0 },
  report: { url: 'https://bucket.s3.amazonaws.com/reports/x?X-Amz-Signature=abc', expiresAt: '2026-11-18T23:00:60Z' },
};
const report = { jobId, commitSha: sha, verdict: 'FAIL', findings: [{ ruleId: 'HARDCODED_SECRET', severity: 'HIGH', path: 'demo/login.js', line: 1, message: 'Hardcoded Secret' }] };

// Fake scanner: answers the status call and the report fetch, and records every request.
function fakeFetch({ status = 200, body = job, reportStatus = 200, reportBody = report } = {}) {
  const calls = [];
  const fetchImpl = async (target, init = {}) => {
    calls.push({ url: String(target), auth: init.headers?.Authorization });
    const isReport = String(target).startsWith('https://bucket.s3.amazonaws.com/');
    const [code, payload] = isReport ? [reportStatus, reportBody] : [status, body];
    return { status: code, headers: new Headers(), json: async () => payload };
  };
  return { fetchImpl, calls };
}
const base = { url, token: 'service-token', repository, jobId, sleep: async () => {}, log: () => {} };

test('returns a fresh, verified link for a completed job in this repository', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await refreshReportLink({ ...base, fetchImpl });
  assert.equal(result.reportUrl, job.report.url);
  assert.equal(result.expiresAt, job.report.expiresAt);
  assert.equal(calls[0].url, `${url}/v1/jobs/${jobId}`);
  assert.equal(calls[0].auth, 'Bearer service-token');
  // The report itself is read without the service token, like any reader would.
  assert.equal(calls[1].url, job.report.url);
  assert.equal(calls[1].auth, undefined);
});

test('never logs the report link', async () => {
  const lines = [];
  await refreshReportLink({ ...base, fetchImpl: fakeFetch().fetchImpl, log: line => lines.push(line) });
  assert.ok(lines.length > 0);
  for (const line of lines) assert.ok(!line.includes('X-Amz-Signature') && !line.includes('s3.amazonaws.com'), line);
});

test('accepts cloud job IDs (64-character hex) as well as local UUIDs', async () => {
  const cloudId = '7604df9e8ddd7202a8a06798ee42f98133e47144d2badcf0aaa2567651974a37';
  const { fetchImpl, calls } = fakeFetch({ body: { ...job, jobId: cloudId }, reportBody: { ...report, jobId: cloudId } });
  await refreshReportLink({ ...base, jobId: cloudId, fetchImpl });
  assert.equal(calls[0].url, `${url}/v1/jobs/${cloudId}`);
});

test('rejects anything that is not a job ID before making a request', async () => {
  for (const bad of ['', 'abc', '../../v1/jobs', `${jobId}/../x`, 'https://evil.example/x', 'a'.repeat(63), 'g'.repeat(64), undefined]) {
    const { fetchImpl, calls } = fakeFetch();
    await assert.rejects(refreshReportLink({ ...base, jobId: bad, fetchImpl }), { code: 'BAD_JOB_ID' });
    assert.equal(calls.length, 0, String(bad));
  }
});

test('refuses jobs from another repository', async () => {
  const { fetchImpl, calls } = fakeFetch({ body: { ...job, repository: 'someone/else' } });
  await assert.rejects(refreshReportLink({ ...base, fetchImpl }), { code: 'WRONG_REPOSITORY' });
  assert.equal(calls.length, 1, 'must not fetch the other repository\'s report');
});

test('explains jobs that have no report yet or failed', async () => {
  await assert.rejects(refreshReportLink({ ...base, fetchImpl: fakeFetch({ body: { ...job, status: 'RUNNING', verdict: 'PENDING', report: undefined } }).fetchImpl }), { code: 'NOT_READY' });
  await assert.rejects(refreshReportLink({ ...base, fetchImpl: fakeFetch({ body: { ...job, status: 'FAILED', verdict: 'ERROR', report: undefined, error: { code: 'TIMEOUT' } } }).fetchImpl }), { code: 'NO_REPORT' });
});

test('explains a wrong token and an unknown or expired job', async () => {
  await assert.rejects(refreshReportLink({ ...base, fetchImpl: fakeFetch({ status: 401, body: { error: { code: 'UNAUTHORIZED' } } }).fetchImpl }), { code: 'UNAUTHORIZED' });
  await assert.rejects(refreshReportLink({ ...base, fetchImpl: fakeFetch({ status: 404, body: { error: { code: 'NOT_FOUND' } } }).fetchImpl }), { code: 'NOT_FOUND' });
});

test('refuses a link that does not work or a report for a different job', async () => {
  await assert.rejects(refreshReportLink({ ...base, fetchImpl: fakeFetch({ reportStatus: 403 }).fetchImpl }), { code: 'UNEXPECTED' });
  await assert.rejects(refreshReportLink({ ...base, fetchImpl: fakeFetch({ reportBody: { ...report, jobId: 'other' } }).fetchImpl }), { code: 'UNEXPECTED' });
});

test('summary shows the link, its expiry and the findings', () => {
  const text = summary({ job, report, reportUrl: job.report.url, expiresAt: job.report.expiresAt });
  assert.match(text, /\[Open the report\]\(https:\/\/bucket\.s3\.amazonaws\.com\//);
  assert.match(text, /stops working at 2026-11-18T23:00:60Z/);
  assert.match(text, /\| HIGH \| HARDCODED_SECRET \| demo\/login\.js \| 1 \|/);
});
