import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { validateSubmission } from '../gate/contract.mjs';
import { buildOutcome, failure } from '../scanner/report.mjs';
import { isConditionalFailure } from './store.mjs';

export function createCloudWorker({ config, store, db, sqs, scanner, now = Date.now, allowedRepository }) {
  if (!scanner?.scan) throw new Error('A scanner is required.');
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
      const cancel=new AbortController();
      heartbeat=setInterval(() => {
        if (busy || lost) return; busy=true;
        renewing=(async () => {
          await db.send(new UpdateCommand({TableName:config.tableName,Key:key(job.id),ConditionExpression:'#g = :g AND #s = :r AND leaseToken = :owner AND leaseUntil > :now AND deadlineAt > :now',UpdateExpression:'SET leaseUntil = :until',ExpressionAttributeNames:{'#g':'generation','#s':'status'},ExpressionAttributeValues:{':g':job.generation,':r':'RUNNING',':owner':leaseToken,':now':now(),':until':now()+30000}}));
          await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:config.queueUrl,ReceiptHandle:message.ReceiptHandle,VisibilityTimeout:60}));
        })().catch(()=>{lost=true;cancel.abort();}).finally(()=>{busy=false;});
      },10000);
      async function stopHeartbeat() { clearInterval(heartbeat); await renewing; }
      try {
        const source=await store.readSource(job);
        const checked=validateSubmission(source,allowedRepository);
        if (checked.digest!==job.digest || source.repository!==job.repository || source.commitSha!==job.commitSha || source.pullRequest!==job.pullRequest) throw new Error('Source integrity mismatch.');
        // Scan the files as text in a fresh bounded container. A lost lease aborts it.
        const files=checked.canonical.files;
        const outcome=buildOutcome(job,files,await scanner.scan(files,{signal:cancel.signal}),{isolation:scanner.isolation,now});
        if (lost) { await stopHeartbeat(); return {kind:'lease-lost'}; }
        // A container that could not start is a host problem, not a scan result: retry it.
        if (outcome.error?.code==='LAUNCH_FAILED') throw new Error('Scan container launch failed.');
        let result;
        if (outcome.status==='COMPLETED') {
          const reportKey=await store.putReport(job,leaseToken,outcome.report);
          result={status:'COMPLETED',verdict:outcome.verdict,summary:outcome.summary,filesScanned:outcome.filesScanned,scanner:outcome.scanner,reportKey};
        } else result={status:'FAILED',verdict:'ERROR',error:outcome.error};
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
          try { await complete(job,leaseToken,{...failure('WORKER_RETRY_EXHAUSTED'),error:{code:'WORKER_RETRY_EXHAUSTED',message:'Worker could not complete the job after bounded retries.'}}); await store.deleteSource(job); await acknowledge(message.ReceiptHandle); return {kind:'failed',jobId:job.id}; }
          catch { return {kind:'retry'}; }
        }
        return {kind:'retry'};
      } finally { clearInterval(heartbeat); cancel.abort(); }
    }
  };
}
