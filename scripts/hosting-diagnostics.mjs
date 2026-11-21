import {spawnSync} from 'node:child_process';
import {setTimeout as wait} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(new URL('../.local/cloud-connection.json',import.meta.url),'utf8'));
function aws(args,{optional=false}={}){
 const r=spawnSync('aws',[...args,'--region','us-east-1','--no-cli-pager','--output','json'],{encoding:'utf8',timeout:30000});
 if(r.status!==0){if(optional)return undefined;throw new Error(`AWS diagnostic call failed: ${args[0]} ${args[1]}`);}
 return JSON.parse(r.stdout||'{}');
}
if(aws(['sts','get-caller-identity']).Account!==config.accountId)throw new Error('AWS account mismatch.');
const group=aws(['autoscaling','describe-auto-scaling-groups','--auto-scaling-group-names','cs6620-team5-nodes']).AutoScalingGroups?.[0];
const ids=group?.Instances?.map(x=>x.InstanceId)??[];
if(ids.length!==2||!ids.every(x=>/^i-[a-f0-9]+$/.test(x)))throw new Error('Expected exactly two project instances.');
const commands=[
 'free -m',
 'docker stats --no-stream --format "{{.Name}} {{.MemUsage}} CPU={{.CPUPerc}}"',
 'docker inspect -f "{{.Name}} OOM={{.State.OOMKilled}} restarts={{.RestartCount}}" cs6620-api cs6620-worker',
 'df -h /',
 'journalctl -k --no-pager --since "-15min" | grep -Ei "out of memory|oom-kill" || true'
];
const response=aws(['ssm','send-command','--document-name','AWS-RunShellScript','--instance-ids',...ids,'--parameters',JSON.stringify({commands}),'--comment','Read-only CS6620 container and memory diagnostics']);
const commandId=response.Command.CommandId;
for(const id of ids){
 let result;
 for(let n=0;n<60;n++){
  result=aws(['ssm','get-command-invocation','--command-id',commandId,'--instance-id',id],{optional:true});
  if(result&&['Success','Failed','Cancelled','TimedOut'].includes(result.Status))break;
  await wait(2000);
 }
 if(!result||result.Status!=='Success'){console.error(`Diagnostics did not complete successfully for ${id}.`);if(result?.StandardErrorContent)console.error(result.StandardErrorContent);process.exitCode=1;continue;}
 console.log(`Instance ${id}:\n${result.StandardOutputContent}`);
}
