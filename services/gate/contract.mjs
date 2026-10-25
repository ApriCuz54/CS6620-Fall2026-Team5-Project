import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ bodyBytes: 256 * 1024, files: 25, fileBytes: 64 * 1024, sourceBytes: 128 * 1024, jobs: 100, retentionMs: 24 * 60 * 60 * 1000 });
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function requireValue(ok, message) { if (!ok) throw new ApiError(400, 'INVALID_REQUEST', message); }
function exactKeys(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object.');
  requireValue(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), `Expected fields: ${keys.join(', ')}.`);
}
export function validateSubmission(body, allowedRepository) {
  exactKeys(body, ['schemaVersion', 'repository', 'pullRequest', 'commitSha', 'simulation', 'files']);
  requireValue(body.schemaVersion === '1', 'schemaVersion must be "1".');
  requireValue(typeof body.repository === 'string' && body.repository.toLowerCase() === allowedRepository.toLowerCase(), 'Repository is not configured for this service.');
  requireValue(Number.isSafeInteger(body.pullRequest) && body.pullRequest > 0, 'pullRequest must be a positive integer.');
  requireValue(typeof body.commitSha === 'string' && /^[a-f0-9]{40}$/i.test(body.commitSha), 'commitSha must contain 40 hexadecimal characters.');
  requireValue(['clean', 'high', 'error'].includes(body.simulation), 'simulation must be clean, high or error.');
  requireValue(Array.isArray(body.files) && body.files.length > 0 && body.files.length <= LIMITS.files, `Provide 1-${LIMITS.files} files.`);
  let total = 0;
  const paths = new Set();
  const files = body.files.map(file => {
    exactKeys(file, ['path', 'content']);
    requireValue(typeof file.path === 'string' && file.path.length <= 200 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:js|mjs|cjs)$/.test(file.path) && !file.path.split('/').some(x => x === '.' || x === '..'), 'Use a relative JavaScript path without traversal, spaces or backslashes.');
    requireValue(!paths.has(file.path), 'Duplicate file path.'); paths.add(file.path);
    requireValue(typeof file.content === 'string' && !file.content.includes('\0'), 'File content must be text without null bytes.');
    const bytes = Buffer.byteLength(file.content);
    requireValue(bytes <= LIMITS.fileBytes, 'Individual file exceeds 64 KiB.'); total += bytes;
    return { path: file.path, content: file.content };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  requireValue(total <= LIMITS.sourceBytes, 'Combined source exceeds 128 KiB.');
  const canonical = { schemaVersion: '1', repository: body.repository.toLowerCase(), pullRequest: body.pullRequest, commitSha: body.commitSha.toLowerCase(), simulation: body.simulation, files };
  return { canonical, identity: `${canonical.repository}:${canonical.pullRequest}:${canonical.commitSha}`, digest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}
