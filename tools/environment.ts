import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createECDH, timingSafeEqual } from 'node:crypto';

function findProjectRoot() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, '.env.example')) && existsSync(join(directory, 'package.json'))) return directory;
    directory = dirname(directory);
  }
  throw new Error('Cannot locate the project root. Run this command from the project checkout.');
}
export const projectRoot = findProjectRoot();
export const envPath = resolve(projectRoot, '.env');

export function parseLocalEnvironment(values: Record<string, string | undefined>, root = projectRoot) {
  const publicKey = values.VAPID_PUBLIC_KEY;
  const privateKey = values.VAPID_PRIVATE_KEY;
  const adminToken = values.LOCAL_ADMIN_TOKEN;
  if (!publicKey || !privateKey || !adminToken) throw new Error('Local configuration is missing. Run npm run setup first.');
  try {
    if (!/^[\w-]{87}$/.test(publicKey) || !/^[\w-]{43}$/.test(privateKey)) throw new Error();
    const curve = createECDH('prime256v1'); curve.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    const expected = curve.getPublicKey(); const supplied = Buffer.from(publicKey, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
  } catch { throw new Error('The VAPID keys are malformed or do not form a matching pair. Restore the original pair; do not regenerate keys for existing subscribers.'); }
  if (!/^[\w-]{43,128}$/.test(adminToken)) throw new Error('LOCAL_ADMIN_TOKEN must contain at least 43 URL-safe random characters. Run setup for a missing token.');
  const port = Number(values.API_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('API_PORT must be a port between 1024 and 65535.');
  const webOrigin = values.WEB_ORIGIN ?? 'http://localhost:5173';
  let web: URL;
  try {
    web = new URL(webOrigin);
    if (web.origin !== webOrigin || web.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(web.hostname)
      || Number(web.port) < 1024 || Number(web.port) > 65535 || !web.port || Number(web.port) === port) throw new Error();
  } catch { throw new Error('WEB_ORIGIN must be an HTTP localhost or 127.0.0.1 origin with a port from 1024–65535 different from API_PORT.'); }
  const directory = values.LOCAL_DATA_DIR ?? '.data';
  if (!directory.trim()) throw new Error('LOCAL_DATA_DIR must point to a private directory.');
  const dataDirectory = resolve(root, directory);
  const privateRoot = resolve(root, '.data');
  if ((dataDirectory === root || dataDirectory.startsWith(`${root}/`)) && dataDirectory !== privateRoot && !dataDirectory.startsWith(`${privateRoot}/`)) {
    throw new Error('Keep project-local data inside the ignored .data directory, or choose a private directory outside the checkout.');
  }
  const subject = values.VAPID_SUBJECT ?? 'mailto:developer@example.com';
  if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto contact address.');
  return {
    port,
    webOrigin,
    adminToken,
    dataDirectory,
    vapid: { publicKey, privateKey, subject },
  };
}
export function loadEnvironment() {
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  return parseLocalEnvironment(process.env);
}
