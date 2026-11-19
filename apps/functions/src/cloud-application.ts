import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, parseNotification, parseSubscription, summarize, type PublicConfig } from '../../../packages/core/src/index.js';
import type { Campaign, DurableSubscriptionStore, SubscriptionDocument } from '../../../packages/core/src/durable.js';
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
  const campaignSummary = (campaign: Campaign) => ({ id: campaign.id, name: campaign.name ?? campaign.content.title,
    content: campaign.content, audience: campaign.audience ?? { type: 'selected', subscriptionIds: campaign.subscriptionIds },
    state: campaign.state, createdAt: campaign.createdAt, updatedAt: campaign.updatedAt ?? campaign.createdAt,
    scheduledAt: campaign.scheduledAt, recipientCount: campaign.subscriptionIds.length,
    dispatchedCount: campaign.dispatchIndex ?? (campaign.state === 'sending' ? campaign.subscriptionIds.length : 0) });
  function version(request: Request) {
    const header = request.headers.get('if-match');
    if (!header) throw new AppError(428, 'Read the current version and supply its ETag in If-Match.');
    try { const value: unknown = JSON.parse(header); if (typeof value === 'string' && value) return value; } catch { /* Reject malformed preconditions. */ }
    throw new AppError(400, 'Supply the exact ETag returned by this record.');
  }
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
      headers.set('Access-Control-Expose-Headers', 'ETag');
      if (request.method === 'OPTIONS') {
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, If-Match');
        headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        return new Response(null, { status: 204, headers });
      }
      const path = new URL(request.url).pathname.replace(/\/$/, '');
      if (path === '/api/health' && request.method === 'GET') return json({ status: 'ok', mode: options.config.mode }, 200, headers);
      if (path === '/api/config' && request.method === 'GET') return json(options.config, 200, headers);
      const eventMatch = /^\/api\/deliveries\/([a-f0-9]{64})\/events$/.exec(path);
      if (eventMatch?.[1] && request.method === 'POST') {
        return json(await options.pipeline.reports.record(eventMatch[1], request.headers.get('authorization'), await input(request)), 200, headers);
      }
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
        if (path === '/api/admin/operations' && ['GET', 'PATCH'].includes(request.method)) {
          const record = request.method === 'GET' ? await options.pipeline.controls.get()
            : await options.pipeline.controls.set(await input(request), version(request));
          headers.set('ETag', JSON.stringify(record._etag));
          return json({ dispatchPaused: record.dispatchPaused, sendingPaused: record.sendingPaused, updatedAt: record.updatedAt }, 200, headers);
        }
        if (path === '/api/admin/subscriptions' && request.method === 'GET') {
          const url = new URL(request.url);
          const cursor = url.searchParams.get('cursor') ?? undefined;
          if (cursor && cursor.length > 4096) throw new AppError(400, 'Invalid page cursor.');
          const page = await options.subscriptions.database.page<SubscriptionDocument>('subscription', 50, cursor);
          return json({ subscriptions: page.items.map(summarize), cursor: page.cursor }, 200, headers);
        }
        const subscriberMatch = /^\/api\/admin\/subscriptions\/([a-f0-9]{64})(\/tags)?$/.exec(path);
        if (subscriberMatch?.[1]) {
          const id = subscriberMatch[1];
          if (!subscriberMatch[2] && request.method === 'GET') {
            const record = await options.subscriptions.database.read<SubscriptionDocument>(id);
            if (!record || record.kind !== 'subscription') throw new AppError(404, 'Subscription not found.');
            headers.set('ETag', JSON.stringify(record._etag));
            return json(summarize(record), 200, headers);
          }
          if (subscriberMatch[2] && request.method === 'PATCH') {
            const data = await input(request);
            const record = await options.pipeline.campaigns.setTags(id, data.tags, version(request));
            if (!record) throw new AppError(404, 'Subscription was removed.');
            headers.set('ETag', JSON.stringify(record._etag));
            return json(summarize(record), 200, headers);
          }
        }
        if (path === '/api/admin/segments/preview' && request.method === 'POST') {
          const data = await input(request);
          return json(await options.pipeline.campaigns.preview(data.audience), 200, headers);
        }
        if (path === '/api/admin/campaigns' && request.method === 'POST') {
          const campaign = await options.pipeline.campaigns.create(admin.objectId, request.headers.get('idempotency-key') ?? '', await input(request));
          headers.set('ETag', JSON.stringify(campaign._etag));
          return json(campaignSummary(campaign), 201, headers);
        }
        if (path === '/api/admin/campaigns' && request.method === 'GET') {
          const url = new URL(request.url);
          const cursor = url.searchParams.get('cursor') ?? undefined;
          const state = url.searchParams.get('state');
          if (cursor && cursor.length > 4096) throw new AppError(400, 'Invalid page cursor.');
          if (state && !['draft', 'scheduled', 'pending', 'queued', 'dispatching', 'sending', 'completed', 'completed_with_failures', 'cancelled', 'failed'].includes(state)) throw new AppError(400, 'Invalid campaign state.');
          const page = await options.subscriptions.database.page<Campaign>('campaign', 25, cursor, state ? [state] : undefined);
          return json({ campaigns: page.items.map(campaignSummary), cursor: page.cursor }, 200, headers);
        }
        if (path === '/api/admin/campaigns/test' && request.method === 'POST') {
          const data = await input(request);
          if (!Array.isArray(data.subscriptionIds) || data.subscriptionIds.some(id => typeof id !== 'string')) throw new AppError(400, 'Select the subscriptions to test.');
          const result = await options.pipeline.submit(admin.objectId, request.headers.get('idempotency-key') ?? '', data, data.subscriptionIds as string[]);
          return json(result, 202, headers);
        }
        const campaignMatch = /^\/api\/admin\/campaigns\/([a-f0-9]{64})(?:\/(preview|send|schedule|cancel))?$/.exec(path);
        if (campaignMatch?.[1] && request.method === 'GET') {
          if (campaignMatch[2]) throw new AppError(404, 'Endpoint not found.');
          const campaign = await options.pipeline.campaigns.get(campaignMatch[1]);
          headers.set('ETag', JSON.stringify(campaign._etag));
          return json({ ...campaignSummary(campaign), ...await options.pipeline.reports.campaign(campaign) }, 200, headers);
        }
        if (campaignMatch?.[1]) {
          const id = campaignMatch[1];
          const action = campaignMatch[2];
          let campaign: Campaign | undefined;
          if (!action && request.method === 'PATCH') campaign = await options.pipeline.campaigns.update(id, await input(request), version(request));
          else if (!action && request.method === 'DELETE') {
            await options.pipeline.campaigns.remove(id, version(request));
            return new Response(null, { status: 204, headers });
          } else if (request.method === 'POST') {
            if (action === 'preview') {
              const saved = await options.pipeline.campaigns.get(id);
              headers.set('ETag', JSON.stringify(saved._etag));
              return json(saved.state === 'draft' ? { ...await options.pipeline.campaigns.preview(saved.audience), snapshot: false }
                : { count: saved.subscriptionIds.length, subscriptionIds: saved.subscriptionIds, audience: saved.audience, snapshot: true }, 200, headers);
            }
            if (action === 'cancel') campaign = await options.pipeline.campaigns.cancel(id);
            else if (action === 'send' || action === 'schedule') {
              const data = request.headers.get('content-type')?.startsWith('application/json') ? await input(request) : {};
              if (action === 'schedule' && data.scheduledAt === undefined) throw new AppError(400, 'Provide scheduledAt with an explicit timezone.');
              if (data.fingerprint !== undefined && (typeof data.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(data.fingerprint))) throw new AppError(400, 'Invalid audience preview fingerprint.');
              campaign = await options.pipeline.activate(id, request.headers.get('idempotency-key') ?? '', action === 'schedule' ? data.scheduledAt : undefined,
                { fingerprint: data.fingerprint as string | undefined, version: request.headers.has('if-match') ? version(request) : undefined });
            }
          }
          if (campaign) {
            headers.set('ETag', JSON.stringify(campaign._etag));
            return json(campaignSummary(campaign), action === 'send' || action === 'schedule' ? 202 : 200, headers);
          }
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
