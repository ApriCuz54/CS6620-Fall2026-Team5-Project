import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function localSecrets() {
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const local=resolve(root,'.local');mkdirSync(local,{recursive:true,mode:0o700});
  function secret(name) {
    const file=resolve(local,name);
    try {writeFileSync(file,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}
    catch(e){if(e.code!=='EEXIST')throw e;}
    chmodSync(file,0o600);const value=readFileSync(file,'utf8').trim();
    if(!/^[a-f0-9]{64}$/.test(value))throw new Error(`Invalid local ${name}; preserve the file and investigate.`);
    return value;
  }
  return {local,token:secret('dev-api-token'),signingKey:Buffer.from(secret('dev-report-signing-key'),'hex')};
}
