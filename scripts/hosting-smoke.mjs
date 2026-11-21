import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {FIXTURES} from './fixtures.mjs';
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
const sample={schemaVersion:'2',repository:process.env.SCANNER_REPOSITORY??'ApriCuz54/CS6620-Fall2026-Team5-Project',pullRequest:1,commitSha:randomBytes(20).toString('hex'),files:FIXTURES.clean.files};
assert.equal((await call('/v1/jobs',sample,false)).status,401);
console.log('PASS: public HTTPS health works; unauthenticated submissions are refused.');
for(const [name,{files,verdict}] of Object.entries(FIXTURES)){
 const body={...sample,commitSha:randomBytes(20).toString('hex'),files};
 const accepted=await call('/v1/jobs',body);assert.equal(accepted.status,202);
 await wait(600);
 const duplicate=await call('/v1/jobs',body);assert.equal(duplicate.status,200);assert.equal(duplicate.body.jobId,accepted.body.jobId);
 let job=accepted.body;const deadline=Date.now()+5*60000;
 while(!['COMPLETED','FAILED'].includes(job.status)&&Date.now()<deadline){await wait(1000);const result=await call(job.statusUrl);assert.equal(result.status,200);job=result.body;}
 assert.equal(job.status,'COMPLETED',`Scan did not complete: ${job.error?.code ?? job.status}`);assert.equal(job.verdict,verdict);assert.equal(job.mergeAllowed,verdict==='PASS');
 assert.equal(job.scanner.isolation,'container');assert.equal(job.filesScanned,files.length);
 const report=await call(job.report.url,undefined,false);assert.equal(report.status,200);assert.equal(report.body.commitSha,body.commitSha);assert.equal(report.body.verdict,verdict);
 assert.equal(JSON.stringify(report.body).includes('demo-only-value'),false);
 console.log(`PASS: ${name} fixture -> ${verdict} over HTTPS; duplicate handling; containerized real scan; private report without source.`);
 await wait(1000);
}
console.log('Hosted smoke tests passed. No raw token, source or presigned URL was logged.');
