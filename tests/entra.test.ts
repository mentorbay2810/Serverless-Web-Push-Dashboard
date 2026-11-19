import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { entraAuthenticator } from '../packages/adapters/src/entra.js';
import { AppError } from '../packages/core/src/index.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const apiClientId = '22222222-2222-4222-8222-222222222222';
const spaClientId = '33333333-3333-4333-8333-333333333333';
const adminId = '44444444-4444-4444-8444-444444444444';
const keys = await generateKeyPair('RS256');
const auth = entraAuthenticator({ tenantId, apiClientId, spaClientId, adminObjectIds: [adminId] }, keys.publicKey);
async function token(claims: Record<string, unknown> = {}, audience = apiClientId, expiry = '5m') {
  return new SignJWT({ ver: '2.0', tid: tenantId, oid: adminId, azp: spaClientId, scp: 'access_as_user', ...claims })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(keys.privateKey);
}
const rejected = (status: number) => (error: unknown) => error instanceof AppError && error.status === status;

test('administrator access requires a signed delegated API token', async () => {
  assert.equal((await auth.authenticate(`Bearer ${await token()}`)).objectId, adminId);
  await assert.rejects(auth.authenticate(null), rejected(401));
  await assert.rejects(auth.authenticate(`Bearer ${await token({}, spaClientId)}`), rejected(401));
});
test('wrong tenant, client, scope, and expired access tokens are rejected', async () => {
  for (const claims of [{ tid: spaClientId }, { azp: apiClientId }, { scp: 'other_scope' }]) {
    await assert.rejects(auth.authenticate(`Bearer ${await token(claims)}`), rejected(401));
  }
  await assert.rejects(auth.authenticate(`Bearer ${await token({}, apiClientId, '-5m')}`), rejected(401));
});
test('valid signed non-administrator tokens receive forbidden responses', async () => {
  await assert.rejects(auth.authenticate(`Bearer ${await token({ oid: '55555555-5555-4555-8555-555555555555' })}`), rejected(403));
  assert.ok(await auth.authenticate(`Bearer ${await token({ oid: '55555555-5555-4555-8555-555555555555', roles: ['WebPush.Admin'] })}`));
});
test('tampered signatures and ID-token-shaped claims cannot authorize the API', async () => {
  const original = await token(); const pieces = original.split('.');
  const signature = pieces[2]!; pieces[2] = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  await assert.rejects(auth.authenticate(`Bearer ${pieces.join('.')}`), rejected(401));
  const idToken = await new SignJWT({ tid: tenantId, oid: adminId, azp: spaClientId, ver: '2.0' }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`).setAudience(apiClientId).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  await assert.rejects(auth.authenticate(`Bearer ${idToken}`), rejected(401));
});
