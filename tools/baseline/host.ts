import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { AppError } from '../../packages/core/src/index.js';
import { close, httpServer, listen } from '../../apps/functions/src/http-server.js';
import { authorized, loopbackOrigin, workload } from '../benchmark/model.js';
import { executeRun, type RunResult } from './engine.js';

export interface BaselineJob { id: string; status: 'running' | 'completed' | 'failed'; result?: RunResult; error?: string }
export async function baselineHost(options: { token: string; provider: { origin: string; token: string; delayMs: number } }) {
  loopbackOrigin(options.provider.origin);
  let origin = ''; let current: BaselineJob | undefined; let task: Promise<void> | undefined; let stopping = false;
  const controller = new AbortController();
  const server = httpServer(async request => {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    if (url.origin !== origin || request.headers.has('origin')) return json({ error: 'Local research clients only.' }, 403);
    if (!authorized(request.headers.get('authorization'), options.token)) return json({ error: 'Research authorization required.' }, 401);
    if (url.pathname === '/health' && request.method === 'GET') return json({ mode: 'always-on-local-research', status: 'ready' });
    if (url.pathname === '/runs' && request.method === 'POST') {
      if (stopping || current?.status === 'running') return json({ error: 'Only one bounded research run can execute at a time.' }, 409);
      try {
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError(415, 'Send JSON.');
        const spec = workload(await request.json()); const job: BaselineJob = { id: randomUUID(), status: 'running' }; current = job;
        task = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
          try { job.result = await executeRun(job.id, spec, options.provider, controller.signal); job.status = 'completed'; }
          catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Controlled research run failed.'; }
        });
        return json({ id: job.id, status: job.status }, 202);
      } catch (error) { return json({ error: error instanceof AppError ? error.message : 'Invalid research input.' }, error instanceof AppError ? error.status : 400); }
    }
    if (current && url.pathname === `/runs/${current.id}` && request.method === 'GET') return json(current);
    return json({ error: 'Research route not found.' }, 404);
  });
  await listen(server, 0, '127.0.0.1'); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let stopped: Promise<void> | undefined;
  return { origin, stop: () => stopped ??= (async () => { stopping = true; controller.abort(); await task; await close(server); })() };
}
