import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { validateSubmission } from '../gate/contract.mjs';
import { buildDummyReport } from '../gate/dummy-worker.mjs';
import { isConditionalFailure } from './store.mjs';

export function createCloudDummyWorker({ config, store, db, sqs, now = Date.now, allowedRepository }) {
  const key = id => ({ pk: `JOB#${id}` });
  async function acknowledge(receipt) { await sqs.send(new DeleteMessageCommand({ QueueUrl: config.queueUrl, ReceiptHandle: receipt })); }
  async function complete(job, leaseToken, result) {
    const attrs = { ...result, updatedAt: new Date(now()).toISOString() };
    const names = { '#g':'generation', '#s':'status' };
    const values = { ':g':job.generation, ':owner':leaseToken, ':running':'RUNNING', ':now':now() };
    let n=0; const sets=[];
    for (const [field,value] of Object.entries(attrs)) { names[`#f${n}`]=field; values[`:v${n}`]=value; sets.push(`#f${n} = :v${n}`); n++; }
    await db.send(new UpdateCommand({ TableName:config.tableName, Key:key(job.id), ConditionExpression:'#g = :g AND #s = :running AND leaseToken = :owner AND leaseUntil > :now AND deadlineAt > :now', UpdateExpression:`SET ${sets.join(', ')} REMOVE leaseToken, leaseUntil, dispatchKey, dispatchAfter`, ExpressionAttributeNames:names, ExpressionAttributeValues:values }));
  }
  return {
    async consumeOnce({ waitTimeSeconds = 2 } = {}) {
      const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl:config.queueUrl, MaxNumberOfMessages:1, WaitTimeSeconds:waitTimeSeconds, VisibilityTimeout:60 }));
      const message = response.Messages?.[0]; if (!message) return { kind:'empty' };
      let envelope;
      try { envelope=JSON.parse(message.Body); } catch { return { kind:'invalid-message' }; }
      if (envelope.schemaVersion!=='1' || !/^[a-f0-9]{64}$/.test(envelope.jobId ?? '') || !/^[a-f0-9-]{36}$/.test(envelope.generation ?? '')) return { kind:'invalid-message' };
      let job=await store.get(envelope.jobId);
      if (!job || job.generation!==envelope.generation || ['COMPLETED','FAILED'].includes(job.status)) { await acknowledge(message.ReceiptHandle); return {kind:'obsolete-or-terminal'}; }
      const leaseToken=randomUUID();
      try {
        const claimed=await db.send(new UpdateCommand({ TableName:config.tableName, Key:key(job.id), ConditionExpression:'#g = :g AND expiresAt > :epoch AND deadlineAt > :now AND (#s = :q OR (#s = :r AND leaseUntil <= :now))', UpdateExpression:'SET #s = :r, leaseToken = :owner, leaseUntil = :until, attempts = if_not_exists(attempts, :zero) + :one, updatedAt = :date', ExpressionAttributeNames:{'#g':'generation','#s':'status'}, ExpressionAttributeValues:{':g':job.generation,':epoch':Math.floor(now()/1000),':now':now(),':q':'QUEUED',':r':'RUNNING',':owner':leaseToken,':until':now()+30000,':zero':0,':one':1,':date':new Date(now()).toISOString()}, ReturnValues:'ALL_NEW' }));
        job=claimed.Attributes;
      } catch (error) { if (isConditionalFailure(error)) return {kind:'claim-lost'}; throw error; }
      let heartbeat; let lost=false; let renewing=Promise.resolve(); let busy=false;
      heartbeat=setInterval(() => {
        if (busy || lost) return; busy=true;
        renewing=(async () => {
          await db.send(new UpdateCommand({TableName:config.tableName,Key:key(job.id),ConditionExpression:'#g = :g AND #s = :r AND leaseToken = :owner AND leaseUntil > :now AND deadlineAt > :now',UpdateExpression:'SET leaseUntil = :until',ExpressionAttributeNames:{'#g':'generation','#s':'status'},ExpressionAttributeValues:{':g':job.generation,':r':'RUNNING',':owner':leaseToken,':now':now(),':until':now()+30000}}));
          await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:config.queueUrl,ReceiptHandle:message.ReceiptHandle,VisibilityTimeout:60}));
        })().catch(()=>{lost=true;}).finally(()=>{busy=false;});
      },10000);
      async function stopHeartbeat() { clearInterval(heartbeat); await renewing; }
      try {
        let result;
        if (job.simulation==='error') result={status:'FAILED',error:{code:'SIMULATED_FAILURE',message:'Development worker simulated a failure.'}};
        else {
          const source=await store.readSource(job);
          const checked=validateSubmission(source,allowedRepository);
          if (checked.digest!==job.digest || source.repository!==job.repository || source.commitSha!==job.commitSha || source.pullRequest!==job.pullRequest) throw new Error('Source integrity mismatch.');
          const report=buildDummyReport(job,checked.canonical.files);
          const reportKey=await store.putReport(job,leaseToken,report);
          result={status:'COMPLETED',summary:report.summary,reportKey};
        }
        await stopHeartbeat();
        if (lost) return {kind:'lease-lost'};
        await complete(job,leaseToken,result);
        await store.deleteSource(job);
        await acknowledge(message.ReceiptHandle);
        return {kind:result.status==='COMPLETED'?'completed':'failed',jobId:job.id};
      } catch (error) {
        await stopHeartbeat();
        if (lost || isConditionalFailure(error)) return {kind:'lease-lost'};
        // Retriable failures leave the receipt unacknowledged. After visibility
        // and lease expiration another worker can claim the same generation.
        if (job.attempts >= 3) {
          try { await complete(job,leaseToken,{status:'FAILED',error:{code:'WORKER_RETRY_EXHAUSTED',message:'Worker could not complete the development job after bounded retries.'}}); await store.deleteSource(job); await acknowledge(message.ReceiptHandle); return {kind:'failed',jobId:job.id}; }
          catch { return {kind:'retry'}; }
        }
        return {kind:'retry'};
      } finally { clearInterval(heartbeat); }
    }
  };
}
