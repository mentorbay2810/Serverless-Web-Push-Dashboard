import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  AppError, DEFAULT_NOTIFICATION, parseNotification, parseSubscription, summarize,
  type PushSender, type SubscriptionStore,
} from '../../../packages/core/src/index.js';

interface Options {
  store: SubscriptionStore;
  sender: PushSender;
  publicKey: string;
  adminToken: string;
  webOrigin: string;
  port: number;
  maxSubscriptions?: number;
  sendsPerMinute?: number;
}

export function tokenHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function authorized(header: string | null, expectedHash: string): boolean {
  if (!header?.startsWith('Bearer ') || header.length > 512) return false;
  const actual = Buffer.from(tokenHash(header.slice(7)), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

class WindowLimit {
  private start = Date.now();
  private count = 0;
  constructor(private readonly maximum: number) {}
  take() {
    if (Date.now() - this.start >= 60_000) { this.start = Date.now(); this.count = 0; }
    if (++this.count > this.maximum) throw new AppError(429, 'Too many requests. Wait a minute before trying again.');
  }
}

export function createApplication(options: Options) {
  const maximum = options.maxSubscriptions ?? 100;
  const origins = new Set([options.webOrigin]);
  const adminHash = tokenHash(options.adminToken);
  const requests = new WindowLimit(240);
  const sends = new WindowLimit(options.sendsPerMinute ?? 5);
  const registrations = new WindowLimit(20);
  const allowedHosts = new Set([`localhost:${options.port}`, `127.0.0.1:${options.port}`]);

  async function body(request: Request): Promise<Record<string, unknown>> {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new AppError(415, 'Send a JSON request.');
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 8192) throw new AppError(413, 'Request is too large.');
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch { throw new AppError(400, 'Invalid JSON request.'); }
  }

  async function send(id: string, input: unknown) {
    const content = parseNotification(input);
    const record = await options.store.get(id);
    if (!record) throw new AppError(404, 'Subscription not found. Connect this browser again.');
    if (record.subscription.expirationTime && record.subscription.expirationTime < Date.now()) {
      await options.store.remove(id);
      throw new AppError(410, 'This subscription expired. Reconnect your browser.');
    }
    sends.take();
    const notificationId = randomUUID();
    try {
      const response = await options.sender.send(record.subscription, {
        ...content, version: 1, notificationId, sentAt: new Date().toISOString(),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) throw { statusCode: response.statusCode };
      await options.store.markAccepted(id, new Date().toISOString());
      return { status: 'accepted', notificationId, providerStatus: response.statusCode };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await options.store.remove(id);
        throw new AppError(410, 'This subscription expired. Reconnect your browser.');
      }
      throw new AppError(502, 'The push service could not accept this notification. Check your network and VAPID contact configuration, then retry.');
    }
  }

  return async function handle(request: Request): Promise<Response> {
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Origin',
    });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
    try {
      const url = new URL(request.url);
      if (!allowedHosts.has(url.host)) throw new AppError(403, 'This local API only accepts loopback hosts.');
      const origin = request.headers.get('origin');
      if (origin && !origins.has(origin)) throw new AppError(403, 'This website origin is not allowed.');
      if (origin) headers.set('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return new Response(null, { status: 204, headers });
      }
      requests.take();
      const path = url.pathname;
      if (request.method === 'GET' && path === '/api/health') return json({ status: 'ok', mode: 'local' });
      if (request.method === 'GET' && path === '/api/config') {
        return json({ vapidPublicKey: options.publicKey, mode: 'local', maxSubscriptions: maximum });
      }
      if (request.method === 'POST' && path === '/api/subscriptions') {
        registrations.take();
        const input = await body(request);
        const subscription = parseSubscription(input.subscription);
        const token = randomBytes(32).toString('base64url');
        const record = { id: randomUUID(), subscription, tokenHash: tokenHash(token), createdAt: new Date().toISOString() };
        await options.store.insert(record, maximum);
        return json({ ...summarize(record), token }, 201);
      }
      if (path.startsWith('/api/local/')) {
        if (!authorized(request.headers.get('authorization'), adminHash)) throw new AppError(401, 'Local CLI authorization is required.');
        if (request.method === 'GET' && path === '/api/local/subscriptions') {
          return json({ subscriptions: (await options.store.list()).map(summarize) });
        }
        if (request.method === 'POST' && path === '/api/local/send-test') {
          const input = await body(request);
          if (typeof input.id !== 'string') throw new AppError(400, 'Choose one subscription ID.');
          return json(await send(input.id, { ...DEFAULT_NOTIFICATION, ...input }));
        }
      }
      const match = /^\/api\/subscriptions\/([a-f0-9-]{36})(\/test)?$/.exec(path);
      if (match?.[1]) {
        const record = await options.store.get(match[1]);
        if (!record) throw new AppError(404, 'Subscription not found. Connect this browser again.');
        if (!authorized(request.headers.get('authorization'), record.tokenHash)) throw new AppError(403, 'This browser does not own that subscription.');
        if (!match[2] && request.method === 'GET') return json(summarize(record));
        if (!match[2] && request.method === 'DELETE') { await options.store.remove(record.id); return json({ status: 'removed' }); }
        if (match[2] && request.method === 'POST') return json(await send(record.id, await body(request)));
      }
      throw new AppError(404, 'Endpoint not found.');
    } catch (error) {
      if (error instanceof AppError) {
        if (error.status === 429) headers.set('Retry-After', '60');
        return json({ error: error.message }, error.status);
      }
      console.error('Local API operation failed. Check the local data directory and configuration.');
      return json({ error: 'The local API could not complete this request.' }, 500);
    }
  };
}
