import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDocumentDatabase } from '../packages/adapters/src/memory-database.js';
import { FileDocumentDatabase } from '../packages/adapters/src/file-database.js';
import { DurableSubscriptionStore, type Delivery, type QueuePublisher } from '../packages/core/src/durable.js';
import { DeliveryPipeline, subscriptionId } from '../packages/core/src/pipeline.js';
import { DEFAULT_NOTIFICATION } from '../packages/core/src/index.js';

function fixture(suffix = randomUUID()) {
  const curve = createECDH('prime256v1'); curve.generateKeys();
  const endpoint = `https://fcm.googleapis.com/wp/${suffix}`;
  return { id: subscriptionId(endpoint), subscription: { endpoint, expirationTime: null,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }, tokenHash: 'test-hash', createdAt: new Date().toISOString() };
}
async function harness(dailyAttemptLimit = 1000) {
  const database = new MemoryDocumentDatabase();
  const subscriptions = new DurableSubscriptionStore(database, 'test');
  const campaigns: string[] = [];
  const deliveries: string[] = [];
  const queue: QueuePublisher = { async campaign(id) { campaigns.push(id); }, async delivery(id) { deliveries.push(id); } };
  let now = new Date('2026-11-18T00:00:00Z');
  let status = 201;
  let attempts = 0;
  const pipeline = new DeliveryPipeline({ database, subscriptions, queue, siteId: 'test', dailyAttemptLimit,
    now: () => now, sender: { async send() { attempts++; return { statusCode: status }; } } });
  const record = fixture(); await subscriptions.insert(record, 100);
  return { database, subscriptions, queue, campaigns, deliveries, pipeline, record,
    setStatus: (value: number) => { status = value; }, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); }, attempts: () => attempts };
}

