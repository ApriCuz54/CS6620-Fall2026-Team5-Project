import { createHash, timingSafeEqual } from 'node:crypto';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { ApiError } from '../gate/contract.mjs';

export function createParameterVerifier({ client, name, now = Date.now, ttlMs = 60000 }) {
  if (!name?.startsWith('/cs6620/team5/')) throw new Error('Unexpected verifier parameter path.');
  let cached; let expires = 0; let loading;
  async function hashes() {
    if (cached && now() < expires) return cached;
    if (!loading) loading = (async () => {
      const response = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      if (response.Parameter?.Type !== 'SecureString') throw new Error('Verifier must be encrypted.');
      const value = JSON.parse(response.Parameter.Value);
      if (value.schemaVersion !== '1' || !Array.isArray(value.hashes) || value.hashes.length < 1 || value.hashes.length > 2 || !value.hashes.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))) throw new Error('Invalid verifier configuration.');
      cached = value.hashes.map(x => Buffer.from(x, 'hex')); expires = now() + ttlMs;
      return cached;
    })().catch(() => { throw new ApiError(503, 'AUTH_CONFIGURATION_UNAVAILABLE', 'Authentication is temporarily unavailable. Retry later.'); }).finally(() => { loading = undefined; });
    return loading;
  }
  return {
    async ready() { await hashes(); return true; },
    async verify(token) {
      if (typeof token !== 'string' || token.length < 32 || token.length > 256) return false;
      const candidate = createHash('sha256').update(token).digest();
      const configured = await hashes();
      // Check all active hashes so rotation can overlap without exposing which matched.
      let match = 0; for (const value of configured) match |= Number(timingSafeEqual(candidate, value));
      return match !== 0;
    }
  };
}
