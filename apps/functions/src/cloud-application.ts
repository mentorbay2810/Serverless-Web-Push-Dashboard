import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, parseNotification, parseSubscription, summarize, type PublicConfig } from '../../../packages/core/src/index.js';
import type { Campaign, Delivery, DurableSubscriptionStore, SubscriptionDocument } from '../../../packages/core/src/durable.js';
import { DeliveryPipeline, subscriptionId } from '../../../packages/core/src/pipeline.js';
import type { AdminAuthenticator } from '../../../packages/adapters/src/entra.js';

export interface CloudApplicationOptions {
  subscriptions: DurableSubscriptionStore;
  pipeline: DeliveryPipeline;
  auth: AdminAuthenticator;
  webOrigin: string;
  config: PublicConfig;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function cloudApplication(options: CloudApplicationOptions) {
  const json = (value: unknown, status: number, headers: Headers) => new Response(JSON.stringify(value), { status, headers });
  async function input(request: Request) {
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError(415, 'Send JSON content.');
    const text = await request.text();
    if (Buffer.byteLength(text) > 8192) throw new AppError(413, 'Request is too large.');
    try { const data: unknown = JSON.parse(text); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data as Record<string, unknown>; }
    catch { throw new AppError(400, 'Invalid JSON request.'); }
  }
  async function owned(request: Request, id: string) {
    const record = await options.subscriptions.get(id);
    if (!record) throw new AppError(404, 'Subscription not found. Reconnect this browser.');
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ') || header.length > 512) throw new AppError(403, 'Subscription ownership is required.');
    if (!timingSafeEqual(Buffer.from(hash(header.slice(7)), 'hex'), Buffer.from(record.tokenHash, 'hex'))) throw new AppError(403, 'Subscription ownership is required.');
    return record;
  }
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== options.webOrigin) throw new AppError(403, 'This website origin is not allowed.');
      if (origin) headers.set('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
        headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        return new Response(null, { status: 204, headers });
      }
      const path = new URL(request.url).pathname.replace(/\/$/, '');
      if (path === '/api/health' && request.method === 'GET') return json({ status: 'ok', mode: options.config.mode }, 200, headers);
      if (path === '/api/config' && request.method === 'GET') return json(options.config, 200, headers);
      if (path === '/api/subscriptions' && request.method === 'POST') {
        const data = await input(request);
        const subscription = parseSubscription(data.subscription);
        const token = randomBytes(32).toString('base64url');
        const record = { id: subscriptionId(subscription.endpoint), subscription, tokenHash: hash(token), createdAt: new Date().toISOString() };
        await options.subscriptions.insert(record, options.config.maxSubscriptions);
        return json({ ...summarize(record), token }, 201, headers);
      }
      if (path.startsWith('/api/admin/')) {
        // Validate the signed API access token before reading data or publishing work.
        const admin = await options.auth.authenticate(request.headers.get('authorization'));
        if (path === '/api/admin/me' && request.method === 'GET') return json({ role: 'administrator' }, 200, headers);
        if (path === '/api/admin/subscriptions' && request.method === 'GET') {
          const url = new URL(request.url);
          const cursor = url.searchParams.get('cursor') ?? undefined;
          if (cursor && cursor.length > 4096) throw new AppError(400, 'Invalid page cursor.');
          const page = await options.subscriptions.database.page<SubscriptionDocument>('subscription', 50, cursor);
          return json({ subscriptions: page.items.map(summarize), cursor: page.cursor }, 200, headers);
        }
        if (path === '/api/admin/campaigns/test' && request.method === 'POST') {
          const data = await input(request);
          if (!Array.isArray(data.subscriptionIds) || data.subscriptionIds.some(id => typeof id !== 'string')) throw new AppError(400, 'Select the subscriptions to test.');
          const result = await options.pipeline.submit(admin.objectId, request.headers.get('idempotency-key') ?? '', data, data.subscriptionIds as string[]);
          return json(result, 202, headers);
        }
        const campaignMatch = /^\/api\/admin\/campaigns\/([a-f0-9]{64})$/.exec(path);
        if (campaignMatch?.[1] && request.method === 'GET') {
          const campaign = await options.subscriptions.database.read<Campaign>(campaignMatch[1]);
          if (!campaign || campaign.kind !== 'campaign') throw new AppError(404, 'Campaign not found.');
          // Small Phase 2 target sets allow bounded point reads rather than an unbounded scan.
          const deliveries = await Promise.all(campaign.subscriptionIds.map(id => options.subscriptions.database.read<Delivery>(hash(`delivery:${campaign.id}:${id}`))));
          const counts: Record<string, number> = {};
          for (const delivery of deliveries) counts[delivery?.state ?? 'not_dispatched'] = (counts[delivery?.state ?? 'not_dispatched'] ?? 0) + 1;
          return json({ id: campaign.id, state: campaign.state, counts }, 200, headers);
        }
      }
      const match = /^\/api\/subscriptions\/([a-f0-9]{64})(\/test)?$/.exec(path);
      if (match?.[1]) {
        const record = await owned(request, match[1]);
        if (!match[2] && request.method === 'GET') return json(summarize(record), 200, headers);
        if (!match[2] && request.method === 'DELETE') { await options.subscriptions.remove(record.id); return json({ status: 'removed' }, 200, headers); }
        if (match[2] && request.method === 'POST') {
          const content = parseNotification(await input(request));
          const result = await options.pipeline.submit(`subscriber:${record.id}`, randomUUID(), content, [record.id]);
          return json({ status: 'queued', campaignId: result.id, notificationId: hash(`delivery:${result.id}:${record.id}`) }, 202, headers);
        }
      }
      throw new AppError(404, 'Endpoint not found.');
    } catch (error) {
      if (error instanceof AppError) {
        if (error.status === 401) headers.set('WWW-Authenticate', 'Bearer');
        if (error.status === 429) headers.set('Retry-After', '60');
        return json({ error: error.message }, error.status, headers);
      }
      // SDK exceptions can include endpoint credentials; never serialize or log them here.
      return json({ error: 'The service could not complete this request. Retry shortly.' }, 503, headers);
    }
  };
}
