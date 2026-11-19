import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { httpServer, listen, close } from '../../apps/functions/src/http-server.js';
import { AppError } from '../../packages/core/src/index.js';
import { authorized, integer } from './model.js';

export interface MockRequest { runId: string; deliveryId: string; recipientId: string; attempt: number }
export async function mockProvider(options: { token: string; delayMs: number; respond?: (request: MockRequest) => { status: number; headers?: Record<string, string> } }) {
  integer(options.delayMs, 'mock delay', 0, 25);
  const records: (MockRequest & { status: number; processingMs: number })[] = [];
  let origin = '';
  const server = httpServer(async request => {
    const url = new URL(request.url);
    if (url.origin !== origin || request.headers.has('origin')) return Response.json({ error: 'Local research clients only.' }, { status: 403 });
    if (!authorized(request.headers.get('authorization'), options.token)) return Response.json({ error: 'Research authorization required.' }, { status: 401 });
    if (url.pathname !== '/push' || request.method !== 'POST') return Response.json({ error: 'Unknown research route.' }, { status: 404 });
    try {
      const data = await request.json() as MockRequest;
      if (!data || typeof data.runId !== 'string' || !/^[\w-]{8,80}$/.test(data.runId) || !/^[a-f0-9]{64}$/.test(data.deliveryId)
        || !/^[a-f0-9]{64}$/.test(data.recipientId)) throw new AppError(400, 'Invalid synthetic push record.');
      integer(data.attempt, 'attempt', 1, 5);
      if (records.length >= 30000) throw new AppError(429, 'The bounded mock record limit was reached.');
      const started = performance.now();
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      const result = options.respond?.(data) ?? { status: 201 };
      records.push({ runId: data.runId, deliveryId: data.deliveryId, recipientId: data.recipientId, attempt: data.attempt, status: result.status, processingMs: performance.now() - started });
      return Response.json({ synthetic: true }, { status: result.status, headers: result.headers });
    } catch (error) { return Response.json({ error: 'Synthetic request rejected.' }, { status: error instanceof AppError ? error.status : 400 }); }
  });
  await listen(server, 0, '127.0.0.1'); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, records, stop: () => close(server) };
}
