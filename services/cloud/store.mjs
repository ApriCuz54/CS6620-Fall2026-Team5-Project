import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { ApiError } from '../gate/contract.mjs';

export const isConditionalFailure = error => error?.name === 'ConditionalCheckFailedException';
const unavailable = () => new ApiError(503, 'CLOUD_TEMPORARILY_UNAVAILABLE', 'Cloud storage is temporarily unavailable. Retry the identical request within your deadline.');
export async function readJsonBody(response, maxBytes = 256 * 1024) {
  if (!response.Body || response.ContentLength > maxBytes) throw new Error('Missing or oversized object.');
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of response.Body) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > maxBytes) throw new Error('Oversized object.'); chunks.push(buffer); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { response.Body.destroy?.(); }
}

export function createCloudStore({ config, db, s3, sqs, signReport, now = Date.now }) {
  const table = config.tableName;
  const key = id => ({ pk: `JOB#${id}` });
  const owner = { ExpectedBucketOwner: config.accountId };
  async function raw(id) {
    const r = await db.send(new GetCommand({ TableName: table, Key: key(id), ConsistentRead: true }));
    return r.Item;
  }
  async function deleteSource(job) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: config.inputBucket, Key: job.sourceKey, ...owner })); return true; }
    catch { return false; } // Lifecycle is the fallback; never expose AWS/source details.
  }
  async function get(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) return undefined;
    let job = await raw(id);
    if (!job || job.expiresAt <= Math.floor(now() / 1000)) return undefined;
    if (['QUEUED', 'RUNNING'].includes(job.status) && job.deadlineAt <= now()) {
      try {
        const r = await db.send(new UpdateCommand({ TableName: table, Key: key(id), ConditionExpression: '#g = :g AND (#s = :q OR #s = :r) AND deadlineAt <= :now', UpdateExpression: 'SET #s = :failed, #err = :err, updatedAt = :date REMOVE dispatchKey, dispatchAfter, leaseToken, leaseUntil', ExpressionAttributeNames: { '#g': 'generation', '#s': 'status', '#err': 'error' }, ExpressionAttributeValues: { ':g': job.generation, ':q': 'QUEUED', ':r': 'RUNNING', ':failed': 'FAILED', ':now': now(), ':date': new Date(now()).toISOString(), ':err': { code: 'JOB_DEADLINE_EXCEEDED', message: 'Job did not complete within its development deadline.' } }, ReturnValues: 'ALL_NEW' }));
        job = r.Attributes;
      } catch (error) { if (!isConditionalFailure(error)) throw error; job = await raw(id); }
      if (job && ['COMPLETED','FAILED'].includes(job.status)) await deleteSource(job);
    }
    return job;
  }
  async function dispatch(job) {
    if (!job || job.dispatchKey !== 'PENDING' || !['QUEUED','RUNNING'].includes(job.status)) return false;
    if (job.expiresAt <= Math.floor(now()/1000)) {
      // TTL deletion is delayed. Remove expired pending markers so they cannot
      // monopolize the first index page and starve newer accepted jobs.
      try { await db.send(new UpdateCommand({ TableName: table, Key: key(job.id), ConditionExpression: '#g = :g AND dispatchKey = :pending AND expiresAt <= :epoch', UpdateExpression: 'REMOVE dispatchKey, dispatchAfter', ExpressionAttributeNames: { '#g': 'generation' }, ExpressionAttributeValues: { ':g': job.generation, ':pending': 'PENDING', ':epoch': Math.floor(now()/1000) } })); }
      catch (error) { if (!isConditionalFailure(error)) throw error; }
      return false;
    }
    if (job.deadlineAt <= now()) { await get(job.id); return false; }
    // Send first, acknowledge the durable outbox second. A crash can duplicate a
    // message, never erase the accepted job; consumers use conditional claims.
    await sqs.send(new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: JSON.stringify({ schemaVersion: '1', jobId: job.id, generation: job.generation }) }));
    try {
      await db.send(new UpdateCommand({ TableName: table, Key: key(job.id), ConditionExpression: '#g = :g AND dispatchKey = :pending', UpdateExpression: 'REMOVE dispatchKey, dispatchAfter', ExpressionAttributeNames: { '#g': 'generation' }, ExpressionAttributeValues: { ':g': job.generation, ':pending': 'PENDING' } }));
    } catch (error) { if (!isConditionalFailure(error)) throw error; }
    return true;
  }
  function existingResult(job, digest) {
    if (job.digest !== digest) throw new ApiError(409, 'COMMIT_PAYLOAD_CONFLICT', 'This repository/PR/commit already has a different submission.');
    return { job, reused: true };
  }
  return {
    backend: 'aws', raw, get, deleteSource,
    async submit({ canonical, identity, digest }) {
      const id = createHash('sha256').update(identity).digest('hex');
      const existing = await get(id);
      if (existing) return existingResult(existing, digest);
      const generation = randomUUID(); const createdAt = new Date(now()).toISOString();
      const job = { ...key(id), id, generation, digest, repository: canonical.repository, pullRequest: canonical.pullRequest, commitSha: canonical.commitSha, simulation: canonical.simulation, status: 'QUEUED', mode: 'dummy', sourceKey: `sources/${id}/${generation}.json`, createdAt, updatedAt: createdAt, deadlineAt: now() + 15 * 60 * 1000, expiresAt: Math.floor(now()/1000) + 86400, dispatchKey: 'PENDING', dispatchAfter: now() };
      try {
        await s3.send(new PutObjectCommand({ Bucket: config.inputBucket, Key: job.sourceKey, Body: JSON.stringify(canonical), ContentType: 'application/json', ServerSideEncryption: 'AES256', ...owner }));
        await db.send(new PutCommand({ TableName: table, Item: job, ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now', ExpressionAttributeValues: { ':now': Math.floor(now()/1000) } }));
      } catch (error) {
        // An ambiguous write timeout might still have created the accepted job.
        // Never delete its source on an unknown outcome. A same-identity retry
        // reconciles against a strongly consistent read; orphans expire by S3 lifecycle.
        let current;
        try { current = await raw(id); } catch { throw unavailable(); }
        if (current && current.expiresAt > Math.floor(now()/1000)) {
          if (isConditionalFailure(error) && current.generation !== generation) await deleteSource(job);
          const result = existingResult(current, digest);
          return { ...result, reused: current.generation !== generation };
        }
        throw unavailable();
      }
      try { await dispatch(job); } catch { /* Durable pending record is retried by the dispatcher. */ }
      return { job, reused: false };
    },
    async flushOutbox() {
      const r = await db.send(new QueryCommand({ TableName: table, IndexName: 'dispatch-index', KeyConditionExpression: '#d = :pending AND #a <= :now', ExpressionAttributeNames: { '#d': 'dispatchKey', '#a': 'dispatchAfter' }, ExpressionAttributeValues: { ':pending': 'PENDING', ':now': now() }, Limit: 25 }));
      let sent = 0;
      for (const job of r.Items ?? []) {
        try { if (await dispatch(job)) sent++; }
        catch {
          try { await db.send(new UpdateCommand({ TableName: table, Key: key(job.id), ConditionExpression: '#g = :g AND dispatchKey = :p', UpdateExpression: 'SET dispatchAfter = :later', ExpressionAttributeNames: { '#g': 'generation' }, ExpressionAttributeValues: { ':g': job.generation, ':p': 'PENDING', ':later': now()+5000 } })); }
          catch { /* Pending state remains durable even when retry backoff cannot be recorded. */ }
        }
      }
      return sent;
    },
    async issueReportLink(job) {
      if (job.status !== 'COMPLETED' || !job.reportKey?.startsWith(`reports/${job.id}/${job.generation}/`)) throw new Error('Invalid completed report reference.');
      const url = await signReport(new GetObjectCommand({ Bucket: config.reportBucket, Key: job.reportKey, ResponseCacheControl: 'no-store', ...owner }), 60);
      return { url, expiresAt: new Date(now()+60000).toISOString() };
    },
    async readSource(job) {
      return readJsonBody(await s3.send(new GetObjectCommand({ Bucket: config.inputBucket, Key: job.sourceKey, ...owner })));
    },
    async putReport(job, leaseToken, report) {
      const reportKey = `reports/${job.id}/${job.generation}/${leaseToken}.json`;
      await s3.send(new PutObjectCommand({ Bucket: config.reportBucket, Key: reportKey, Body: JSON.stringify(report), ContentType: 'application/json', CacheControl: 'no-store', ServerSideEncryption: 'AES256', ...owner }));
      return reportKey;
    }
  };
}
