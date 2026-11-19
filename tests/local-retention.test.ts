import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CampaignManager, deliveryId, digest } from '../packages/core/src/campaigns.js';
import { AppError, DEFAULT_NOTIFICATION } from '../packages/core/src/index.js';
import { DurableSubscriptionStore, type Campaign, type Delivery, type Document } from '../packages/core/src/durable.js';
import { FileDocumentDatabase } from '../packages/adapters/src/file-database.js';
import { acquireLocalLock, localLockStatus } from '../packages/adapters/src/local-lock.js';
import { applyRetention, planRetention, restoreRetention } from '../tools/retention/local-history.js';

type Row = Document & Record<string, unknown>;
const now = new Date('2026-11-19T00:00:00.000Z'), old = '2026-09-01T00:00:00.000Z';
const documents = 'phase2-documents.json', queues = 'phase2-queues.json';
const subscriber = digest('subscriber');
const draft = { name: 'Old update', content: DEFAULT_NOTIFICATION, audience: { type: 'all' as const } };
function campaign(key: string, patch: Partial<Campaign> = {}): Campaign {
  return { id: digest(`campaign:test:admin:${key}`), siteId: 'test', kind: 'campaign', _etag: 'original-campaign-etag',
    ...draft, subscriptionIds: [subscriber], createdBy: 'admin', createdAt: old, updatedAt: old, state: 'completed', ...patch };
}
function delivery(parent: Campaign, patch: Partial<Delivery> = {}): Delivery {
  return { id: deliveryId(parent.id, subscriber), siteId: 'test', kind: 'delivery', _etag: 'original-delivery-etag',
    campaignId: parent.id, subscriptionId: subscriber, state: 'accepted', updatedAt: old, nextAttemptAt: old,
    eventExpiresAt: '2026-09-08T00:00:00.000Z', attempts: 1, ...patch };
}
async function write(directory: string, name: string, rows: Document[]) {
  await writeFile(join(directory, name), JSON.stringify({ version: 1, documents: rows }), { mode: 0o600 });
}
async function fixture(context: { after: (callback: () => Promise<void>) => void }, rows?: Document[], messages: Document[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'webpush-retention-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parent = campaign('original-key-123');
  await write(root, documents, rows ?? [parent, delivery(parent)]);
  await write(root, queues, messages);
  return { root, parent, before: await readFile(join(root, documents)), queueBefore: await readFile(join(root, queues)) };
}
const message = (bodyId: string, queue: 'campaign' | 'delivery', kind = 'message') => ({ id: digest(`${bodyId}:${kind}`), siteId: 'local', kind,
  _etag: 'queue-etag', queue, bodyId, visibleAt: old, attempts: 1 }) as Row;

test('retention previews only; apply preserves all non-history state and restore is byte exact', async context => {
  const parent = campaign('original-key-123');
  const preserved: Row[] = ['subscription', 'quota', 'budget', 'operations', 'recovery', 'future-kind'].map(kind => ({
    id: `${kind}-kept`, siteId: 'test', kind, _etag: `${kind}-etag`, privateValue: 'fixture-only-private-material', count: 17,
  }));
  const h = await fixture(context, [parent, delivery(parent), ...preserved]);
  const plan = await planRetention(h.root, 30, now);
  assert.deepEqual(plan.campaignIds, [parent.id]); assert.equal(plan.deliveryIds.length, 1);
  assert.deepEqual(await readFile(join(h.root, documents)), h.before); assert.deepEqual(await readFile(join(h.root, queues)), h.queueBefore);
  const planBytes = await readFile(join(h.root, 'retention', `${plan.id}.plan.json`), 'utf8');
  assert.ok(!planBytes.includes('fixture-only-private-material')); assert.ok(!planBytes.includes(DEFAULT_NOTIFICATION.body));
  const result = await applyRetention(h.root, plan.id, now);
  assert.ok(result.changed); if (!result.changed) return;
  const after = JSON.parse(await readFile(join(h.root, documents), 'utf8')).documents as Row[];
  assert.deepEqual(after.filter(row => row.kind !== 'campaign-archive'), preserved);
  assert.deepEqual(Object.keys(after[0]!).sort(), ['_etag', 'archivedAt', 'id', 'kind', 'siteId']);
  assert.equal(after[0]!.id, parent.id); assert.notEqual(after[0]!._etag, parent._etag);
  assert.deepEqual(await readFile(join(h.root, queues)), h.queueBefore);
  const backup = join(h.root, 'retention', result.backupId);
  assert.deepEqual(await readFile(join(backup, documents)), h.before);
  assert.deepEqual(await readFile(join(backup, queues)), h.queueBefore);
  for (const path of [join(h.root, 'retention'), backup]) assert.equal((await stat(path)).mode & 0o077, 0);
  for (const path of [join(backup, documents), join(backup, queues), join(backup, 'manifest.json'), join(h.root, documents)]) assert.equal((await stat(path)).mode & 0o077, 0);
  await restoreRetention(h.root, result.backupId);
  assert.deepEqual(await readFile(join(h.root, documents)), h.before);
  await assert.rejects(restoreRetention(h.root, result.backupId), /changed after retention/);
  assert.equal(await localLockStatus(join(h.root, 'backend.lock')), 'free');
});

test('an archived campaign identity blocks old retries and activation without reserving quota or sending', async context => {
  const h = await fixture(context); const plan = await planRetention(h.root, 30, now); await applyRetention(h.root, plan.id, now);
  const database = new FileDocumentDatabase(join(h.root, documents));
  const manager = new CampaignManager(database, new DurableSubscriptionStore(database, 'test'), 'test', () => now);
  for (const ready of [false, true]) {
    await assert.rejects(manager.create('admin', 'original-key-123', draft, ready), error => error instanceof AppError && error.status === 409 && /archived/.test(error.message));
  }
  await assert.rejects(manager.activate(h.parent.id, 'activation-key-123'), error => error instanceof AppError && error.status === 404);
  assert.equal((await database.page('budget', 100)).items.length, 0);
  const fresh = await manager.create('admin', 'new-draft-key-123', draft);
  assert.equal(fresh.state, 'draft'); assert.notEqual(fresh.id, h.parent.id);
  assert.equal((await database.page('campaign', 100)).items.length, 1);
});

test('recent observations, live claims, unexpired capabilities and incomplete groups stay intact', async context => {
  const cases: { parent?: Partial<Campaign>; child?: Partial<Delivery>; omitChild?: boolean }[] = [
    { parent: { state: 'draft' } }, { parent: { state: 'scheduled' } }, { parent: { state: 'sending' } },
    { parent: { updatedAt: now.toISOString() } }, { parent: { createdAt: 'invalid' } },
    { parent: { dispatchLeaseId: 'live', dispatchLeaseUntil: '2026-11-20T00:00:00.000Z' } },
    { parent: { dispatchLeaseId: 'unknown-expiry' } }, { child: { state: 'processing' } },
    { parent: { state: 'cancelled' }, child: { state: 'pending' } },
    { child: { receivedAt: now.toISOString() } }, { child: { clickedAt: now.toISOString() } },
    { child: { eventExpiresAt: '2026-11-20T00:00:00.000Z' } },
    { child: { leaseId: 'live', leaseUntil: '2026-11-20T00:00:00.000Z' } },
    { child: { leaseId: 'unknown-expiry' } }, { child: { updatedAt: 'bad-date' } },
    { child: { siteId: 'different-site' } }, { omitChild: true },
  ];
  const rows = cases.flatMap((entry, index) => {
    const parent = campaign(`protected-key-${index}`, entry.parent);
    return entry.omitChild ? [parent] : [parent, delivery(parent, entry.child)];
  });
  const h = await fixture(context, rows); const plan = await planRetention(h.root, 30, now);
  assert.equal(plan.campaignIds.length, 0); assert.deepEqual(await applyRetention(h.root, plan.id, now), { changed: false });
  assert.deepEqual(await readFile(join(h.root, documents)), h.before);
  assert.equal((await readdir(join(h.root, 'retention'))).length, 1);
});

test('both queue messages and dead letters protect referenced campaign or delivery groups', async context => {
  const rows: Document[] = [], messages: Document[] = [];
  for (const [index, kind] of ['message', 'dead-letter'].entries()) {
    for (const queue of ['campaign', 'delivery'] as const) {
      const parent = campaign(`queue-key-${index}-${queue}`), child = delivery(parent);
      rows.push(parent, child); messages.push(message(queue === 'campaign' ? parent.id : child.id, queue, kind));
    }
  }
  const missingChild = campaign('cancelled-missing-child-123', { state: 'cancelled' });
  rows.push(missingChild); messages.push(message(deliveryId(missingChild.id, subscriber), 'delivery', 'dead-letter'));
  const h = await fixture(context, rows, messages); const plan = await planRetention(h.root, 30, now);
  assert.equal(plan.campaignIds.length, 0); assert.deepEqual(await readFile(join(h.root, queues)), h.queueBefore);
});

test('cancelled or failed groups with no unfinished children can archive; orphan deliveries are preserved', async context => {
  const cancelled = campaign('cancelled-key-123', { state: 'cancelled' });
  const failed = campaign('failed-key-123', { state: 'failed' });
  const orphan = delivery(campaign('missing-parent-123'));
  const h = await fixture(context, [cancelled, failed, delivery(failed, { state: 'failed' }), orphan]);
  const plan = await planRetention(h.root, 30, now);
  assert.deepEqual(plan.campaignIds, [cancelled.id, failed.id].sort()); assert.equal(plan.deliveryIds.length, 1);
  await applyRetention(h.root, plan.id, now);
  assert.deepEqual(JSON.parse(await readFile(join(h.root, documents), 'utf8')).documents.find((row: Row) => row.id === orphan.id), orphan);
});

test('a changed document or queue snapshot invalidates the reviewed plan', async context => {
  for (const name of [documents, queues]) {
    const h = await fixture(context); const plan = await planRetention(h.root, 30, now);
    const changed = Buffer.concat([await readFile(join(h.root, name)), Buffer.from('\n')]);
    await writeFile(join(h.root, name), changed);
    await assert.rejects(applyRetention(h.root, plan.id, now), /changed since preview/);
    assert.deepEqual(await readFile(join(h.root, name)), changed);
    assert.equal((await readdir(join(h.root, 'retention'))).length, 1);
  }
});

test('restore refuses newer document or queue writes and damaged backup bytes', async context => {
  for (const changedFile of ['current-documents', 'current-queues', 'backup']) {
    const h = await fixture(context); const plan = await planRetention(h.root, 30, now);
    const result = await applyRetention(h.root, plan.id, now); assert.ok(result.changed); if (!result.changed) continue;
    const target = changedFile === 'backup' ? join(h.root, 'retention', result.backupId, documents)
      : join(h.root, changedFile === 'current-documents' ? documents : queues);
    await writeFile(target, Buffer.concat([await readFile(target), Buffer.from('\n')]));
    const preserved = await readFile(join(h.root, documents));
    await assert.rejects(restoreRetention(h.root, result.backupId), /changed|refused/);
    assert.deepEqual(await readFile(join(h.root, documents)), preserved);
  }
});

test('invalid, expired or modified plans cannot mutate local state', async context => {
  const h = await fixture(context);
  for (const days of [0, 29, 30.5, 3651, NaN]) await assert.rejects(planRetention(h.root, days, now), /30 to 3650/);
  const plan = await planRetention(h.root, 30, now);
  for (const time of [new Date(now.getTime() - 1), new Date(now.getTime() + 86400001)]) await assert.rejects(applyRetention(h.root, plan.id, time), /24 hours/);
  await assert.rejects(applyRetention(h.root, '../escape', now), /plan ID/);
  await assert.rejects(restoreRetention(h.root, '../escape'), /backup ID/);
  await writeFile(join(h.root, 'retention', `${plan.id}.plan.json`), JSON.stringify({ ...plan, campaignIds: [] }));
  await assert.rejects(applyRetention(h.root, plan.id, now), /verify the retention plan/);
  assert.deepEqual(await readFile(join(h.root, documents)), h.before);
});

test('malformed snapshots, duplicate IDs, unknown queue formats and unlinked deliveries fail closed', async context => {
  const h = await fixture(context);
  for (const value of ['{invalid', JSON.stringify({ version: 2, documents: [] }), JSON.stringify({ version: 1, documents: [h.parent, h.parent] }),
    JSON.stringify({ version: 1, documents: [{ ...delivery(h.parent), campaignId: undefined }] })]) {
    await writeFile(join(h.root, documents), value);
    await assert.rejects(planRetention(h.root, 30, now), /snapshot|identity/);
    assert.equal(await readFile(join(h.root, documents), 'utf8'), value);
  }
  await writeFile(join(h.root, documents), h.before);
  await write(h.root, queues, [{ ...message(h.parent.id, 'campaign'), kind: 'unknown-queue-format' }]);
  await assert.rejects(planRetention(h.root, 30, now), /Unknown queue record/);
  assert.deepEqual(await readFile(join(h.root, documents)), h.before);
});

test('active and stale backend locks both prevent preview or retention', async context => {
  const h = await fixture(context); const release = await acquireLocalLock(join(h.root, 'backend.lock'));
  await assert.rejects(planRetention(h.root, 30, now), /Another process/); await release();
  await writeFile(join(h.root, 'backend.lock'), JSON.stringify({ version: 1, pid: 2147483647, nonce: 'stale' }), { mode: 0o600 });
  await assert.rejects(planRetention(h.root, 30, now), /stale lock/);
  assert.deepEqual(await readFile(join(h.root, documents)), h.before);
});

test('linked or public files and artifact directories cannot be used for retention', async context => {
  const h = await fixture(context);
  const source = join(h.root, 'original.json'); await writeFile(source, h.before, { mode: 0o600 });
  await rm(join(h.root, documents)); await symlink(source, join(h.root, documents));
  await assert.rejects(planRetention(h.root, 30, now)); assert.deepEqual(await readFile(source), h.before);
  await rm(join(h.root, documents)); await link(source, join(h.root, documents));
  await assert.rejects(planRetention(h.root, 30, now), /without links/);
  await rm(join(h.root, documents)); await writeFile(join(h.root, documents), h.before, { mode: 0o644 });
  await assert.rejects(planRetention(h.root, 30, now), /private regular files/);
  await chmod(join(h.root, documents), 0o600);
  const outside = join(h.root, 'outside'); await mkdir(outside, { mode: 0o700 });
  await rm(join(h.root, 'retention'), { recursive: true, force: true }); await symlink(outside, join(h.root, 'retention'));
  await assert.rejects(planRetention(h.root, 30, now), /without symbolic links/);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(planRetention(join(h.root, 'retention'), 30, now), /without symbolic links/);
});

test('backup setup failure leaves live data unchanged; a second apply cannot remove more history', async context => {
  const h = await fixture(context); const plan = await planRetention(h.root, 30, now);
  // Prevent any backup directory from being created; no live rewrite is allowed.
  await chmod(join(h.root, 'retention'), 0o500);
  try { await assert.rejects(applyRetention(h.root, plan.id, now)); }
  finally { await chmod(join(h.root, 'retention'), 0o700); }
  assert.deepEqual(await readFile(join(h.root, documents)), h.before);
  const result = await applyRetention(h.root, plan.id, now); assert.ok(result.changed);
  const after = await readFile(join(h.root, documents));
  await assert.rejects(applyRetention(h.root, plan.id, now), /changed since preview/);
  assert.deepEqual(await readFile(join(h.root, documents)), after);
  const nextPlan = await planRetention(h.root, 30, now); assert.deepEqual(await applyRetention(h.root, nextPlan.id, now), { changed: false });
});

test('a missing queue file remains absent through apply and byte-exact undo', async context => {
  const h = await fixture(context); await rm(join(h.root, queues));
  const plan = await planRetention(h.root, 30, now); assert.equal(plan.before.queues, null);
  const result = await applyRetention(h.root, plan.id, now); assert.ok(result.changed); if (!result.changed) return;
  await restoreRetention(h.root, result.backupId);
  assert.deepEqual(await readFile(join(h.root, documents)), h.before);
  await assert.rejects(readFile(join(h.root, queues)), { code: 'ENOENT' });
});
