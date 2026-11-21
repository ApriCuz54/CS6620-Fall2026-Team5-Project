import { readFile } from 'node:fs/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createCloudStore } from './store.mjs';

export async function loadCloud() {
  const config=JSON.parse(await readFile(process.env.CLOUD_CONNECTION_FILE ?? new URL('../../.local/cloud-connection.json',import.meta.url),'utf8'));
  if (!/^\d{12}$/.test(config.accountId ?? '') || config.region!=='us-east-1' || config.tableName!=='cs6620-team5-jobs' || config.inputBucket!==`cs6620-team5-inputs-${config.accountId}` || config.reportBucket!==`cs6620-team5-reports-${config.accountId}` || config.queueUrl!==`https://sqs.us-east-1.amazonaws.com/${config.accountId}/cs6620-team5-jobs`) throw new Error('Invalid cloud resource configuration.');
  const options={region:config.region,maxAttempts:2,requestHandler:{connectionTimeout:2000,requestTimeout:5000}};
  const sts=new STSClient(options);
  try { const identity=await sts.send(new GetCallerIdentityCommand({})); if (identity.Account!==config.accountId) throw new Error('AWS account mismatch.'); }
  finally { sts.destroy(); }
  const dynamo=new DynamoDBClient(options);
  const db=DynamoDBDocumentClient.from(dynamo,{marshallOptions:{removeUndefinedValues:true}});
  const s3=new S3Client(options); const sqs=new SQSClient(options);
  const store=createCloudStore({config,db,s3,sqs,signReport:(command,seconds)=>getSignedUrl(s3,command,{expiresIn:seconds})});
  return {config,db,s3,sqs,store,close(){dynamo.destroy();s3.destroy();sqs.destroy();}};
}
