import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryDocumentDatabase } from '../packages/adapters/src/memory-database.js';
import { FileDocumentDatabase } from '../packages/adapters/src/file-database.js';
import { DurableSubscriptionStore, type Delivery, type DocumentDatabase, type SubscriptionDocument } from '../packages/core/src/durable.js';
import { DeliveryPipeline, subscriptionId } from '../packages/core/src/pipeline.js';
import { AppError, DEFAULT_NOTIFICATION, type PushPayload } from '../packages/core/src/index.js';
import { cloudApplication } from '../apps/functions/src/cloud-application.js';

const hasStatus = (status: number) => (error: unknown) => error instanceof AppError && error.status === status;
async function harness(database: DocumentDatabase = new MemoryDocumentDatabase()) {
  let time = new Date('2026-11-18T00:00:00Z');
  const subscriptions = new DurableSubscriptionStore(database, 'test');
  for (let index = 0; index < 2; index++) {
    const endpoint = `https://fcm.googleapis.com/wp/report-${index}`;
    await subscriptions.insert({ id: subscriptionId(endpoint), subscription: { endpoint, expirationTime: null, keys: { p256dh: 'private-encryption-key', auth: 'private-auth-key' } },
      tokenHash: 'private-ownership-hash', createdAt: time.toISOString() }, 100);
  }
  const payloads: PushPayload[] = [], messages: string[] = [], dispatches: string[] = [];
  const sender = { async send(_subscription: unknown, payload: PushPayload) { payloads.push(payload); return { statusCode: 201 }; } };
  const make = (db = database) => new DeliveryPipeline({ database: db, subscriptions: new DurableSubscriptionStore(db, 'test'), siteId: 'test',
    queue: { async campaign(id) { dispatches.push(id); }, async delivery(id) { messages.push(id); } },
    sender, eventSecret: 'test-only-reporting-secret', eventBaseUrl: 'http://localhost:5173', dailyAttemptLimit: 1000, now: () => time });
  const pipeline = make();
  const records = await subscriptions.list();
  const campaign = await pipeline.submit('admin', 'reporting-case-123', DEFAULT_NOTIFICATION, records.map(row => row.id));
  const handle = cloudApplication({ pipeline, subscriptions, webOrigin: 'http://localhost:5173', config: { mode: 'azure', vapidPublicKey: 'public', maxSubscriptions: 100 },
    auth: { async authenticate(header) { if (header !== 'Bearer admin') throw new AppError(401, 'Sign in.'); return { objectId: 'admin' }; } } });
  const event = (payload: PushPayload, type: string, token = payload.reporting!.token, origin?: string) => handle(new Request(payload.reporting!.url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ type }),
  }));
  return { database, pipeline, make, campaign, payloads, messages, dispatches, sender, handle, event,
    advance: (milliseconds: number) => { time = new Date(time.getTime() + milliseconds); } };
}

test('authenticated receipt and click observations persist independently of provider acceptance and deduplicate concurrent replays', async () => {
  const h = await harness(); await h.pipeline.fanOut(h.campaign.id);
  for (const id of h.messages) await h.pipeline.deliver(id);
  const payload = h.payloads[0]!; assert.ok(payload.reporting);
  const responses = await Promise.all(Array.from({ length: 12 }, () => h.event(payload, 'received')));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal((await h.event(payload, 'clicked')).status, 200);
  assert.equal((await h.event(payload, 'clicked')).status, 200);
  const report = await h.pipeline.reports.campaign(await h.pipeline.campaigns.get(h.campaign.id));
  assert.deepEqual(report.metrics, { targeted: 2, accepted: 2, received: 1, clicked: 1, failed: 0, expired: 0, cancelled: 0 });
  const first = report.deliveries.find(row => row.id === payload.notificationId)!.receivedAt;
  h.advance(60_000); await h.event(payload, 'received');
  assert.equal((await h.pipeline.reports.campaign(await h.pipeline.campaigns.get(h.campaign.id))).deliveries.find(row => row.id === payload.notificationId)!.receivedAt, first);
});

