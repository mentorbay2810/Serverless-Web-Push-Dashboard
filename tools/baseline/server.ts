import { baselineHost } from './host.js';
import { integer, loopbackOrigin } from '../benchmark/model.js';

try {
  if (['LOCAL_ADMIN_TOKEN', 'VAPID_PRIVATE_KEY', 'AZURE_CLIENT_SECRET'].some(name => process.env[name])) throw new Error('Research host must not inherit application or cloud credentials. Use the benchmark launcher.');
  const token = process.env.BENCHMARK_API_TOKEN ?? ''; const providerToken = process.env.BENCHMARK_PROVIDER_TOKEN ?? '';
  if (![token, providerToken].every(value => /^[\w-]{43}$/.test(value))) throw new Error('Use the benchmark launcher to supply separate research credentials.');
  const host = await baselineHost({ token, provider: { token: providerToken, origin: loopbackOrigin(process.env.BENCHMARK_PROVIDER_ORIGIN ?? ''),
    delayMs: integer(Number(process.env.BENCHMARK_DELAY_MS), 'mock delay', 0, 25) } });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await host.stop(); if (process.connected) process.disconnect(); };
  process.on('message', message => { if ((message as { type?: string })?.type === 'stop') void stop(); });
  process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
  if (process.send) process.send({ type: 'ready', origin: host.origin });
  else console.log(`Local research baseline: ${host.origin}. Credentials are supplied through its launcher.`);
} catch { console.error('The isolated baseline host could not start. Check the research launcher settings.'); process.exitCode = 1; }
