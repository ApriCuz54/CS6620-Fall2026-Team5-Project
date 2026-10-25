// Reversible application-outage drill on one project node. No EC2 termination.
import {spawnSync} from 'node:child_process';
import {setTimeout as wait} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(await readFile(new URL('../.local/cloud-connection.json',import.meta.url),'utf8'));
function aws(args){const r=spawnSync('aws',[...args,'--region','us-east-1','--no-cli-pager','--output','json'],{encoding:'utf8',timeout:30000});if(r.status!==0)throw new Error(`AWS failover call failed: ${args[0]} ${args[1]}`);return JSON.parse(r.stdout||'{}');}
if(aws(['sts','get-caller-identity']).Account!==config.accountId)throw new Error('AWS account mismatch.');
const name='cs6620-team5-nodes';
const group=aws(['autoscaling','describe-auto-scaling-groups','--auto-scaling-group-names',name]).AutoScalingGroups?.[0];
if(group?.Instances?.length!==2||group.Instances.some(x=>x.HealthStatus!=='Healthy')||group.SuspendedProcesses?.length)throw new Error('Require exactly two healthy project nodes and no pre-existing suspension.');
const output=spawnSync('terraform',['-chdir=infra/app','output','-raw','target_group_arn'],{cwd:root,encoding:'utf8',timeout:30000});if(output.status!==0)throw new Error('Cannot read project target group.');
const targetGroup=output.stdout.trim();const isolated=group.Instances[0].InstanceId;const remaining=group.Instances[1].InstanceId;
const targets=()=>aws(['elbv2','describe-target-health','--target-group-arn',targetGroup]).TargetHealthDescriptions;
async function command(commands){
 const response=aws(['ssm','send-command','--document-name','AWS-RunShellScript','--instance-ids',isolated,'--parameters',JSON.stringify({commands}),'--comment','Reversible CS6620 application failover drill']);
 for(let n=0;n<40;n++){
  await wait(2000);
  const r=spawnSync('aws',['ssm','get-command-invocation','--command-id',response.Command.CommandId,'--instance-id',isolated,'--region','us-east-1','--no-cli-pager','--output','json'],{encoding:'utf8',timeout:30000});
  if(r.status!==0)continue;
  const value=JSON.parse(r.stdout);
  if(value.Status==='Success')return;
  if(['Failed','Cancelled','TimedOut'].includes(value.Status))throw new Error('Project container control command did not succeed.');
 }
 throw new Error('Container control command deadline exceeded.');
}
async function health(predicate){for(let n=0;n<40;n++){if(predicate(targets()))return;await wait(3000);}throw new Error('Target-health deadline exceeded.');}
let suspended=false;let stopped=false;
try{
 if(targets().filter(x=>x.TargetHealth.State==='healthy').length!==2)throw new Error('Both targets must be healthy before this drill.');
 aws(['autoscaling','suspend-processes','--auto-scaling-group-name',name,'--scaling-processes','HealthCheck','ReplaceUnhealthy']);suspended=true;
 stopped=true;await command(['docker stop cs6620-api cs6620-worker']);
 await health(xs=>xs.find(x=>x.Target.Id===isolated)?.TargetHealth.State==='unhealthy'&&xs.find(x=>x.Target.Id===remaining)?.TargetHealth.State==='healthy');
 console.log('One project application node is unavailable; the other remains healthy. Running the HTTPS checks.');
 const smoke=spawnSync(process.execPath,['scripts/hosting-smoke.mjs'],{cwd:root,env:process.env,stdio:'inherit',timeout:180000});
 if(smoke.status!==0)throw new Error('Single-node HTTPS checks failed.');
 console.log('PASS: one remaining node served the authenticated dummy job/report flow.');
}finally{
 try{
  if(stopped){await command(['docker start cs6620-api cs6620-worker']);await health(xs=>xs.filter(x=>x.TargetHealth.State==='healthy').length===2);console.log('Both project application nodes are healthy again.');}
 }finally{
  if(suspended){aws(['autoscaling','resume-processes','--auto-scaling-group-name',name,'--scaling-processes','HealthCheck','ReplaceUnhealthy']);console.log('ASG health checking and replacement resumed.');}
 }
}
