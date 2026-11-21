import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createParameterVerifier } from '../services/cloud/verifier.mjs';
const token='a'.repeat(64);const next='b'.repeat(64);
const hash=x=>createHash('sha256').update(x).digest('hex');
test('SSM verifier caches only hashes and supports overlap/retirement after cache expiry',async()=>{
 let time=0;let calls=0;let hashes=[hash(token)];
 const client={async send(command){calls++;assert.equal(command.input.WithDecryption,true);return{Parameter:{Type:'SecureString',Value:JSON.stringify({schemaVersion:'1',hashes})}};}};
 const v=createParameterVerifier({client,name:'/cs6620/team5/test',now:()=>time});
 assert.equal(await v.verify(token),true);assert.equal(await v.verify('c'.repeat(64)),false);assert.equal(calls,1);
 hashes=[hash(next),hash(token)];time=60001;
 assert.equal(await v.verify(next),true);assert.equal(await v.verify(token),true);assert.equal(calls,2);
 hashes=[hash(next)];time=120002;
 assert.equal(await v.verify(token),false);assert.equal(await v.verify(next),true);
});
test('expired verifier cache fails closed during SSM failure',async()=>{
 let time=0;let fail=false;
 const client={async send(){if(fail)throw Error('private detail');return{Parameter:{Type:'SecureString',Value:JSON.stringify({schemaVersion:'1',hashes:[hash(token)]})}};}};
 const v=createParameterVerifier({client,name:'/cs6620/team5/test',now:()=>time});
 assert.equal(await v.verify(token),true);time=60001;fail=true;
 await assert.rejects(v.verify(token),e=>e.status===503&&!e.message.includes('private detail'));
 await assert.rejects(v.ready(),e=>e.status===503);
});
test('unencrypted or malformed verifier is refused and concurrent loads share one request',async()=>{
 let calls=0;
 const client={async send(){calls++;await new Promise(resolve=>setTimeout(resolve,5));return{Parameter:{Type:'String',Value:'bad'}};}};
 const v=createParameterVerifier({client,name:'/cs6620/team5/test'});
 const results=await Promise.allSettled([v.ready(),v.ready()]);assert.ok(results.every(x=>x.status==='rejected'));assert.equal(calls,1);
 assert.equal(await v.verify('short'),false);
});
