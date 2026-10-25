import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
const root=new URL('../',import.meta.url);
const token=(await readFile(new URL('.local/deployment-service-token',root),'utf8')).trim();
const r=spawnSync('terraform',['-chdir=infra/app','output','-raw','endpoint'],{cwd:fileURLToPath(root),encoding:'utf8',timeout:30000});
if(r.status!==0)throw new Error('Cannot read hosting endpoint.');
const base=r.stdout.trim();
if(!/^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/.test(base))throw new Error('Unexpected endpoint.');
async function call(path,body,auth=true){
 const response=await fetch(new URL(path,base),{method:body?'POST':'GET',headers:{...(auth?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 return{status:response.status,body:await response.json()};
}
assert.equal((await call('/health',undefined,false)).status,200);
const sample={schemaVersion:'1',repository:'ApriCuz54/CS6620-Fall2026-Team5-Project',pullRequest:1,commitSha:randomBytes(20).toString('hex'),simulation:'clean',files:[{path:'src/hosting-smoke.js',content:'CLOUD_HOSTING_SYNTHETIC_SOURCE'}]};
assert.equal((await call('/v1/jobs',sample,false)).status,401);
console.log('PASS: public HTTPS health works; unauthenticated submissions are refused.');
for(const simulation of ['clean','high','error']){
 const body={...sample,commitSha:randomBytes(20).toString('hex'),simulation};
 const accepted=await call('/v1/jobs',body);assert.equal(accepted.status,202);
 await wait(600);
 const duplicate=await call('/v1/jobs',body);assert.equal(duplicate.status,200);assert.equal(duplicate.body.jobId,accepted.body.jobId);
 let job=accepted.body;const deadline=Date.now()+60000;
 while(!['COMPLETED','FAILED'].includes(job.status)&&Date.now()<deadline){await wait(1000);const result=await call(job.statusUrl);assert.equal(result.status,200);job=result.body;}
 assert.equal(job.mode,'dummy');assert.equal(job.gate,'NOT_EVALUATED');assert.equal(job.mergeAllowed,false);
 if(simulation==='error'){assert.equal(job.status,'FAILED');assert.equal(job.report,undefined);}
 else{
  assert.equal(job.status,'COMPLETED');assert.equal(job.summary.high,simulation==='high'?1:0);
  const report=await call(job.report.url,undefined,false);assert.equal(report.status,200);assert.equal(report.body.commitSha,body.commitSha);assert.equal(report.body.mergeAllowed,false);
  assert.equal(JSON.stringify(report.body).includes('CLOUD_HOSTING_SYNTHETIC_SOURCE'),false);
 }
 console.log(`PASS: ${simulation} HTTPS roundtrip, duplicate handling, real AWS-hosted worker and non-passing dummy report.`);
 await wait(1000);
}
console.log('Hosted smoke tests passed. No raw token, source or presigned URL was logged.');
