import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDocumentDatabase } from '../packages/adapters/src/memory-database.js';
import { FileDocumentDatabase } from '../packages/adapters/src/file-database.js';
import { DurableSubscriptionStore, type Campaign, type Delivery, type DocumentDatabase, type SubscriptionDocument } from '../packages/core/src/durable.js';
import { DeliveryPipeline, retryDelay, subscriptionId } from '../packages/core/src/pipeline.js';
import { deliveryId, digest, parseTags } from '../packages/core/src/campaigns.js';
import { AppError, DEFAULT_NOTIFICATION, type PushSender } from '../packages/core/src/index.js';

const draft = { name: 'Project update', content: DEFAULT_NOTIFICATION, audience: { type: 'all' } };
const status = (code: number) => (error: unknown) => error instanceof AppError && error.status === code;
async function harness(count = 1, database: DocumentDatabase = new MemoryDocumentDatabase()) {
  let now = new Date('2026-11-18T00:00:00Z');
  const subscriptions = new DurableSubscriptionStore(database, 'test');
  for (let index = 0; index < count; index++) {
    const endpoint = `https://fcm.googleapis.com/wp/phase3-${index}`;
    await subscriptions.insert({ id: subscriptionId(endpoint), subscription: { endpoint, expirationTime: null, keys: { p256dh: 'test', auth: 'test' } },
      tokenHash: 'test-hash', createdAt: now.toISOString() }, 100);
  }
  const campaigns: string[] = [], deliveries: string[] = [], sent: string[] = [];
  const queue = { async campaign(id: string) { campaigns.push(id); }, async delivery(id: string) { deliveries.push(id); } };
  const sender: PushSender = { async send(_subscription, payload) { sent.push(payload.notificationId); return { statusCode: 201 }; } };
  const make = (db = database) => new DeliveryPipeline({ database: db, subscriptions: new DurableSubscriptionStore(db, 'test'),
    queue, sender, siteId: 'test', dailyAttemptLimit: 1000, now: () => now });
  const pipeline = make();
  const records = await subscriptions.list();
  return { database, subscriptions, pipeline, manager: pipeline.campaigns, records, queue, campaigns, deliveries, sent, sender, make,
    advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}

test('draft creation is idempotent, edits require the latest version, and only drafts can be deleted', async () => {
  const h = await harness();
  const created = await h.manager.create('admin', 'draft-key-123', draft);
  assert.equal(created.state, 'draft'); assert.equal(h.campaigns.length, 0);
  assert.equal((await h.manager.create('admin', 'draft-key-123', draft)).id, created.id);
  await assert.rejects(h.manager.create('admin', 'draft-key-123', { ...draft, name: 'Different' }), status(409));
  const edited = await h.manager.update(created.id, { ...draft, name: 'Edited' }, created._etag!);
  assert.equal(edited.name, 'Edited');
  await assert.rejects(h.manager.update(created.id, draft, created._etag!), status(412));
  await assert.rejects(h.manager.update(created.id, draft, ''), status(428));
  await h.pipeline.activate(created.id, 'send-key-123');
  await assert.rejects(h.manager.update(created.id, draft, (await h.manager.get(created.id))._etag!), status(409));
  await assert.rejects(h.manager.remove(created.id, (await h.manager.get(created.id))._etag!), status(409));
  const removable = await h.manager.create('admin', 'delete-key-123', draft);
  await h.manager.remove(removable.id, removable._etag!);
  await assert.rejects(h.manager.get(removable.id), status(404));
});

test('tag targeting uses normalized AND filters and rejects stale changes or missing selected recipients', async () => {
  const h = await harness(3);
  const first = (await h.database.read<SubscriptionDocument>(h.records[0]!.id))!;
  const tagged = await h.manager.setTags(first.id, ['News', 'demo', 'news'], first._etag!);
  assert.deepEqual(tagged?.tags, ['demo', 'news']);
  await assert.rejects(h.manager.setTags(first.id, ['other'], first._etag!), status(412));
  assert.equal((await h.manager.preview({ type: 'tags', tags: ['Demo', 'News'] })).count, 1);
  assert.equal((await h.manager.preview({ type: 'tags', tags: ['missing'] })).count, 0);
  assert.equal((await h.manager.preview({ type: 'all' })).count, 3);
  await assert.rejects(h.manager.preview({ type: 'selected', subscriptionIds: [digest('missing')] }), status(409));
  assert.throws(() => parseTags(['bad tag']), status(400));
  assert.throws(() => parseTags(Array(11).fill('demo')), status(400));
});

test('scheduling freezes the audience, normalizes timezone offsets, and never dispatches early', async () => {
  const h = await harness(2);
  const first = (await h.database.read<SubscriptionDocument>(h.records[0]!.id))!;
  await h.manager.setTags(first.id, ['demo'], first._etag!);
  const campaign = await h.manager.create('admin', 'schedule-draft-1', { ...draft, audience: { type: 'tags', tags: ['demo'] } });
  const scheduled = await h.pipeline.activate(campaign.id, 'schedule-key-1', '2026-11-18T05:31:00+05:30');
  assert.equal(scheduled.scheduledAt, '2026-11-18T00:01:00.000Z');
  assert.deepEqual(scheduled.subscriptionIds, [first.id]);
  const current = (await h.database.read<SubscriptionDocument>(first.id))!;
  await h.manager.setTags(first.id, [], current._etag!);
  const second = (await h.database.read<SubscriptionDocument>(h.records[1]!.id))!;
  await h.manager.setTags(second.id, ['demo'], second._etag!);
  await h.pipeline.fanOut(campaign.id); await h.pipeline.reconcile();
  assert.equal(h.campaigns.length, 0); assert.equal(h.deliveries.length, 0);
  h.advance(60_000); await Promise.all([h.pipeline.reconcile(), h.pipeline.reconcile()]);
  assert.equal(h.campaigns.length, 1);
  await h.pipeline.fanOut(campaign.id);
  assert.deepEqual(h.deliveries, [deliveryId(campaign.id, first.id)]);
  await h.pipeline.deliver(h.deliveries[0]!);
  assert.equal((await h.manager.get(campaign.id)).state, 'completed');
  // A delayed retry of the original scheduling request cannot create another send.
  assert.equal((await h.pipeline.activate(campaign.id, 'schedule-key-1', '2026-11-18T00:01:00Z')).state, 'completed');
  assert.equal(h.sent.length, 1);
});

test('empty segments, ambiguous times, past times, and schedules beyond seven days are rejected', async () => {
  const h = await harness();
  const campaign = await h.manager.create('admin', 'schedule-invalid', draft);
  for (const time of ['2026-11-18T00:01:00', 'yesterday', '2026-11-17T23:59:00Z', '2026-11-26T00:00:00Z']) {
    await assert.rejects(h.pipeline.activate(campaign.id, 'invalid-key-123', time), status(400));
  }
  const empty = await h.manager.create('admin', 'empty-draft-123', { ...draft, audience: { type: 'tags', tags: ['missing'] } });
  await assert.rejects(h.pipeline.activate(empty.id, 'empty-key-123'), status(400));
  assert.equal(h.campaigns.length, 0);
});

test('scheduled campaigns survive durable adapter and pipeline recreation', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'webpush-phase3-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'documents.json');
  const h = await harness(1, new FileDocumentDatabase(path));
  const campaign = await h.manager.create('admin', 'restart-draft-1', draft);
  await h.pipeline.activate(campaign.id, 'restart-key-123', '2026-11-18T00:01:00Z');
  const restarted = h.make(new FileDocumentDatabase(path));
  await restarted.reconcile(); assert.equal(h.campaigns.length, 0);
  h.advance(60_000); await restarted.reconcile(); await restarted.fanOut(campaign.id);
  await restarted.deliver(h.deliveries[0]!);
  assert.equal((await restarted.campaigns.get(campaign.id)).state, 'completed');
});

