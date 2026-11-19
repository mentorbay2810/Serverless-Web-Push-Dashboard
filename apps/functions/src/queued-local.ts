import { join } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { FileDocumentDatabase } from '../../../packages/adapters/src/file-database.js';
import { LocalQueuePublisher } from '../../../packages/adapters/src/local-queue.js';
import { WebPushSender } from '../../../packages/adapters/src/web-push-sender.js';
import { DurableSubscriptionStore } from '../../../packages/core/src/durable.js';
import { DeliveryPipeline } from '../../../packages/core/src/pipeline.js';
import { AppError, DEFAULT_NOTIFICATION, summarize } from '../../../packages/core/src/index.js';
import { cloudApplication } from './cloud-application.js';
import type { loadEnvironment } from '../../../tools/environment.js';

export function queuedLocal(config: ReturnType<typeof loadEnvironment>) {
  const database = new FileDocumentDatabase(join(config.dataDirectory, 'phase2-documents.json'));
  const queue = new LocalQueuePublisher(new FileDocumentDatabase(join(config.dataDirectory, 'phase2-queues.json')));
  const subscriptions = new DurableSubscriptionStore(database, 'local');
  const pipeline = new DeliveryPipeline({ database, queue, subscriptions, siteId: 'local', dailyAttemptLimit: 1000, sender: new WebPushSender(config.vapid) });
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const localAuthorized = (header: string | null) => !!header?.startsWith('Bearer ')
    && timingSafeEqual(digest(header.slice(7)), digest(config.adminToken));
  const publicApi = cloudApplication({ subscriptions, pipeline, webOrigin: config.webOrigin,
    config: { mode: 'local', vapidPublicKey: config.vapid.publicKey, maxSubscriptions: 100 },
    auth: { async authenticate() { throw new AppError(401, 'Entra administrator access is not configured in this local profile.'); } },
  });
  // This handler is reachable only through the host, origin, and CLI-token checks below.
  const managementApi = cloudApplication({ subscriptions, pipeline, webOrigin: config.webOrigin,
    config: { mode: 'local', vapidPublicKey: config.vapid.publicKey, maxSubscriptions: 100 },
    auth: { async authenticate(header) {
      if (!localAuthorized(header)) throw new AppError(401, 'Local CLI authorization is required.');
      return { objectId: 'local-cli' };
    } },
  });
  let working = false;
  let stopping = false;
  const timer = setInterval(async () => {
    if (working || stopping) return;
    working = true;
    try { await queue.consume('campaign', id => pipeline.fanOut(id)); await queue.consume('delivery', id => pipeline.deliver(id)); }
    catch { console.error('Queued local processing will retry. Check local data and configuration.'); }
    finally { working = false; }
  }, 150);
  const recovery = setInterval(() => { if (!stopping) void pipeline.reconcile().catch(() => console.error('Local recovery will retry.')); }, 60_000);
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  const handle = async (request: Request) => {
    const url = new URL(request.url);
    if (![ `localhost:${config.port}`, `127.0.0.1:${config.port}` ].includes(url.host)
      || (request.headers.has('origin') && request.headers.get('origin') !== config.webOrigin)) return json({ error: 'Only the configured local origin is allowed.' }, 403);
    if (!url.pathname.startsWith('/api/local/')) return publicApi(request);
    if (!localAuthorized(request.headers.get('authorization'))) return json({ error: 'Local CLI authorization is required.' }, 401);
    if (url.pathname.startsWith('/api/local/manage/')) {
      url.pathname = url.pathname.replace('/api/local/manage/', '/api/admin/');
      return managementApi(new Request(url, request));
    }
    if (url.pathname === '/api/local/subscriptions' && request.method === 'GET') return json({ subscriptions: (await subscriptions.list()).map(summarize) });
    if (url.pathname === '/api/local/send-test' && request.method === 'POST') {
      try {
        const input = await request.json() as Record<string, unknown>;
        const result = await pipeline.submit('local-cli', randomUUID(), { ...DEFAULT_NOTIFICATION, ...input }, typeof input.id === 'string' ? [input.id] : []);
        return json({ status: 'queued', campaignId: result.id }, 202);
      } catch (error) { return json({ error: error instanceof AppError ? error.message : 'Invalid request.' }, error instanceof AppError ? error.status : 400); }
    }
    return json({ error: 'Endpoint not found.' }, 404);
  };
  return { handle, stop() { stopping = true; clearInterval(timer); clearInterval(recovery); } };
}
