import { loadEnvironment } from './environment.js';

async function main() {
  const config = loadEnvironment();
  const response = await fetch(`http://127.0.0.1:${config.port}/api/local/session`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.adminToken}` }, signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json() as { url?: string; expiresAt?: string; error?: string };
  if (!response.ok || !result.url) throw new Error(result.error ?? 'Start npm run dev:queued to use the local dashboard.');
  console.log('Open this one-use link within two minutes to start a one-hour local administrator session:');
  console.log(result.url);
  console.log('Keep the link private. Restarting the API revokes all local administrator sessions.');
}
main().catch(error => { console.error(error instanceof TypeError ? 'Cannot reach the local API. Start npm run dev:queued.' : error.message); process.exitCode = 1; });
