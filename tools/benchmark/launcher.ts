import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loopbackOrigin } from './model.js';

export async function launchBaseline(root: string, provider: { origin: string; token: string; delayMs: number }) {
  loopbackOrigin(provider.origin);
  const entry = join(root, 'dist/tools/baseline/server.js');
  await access(entry).catch(() => { throw new Error('Build the benchmark tools with npm run build first.'); });
  const token = randomBytes(32).toString('base64url'); const start = performance.now();
  // Deliberately omit application credentials, NODE_OPTIONS, and cloud identity settings.
  const child = fork(entry, [], { cwd: root, execArgv: [], env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test',
    BENCHMARK_API_TOKEN: token, BENCHMARK_PROVIDER_TOKEN: provider.token, BENCHMARK_PROVIDER_ORIGIN: provider.origin, BENCHMARK_DELAY_MS: String(provider.delayMs) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout?.resume(); child.stderr?.resume(); const exited = once(child, 'exit');
  let timer: ReturnType<typeof setTimeout>;
  try {
    const message = await Promise.race([
      once(child, 'message').then(([value]) => value as { type?: string; origin?: string }),
      exited.then(() => { throw new Error('Isolated baseline exited before readiness.'); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Isolated baseline startup timed out.')), 10000); }),
    ]).finally(() => clearTimeout(timer!));
    if (message.type !== 'ready' || !message.origin) throw new Error('Invalid baseline readiness message.');
    const origin = loopbackOrigin(message.origin); const startupMs = performance.now() - start;
    const stop = async () => {
      if (child.connected) child.send({ type: 'stop' });
      const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 6000); timeout.unref();
      await exited; clearTimeout(timeout);
    };
    return { origin, token, startupMs, stop };
  } catch (error) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; throw error; }
}