test('atomic subscriber quota survives registration races and allows capacity reuse after deletion', async () => {
  const database = new MemoryDocumentDatabase();
  const store = new DurableSubscriptionStore(database, 'test');
  const rows = Array.from({ length: 8 }, () => fixture());
  const results = await Promise.allSettled(rows.map(row => store.insert(row, 3)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  const saved = await store.list(); assert.equal(saved.length, 3);
  await store.remove(saved[0]!.id); await store.insert(fixture(), 3);
  assert.equal((await store.list()).length, 3);
});

test('durable documents persist across store recreation and reject stale writes', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'webpush-phase2-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'documents.json');
  const original = new FileDocumentDatabase(path);
  const store = new DurableSubscriptionStore(original, 'local');
  const row = fixture(); await store.insert(row, 100);
  const restarted = new FileDocumentDatabase(path);
  assert.equal((await new DurableSubscriptionStore(restarted, 'local').get(row.id))?.subscription.endpoint, row.subscription.endpoint);
  const before = (await restarted.read(row.id))!;
  assert.equal(await restarted.replace({ ...before, kind: 'subscription' }, before._etag!), true);
  assert.equal(await restarted.replace(before, before._etag!), false);
});

test('campaigns cross both queues and duplicate deliveries produce one provider call', async () => {
  const h = await harness();
  const result = await h.pipeline.submit('admin', 'request-key-1234', DEFAULT_NOTIFICATION, [h.record.id]);
  assert.equal(h.campaigns[0], result.id);
  await h.pipeline.fanOut(h.campaigns[0]!);
  const job = h.deliveries[0]!; assert.ok(job); assert.notEqual(job, result.id);
  await Promise.all([h.pipeline.deliver(job), h.pipeline.deliver(job)]);
  await h.pipeline.deliver(job);
  assert.equal(h.attempts(), 1);
  assert.equal((await h.database.read<Delivery>(job))?.state, 'accepted');
});

test('idempotency keys cannot duplicate or change a campaign', async () => {
  const h = await harness();
  const first = await h.pipeline.submit('admin', 'request-key-1234', DEFAULT_NOTIFICATION, [h.record.id]);
  const again = await h.pipeline.submit('admin', 'request-key-1234', DEFAULT_NOTIFICATION, [h.record.id]);
  assert.equal(first.id, again.id); assert.equal(h.campaigns.length, 1);
  await assert.rejects(h.pipeline.submit('admin', 'request-key-1234', { ...DEFAULT_NOTIFICATION, title: 'Changed' }, [h.record.id]), /different campaign/);
});

test('outbox recovers a campaign when queue publication fails after database commit', async () => {
  const h = await harness();
  const publish = h.queue.campaign;
  h.queue.campaign = async () => { throw new Error('queue unavailable'); };
  const campaign = await h.pipeline.submit('admin', 'request-key-1234', DEFAULT_NOTIFICATION, [h.record.id]);
  assert.equal(campaign.state, 'pending'); assert.equal(h.campaigns.length, 0);
  h.queue.campaign = publish;
  await h.pipeline.reconcile();
  assert.equal(h.campaigns[0], campaign.id);
});

test('transient provider errors wait for the retry time and recover', async () => {
  const h = await harness();
  const campaign = await h.pipeline.submit('admin', 'request-key-1234', DEFAULT_NOTIFICATION, [h.record.id]);
  await h.pipeline.fanOut(campaign.id);
  const id = h.deliveries[0]!; h.setStatus(503);
  await h.pipeline.deliver(id); await h.pipeline.deliver(id);
  assert.equal(h.attempts(), 1); assert.equal((await h.database.read<Delivery>(id))?.state, 'pending');
  h.advance(31_000); h.setStatus(201); await h.pipeline.reconcile(); await h.pipeline.deliver(id);
  assert.equal(h.attempts(), 2); assert.equal((await h.database.read<Delivery>(id))?.state, 'accepted');
});

test('expired processing leases recover after worker restart', async () => {
  const h = await harness();
  const campaign = await h.pipeline.submit('admin', 'request-key-1234', DEFAULT_NOTIFICATION, [h.record.id]);
  await h.pipeline.fanOut(campaign.id);
  const job = (await h.database.read<Delivery>(h.deliveries[0]!))!;
  await h.database.replace({ ...job, state: 'processing', attempts: 1, leaseId: 'crashed-worker', leaseUntil: '2026-11-17T23:59:59Z' } as Delivery, job._etag!);
  await h.pipeline.reconcile(); await h.pipeline.deliver(job.id);
  assert.equal((await h.database.read<Delivery>(job.id))?.state, 'accepted'); assert.equal(h.attempts(), 1);
});

test('global daily attempt budget is atomic across different deliveries', async () => {
  const h = await harness(1); const second = fixture(); await h.subscriptions.insert(second, 100);
  const campaign = await h.pipeline.submit('admin', 'request-key-1234', DEFAULT_NOTIFICATION, [h.record.id, second.id]);
  await h.pipeline.fanOut(campaign.id);
  await Promise.all(h.deliveries.map(id => h.pipeline.deliver(id)));
  assert.equal(h.attempts(), 1);
  const rows = await Promise.all(h.deliveries.map(id => h.database.read<Delivery>(id)));
  assert.equal(rows.filter(row => row?.state === 'failed' && row.reason === 'daily_limit').length, 1);
});

test('provider expiry deactivates a subscription and does not send again', async () => {
  const h = await harness(); const campaign = await h.pipeline.submit('admin', 'request-key-1234', DEFAULT_NOTIFICATION, [h.record.id]);
  await h.pipeline.fanOut(campaign.id); h.setStatus(410); await h.pipeline.deliver(h.deliveries[0]!);
  assert.equal(await h.subscriptions.get(h.record.id), undefined);
  await h.pipeline.deliver(h.deliveries[0]!); assert.equal(h.attempts(), 1);
});

test('provider retries stop after five attempts even if duplicate messages keep arriving', async () => {
  const h = await harness(); const campaign = await h.pipeline.submit('admin', 'retry-limit-1234', DEFAULT_NOTIFICATION, [h.record.id]);
  await h.pipeline.fanOut(campaign.id); h.setStatus(503);
  for (let attempt = 0; attempt < 8; attempt++) { await h.pipeline.deliver(h.deliveries[0]!); h.advance(600_000); }
  const record = await h.database.read<Delivery>(h.deliveries[0]!);
  assert.equal(h.attempts(), 5); assert.equal(record?.state, 'failed'); assert.equal(record?.reason, 'retry_limit');
});

test('daily campaign quota stops new submissions while allowing idempotent request retries', async () => {
  const h = await harness();
  for (let index = 0; index < 100; index++) await h.pipeline.submit('admin', `budget-case-${index}`, DEFAULT_NOTIFICATION, [h.record.id]);
  await assert.rejects(h.pipeline.submit('admin', 'budget-overflow', DEFAULT_NOTIFICATION, [h.record.id]), /daily demonstration campaign limit/);
  assert.ok(await h.pipeline.submit('admin', 'budget-case-0', DEFAULT_NOTIFICATION, [h.record.id]));
  assert.equal(h.campaigns.length, 100);
});
