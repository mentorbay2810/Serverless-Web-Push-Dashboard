import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { acquireLocalLock } from '../../../packages/adapters/src/local-lock.js';
import { FileDocumentDatabase } from '../../../packages/adapters/src/file-database.js';
import { FileSubscriptionStore } from '../../../packages/adapters/src/file-store.js';
import { WebPushSender } from '../../../packages/adapters/src/web-push-sender.js';
import type { PushSender } from '../../../packages/core/src/index.js';
import { DeliveryControls } from '../../../packages/core/src/operations.js';
import type { loadEnvironment } from '../../../tools/environment.js';
import { createApplication } from './application.js';
import { queuedLocal } from './queued-local.js';
import { close, httpServer, listen, type Handler } from './http-server.js';
import { staticFrontend } from './static-frontend.js';

type Config = ReturnType<typeof loadEnvironment>;
export interface LocalRuntimeOptions { queued?: boolean; frontendDirectory?: string; sender?: PushSender; startPaused?: boolean }
export async function startLocalRuntime(config: Config, options: LocalRuntimeOptions = {}) {
  if (options.frontendDirectory) await access(join(options.frontendDirectory, 'index.html')).catch(() => { throw new Error('The dashboard build is missing. Run npm run build first.'); });
  const release = await acquireLocalLock(join(config.dataDirectory, 'backend.lock'));
  let api: Handler = async () => Response.json({ error: 'The service is starting.' }, { status: 503 });
  let frontend: Handler = api;
  let queued: ReturnType<typeof queuedLocal> | undefined;
  const backend = httpServer(request => api(request));
  const web = options.frontendDirectory ? httpServer(request => frontend(request)) : undefined;
  const servers = web ? [backend, web] : [backend];
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    const worker = queued?.stop();
    await Promise.all([...servers.map(close), worker]); await release();
  })();
  try {
    if (options.startPaused) {
      if (options.queued === false) throw new Error('Paused startup requires the queued profile.');
      // The data lock is held and no worker exists yet, so restored work cannot race this write.
      const controls = new DeliveryControls(new FileDocumentDatabase(join(config.dataDirectory, 'phase2-documents.json')), 'local', () => new Date());
      const current = await controls.get(); await controls.set({ dispatchPaused: true, sendingPaused: true }, current._etag!);
    }
    const origin = new URL(config.webOrigin);
    const starts = await Promise.allSettled([listen(backend, config.port, '127.0.0.1'), ...(web ? [listen(web, Number(origin.port), origin.hostname)] : [])]);
    if (starts.some(result => result.status === 'rejected')) throw new Error('A local port could not be opened. Stop the other service or choose different API_PORT and WEB_ORIGIN ports.');
    const current: Config = { ...config, port: (backend.address() as AddressInfo).port };
    if (web) { origin.port = String((web.address() as AddressInfo).port); current.webOrigin = origin.origin; }
    const sender = options.sender ?? new WebPushSender(current.vapid);
    queued = options.queued === false ? undefined : queuedLocal(current, { sender });
    api = queued?.handle ?? createApplication({ ...current, publicKey: current.vapid.publicKey, store: new FileSubscriptionStore(current.dataDirectory), sender });
    if (options.frontendDirectory) frontend = staticFrontend(options.frontendDirectory, current.webOrigin, `http://127.0.0.1:${current.port}`, api);
    for (const server of servers) server.on('error', () => { process.exitCode = 1; void stop(); });
    return { config: current, stop };
  } catch (error) { await stop(); throw error; }
}

/** Keep handlers installed through cleanup: npm can forward a second stop signal. */
export async function runLocalEntry(config: Config, options: LocalRuntimeOptions) {
  let runtime: Awaited<ReturnType<typeof startLocalRuntime>> | undefined;
  let requested = false;
  const shutdown = () => {
    requested = true;
    void runtime?.stop().catch(() => { console.error('Local shutdown could not finish. Inspect ownership before restarting.'); process.exitCode = 1; });
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
  try {
    runtime = await startLocalRuntime(config, options);
    if (requested) { await runtime.stop(); return undefined; }
    return runtime;
  } catch (error) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, shutdown);
    throw error;
  }
}
