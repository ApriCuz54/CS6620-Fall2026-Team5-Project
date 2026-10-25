import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
function run(command,args,{input,quiet=false,allowError=false}={}) {
 const r=spawnSync(command,args,{cwd:root,input,encoding:'utf8',maxBuffer:8*1024*1024});
 if(!quiet&&r.stdout)process.stdout.write(r.stdout);
 if(!quiet&&r.stderr)process.stderr.write(r.stderr);
 if(r.status!==0&&!allowError)throw new Error(`${command} failed (${r.status}).`);
 return r;
}
const connection=JSON.parse(readFileSync(join(root,'.local/cloud-connection.json'),'utf8'));
const identity=run('aws',['sts','get-caller-identity','--query','Account','--output','text'],{quiet:true}).stdout.trim();
if(identity!==connection.accountId)throw new Error('AWS account mismatch.');
const repository=run('terraform',['-chdir=infra/artifacts','output','-raw','repository_url'],{quiet:true}).stdout.trim();
if(repository!==`${identity}.dkr.ecr.us-east-1.amazonaws.com/cs6620-team5-runtime`)throw new Error('Unexpected ECR destination.');
const files=['Dockerfile.hosting','package.json','package-lock.json','scripts/cloud-worker.mjs'];
function visit(dir){for(const entry of readdirSync(join(root,dir),{withFileTypes:true})){const path=`${dir}/${entry.name}`;if(entry.isDirectory())visit(path);else files.push(path);}}
visit('services');
const hash=createHash('sha256');for(const file of files.sort()){hash.update(file+'\0');hash.update(readFileSync(join(root,file)));}
const tag=`foundation-${hash.digest('hex').slice(0,16)}`;
const lookup=()=>run('aws',['ecr','describe-images','--region','us-east-1','--repository-name','cs6620-team5-runtime','--image-ids',`imageTag=${tag}`,'--query','imageDetails[0].imageDigest','--output','text'],{quiet:true,allowError:true});
let found=lookup();
if(found.status!==0){
 if(!found.stderr.includes('ImageNotFoundException'))throw new Error('Could not inspect ECR image; no build attempted.');
 const password=run('aws',['ecr','get-login-password','--region','us-east-1'],{quiet:true}).stdout;
 run('docker',['login','--username','AWS','--password-stdin',repository.split('/')[0]],{input:password,quiet:true});
 try{
  run('docker',['buildx','build','--platform','linux/amd64','--provenance=false','--load','-f','Dockerfile.hosting','-t',`${repository}:${tag}`,'.']);
  run('docker',['push',`${repository}:${tag}`]);
 }finally{run('docker',['logout',repository.split('/')[0]],{quiet:true,allowError:true});}
 found=lookup();
}
if(found.status!==0||!/^sha256:[a-f0-9]{64}$/.test(found.stdout.trim()))throw new Error('Image digest unavailable.');
const imageUri=`${repository}@${found.stdout.trim()}`;
mkdirSync(join(root,'.local'),{recursive:true,mode:0o700});
writeFileSync(join(root,'.local/hosting-image.json'),JSON.stringify({imageUri,tag,platform:'linux/amd64'},null,2)+'\n',{mode:0o600});
console.log('Runtime image published and pinned by digest; no credentials or service token were included.');
