import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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

export function loadEnvironment() {
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const adminToken = process.env.LOCAL_ADMIN_TOKEN;
  if (!publicKey || !privateKey || !adminToken) throw new Error('Local configuration is missing. Run npm run setup first.');
  const port = Number(process.env.API_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('API_PORT must be a port between 1024 and 65535.');
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
  if (new URL(webOrigin).origin !== webOrigin) throw new Error('WEB_ORIGIN must be an origin without a trailing slash or path.');
  return {
    port,
    webOrigin,
    adminToken,
    dataDirectory: resolve(projectRoot, process.env.LOCAL_DATA_DIR ?? '.data'),
    vapid: { publicKey, privateKey, subject: process.env.VAPID_SUBJECT ?? 'mailto:developer@example.com' },
  };
}
