import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {fixture} from './fixtures.mjs';
const root=new URL('../',import.meta.url);
const token=(process.env.SCANNER_TOKEN ?? await readFile(new URL('.local/deployment-service-token',root),'utf8')).trim();
let base=process.env.SCANNER_URL?.trim().replace(/\/$/,'');
if(!base){
 const output=spawnSync('terraform',['-chdir=infra/app','output','-raw','endpoint'],{cwd:fileURLToPath(root),encoding:'utf8',timeout:30000});
 if(output.status!==0)throw new Error('Set SCANNER_URL, or use the owner profile to read the hosting endpoint.');
 base=output.stdout.trim();
}
if(!/^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/.test(base))throw new Error('Unexpected endpoint.');
async function request(path,body,auth=true){
 const r=await fetch(new URL(path,base),{method:body?'POST':'GET',headers:{...(auth?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw new Error(`Request returned HTTP ${r.status}; no passing result inferred.`);
 return r.json();
}
const name=process.argv[2]??'clean';const {files,verdict:expected}=fixture(name);
const body={schemaVersion:'2',repository:process.env.SCANNER_REPOSITORY??'ApriCuz54/CS6620-Fall2026-Team5-Project',pullRequest:1,commitSha:randomBytes(20).toString('hex'),files};
let job=await request('/v1/jobs',body);const deadline=Date.now()+5*60000;
while(true){
 console.log(`${job.status}; verdict=${job.verdict}; mergeAllowed=${job.mergeAllowed}`);
 if(['COMPLETED','FAILED'].includes(job.status))break;
 if(Date.now()>deadline)throw new Error('Polling deadline exceeded. No passing result inferred.');
 await wait(1000);job=await request(job.statusUrl);
}
if(job.status==='COMPLETED'){
 const report=await request(job.report.url,undefined,false);
 console.log(JSON.stringify({verdict:report.verdict,mergeAllowed:report.mergeAllowed,scanner:report.scanner,summary:report.summary,findings:report.findings},null,2));
 if(report.verdict!==expected){console.error(`Expected ${expected} for the ${name} fixture.`);process.exitCode=1;}
}else{console.error(`Scan failed: ${job.error?.code}`);process.exitCode=1;}
