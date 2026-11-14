// Opt-in live AWS test: never runs as part of npm test. Uses only synthetic text.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../services/gate/app.mjs';
import { loadCloud } from '../services/cloud/config.mjs';
import { createCloudWorker } from '../services/cloud/worker.mjs';
import { createScanner } from '../services/scanner/scan.mjs';
import { FIXTURES } from './fixtures.mjs';

const cloud=await loadCloud();
const repository=process.env.SCANNER_REPOSITORY ?? 'ApriCuz54/CS6620-Fall2026-Team5-Project';
const token=randomBytes(32).toString('hex');
const app=createApp({store:cloud.store,token,signingKey:randomBytes(32),allowedRepository:repository});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const scanner=createScanner();
const worker=()=>createCloudWorker({...cloud,scanner,allowedRepository:repository});
async function request(path,body){
 const r=await fetch(new URL(path,base),{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
 return {status:r.status,body:await r.json()};
}
try {
 // Lose exactly one enqueue attempt while leaving the accepted DynamoDB record.
 const send=cloud.sqs.send.bind(cloud.sqs);let loseEnqueue=true;
 cloud.sqs.send=async(command,...rest)=>{if(loseEnqueue&&command instanceof SendMessageCommand){loseEnqueue=false;throw new Error('Intentional smoke-test enqueue failure');}return send(command,...rest);};
 for(const [name,{files,verdict}] of Object.entries(FIXTURES)){
  const body={schemaVersion:'2',repository,pullRequest:1,commitSha:randomBytes(20).toString('hex'),files};
  const accepted=await request('/v1/jobs',body);assert.equal(accepted.status,202);assert.equal(accepted.body.mergeAllowed,false);
  const duplicate=await request('/v1/jobs',body);assert.equal(duplicate.status,200);assert.equal(duplicate.body.jobId,accepted.body.jobId);
  const conflict=await request('/v1/jobs',{...body,files:[{path:'changed.js',content:'changed'}]});assert.equal(conflict.status,409);
  const row=await cloud.store.raw(accepted.body.jobId);
  if(name==='clean'){assert.equal(row.dispatchKey,'PENDING');console.log('PASS: accepted job remains durable after a simulated enqueue failure.');}
  else {
   // Deliberate duplicate delivery exercises atomic claims with two consumers.
   await cloud.sqs.send(new SendMessageCommand({QueueUrl:cloud.config.queueUrl,MessageBody:JSON.stringify({schemaVersion:'1',jobId:row.id,generation:row.generation})}));
  }
  let job;
  for(let n=0;n<15;n++){
   await cloud.store.flushOutbox();
   await Promise.all([worker().consumeOnce({waitTimeSeconds:1}),worker().consumeOnce({waitTimeSeconds:1})]);
   job=(await request(accepted.body.statusUrl)).body;
   if(['COMPLETED','FAILED'].includes(job.status))break;
   await wait(300);
  }
  assert.ok(job&&['COMPLETED','FAILED'].includes(job.status),'Cloud job did not reach a terminal state.');
  assert.equal(job.status,'COMPLETED',`Scan did not complete: ${job.error?.code ?? job.status}`);assert.equal(job.verdict,verdict);assert.equal(job.mergeAllowed,verdict==='PASS');
  const final=await cloud.store.raw(job.jobId);
  assert.equal(final.attempts,1,'Duplicate delivery must not create a second active execution.');
  assert.equal(final.dispatchKey,undefined);assert.equal(final.leaseToken,undefined);
  {
   const r=await fetch(job.report.url,{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);
   const report=await r.json();assert.equal(report.jobId,job.jobId);assert.equal(report.commitSha,body.commitSha);assert.equal(report.verdict,verdict);
   assert.equal(JSON.stringify(report).includes('demo-only-value'),false);
   // Removing the signature must not turn the object into a public report.
   const unsigned=new URL(job.report.url);unsigned.search='';
   const anonymous=await fetch(unsigned,{signal:AbortSignal.timeout(10000)});assert.equal(anonymous.status,403);await anonymous.body?.cancel();
  }
  let sourceRemoved=false;
  try{await cloud.s3.send(new GetObjectCommand({Bucket:cloud.config.inputBucket,Key:row.sourceKey,ExpectedBucketOwner:cloud.config.accountId}));}
  catch(error){if(error.name==='NoSuchKey')sourceRemoved=true;else throw error;}
  assert.equal(sourceRemoved,true,'Terminal source should be deleted; lifecycle remains a fallback.');
  console.log(`PASS: ${name} fixture -> ${verdict}; duplicate handling; private report behavior; source cleanup.`);
 }
 console.log('Live AWS queue/storage smoke tests passed. No public API or EC2 instance was created.');
}finally{await new Promise(resolve=>server.close(resolve));cloud.close();}
