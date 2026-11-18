import { loadEnvironment } from '../../../tools/environment.js';
import { runLocalEntry } from './local-runtime.js';

try {
  const runtime = await runLocalEntry(loadEnvironment(), { queued: process.env.LOCAL_PIPELINE_MODE === 'queued', startPaused: process.env.LOCAL_START_PAUSED === 'true' });
  if (runtime) console.log(`Local push API: http://127.0.0.1:${runtime.config.port}`);
} catch (error) { console.error(error instanceof Error ? error.message : 'Local startup failed.'); process.exitCode = 1; }