test('fan-out processes 25 recipients per page, tolerates concurrent duplicates, and resumes after publication failure', async () => {
  const h = await harness(60);
  const created = await h.manager.create('admin', 'paged-draft-123', draft);
  await h.pipeline.activate(created.id, 'paged-send-123');
  const publish = h.queue.campaign;
  h.queue.campaign = async () => { throw new Error('Broker unavailable after checkpoint'); };
  await Promise.all([h.pipeline.fanOut(created.id), h.pipeline.fanOut(created.id)]);
  assert.equal((await h.manager.get(created.id)).dispatchIndex, 25);
  assert.equal(h.deliveries.length, 25);
  h.queue.campaign = publish;
  const restarted = h.make();
  await restarted.reconcile(); await restarted.fanOut(created.id);
  assert.equal((await h.manager.get(created.id)).dispatchIndex, 50);
  await restarted.fanOut(created.id); await restarted.fanOut(created.id);
  assert.equal((await h.manager.get(created.id)).dispatchIndex, 60);
  assert.equal(new Set(h.deliveries).size, 60); assert.equal(h.deliveries.length, 60);
  for (const id of h.deliveries) await restarted.deliver(id);
  assert.equal(h.sent.length, 60); assert.equal((await h.manager.get(created.id)).state, 'completed');
});

