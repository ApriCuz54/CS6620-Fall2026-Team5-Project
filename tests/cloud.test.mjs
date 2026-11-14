import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createCloudStore, readJsonBody } from '../services/cloud/store.mjs';
import { createCloudWorker } from '../services/cloud/worker.mjs';
import { createScanner } from '../services/scanner/scan.mjs';
const scanner=createScanner({isolation:'in-process'});
import { validateSubmission } from '../services/gate/contract.mjs';

const config={accountId:'123456789012',region:'us-east-1',tableName:'test-jobs',queueUrl:'https://example.test/queue',inputBucket:'test-inputs',reportBucket:'test-reports'};
const repository='ApriCuz54/CS6620-Fall2026-Team5-Project';
const checked=overrides=>validateSubmission({schemaVersion:'2',repository,pullRequest:1,commitSha:'d'.repeat(40),files:[{path:'a.js',content:'DO_NOT_LEAK_SOURCE'}],...overrides},repository);
const conditional=()=>Object.assign(new Error('conditional'),{name:'ConditionalCheckFailedException'});
function fakeCloud({failSend=false,ambiguousPut=false,failAcknowledge=false}={}) {
  const rows=new Map();const objects=new Map();const sends=[];const deletes=[];
  const state={failSend,failAcknowledge};
  const db={async send(command){
    const x=command.input;
    if(command.constructor.name==='GetCommand')return {Item:structuredClone(rows.get(x.Key.pk))};
    if(command.constructor.name==='PutCommand'){
      if(rows.has(x.Item.pk))throw conditional();
      rows.set(x.Item.pk,structuredClone(x.Item));if(ambiguousPut)throw new Error('response lost after commit');return {};
    }
    if(command.constructor.name==='QueryCommand')return {Items:[...rows.values()].filter(j=>j.dispatchKey==='PENDING')};
    if(command.constructor.name==='UpdateCommand'){
      const row=rows.get(x.Key.pk);
      if(row.generation!==x.ExpressionAttributeValues[':g']||row.dispatchKey!=='PENDING')throw conditional();
      if(state.failAcknowledge)throw new Error('dispatch acknowledgement unavailable');
      if(x.UpdateExpression.startsWith('REMOVE')){delete row.dispatchKey;delete row.dispatchAfter;}
      else row.dispatchAfter=x.ExpressionAttributeValues[':later'];
      return {};
    }
    throw new Error('Unexpected fake command');
  }};
  const s3={async send(command){const x=command.input;if(command.constructor.name==='PutObjectCommand'){objects.set(x.Key,x.Body);return {};}if(command.constructor.name==='DeleteObjectCommand'){deletes.push(x.Key);objects.delete(x.Key);return {};}throw new Error('Unexpected fake S3 command');}};
  const sqs={async send(command){if(state.failSend)throw new Error('queue unavailable');sends.push(JSON.parse(command.input.MessageBody));return {};}};
  const store=createCloudStore({config,db,s3,sqs,signReport:async()=> 'https://example.test/private'});
  return {store,rows,objects,sends,deletes,state};
}

test('cloud submission retains a durable pending job when enqueue fails, then dispatches it',async()=>{
 const h=fakeCloud({failSend:true});const result=await h.store.submit(checked());
 assert.equal(result.job.status,'QUEUED');assert.equal([...h.rows.values()][0].dispatchKey,'PENDING');
 assert.equal(h.objects.size,1);h.state.failSend=false;
 assert.equal(await h.store.flushOutbox(),1);assert.equal([...h.rows.values()][0].dispatchKey,undefined);
 assert.deepEqual(Object.keys(h.sends[0]).sort(),['generation','jobId','schemaVersion']);
 assert.equal(JSON.stringify(h.sends).includes('DO_NOT_LEAK_SOURCE'),false);
});

test('ambiguous DynamoDB write outcome never deletes the accepted source',async()=>{
 const h=fakeCloud({ambiguousPut:true});const result=await h.store.submit(checked());
 assert.equal(result.reused,false);assert.equal(h.rows.size,1);assert.equal(h.objects.has(result.job.sourceKey),true);assert.equal(h.deletes.length,0);
 assert.equal(await h.store.flushOutbox(),1);
});

