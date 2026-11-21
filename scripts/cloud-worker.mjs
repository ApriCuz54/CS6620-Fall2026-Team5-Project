import { loadCloud } from '../services/cloud/config.mjs';
import { createCloudWorker } from '../services/cloud/worker.mjs';
import { createScanner } from '../services/scanner/scan.mjs';
import { setTimeout as wait } from 'node:timers/promises';
const scanner=createScanner();
if(process.env.CLOUD_DEPLOYED==='1'&&scanner.isolation!=='container')throw new Error('Deployed workers must scan in containers.');
const cloud=await loadCloud();
console.log(`Cloud worker started (scanner isolation: ${scanner.isolation}).`);
const worker=createCloudWorker({...cloud,scanner,allowedRepository:process.env.SCANNER_REPOSITORY ?? 'ApriCuz54/CS6620-Fall2026-Team5-Project'});
let stopping=false;process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
try {
  do {
    try { const result=await worker.consumeOnce();if(result.kind!=='empty')console.log(`Cloud worker: ${result.kind}`); }
    catch { console.error('Cloud worker request failed; no passing result was produced.');if(process.argv.includes('--once'))process.exitCode=1;else await wait(2000); }
  }while(!stopping&&!process.argv.includes('--once'));
}finally{cloud.close();}
