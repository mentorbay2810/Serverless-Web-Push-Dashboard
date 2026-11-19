import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { MemoryDocumentDatabase } from '../packages/adapters/src/memory-database.js';
import { DurableSubscriptionStore } from '../packages/core/src/durable.js';
import { DeliveryPipeline } from '../packages/core/src/pipeline.js';
import { cloudApplication } from '../apps/functions/src/cloud-application.js';
import { AppError, DEFAULT_NOTIFICATION } from '../packages/core/src/index.js';

function harness() {
  const database = new MemoryDocumentDatabase();
  const subscriptions = new DurableSubscriptionStore(database, 'test');
  const campaigns: string[] = [];
  const pipeline = new DeliveryPipeline({ database, subscriptions, siteId: 'test', dailyAttemptLimit: 1000,
    queue: { async campaign(id) { campaigns.push(id); }, async delivery() {} }, sender: { async send() { return { statusCode: 201 }; } } });
  const handle = cloudApplication({ subscriptions, pipeline, webOrigin: 'http://localhost:5173',
    config: { mode: 'azure', vapidPublicKey: 'public-only', maxSubscriptions: 100 },
    auth: { async authenticate(header) {
      if (header !== 'Bearer test-administrator') throw new AppError(401, 'Sign in first.');
      return { objectId: 'verified-user' };
    } },
  });
  const request = (path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) => handle(new Request(`https://example.azurewebsites.net${path}`, {
    method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  async function register() {
    const curve = createECDH('prime256v1'); curve.generateKeys();
    const result = await request('/api/subscriptions', { subscription: { endpoint: 'https://fcm.googleapis.com/wp/test', keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } } });
    assert.equal(result.status, 201); return await result.json() as { id: string; token: string };
  }
  return { request, register, campaigns };
}

test('cloud administrator routes reject unauthenticated work before queue publication', async () => {
  const h = harness();
  const denied = await h.request('/api/admin/campaigns/test', { ...DEFAULT_NOTIFICATION, subscriptionIds: [] });
  assert.equal(denied.status, 401); assert.equal(h.campaigns.length, 0);
  assert.equal((await h.request('/api/local/subscriptions', undefined, 'test-administrator')).status, 404);
});
test('cloud subscriber tests are queued and ownership is required', async () => {
  const h = harness(); const owner = await h.register();
  assert.equal((await h.request(`/api/subscriptions/${owner.id}/test`, DEFAULT_NOTIFICATION, 'someone-else')).status, 403);
  const queued = await h.request(`/api/subscriptions/${owner.id}/test`, DEFAULT_NOTIFICATION, owner.token);
  assert.equal(queued.status, 202); const body = await queued.json(); assert.equal(body.status, 'queued');
  assert.equal(typeof body.notificationId, 'string'); assert.equal(h.campaigns.length, 1);
});
test('administrator can submit idempotent campaigns; origins and public data stay restricted', async () => {
  const h = harness(); const owner = await h.register();
  const payload = { ...DEFAULT_NOTIFICATION, subscriptionIds: [owner.id] };
  const headers = { 'Idempotency-Key': 'campaign-request-123' };
  assert.equal((await h.request('/api/admin/campaigns/test', payload, 'test-administrator', headers)).status, 202);
  assert.equal((await h.request('/api/admin/campaigns/test', payload, 'test-administrator', headers)).status, 202);
  assert.equal(h.campaigns.length, 1);
  assert.equal((await h.request('/api/config', undefined, undefined, { Origin: 'https://another.example' })).status, 403);
  const rows = await (await h.request('/api/admin/subscriptions', undefined, 'test-administrator')).json();
  assert.ok(!JSON.stringify(rows).includes(owner.token));
  assert.ok(!JSON.stringify(rows).includes('p256dh'));
});
