import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../../core/src/index.js';

export interface AdminIdentity { objectId: string }
export interface AdminAuthenticator { authenticate(header: string | null): Promise<AdminIdentity> }
export interface EntraOptions { tenantId: string; apiClientId: string; spaClientId: string; adminObjectIds: string[] }
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function entraAuthenticator(options: EntraOptions, verificationKey?: JWTVerifyGetKey | CryptoKey): AdminAuthenticator {
  if (![options.tenantId, options.apiClientId, options.spaClientId, ...options.adminObjectIds].every(id => guid.test(id))) throw new Error('Invalid Entra configuration.');
  const issuer = `https://login.microsoftonline.com/${options.tenantId}/v2.0`;
  const remoteKeys = verificationKey ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${options.tenantId}/discovery/v2.0/keys`), { timeoutDuration: 5000 });
  return {
    async authenticate(header) {
      if (!header?.startsWith('Bearer ') || header.length > 16_384) throw new AppError(401, 'Sign in with an administrator account.');
      let payload;
      try {
        const verified = typeof remoteKeys === 'function'
          ? await jwtVerify(header.slice(7), remoteKeys, { issuer, audience: options.apiClientId, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'tid', 'oid', 'scp'], clockTolerance: 5 })
          : await jwtVerify(header.slice(7), remoteKeys, { issuer, audience: options.apiClientId, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'tid', 'oid', 'scp'], clockTolerance: 5 });
        payload = verified.payload;
      } catch { throw new AppError(401, 'The access token is missing, expired, or invalid for this API.'); }
      if (payload.ver !== '2.0' || payload.tid !== options.tenantId || payload.azp !== options.spaClientId
        || typeof payload.oid !== 'string' || !guid.test(payload.oid)
        || typeof payload.scp !== 'string' || !payload.scp.split(' ').includes('access_as_user')) {
        throw new AppError(401, 'This is not an authorized delegated API access token.');
      }
      const hasRole = Array.isArray(payload.roles) && payload.roles.includes('WebPush.Admin');
      if (!hasRole && !options.adminObjectIds.includes(payload.oid)) throw new AppError(403, 'Administrator access is required.');
      return { objectId: payload.oid };
    },
  };
}