test('observation API rejects forged, cross-delivery, expired, foreign-origin, and invalid-type events', async () => {
  const h = await harness(); await h.pipeline.fanOut(h.campaign.id);
  for (const id of h.messages) await h.pipeline.deliver(id);
  const payload = h.payloads[0]!;
  assert.equal((await h.event(payload, 'received', 'forged')).status, 401);
  assert.equal((await h.event(payload, 'received', h.payloads[1]!.reporting!.token)).status, 401);
  assert.equal((await h.event(payload, 'read')).status, 400);
  assert.equal((await h.event(payload, 'received', payload.reporting!.token, 'https://foreign.example')).status, 403);
  assert.equal((await h.event(payload, 'clicked')).status, 200);
  const report = await h.pipeline.reports.campaign(await h.pipeline.campaigns.get(h.campaign.id));
  assert.equal(report.metrics.received, 0); assert.equal(report.metrics.clicked, 1);
  h.advance(604800000); assert.equal((await h.event(payload, 'received')).status, 410);
});

test('browser observations received during the provider call survive the send outcome update', async () => {
  const h = await harness(); await h.pipeline.fanOut(h.campaign.id);
  h.sender.send = async (_subscription, payload) => {
    h.payloads.push(payload); assert.equal((await h.event(payload, 'received')).status, 200); return { statusCode: 201 };
  };
  await h.pipeline.deliver(h.messages[0]!);
  const row = (await h.database.read<Delivery>(h.messages[0]!))!;
  assert.equal(row.state, 'accepted'); assert.ok(row.receivedAt);
});

test('administrator reports show failure reasons without credentials and reject unauthenticated readers', async () => {
  const h = await harness(); await h.pipeline.fanOut(h.campaign.id);
  h.sender.send = async () => { throw { statusCode: 403, body: 'upstream-private-provider-body', endpoint: 'private-endpoint' }; };
  await h.pipeline.deliver(h.messages[0]!);
  h.sender.send = async () => { throw { statusCode: 410 }; };
  await h.pipeline.deliver(h.messages[1]!);
  const url = `http://localhost:5173/api/admin/campaigns/${h.campaign.id}`;
  assert.equal((await h.handle(new Request(url))).status, 401);
  const response = await h.handle(new Request(url, { headers: { Authorization: 'Bearer admin' } }));
  assert.equal(response.status, 200); const text = await response.text(); const report = JSON.parse(text);
  assert.equal(report.metrics.accepted, 0); assert.equal(report.metrics.failed, 1); assert.equal(report.metrics.expired, 1);
  assert.ok(report.deliveries.some((row: { reason: string }) => row.reason === 'provider_rejected'));
  for (const value of ['private-encryption-key', 'private-auth-key', 'private-ownership-hash', 'upstream-private-provider-body', 'private-endpoint', 'test-only-reporting-secret', 'eventExpiresAt']) assert.ok(!text.includes(value));
});

test('pause controls retain queued work and do not spend attempt reservations until resumed', async () => {
  const h = await harness();
  let controls = await h.pipeline.controls.get();
  await h.pipeline.controls.set({ dispatchPaused: true, sendingPaused: true }, controls._etag!);
  await h.pipeline.fanOut(h.campaign.id); assert.equal(h.messages.length, 0);
  controls = await h.pipeline.controls.get();
  await h.pipeline.controls.set({ dispatchPaused: false, sendingPaused: true }, controls._etag!);
  await h.pipeline.reconcile(); await h.pipeline.fanOut(h.campaign.id);
  for (const id of h.messages) await h.pipeline.deliver(id);
  assert.equal(h.payloads.length, 0);
  assert.equal((await h.database.read<Delivery>(h.messages[0]!))?.attempts, 0);
  controls = await h.pipeline.controls.get();
  await h.pipeline.controls.set({ dispatchPaused: false, sendingPaused: false }, controls._etag!);
  for (const id of h.messages) await h.pipeline.deliver(id);
  assert.equal(h.payloads.length, 2); assert.equal((await h.pipeline.campaigns.get(h.campaign.id)).state, 'completed');
});

test('a pause that wins before a send claim commits prevents the provider call', async () => {
  const h = await harness(); await h.pipeline.fanOut(h.campaign.id);
  const transact = h.database.transact.bind(h.database); let pause = true;
  h.database.transact = async writes => {
    if (pause && writes.some(write => write.type === 'replace' && write.document.kind === 'delivery' && (write.document as Delivery).state === 'processing')) {
      pause = false; const controls = await h.pipeline.controls.get();
      await h.pipeline.controls.set({ dispatchPaused: false, sendingPaused: true }, controls._etag!);
    }
    return transact(writes);
  };
  await h.pipeline.deliver(h.messages[0]!); assert.equal(h.payloads.length, 0);
  assert.equal((await h.database.read<Delivery>(h.messages[0]!))?.attempts, 0);
});

