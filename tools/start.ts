import { join } from 'node:path';
import { runLocalEntry } from '../apps/functions/src/local-runtime.js';
import { loadEnvironment, projectRoot } from './environment.js';

try {
  const runtime = await runLocalEntry(loadEnvironment(), { frontendDirectory: join(projectRoot, 'apps/dashboard/dist'), startPaused: process.argv.includes('--paused') });
  if (runtime) {
    console.log(`Built dashboard: ${runtime.config.webOrigin}`);
    console.log(`Local API: http://127.0.0.1:${runtime.config.port}`);
    console.log('Run npm run admin:login in another terminal. Cloud deployment remains off.');
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'Built application startup failed.'); process.exitCode = 1; }
