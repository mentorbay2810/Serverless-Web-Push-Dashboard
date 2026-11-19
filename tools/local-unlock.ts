import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { unlockStaleLocalLock } from '../packages/adapters/src/local-lock.js';
import { envPath, projectRoot } from './environment.js';

try {
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const directory = resolve(projectRoot, process.env.LOCAL_DATA_DIR || '.data');
  for (const path of [join(projectRoot, '.env.setup.lock'), join(directory, 'backend.lock')]) {
    const removed = await unlockStaleLocalLock(path);
    console.log(removed ? 'Removed a verified stale local process lock.' : 'No stale lock at this location.');
  }
  console.log('Subscription, campaign, queue, and environment files were preserved.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Unlock could not complete.'); process.exitCode = 1; }