test('racing duplicate submissions preserve the winning source and one logical job',async()=>{
 const h=fakeCloud();const [a,b]=await Promise.all([h.store.submit(checked()),h.store.submit(checked())]);
 assert.equal(a.job.id,b.job.id);assert.equal(h.rows.size,1);
 const job=[...h.rows.values()][0];assert.equal(h.objects.has(job.sourceKey),true);
 assert.equal(h.deletes.includes(job.sourceKey),false);assert.equal(h.objects.size,1);
});

test('a conflicting payload does not replace existing source or job',async()=>{
 const h=fakeCloud();const first=await h.store.submit(checked());
 await assert.rejects(h.store.submit(checked({files:[{path:'a.js',content:'CHANGED'}]})),error=>error.status===409);
 assert.equal(h.rows.size,1);assert.equal(h.objects.has(first.job.sourceKey),true);assert.equal(h.deletes.length,0);
});

test('send success followed by failed outbox acknowledgement safely retries the same generation',async()=>{
 const h=fakeCloud({failAcknowledge:true});await h.store.submit(checked());
 assert.equal([...h.rows.values()][0].dispatchKey,'PENDING');assert.equal(h.sends.length,1);
 h.state.failAcknowledge=false;await h.store.flushOutbox();
 assert.equal(h.sends.length,2);assert.deepEqual(h.sends[0],h.sends[1]);assert.equal(h.rows.size,1);
});

test('source reader bounds actual streamed bytes, not only the declared object size',async()=>{
 await assert.rejects(readJsonBody({ContentLength:999,Body:Readable.from(['{}'])},20));
 await assert.rejects(readJsonBody({Body:Readable.from(['x'.repeat(21)])},20));
 assert.deepEqual(await readJsonBody({Body:Readable.from(['{"ok":','true}'])},20),{ok:true});
});

test('cloud worker acknowledges terminal duplicates without executing or publishing again',async()=>{
 const commands=[];let claimed=false;
 const id='a'.repeat(64);const generation='12345678-1234-1234-1234-123456789012';
 const sqs={async send(command){commands.push(command.constructor.name);return command.constructor.name==='ReceiveMessageCommand'?{Messages:[{Body:JSON.stringify({schemaVersion:'1',jobId:id,generation}),ReceiptHandle:'receipt'}]}:{};}};
 const worker=createCloudWorker({config,scanner,sqs,db:{async send(){claimed=true;}},store:{async get(){return{id,generation,status:'COMPLETED'};}},allowedRepository:repository});
 assert.equal((await worker.consumeOnce()).kind,'obsolete-or-terminal');assert.equal(claimed,false);assert.ok(commands.includes('DeleteMessageCommand'));
});

test('a stale lease cannot finalize or acknowledge a worker result',async()=>{
 const body=checked();const id='b'.repeat(64);const generation='12345678-1234-1234-1234-123456789012';const commands=[];
 const job={id,generation,status:'QUEUED',repository:body.canonical.repository,pullRequest:1,commitSha:body.canonical.commitSha,digest:body.digest};
 const sqs={async send(command){commands.push(command.constructor.name);return command.constructor.name==='ReceiveMessageCommand'?{Messages:[{Body:JSON.stringify({schemaVersion:'1',jobId:id,generation}),ReceiptHandle:'receipt'}]}:{};}};
 let calls=0;const db={async send(command){calls++;if(calls===1)return{Attributes:{...job,status:'RUNNING',attempts:1}};assert.ok(command.input.ConditionExpression.includes('leaseToken = :owner'));throw conditional();}};
 const worker=createCloudWorker({config,scanner,sqs,db,allowedRepository:repository,store:{async get(){return job;},async readSource(){return body.canonical;},async putReport(){return'orphan-report';},async deleteSource(){throw new Error('Must not remove source after losing claim');}}});
 assert.equal((await worker.consumeOnce()).kind,'lease-lost');assert.equal(commands.includes('DeleteMessageCommand'),false);
});