test('observations and pause controls survive file-store and pipeline recreation', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'webpush-reports-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'documents.json'); const h = await harness(new FileDocumentDatabase(path));
  await h.pipeline.fanOut(h.campaign.id); await h.pipeline.deliver(h.messages[0]!); await h.event(h.payloads[0]!, 'received');
  const controls = await h.pipeline.controls.get(); await h.pipeline.controls.set({ dispatchPaused: true, sendingPaused: true }, controls._etag!);
  const restarted = h.make(new FileDocumentDatabase(path));
  assert.equal((await restarted.controls.get()).sendingPaused, true);
  assert.equal((await restarted.reports.campaign(await restarted.campaigns.get(h.campaign.id))).metrics.received, 1);
  await assert.rejects(restarted.controls.set({ dispatchPaused: false, sendingPaused: false }, controls._etag!), hasStatus(412));
});

test('operation routes require administrator authorization and record version preconditions', async () => {
  const h = await harness(); const url = 'http://localhost:5173/api/admin/operations';
  assert.equal((await h.handle(new Request(url))).status, 401);
  const current = await h.handle(new Request(url, { headers: { Authorization: 'Bearer admin' } }));
  const patch = (etag?: string) => h.handle(new Request(url, { method: 'PATCH', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
    body: JSON.stringify({ dispatchPaused: true, sendingPaused: false }) }));
  assert.equal((await patch()).status, 428); assert.equal((await patch(current.headers.get('etag')!)).status, 200);
  assert.equal((await patch(current.headers.get('etag')!)).status, 412);
});

test('send review rejects a changed draft version or a changed audience before activation', async () => {
  const h = await harness(); const rows = await new DurableSubscriptionStore(h.database, 'test').list();
  const first = (await h.database.read<SubscriptionDocument>(rows[0]!.id))!;
  await h.pipeline.campaigns.setTags(first.id, ['demo'], first._etag!);
  const draft = { content: DEFAULT_NOTIFICATION, audience: { type: 'tags', tags: ['demo'] } };
  const created = await h.pipeline.campaigns.create('admin', 'review-draft-123', draft);
  const preview = await h.pipeline.campaigns.preview(draft.audience);
  const second = (await h.database.read<SubscriptionDocument>(rows[1]!.id))!;
  await h.pipeline.campaigns.setTags(second.id, ['demo'], second._etag!);
  await assert.rejects(h.pipeline.activate(created.id, 'review-send-123', undefined, { version: created._etag, fingerprint: preview.fingerprint }), hasStatus(409));
  const fresh = await h.pipeline.campaigns.preview(draft.audience);
  await h.pipeline.campaigns.update(created.id, { ...draft, name: 'Changed by another administrator' }, created._etag!);
  await assert.rejects(h.pipeline.activate(created.id, 'review-send-123', undefined, { version: created._etag, fingerprint: fresh.fingerprint }), hasStatus(412));
  assert.equal((await h.pipeline.campaigns.get(created.id)).state, 'draft');
});

test('pausing expansion before a page transaction wins prevents recipients from being committed', async () => {
  const h = await harness(); const transact = h.database.transact.bind(h.database); let pause = true;
  h.database.transact = async writes => {
    if (pause && writes.some(write => write.type === 'create' && write.document.kind === 'delivery')) {
      pause = false; const controls = await h.pipeline.controls.get();
      await h.pipeline.controls.set({ dispatchPaused: true, sendingPaused: false }, controls._etag!);
    }
    return transact(writes);
  };
  await assert.rejects(h.pipeline.fanOut(h.campaign.id), /dispatch changed/);
  assert.equal(h.messages.length, 0); assert.equal((await h.database.page<Delivery>('delivery', 100)).items.length, 0);
  h.advance(120001); const controls = await h.pipeline.controls.get();
  await h.pipeline.controls.set({ dispatchPaused: false, sendingPaused: false }, controls._etag!);
  await h.pipeline.reconcile(); await h.pipeline.fanOut(h.campaign.id);
  assert.equal(h.messages.length, 2);
});
