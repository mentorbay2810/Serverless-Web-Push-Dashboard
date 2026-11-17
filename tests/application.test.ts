import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { createApplication } from '../apps/functions/src/application.js';
import { FileSubscriptionStore } from '../packages/adapters/src/file-store.js';
import type { PushPayload } from '../packages/core/src/index.js';

const browserSubscription = () => {
  const curve = createECDH('prime256v1'); curve.generateKeys();
  return { endpoint: 'https://fcm.googleapis.com/fcm/send/test', expirationTime: null,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};

async function harness(context: { after: (fn: () => Promise<void>) => void }, sendsPerMinute = 5) {
  const directory = await mkdtemp(join(tmpdir(), 'webpush-foundation-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileSubscriptionStore(directory);
  const payloads: PushPayload[] = [];
  let providerStatus = 201;
  const handle = createApplication({
    store, sender: { async send(_subscription, payload) { payloads.push(payload); return { statusCode: providerStatus }; } },
    publicKey: 'public-key-only', adminToken: 'local-admin-test-token', webOrigin: 'http://localhost:5173', port: 8787, sendsPerMinute,
  });
  const request = (path: string, options: { method?: string; body?: unknown; token?: string; origin?: string; host?: string } = {}) => handle(new Request(`http://${options.host ?? '127.0.0.1:8787'}${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.origin ? { Origin: options.origin } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  }));
  const subscribe = async () => {
    const response = await request('/api/subscriptions', { body: { subscription: browserSubscription() } });
    assert.equal(response.status, 201);
    return await response.json() as { id: string; token: string };
  };
  return { request, subscribe, store, directory, payloads, setProviderStatus: (status: number) => { providerStatus = status; } };
}

test('public configuration never exposes private configuration and rejects foreign origins and hosts', async context => {
  const h = await harness(context);
  const response = await h.request('/api/config');
  const config = await response.json();
  assert.deepEqual(Object.keys(config).sort(), ['maxSubscriptions', 'mode', 'vapidPublicKey']);
  assert.equal((await h.request('/api/config', { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await h.request('/api/config', { host: 'attacker.example:8787' })).status, 403);
  assert.equal((await h.request('/api/local/subscriptions')).status, 401);
});

test('register, restart the local store, send, and opt out using subscription ownership', async context => {
  const h = await harness(context);
  const owner = await h.subscribe();
  const disk = new FileSubscriptionStore(h.directory);
  assert.equal((await disk.list()).length, 1);
  assert.equal((await h.request(`/api/subscriptions/${owner.id}`, { method: 'DELETE', token: 'wrong' })).status, 403);
  const sent = await h.request(`/api/subscriptions/${owner.id}/test`, { token: owner.token, body: { title: 'Hello', body: 'One real payload', url: '/' } });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).status, 'accepted');
  assert.equal(h.payloads[0]?.title, 'Hello');
  assert.ok((await disk.get(owner.id))?.lastAcceptedAt);
  assert.equal((await h.request(`/api/subscriptions/${owner.id}`, { method: 'DELETE', token: owner.token })).status, 200);
  assert.equal((await disk.list()).length, 0);
});

test('duplicate registration cannot take over an existing subscription', async context => {
  const h = await harness(context);
  const owner = await h.subscribe();
  const original = (await h.store.get(owner.id))!;
  const response = await h.request('/api/subscriptions', { body: { subscription: original.subscription } });
  assert.equal(response.status, 409);
  assert.equal((await h.store.list()).length, 1);
  assert.equal((await h.store.get(owner.id))?.tokenHash, original.tokenHash);
  assert.equal((await h.request(`/api/subscriptions/${owner.id}`, { token: owner.token })).status, 200);
});

test('test sends have a shared rate limit and do not broadcast', async context => {
  const h = await harness(context, 1);
  const owner = await h.subscribe();
  const options = { token: owner.token, body: { title: 'Test', body: 'Message' } };
  assert.equal((await h.request(`/api/subscriptions/${owner.id}/test`, options)).status, 200);
  assert.equal((await h.request(`/api/subscriptions/${owner.id}/test`, options)).status, 429);
  assert.equal(h.payloads.length, 1);
});

test('expired provider endpoints are removed and upstream error details remain private', async context => {
  const h = await harness(context);
  const owner = await h.subscribe();
  h.setProviderStatus(410);
  const response = await h.request(`/api/subscriptions/${owner.id}/test`, { token: owner.token, body: { title: 'Test', body: 'Message' } });
  assert.equal(response.status, 410);
  assert.equal((await h.store.list()).length, 0);
  const owner2 = await h.subscribe();
  h.setProviderStatus(503);
  const failed = await h.request(`/api/subscriptions/${owner2.id}/test`, { token: owner2.token, body: { title: 'Test', body: 'Message' } });
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes('fcm.googleapis.com'));
});

test('corrupt local data is preserved and simultaneous registrations respect the limit', async context => {
  const h = await harness(context);
  const record = { id: 'one', subscription: browserSubscription(), tokenHash: 'hash', createdAt: new Date().toISOString() };
  const results = await Promise.allSettled([
    h.store.insert(record, 1),
    h.store.insert({ ...record, id: 'two', subscription: { ...record.subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/another' } }, 1),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await writeFile(join(h.directory, 'subscriptions.json'), '{corrupt');
  await assert.rejects(h.store.list(), /existing data was preserved/);
  assert.equal(await readFile(join(h.directory, 'subscriptions.json'), 'utf8'), '{corrupt');
});