test('report issuance uses an account-bound private S3 object and a short expiry',async()=>{
 const seen=[];
 const store=createCloudStore({config,db:{},s3:{},sqs:{},signReport:async(command,seconds)=>{seen.push({input:command.input,seconds});return'https://example.test/temporary';}});
 const job={id:'f'.repeat(64),generation:'generation',status:'COMPLETED',reportKey:`reports/${'f'.repeat(64)}/generation/owner.json`};
 assert.equal((await store.issueReportLink(job)).url,'https://example.test/temporary');
 assert.equal(seen[0].seconds,60);assert.equal(seen[0].input.ExpectedBucketOwner,config.accountId);assert.equal(seen[0].input.Bucket,config.reportBucket);
 await assert.rejects(store.issueReportLink({...job,reportKey:'someone-elses-report'}));
});


test('expired pending jobs leave the outbox index before asynchronous TTL deletion',async()=>{
 const h=fakeCloud({failSend:true});await h.store.submit(checked());
 const row=[...h.rows.values()][0];row.expiresAt=1;
 h.state.failSend=false;assert.equal(await h.store.flushOutbox(),0);
 assert.equal(row.dispatchKey,undefined);assert.equal(h.sends.length,0);
});

function workerHarness({scan}={}){
 const body=checked({files:[{path:'a.js',content:'const password = "DO_NOT_LEAK_SOURCE";'}]});const id='c'.repeat(64);const generation='12345678-1234-1234-1234-123456789012';
 const job={id,generation,status:'QUEUED',repository:body.canonical.repository,pullRequest:1,commitSha:body.canonical.commitSha,digest:body.digest};
 const commands=[];const updates=[];const reports=[];
 const sqs={async send(command){commands.push(command.constructor.name);return command.constructor.name==='ReceiveMessageCommand'?{Messages:[{Body:JSON.stringify({schemaVersion:'1',jobId:id,generation}),ReceiptHandle:'receipt'}]}:{};}};
 const db={async send(command){updates.push(command.input);return updates.length===1?{Attributes:{...job,status:'RUNNING',attempts:1}}:{};}};
 const store={async get(){return job;},async readSource(){return body.canonical;},async putReport(j,lease,report){reports.push(report);return`reports/${id}/${generation}/${lease}.json`;},async deleteSource(){return true;}};
 const worker=createCloudWorker({config,sqs,db,store,allowedRepository:repository,scanner:scan?{isolation:'test',scan}:scanner});
 return {worker,commands,updates,reports};
}

test('cloud worker commits a real FAIL verdict and report for a vulnerable job, then acknowledges',async()=>{
 const h=workerHarness();
 assert.equal((await h.worker.consumeOnce()).kind,'completed');
 const final=h.updates.at(-1);const values=Object.values(final.ExpressionAttributeValues);
 assert.ok(values.includes('COMPLETED'));assert.ok(values.includes('FAIL'));
 assert.ok(values.some(v=>v?.high===1));assert.ok(values.some(v=>v?.policyVersion==='high-blocks-v1'));
 assert.equal(h.reports[0].verdict,'FAIL');assert.equal(JSON.stringify(h.reports).includes('DO_NOT_LEAK_SOURCE'),false);
 assert.ok(h.commands.includes('DeleteMessageCommand'));
});

test('a scan container that cannot start is retried, not recorded as a result',async()=>{
 const h=workerHarness({scan:async()=>({status:'ERROR',error:{code:'LAUNCH_FAILED'}})});
 assert.equal((await h.worker.consumeOnce()).kind,'retry');
 assert.equal(h.updates.length,1,'only the claim was written');assert.equal(h.commands.includes('DeleteMessageCommand'),false);
});

test('a scan timeout is a terminal FAILED/ERROR result with no report',async()=>{
 const h=workerHarness({scan:async()=>({status:'ERROR',error:{code:'TIMEOUT'}})});
 assert.equal((await h.worker.consumeOnce()).kind,'failed');
 const values=Object.values(h.updates.at(-1).ExpressionAttributeValues);
 assert.ok(values.includes('FAILED'));assert.ok(values.includes('ERROR'));assert.ok(values.some(v=>v?.code==='TIMEOUT'));
 assert.equal(h.reports.length,0);
});
