import { createECDH, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MemoryDocumentDatabase } from '../../packages/adapters/src/memory-database.js';
import { DurableSubscriptionStore, type Campaign, type Delivery, type Document, type DocumentDatabase, type Write } from '../../packages/core/src/durable.js';
import { DeliveryPipeline, subscriptionId } from '../../packages/core/src/pipeline.js';
import { CONTENT, distribution, fingerprint, workload, type Attempt, type Outcome, type Workload } from '../benchmark/model.js';
import { MockHttpSender } from '../benchmark/mock-sender.js';
import type { StoredSubscription } from '../../packages/core/src/index.js';

class MeasuredDatabase implements DocumentDatabase {
  private readonly inner = new MemoryDocumentDatabase();
  readonly operations = { reads: 0, creates: 0, replaces: 0, transactions: 0, transactionWrites: 0, pages: 0 };
  read<T extends Document>(id: string) { this.operations.reads++; return this.inner.read<T>(id); }
  create(document: Document) { this.operations.creates++; return this.inner.create(document); }
  replace(document: Document, etag: string) { this.operations.replaces++; return this.inner.replace(document, etag); }
  transact(writes: Write[]) { this.operations.transactions++; this.operations.transactionWrites += writes.length; return this.inner.transact(writes); }
  page<T extends Document>(kind: string, limit: number, cursor?: string, states?: string[]) { this.operations.pages++; return this.inner.page<T>(kind, limit, cursor, states); }
}
export async function executeRun(runId: string, spec: Workload, provider: { origin: string; token: string; delayMs: number }, signal: AbortSignal) {
  spec = workload(spec);
  const database = new MeasuredDatabase();
  class SyntheticSubscriptions extends DurableSubscriptionStore {
    override async list(): Promise<StoredSubscription[]> {
      const rows: StoredSubscription[] = []; let cursor: string | undefined;
      do { const page = await database.page<Document & StoredSubscription>('subscription', 100, cursor); rows.push(...page.items); cursor = page.cursor; } while (cursor);
      return rows;
    }
  }
  const subscriptions = new SyntheticSubscriptions(database, 'benchmark');
  const campaigns: string[] = []; const jobs: { id: string; enqueued: number }[] = [];
  const queueWait = new Map<string, number>(); const attempts: Attempt[] = []; const outcomes: Outcome[] = [];
  const sender = new MockHttpSender({ ...provider, runId, queueWait: id => queueWait.get(id) ?? 0, record: row => attempts.push(row) });
  const pipeline = new DeliveryPipeline({ database, subscriptions, sender, siteId: 'benchmark', dailyAttemptLimit: spec.audience * 5,
    queue: { async campaign(id) { campaigns.push(id); }, async delivery(id) { jobs.push({ id, enqueued: performance.now() }); } } });
  const check = () => { if (signal.aborted) throw new Error('Research run aborted.'); };
  const curve = createECDH('prime256v1'); curve.setPrivateKey(createHash('sha256').update('synthetic-benchmark-fixture-key').digest());
  const ids: string[] = []; const seededAt = performance.now();
  const rssBefore = process.memoryUsage().rss; const cpuBefore = process.cpuUsage();
  for (let index = 0; index < spec.audience; index++) {
    check(); const endpoint = `https://fcm.googleapis.com/wp/benchmark-${spec.seed}-${index}`; const id = subscriptionId(endpoint); ids.push(id);
    await subscriptions.insert({ id, subscription: { endpoint, expirationTime: null, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } },
      tokenHash: 'synthetic-only', createdAt: new Date().toISOString() }, spec.audience);
  }
  const submittedAt = performance.now(); const campaignIds: string[] = [];
  // Preserve the real campaign recipient limit; larger synthetic audiences use batches of 100.
  for (let start = 0; start < ids.length; start += 100) {
    check(); const campaign = await pipeline.submit('benchmark', `${runId}-${start}`, CONTENT, ids.slice(start, start + 100)); campaignIds.push(campaign.id);
  }
  while (campaigns.length) { check(); await pipeline.fanOut(campaigns.shift()!); }
  const dispatchedAt = performance.now();
  const workers = await Promise.allSettled(Array.from({ length: spec.concurrency }, async () => {
    for (;;) {
      check(); const item = jobs.shift(); if (!item) return;
      queueWait.set(item.id, performance.now() - item.enqueued);
      await pipeline.deliver(item.id);
      const row = await database.read<Delivery>(item.id);
      if (!row || row.state !== 'accepted') throw new Error('Healthy local baseline did not accept every delivery. No performance claim is produced.');
      outcomes.push({ deliveryId: item.id, state: row.state, attempts: row.attempts, endToEndMs: performance.now() - submittedAt });
    }
  }));
  const failure = workers.find(row => row.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  for (const id of campaignIds) {
    await pipeline.refreshCampaign(id);
    if ((await database.read<Campaign>(id))?.state !== 'completed') throw new Error('Baseline campaign did not complete.');
  }
  const finishedAt = performance.now(); const cpu = process.cpuUsage(cpuBefore);
  if (outcomes.length !== spec.audience || attempts.length !== spec.audience || new Set(attempts.map(row => row.deliveryId)).size !== spec.audience) throw new Error('Baseline outcome accounting mismatch.');
  return { runId, spec, workloadSha256: fingerprint(spec, provider.delayMs), scope: 'always-on local baseline; memory adapters; loopback mock; no Web Push encryption',
    scheduler: 'phased fan-out, then bounded-parallel delivery', virtualClock: false, accepted: outcomes.length, failed: 0,
    seedMs: submittedAt - seededAt, dispatchMs: dispatchedAt - submittedAt, deliveryStageMs: finishedAt - dispatchedAt, elapsedMs: finishedAt - submittedAt,
    acceptedPerSecond: outcomes.length / ((finishedAt - submittedAt) / 1000), rssBeforeBytes: rssBefore, rssAfterBytes: process.memoryUsage().rss,
    cpuMs: (cpu.user + cpu.system) / 1000, databaseOperations: database.operations,
    latencyMs: { endToEnd: distribution(outcomes.map(row => row.endToEndMs)), queueWait: distribution(attempts.map(row => row.queueWaitMs)), providerRequest: distribution(attempts.map(row => row.requestMs)) },
    attempts, outcomes };
}
export type RunResult = Awaited<ReturnType<typeof executeRun>>;
