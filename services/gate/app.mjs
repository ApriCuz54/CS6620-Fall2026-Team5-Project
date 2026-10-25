import express from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, LIMITS, validateSubmission } from './contract.mjs';

function hash(value) { return createHash('sha256').update(value).digest(); }
export function createApp({ store, token, signingKey, allowedRepository, now = Date.now, reportTtlSeconds = 60, verifyToken, checkReady }) {
  if ((typeof verifyToken !== 'function' && (typeof token !== 'string' || token.length < 32)) || (!store.issueReportLink && (!Buffer.isBuffer(signingKey) || signingKey.length < 32)) || !allowedRepository) throw new Error('Authentication, report and repository configuration are required.');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); next(); });
  const fail = (status, code, message) => new ApiError(status, code, message);
  function requireToken(req, res, next) {
    Promise.resolve().then(async () => {
      const header = req.get('Authorization') ?? '';
      if (!header.startsWith('Bearer ')) throw fail(401, 'UNAUTHORIZED', 'A valid service bearer token is required.');
      const candidate = header.slice(7);
      const valid = verifyToken ? await verifyToken(candidate) : timingSafeEqual(hash(candidate), hash(token));
      if (!valid) throw fail(401, 'UNAUTHORIZED', 'A valid service bearer token is required.');
      next();
    }).catch(next);
  }
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  async function find(id) { const job = await store.get(id); if (!job) throw fail(404, 'JOB_NOT_FOUND', 'Job was not found or has expired.'); return job; }
  const signature = (id, expires) => createHmac('sha256', signingKey).update(`${id}:${expires}`).digest('hex');
  async function view(job) {
    const result = { schemaVersion: '1', mode: 'dummy', gate: 'NOT_EVALUATED', mergeAllowed: false, jobId: job.id, repository: job.repository, pullRequest: job.pullRequest, commitSha: job.commitSha, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, statusUrl: `/v1/jobs/${job.id}` };
    if (job.error) result.error = job.error;
    if (job.status === 'COMPLETED') {
      const expires = Math.floor(now() / 1000) + reportTtlSeconds;
      result.summary = job.report?.summary ?? job.summary;
      result.report = store.issueReportLink ? await store.issueReportLink(job) : { url: `/v1/jobs/${job.id}/report?expires=${expires}&signature=${signature(job.id, expires)}`, expiresAt: new Date(expires * 1000).toISOString() };
    }
    return result;
  }
  app.get('/', (req, res) => res.json({ service: 'CS6620 development job API', backend: store.backend ?? 'local', mode: 'dummy', message: 'Development only. No result can approve a merge.', health: '/health' }));
  app.get('/health', route(async (req, res) => { if (checkReady) await checkReady(); res.json({ status: 'healthy', backend: store.backend ?? 'local', mode: 'dummy', mergeAllowed: false }); }));
  app.post('/v1/jobs', requireToken, (req, res, next) => {
    if (!req.is('application/json')) return next(fail(415, 'CONTENT_TYPE', 'Use application/json.'));
    next();
  }, express.json({ limit: LIMITS.bodyBytes, strict: true }), route(async (req, res) => {
    const result = await store.submit(validateSubmission(req.body, allowedRepository));
    res.status(result.reused ? 200 : 202).location(`/v1/jobs/${result.job.id}`).json({ ...await view(result.job), reused: result.reused });
  }));
  app.get('/v1/jobs/:id', requireToken, route(async (req, res) => res.json(await view(await find(req.params.id)))));
  app.get('/v1/jobs/:id/report', route(async (req, res) => {
    if (store.issueReportLink) throw fail(404, 'NOT_FOUND', 'Use the private report URL returned by the status endpoint.');
    const { expires, signature: supplied } = req.query;
    if (typeof expires !== 'string' || !/^\d{1,12}$/.test(expires) || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(req.params.id, expires), 'hex'))) throw fail(403, 'INVALID_REPORT_LINK', 'Report link is invalid.');
    if (+expires <= Math.floor(now() / 1000)) throw fail(403, 'EXPIRED_REPORT_LINK', 'Report link expired. Request a fresh link through the authenticated status endpoint.');
    const job = await find(req.params.id);
    if (job.status !== 'COMPLETED') throw fail(409, 'REPORT_NOT_READY', 'A completed report is not available.');
    res.json(job.report);
  }));
  app.use((req, res, next) => next(fail(404, 'NOT_FOUND', 'Endpoint not found.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof ApiError ? error.status : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    const code = error instanceof ApiError ? error.code : status === 413 ? 'BODY_TOO_LARGE' : status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR';
    if (status === 503) res.set('Retry-After', '2');
    res.status(status).json({ schemaVersion: '1', mode: 'dummy', gate: 'NOT_EVALUATED', mergeAllowed: false, error: { code, message: error instanceof ApiError ? error.message : status === 500 ? 'Local service could not complete the request.' : 'Invalid or oversized JSON request.' } });
  });
  return app;
}