test('a crash before a dispatch page commits recovers its expired lease without losing recipients', async () => {
  const h = await harness(30);
  const campaign = await h.manager.create('admin', 'crash-draft-123', draft); await h.pipeline.activate(campaign.id, 'crash-send-123');
  const transact = h.database.transact.bind(h.database);
  let crash = true;
  h.database.transact = async writes => {
    if (crash && writes.some(write => write.type === 'create' && write.document.kind === 'delivery')) { crash = false; throw new Error('Simulated process termination'); }
    return transact(writes);
  };
  await assert.rejects(h.pipeline.fanOut(campaign.id), /Simulated process termination/);
  assert.equal((await h.manager.get(campaign.id)).dispatchIndex, 0); assert.equal(h.deliveries.length, 0);
  h.advance(120_001); await h.make().reconcile();
  await h.pipeline.fanOut(campaign.id); await h.pipeline.fanOut(campaign.id);
  assert.equal((await h.manager.get(campaign.id)).dispatchIndex, 30); assert.equal(new Set(h.deliveries).size, 30);
});

test('cancellation stops scheduled work, further fan-out, and queued attempts without using the send allowance', async () => {
  const h = await harness(30);
  const campaign = await h.manager.create('admin', 'cancel-draft-12', draft); await h.pipeline.activate(campaign.id, 'cancel-send-123');
  await h.pipeline.fanOut(campaign.id); assert.equal(h.deliveries.length, 25);
  await h.manager.cancel(campaign.id); await h.manager.cancel(campaign.id);
  await h.pipeline.fanOut(campaign.id);
  for (const id of h.deliveries) await h.pipeline.deliver(id);
  await h.pipeline.reconcile();
  assert.equal(h.deliveries.length, 25); assert.equal(h.sent.length, 0);
  assert.equal((await h.database.read<Delivery>(h.deliveries[0]!))?.state, 'cancelled');
  assert.equal((await h.database.read<{ id: string; siteId: string; kind: string; count: number }>('attempts-2026-11-18'))?.count, 0);
  const scheduled = await h.manager.create('admin', 'cancel-scheduled', draft);
  await h.pipeline.activate(scheduled.id, 'cancel-sched-123', '2026-11-18T00:01:00Z');
  await h.manager.cancel(scheduled.id); h.advance(60_000); await h.pipeline.reconcile();
  assert.equal((await h.manager.get(scheduled.id)).state, 'cancelled');
});

test('cancellation wins a race before a delivery claim commits', async () => {
  const h = await harness();
  const campaign = await h.pipeline.submit('admin', 'cancel-race-123', DEFAULT_NOTIFICATION, [h.records[0]!.id]);
  await h.pipeline.fanOut(campaign.id);
  const transact = h.database.transact.bind(h.database); let cancel = true;
  h.database.transact = async writes => {
    if (cancel && writes.some(write => write.type === 'replace' && write.document.kind === 'delivery')) {
      cancel = false; await h.manager.cancel(campaign.id);
    }
    return transact(writes);
  };
  await h.pipeline.deliver(h.deliveries[0]!);
  assert.equal(h.sent.length, 0); assert.equal((await h.database.read<Delivery>(h.deliveries[0]!))?.state, 'cancelled');
});

test('an already in-flight provider acceptance is retained after cancellation', async () => {
  const h = await harness(2);
  const campaign = await h.pipeline.submit('admin', 'inflight-send-1', DEFAULT_NOTIFICATION, h.records.map(row => row.id));
  await h.pipeline.fanOut(campaign.id);
  let sends = 0;
  h.sender.send = async () => { sends++; await h.manager.cancel(campaign.id); return { statusCode: 201 }; };
  for (const id of h.deliveries) await h.pipeline.deliver(id);
  assert.equal(sends, 1); assert.equal((await h.manager.get(campaign.id)).state, 'cancelled');
  assert.equal((await h.database.read<Delivery>(h.deliveries[0]!))?.state, 'accepted');
  assert.equal((await h.database.read<Delivery>(h.deliveries[1]!))?.state, 'cancelled');
});

