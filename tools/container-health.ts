import { loadEnvironment } from './environment.js';

try {
  const config = loadEnvironment();
  const origin = new URL(config.webOrigin);
  const response = await fetch(`http://127.0.0.1:${origin.port}/api/health`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok || (await response.json() as { status?: string }).status !== 'ok') throw new Error();
} catch { process.exitCode = 1; }
