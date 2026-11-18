import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { cloudApplication } from '../apps/functions/src/cloud-application.js';
import { MemoryDocumentDatabase } from '../packages/adapters/src/memory-database.js';
import { DurableSubscriptionStore } from '../packages/core/src/durable.js';
import { DeliveryPipeline } from '../packages/core/src/pipeline.js';
import { AppError, DEFAULT_NOTIFICATION } from '../packages/core/src/index.js';
import { WebPushSender } from '../packages/adapters/src/web-push-sender.js';

function fixture(index = 0) {
  const curve = createECDH('prime256v1'); curve.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/wp/security-${index}`, expirationTime: null, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
function harness(limit = 100) {
  const database = new MemoryDocumentDatabase(); const subscriptions = new DurableSubscriptionStore(database, 'test'); let publications = 0;
  const pipeline = new DeliveryPipeline({ database, subscriptions, siteId: 'test', dailyAttemptLimit: 1000,
    queue: { async campaign() { publications++; }, async delivery() { publications++; } }, sender: { async send() { throw new Error('No provider calls are expected.'); } } });
  const handle = cloudApplication({ subscriptions, pipeline, webOrigin: 'http://localhost:5173', config: { mode: 'azure', vapidPublicKey: 'public', maxSubscriptions: limit },
    auth: { async authenticate(header) { if (header !== 'Bearer admin-fixture') throw new AppError(401, 'Sign in.'); return { objectId: 'test-admin' }; } } });
  const request = (path: string, method = 'GET', body?: unknown, token?: string) => handle(new Request(`https://example.azurewebsites.net${path}`, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  return { database, subscriptions, handle, request, publications: () => publications };
}

test('malformed and oversized JSON cannot register subscribers or create campaigns', async () => {
  const h = harness();
  for (const [body, contentType, status] of [['{bad', 'application/json', 400], ['[]', 'application/json', 400], ['null', 'application/json', 400], ['{}', 'text/plain', 415], ['x'.repeat(8193), 'application/json', 413]] as const) {
    for (const path of ['/api/subscriptions', '/api/admin/campaigns']) {
      const response = await h.handle(new Request(`https://example.azurewebsites.net${path}`, { method: 'POST', headers: { 'Content-Type': contentType, Authorization: 'Bearer admin-fixture' }, body }));
      assert.equal(response.status, status);
    }
  }
  assert.equal((await h.database.page('campaign', 100)).items.length, 0); assert.equal((await h.subscriptions.list()).length, 0); assert.equal(h.publications(), 0);
});

test('hostile destinations and endpoint payloads are rejected before storage or queue publication', async () => {
  const h = harness(); const owner = await (await h.request('/api/subscriptions', 'POST', { subscription: fixture() })).json();
  for (const url of ['//evil.example', '/\\evil.example', '/\nredirect', 'javascript:alert(1)', 'https://external.example']) {
    assert.equal((await h.request(`/api/subscriptions/${owner.id}/test`, 'POST', { ...DEFAULT_NOTIFICATION, url }, owner.token)).status, 400);
  }
  for (const endpoint of ['https://169.254.169.254/metadata', 'https://[::1]/', 'https://fcm.googleapis.com.evil.example/send', 'https://user:pass@fcm.googleapis.com/send', 'http://fcm.googleapis.com/send']) {
    assert.equal((await h.request('/api/subscriptions', 'POST', { subscription: { ...fixture(1), endpoint } })).status, 400);
  }
  assert.equal((await h.subscriptions.list()).length, 1); assert.equal(h.publications(), 0);
});

test('subscription capabilities cannot manage another subscriber or become administrator credentials', async () => {
  const h = harness(); const first = await (await h.request('/api/subscriptions', 'POST', { subscription: fixture(1) })).json();
  const second = await (await h.request('/api/subscriptions', 'POST', { subscription: fixture(2) })).json();
  for (const method of ['GET', 'DELETE', 'POST']) {
    const path = `/api/subscriptions/${second.id}${method === 'POST' ? '/test' : ''}`;
    assert.equal((await h.request(path, method, method === 'POST' ? DEFAULT_NOTIFICATION : undefined, first.token)).status, 403);
  }
  const denied = await h.request('/api/admin/subscriptions', 'GET', undefined, first.token); assert.equal(denied.status, 401); assert.equal(denied.headers.get('www-authenticate'), 'Bearer');
  const rows = await (await h.request('/api/admin/subscriptions', 'GET', undefined, 'admin-fixture')).text();
  for (const privateValue of [first.token, second.token, 'p256dh', 'tokenHash']) assert.ok(!rows.includes(privateValue));
  assert.equal(h.publications(), 0); assert.equal((await h.subscriptions.list()).length, 2);
});

test('concurrent public registrations respect the atomic quota and duplicate registration preserves ownership', async () => {
  const h = harness(3); const requests = Array.from({ length: 8 }, (_, index) => fixture(index));
  const responses = await Promise.all(requests.map(subscription => h.request('/api/subscriptions', 'POST', { subscription })));
  assert.equal(responses.filter(row => row.status === 201).length, 3); assert.ok(responses.every(row => [201, 429].includes(row.status)));
  const registered = responses.findIndex(row => row.status === 201); const owner = await responses[registered]!.json();
  const before = await h.subscriptions.get(owner.id);
  assert.equal((await h.request('/api/subscriptions', 'POST', { subscription: requests[registered] })).status, 429);
  assert.equal((await h.subscriptions.get(owner.id))?.tokenHash, before?.tokenHash);
  assert.equal((await h.request(`/api/subscriptions/${owner.id}`, 'GET', undefined, owner.token)).status, 200);
});

test('unexpected SDK errors return a generic unavailable response without credential details', async () => {
  const h = harness(); h.database.page = async () => { throw new Error('SDK failure: secret-endpoint-token=DO-NOT-LEAK'); };
  const response = await h.request('/api/admin/subscriptions', 'GET', undefined, 'admin-fixture');
  assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'The service could not complete this request. Retry shortly.' });
});

test('real Web Push sender revalidates persisted endpoints before reaching the provider SDK', async () => {
  const sender = new WebPushSender({ subject: 'mailto:test@example.com', publicKey: 'unused', privateKey: 'unused' });
  await assert.rejects(sender.send({ ...fixture(), endpoint: 'https://127.0.0.1/private' }, { ...DEFAULT_NOTIFICATION, version: 1, sentAt: new Date().toISOString(), notificationId: 'test' }), (error: unknown) => error instanceof AppError && error.status === 400);
});