test('a cancelled dispatch page cannot commit recipients after cancellation wins its transaction race', async () => {
  const h = await harness(30);
  const campaign = await h.pipeline.submit('admin', 'fanout-cancel-1', DEFAULT_NOTIFICATION, h.records.map(row => row.id));
  const transact = h.database.transact.bind(h.database); let cancel = true;
  h.database.transact = async writes => {
    if (cancel && writes.some(write => write.type === 'create' && write.document.kind === 'delivery')) {
      cancel = false; await h.manager.cancel(campaign.id);
    }
    return transact(writes);
  };
  await h.pipeline.fanOut(campaign.id);
  assert.equal(h.deliveries.length, 0); assert.equal(h.sent.length, 0);
  assert.equal((await h.database.page<Delivery>('delivery', 100)).items.length, 0);
});

test('committed dispatch jobs recover when delivery queue publication fails', async () => {
  const h = await harness(2);
  const campaign = await h.pipeline.submit('admin', 'delivery-outbox-1', DEFAULT_NOTIFICATION, h.records.map(row => row.id));
  const publish = h.queue.delivery; h.queue.delivery = async () => { throw new Error('Broker unavailable'); };
  await h.pipeline.fanOut(campaign.id);
  assert.equal((await h.manager.get(campaign.id)).state, 'sending'); assert.equal(h.deliveries.length, 0);
  h.queue.delivery = publish; await h.make().reconcile();
  assert.equal(new Set(h.deliveries).size, 2);
  for (const id of h.deliveries) await h.pipeline.deliver(id);
  assert.equal((await h.manager.get(campaign.id)).state, 'completed');
});

test('provider Retry-After seconds and dates delay retries; excessive delays fail the bounded job', async () => {
  assert.equal(retryDelay('120', new Date('2026-11-18T00:00:00Z')), 120000);
  assert.equal(retryDelay('Wed, 18 Nov 2026 00:03:00 GMT', new Date('2026-11-18T00:00:00Z')), 180000);
  assert.equal(retryDelay('invalid', new Date()), undefined);
  const h = await harness();
  const campaign = await h.pipeline.submit('admin', 'retry-after-123', DEFAULT_NOTIFICATION, [h.records[0]!.id]);
  await h.pipeline.fanOut(campaign.id); let calls = 0;
  h.sender.send = async () => { calls++; throw { statusCode: 429, headers: { 'retry-after': '120' } }; };
  await h.pipeline.deliver(h.deliveries[0]!); h.advance(119_999); await h.pipeline.deliver(h.deliveries[0]!);
  assert.equal(calls, 1); h.advance(1); await h.pipeline.deliver(h.deliveries[0]!); assert.equal(calls, 2);
  h.advance(120_000);
  h.sender.send = async () => { throw { statusCode: 503, headers: { 'retry-after': '86401' } }; };
  await h.pipeline.deliver(h.deliveries[0]!);
  assert.equal((await h.database.read<Delivery>(h.deliveries[0]!))?.reason, 'retry_after_exceeds_window');
  assert.equal((await h.manager.get(campaign.id)).state, 'completed_with_failures');
});

test('recovery cursors survive pipeline recreation and reach beyond the first 100 changing active jobs', async () => {
  const h = await harness();
  const campaign = await h.pipeline.submit('admin', 'cursor-draft-12', DEFAULT_NOTIFICATION, [h.records[0]!.id]);
  // Synthetic persisted jobs exercise recovery pagination without contacting a provider.
  for (let index = 0; index < 205; index++) await h.database.create({ id: digest(`cursor-job-${index}`), kind: 'delivery', siteId: 'test',
    campaignId: campaign.id, subscriptionId: h.records[0]!.id, state: 'pending', attempts: 0,
    nextAttemptAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z' } as Delivery);
  await h.pipeline.reconcile(); assert.equal(h.deliveries.length, 100);
  for (const id of h.deliveries) {
    const job = (await h.database.read<Delivery>(id))!;
    await h.database.replace({ ...job, state: 'accepted' } as Delivery, job._etag!);
  }
  await h.make().reconcile(); await h.make().reconcile();
  assert.equal(new Set(h.deliveries).size, 205);
});

test('future schedules on the first recovery page do not starve a due campaign on the next page', async () => {
  const h = await harness();
  for (let index = 0; index < 101; index++) await h.database.create({ id: index.toString(16).padStart(64, '0'), siteId: 'test', kind: 'campaign',
    content: DEFAULT_NOTIFICATION, subscriptionIds: [h.records[0]!.id], state: 'scheduled', createdBy: 'admin', createdAt: '2026-11-18T00:00:00Z',
    scheduledAt: index === 100 ? '2026-11-18T00:00:00Z' : '2026-11-19T00:00:00Z' } as Campaign);
  await h.pipeline.reconcile(); assert.equal(h.campaigns.length, 0);
  await h.make().reconcile(); assert.deepEqual(h.campaigns, [(100).toString(16).padStart(64, '0')]);
});
