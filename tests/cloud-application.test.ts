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
  return { request, register, campaigns, handle, database };
}

test('cloud administrator routes reject unauthenticated work before queue publication', async () => {
  const h = harness();
  const denied = await h.request('/api/admin/campaigns/test', { ...DEFAULT_NOTIFICATION, subscriptionIds: [] });
  assert.equal(denied.status, 401); assert.equal(h.campaigns.length, 0);
  assert.equal((await h.request('/api/local/subscriptions', undefined, 'test-administrator')).status, 404);
});

test('campaign API supports drafts, versioned edits, previews, send, and cancellation', async () => {
  const h = harness(); const owner = await h.register();
  const api = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => h.handle(new Request(`https://example.azurewebsites.net/api/admin/${path}`, {
    method, headers: { Authorization: 'Bearer test-administrator', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  const draft = { name: 'API campaign', content: DEFAULT_NOTIFICATION, audience: { type: 'selected', subscriptionIds: [owner.id] } };
  const created = await api('campaigns', 'POST', draft, { 'Idempotency-Key': 'api-draft-1234' });
  assert.equal(created.status, 201); assert.ok(created.headers.get('etag'));
  const campaign = await created.json() as { id: string; state: string };
  assert.equal(campaign.state, 'draft'); assert.equal(h.campaigns.length, 0);
  assert.equal((await api(`campaigns/${campaign.id}`, 'PATCH', draft)).status, 428);
  const edited = await api(`campaigns/${campaign.id}`, 'PATCH', { ...draft, name: 'Edited' }, { 'If-Match': created.headers.get('etag')! });
  assert.equal(edited.status, 200);
  assert.equal((await api(`campaigns/${campaign.id}`, 'PATCH', draft, { 'If-Match': created.headers.get('etag')! })).status, 412);
  const preview = await api(`campaigns/${campaign.id}/preview`, 'POST', {});
  assert.equal((await preview.json()).count, 1);
  assert.equal((await api(`campaigns/${campaign.id}/send`, 'POST', {}, { 'Idempotency-Key': 'api-send-1234' })).status, 202);
  assert.equal((await api(`campaigns/${campaign.id}/send`, 'POST', {}, { 'Idempotency-Key': 'api-send-1234' })).status, 202);
  assert.equal(h.campaigns.length, 1);
  assert.equal((await api(`campaigns/${campaign.id}/cancel`, 'POST', {})).status, 200);
  const state = await (await api(`campaigns/${campaign.id}`)).json();
  assert.equal(state.state, 'cancelled'); assert.equal(state.counts.cancelled, 1);
  const listed = await (await api('campaigns?state=cancelled')).json(); assert.equal(listed.campaigns.length, 1);
  assert.equal((await api('campaigns?state=unknown')).status, 400);
  const removable = await api('campaigns', 'POST', draft, { 'Idempotency-Key': 'api-delete-1234' });
  const removableBody = await removable.json() as { id: string };
  assert.equal((await api(`campaigns/${removableBody.id}`, 'DELETE', undefined, { 'If-Match': removable.headers.get('etag')! })).status, 204);
});

test('administrator tags and schedules require authorization and retain safe response data', async () => {
  const h = harness(); const owner = await h.register();
  const api = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => h.handle(new Request(`https://example.azurewebsites.net/api/admin/${path}`, {
    method, headers: { Authorization: 'Bearer test-administrator', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  const subscriber = await api(`subscriptions/${owner.id}`, 'GET');
  const tags = await api(`subscriptions/${owner.id}/tags`, 'PATCH', { tags: ['Demo'] }, { 'If-Match': subscriber.headers.get('etag')! });
  assert.equal(tags.status, 200); const safe = await tags.text();
  assert.deepEqual(JSON.parse(safe).tags, ['demo']);
  for (const secret of [owner.token, 'tokenHash', 'p256dh', 'endpoint']) assert.ok(!safe.includes(secret));
  const draft = { content: DEFAULT_NOTIFICATION, audience: { type: 'tags', tags: ['demo'] } };
  assert.equal((await (await api('segments/preview', 'POST', { audience: draft.audience })).json()).count, 1);
  const campaign = await (await api('campaigns', 'POST', draft, { 'Idempotency-Key': 'schedule-api-123' })).json() as { id: string };
  assert.equal((await api(`campaigns/${campaign.id}/schedule`, 'POST', {}, { 'Idempotency-Key': 'schedule-key-123' })).status, 400);
  const scheduled = await api(`campaigns/${campaign.id}/schedule`, 'POST', { scheduledAt: new Date(Date.now() + 60_000).toISOString() }, { 'Idempotency-Key': 'schedule-key-123' });
  assert.equal(scheduled.status, 202); assert.equal(h.campaigns.length, 0);
  for (const [path, method, body] of [
    ['campaigns', 'POST', draft], [`subscriptions/${owner.id}/tags`, 'PATCH', { tags: [] }],
    ['segments/preview', 'POST', { audience: { type: 'all' } }], [`campaigns/${campaign.id}/cancel`, 'POST', {}],
  ] as const) {
    const denied = await h.handle(new Request(`https://example.azurewebsites.net/api/admin/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    assert.equal(denied.status, 401);
  }
  const preflight = await h.handle(new Request('https://example.azurewebsites.net/api/admin/campaigns', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } }));
  assert.match(preflight.headers.get('access-control-allow-methods')!, /PATCH/);
  assert.match(preflight.headers.get('access-control-allow-headers')!, /If-Match/);
  assert.equal(preflight.headers.get('access-control-expose-headers'), 'ETag');
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
