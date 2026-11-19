import { randomUUID } from 'node:crypto';
import { type PushSender } from './index.js';
import { change, type Campaign, type Delivery, type Document, type DocumentDatabase, type QueuePublisher, type DurableSubscriptionStore, type Write } from './durable.js';
import { CampaignManager, deliveryId, digest, terminalCampaign } from './campaigns.js';
import { DeliveryControls } from './operations.js';
import { DeliveryReports } from './reports.js';

export const message = (id: string) => ({ version: 1 as const, id });
export function messageId(value: unknown): string {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('id' in value)
    || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id)) throw new Error('Invalid queue envelope.');
  return value.id;
}
export const subscriptionId = (endpoint: string) => digest(`subscription:${endpoint}`);
export const terminalDelivery = (state: Delivery['state']) => ['accepted', 'expired', 'failed', 'cancelled'].includes(state);

interface Counter extends Document { count: number }
interface RecoveryCursor extends Document { cursor?: string }
interface PipelineOptions {
  database: DocumentDatabase;
  subscriptions: DurableSubscriptionStore;
  queue: QueuePublisher;
  sender: PushSender;
  siteId: string;
  dailyAttemptLimit: number;
  now?: () => Date;
  eventSecret?: string;
  eventBaseUrl?: string;
}

/** Provider Retry-After is a minimum; very long delays fail the bounded demo job. */
export function retryDelay(value: unknown, now: Date): number | undefined {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : undefined;
}

export class DeliveryPipeline {
  private readonly clock: () => Date;
  readonly campaigns: CampaignManager;
  readonly controls: DeliveryControls;
  readonly reports: DeliveryReports;
  constructor(private readonly options: PipelineOptions) {
    this.clock = options.now ?? (() => new Date());
    this.campaigns = new CampaignManager(options.database, options.subscriptions, options.siteId, this.clock);
    this.controls = new DeliveryControls(options.database, options.siteId, this.clock);
    this.reports = new DeliveryReports(options.database, options.siteId, this.clock, options.eventSecret, options.eventBaseUrl);
  }

  async submit(createdBy: string, key: string, input: unknown, ids: string[]): Promise<{ id: string; state: Campaign['state'] }> {
    const campaign = await this.campaigns.create(createdBy, key, { content: input, audience: { type: 'selected', subscriptionIds: ids } }, true);
    if (campaign.state === 'pending') await this.publishCampaign(campaign.id);
    const stored = await this.campaigns.get(campaign.id);
    return { id: stored.id, state: stored.state };
  }

  async activate(id: string, key: string, scheduledAt?: unknown, expected?: { fingerprint?: string; version?: string }) {
    const campaign = await this.campaigns.activate(id, key, scheduledAt, expected);
    if (campaign.state === 'pending') await this.publishCampaign(id);
    return this.campaigns.get(id);
  }

  private async publishCampaign(id: string) {
    try {
      const campaign = await this.campaigns.get(id);
      if (!['pending', 'queued', 'dispatching'].includes(campaign.state)) return;
      await this.options.queue.campaign(id);
      if (campaign.state === 'pending') await this.options.database.replace({ ...campaign, state: 'queued', updatedAt: this.clock().toISOString() } as Campaign, campaign._etag!);
    } catch { /* The campaign is a durable outbox entry; recovery retries publication. */ }
  }

  async fanOut(id: string) {
    let claimed: Campaign | undefined;
    for (let retry = 0; retry < 8; retry++) {
      const campaign = await this.campaigns.get(id);
      if (terminalCampaign(campaign.state) || campaign.state === 'draft') return;
      const controls = await this.controls.get();
      if (controls.dispatchPaused) {
        if (campaign.state === 'queued') await this.options.database.replace({ ...campaign, state: 'pending' } as Campaign, campaign._etag!);
        return;
      }
      if (campaign.scheduledAt && Date.parse(campaign.scheduledAt) > this.clock().getTime()) return;
      if (campaign.state === 'sending') { await this.refreshCampaign(id); return; }
      if (campaign.dispatchLeaseUntil && Date.parse(campaign.dispatchLeaseUntil) > this.clock().getTime()) return;
      const leaseId = randomUUID();
      if (await this.options.database.transact([
        { type: 'replace', document: { ...campaign, state: 'dispatching', dispatchLeaseId: leaseId,
          dispatchLeaseUntil: new Date(this.clock().getTime() + 120_000).toISOString() } as Campaign, etag: campaign._etag! },
        { type: 'replace', document: controls, etag: controls._etag! },
      ])) {
        const stored = await this.campaigns.get(id);
        if (stored.dispatchLeaseId !== leaseId || stored.state === 'cancelled') return;
        claimed = stored; break;
      }
    }
    if (!claimed) throw new Error('Could not acquire a campaign dispatch lease.');
    const start = claimed.dispatchIndex ?? 0;
    const end = Math.min(start + 25, claimed.subscriptionIds.length);
    const now = this.clock().toISOString();
    const writes: Write[] = [];
    const ids = claimed.subscriptionIds.slice(start, end).map(subscriptionId => {
      const id = deliveryId(claimed!.id, subscriptionId);
      return { id, siteId: this.options.siteId, kind: 'delivery' as const, campaignId: claimed!.id,
        subscriptionId, state: 'pending' as const, attempts: 0, updatedAt: now, nextAttemptAt: now,
        eventExpiresAt: new Date(this.clock().getTime() + 604800000).toISOString(), ttl: 604800 };
    });
    for (const delivery of ids) if (!await this.options.database.read<Delivery>(delivery.id)) writes.push({ type: 'create', document: delivery });
    const next: Campaign = { ...claimed, dispatchIndex: end, state: end < claimed.subscriptionIds.length ? 'pending' : 'sending',
      dispatchLeaseId: undefined, dispatchLeaseUntil: undefined, updatedAt: now };
    writes.push({ type: 'replace', document: next, etag: claimed._etag! });
    const controls = await this.controls.get();
    if (controls.dispatchPaused) {
      await this.options.database.replace({ ...claimed, state: 'pending', dispatchLeaseId: undefined, dispatchLeaseUntil: undefined } as Campaign, claimed._etag!);
      return;
    }
    writes.push({ type: 'replace', document: controls, etag: controls._etag! });
    // Page rows and the continuation checkpoint commit together. Cancellation invalidates this batch.
    if (!await this.options.database.transact(writes)) {
      if ((await this.campaigns.get(id)).state === 'cancelled') return;
      throw new Error('Campaign dispatch changed; retry after its lease expires.');
    }
    for (const entry of ids) {
      const delivery = await this.options.database.read<Delivery>(entry.id);
      if (delivery && ['pending', 'queued'].includes(delivery.state)) {
        try { await this.publishDelivery(delivery); } catch { /* Pending jobs recover independently. */ }
      }
    }
    if (next.state === 'pending') await this.publishCampaign(id);
    else await this.refreshCampaign(id);
  }

  private async publishDelivery(delivery: Delivery) {
    await this.options.queue.delivery(delivery.id);
    // A fast worker may already have claimed this document. Its state wins.
    await this.options.database.replace({ ...delivery, state: 'queued', updatedAt: this.clock().toISOString() } as Delivery, delivery._etag!);
  }

  private async claim(id: string): Promise<Delivery | undefined> {
    const now = this.clock();
    const counterId = `attempts-${now.toISOString().slice(0, 10)}`;
    await this.options.database.create({ id: counterId, siteId: this.options.siteId, kind: 'budget', count: 0, ttl: 172800 } as Counter);
    for (let retry = 0; retry < 8; retry++) {
      const delivery = await this.options.database.read<Delivery>(id);
      if (!delivery || delivery.kind !== 'delivery' || terminalDelivery(delivery.state)) return;
      const campaign = await this.options.database.read<Campaign>(delivery.campaignId);
      const stopped = !campaign || campaign.state === 'cancelled' || campaign.state === 'draft' || campaign.state === 'failed';
      if (stopped) {
        if (await this.options.database.replace({ ...delivery, state: campaign?.state === 'cancelled' ? 'cancelled' : 'failed',
          reason: campaign?.state === 'cancelled' ? 'campaign_cancelled' : 'campaign_unavailable', updatedAt: now.toISOString() } as Delivery, delivery._etag!)) return;
        continue;
      }
      const controls = await this.controls.get();
      if (controls.sendingPaused) {
        if (delivery.state === 'queued') await this.options.database.replace({ ...delivery, state: 'pending' } as Delivery, delivery._etag!);
        return;
      }
      if (campaign.scheduledAt && Date.parse(campaign.scheduledAt) > now.getTime()) return;
      if (new Date(delivery.nextAttemptAt) > now || (delivery.state === 'processing' && new Date(delivery.leaseUntil!) > now)) return;
      const counter = await this.options.database.read<Counter>(counterId);
      if (!counter?._etag) throw new Error('Attempt budget is unavailable.');
      if (delivery.attempts >= 5 || counter.count >= this.options.dailyAttemptLimit) {
        if (await this.options.database.replace({ ...delivery, state: 'failed', reason: delivery.attempts >= 5 ? 'retry_limit' : 'daily_limit', updatedAt: now.toISOString() } as Delivery, delivery._etag!)) return;
        continue;
      }
      const claimed: Delivery = { ...delivery, state: 'processing', attempts: delivery.attempts + 1,
        leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + 120_000).toISOString(), updatedAt: now.toISOString() };
      // The campaign guard serializes cancellation with acquisition of a send claim.
      if (await this.options.database.transact([
        { type: 'replace', document: claimed, etag: delivery._etag! },
        { type: 'replace', document: campaign, etag: campaign._etag! },
        { type: 'replace', document: controls, etag: controls._etag! },
        { type: 'replace', document: { ...counter, count: counter.count + 1 } as Counter, etag: counter._etag },
      ])) return claimed;
    }
    throw new Error('Could not acquire delivery claim.');
  }

  async deliver(id: string) {
    const job = await this.claim(id);
    if (!job) {
      const saved = await this.options.database.read<Delivery>(id);
      if (saved) await this.refreshCampaign(saved.campaignId);
      return;
    }
    const finish = async (state: Delivery['state'], reason?: string, providerStatus?: number, minimumDelay = 0) => {
      await change<Delivery>(this.options.database, id, current => current.leaseId !== job.leaseId ? current : ({
        ...current, state, reason, providerStatus, leaseId: undefined, leaseUntil: undefined,
        updatedAt: this.clock().toISOString(), nextAttemptAt: new Date(this.clock().getTime() + Math.max(minimumDelay, Math.min(300_000, 30_000 * 2 ** (job.attempts - 1)))).toISOString(),
      }));
      await this.refreshCampaign(job.campaignId);
    };
    const subscription = await this.options.subscriptions.get(job.subscriptionId);
    const campaign = await this.options.database.read<Campaign>(job.campaignId);
    if (!campaign || campaign.state === 'cancelled') { await finish('cancelled', 'campaign_cancelled'); return; }
    if ((await this.controls.get()).sendingPaused) { await finish('pending', 'sending_paused'); return; }
    if (!subscription || (subscription.subscription.expirationTime && subscription.subscription.expirationTime <= this.clock().getTime())) {
      await this.options.subscriptions.remove(job.subscriptionId); await finish('expired', 'subscription_expired'); return;
    }
    let status: number;
    let minimumDelay = 0;
    try {
      status = (await this.options.sender.send(subscription.subscription, {
        ...campaign.content, version: 1, notificationId: id, sentAt: this.clock().toISOString(), reporting: this.reports.payload(job),
      })).statusCode;
    } catch (error) {
      const response = error as { statusCode?: number; headers?: Record<string, unknown> };
      status = Number(response.statusCode) || 503;
      minimumDelay = retryDelay(response.headers?.['retry-after'], this.clock()) ?? 0;
    }
    if (status >= 200 && status < 300) {
      await finish('accepted', undefined, status);
      await this.options.subscriptions.markAccepted(job.subscriptionId, this.clock().toISOString());
    } else if ([404, 410].includes(status)) {
      await this.options.subscriptions.remove(job.subscriptionId); await finish('expired', 'provider_expired', status);
    } else if (status === 408 || status === 429 || status >= 500) {
      if (minimumDelay > 86400000) await finish('failed', 'retry_after_exceeds_window', status);
      else await finish(job.attempts >= 5 ? 'failed' : 'pending', job.attempts >= 5 ? 'retry_limit' : 'provider_retry', status, minimumDelay);
    } else await finish('failed', 'provider_rejected', status);
  }

  async refreshCampaign(id: string) {
    for (let retry = 0; retry < 8; retry++) {
      const campaign = await this.options.database.read<Campaign>(id);
      if (!campaign || campaign.state !== 'sending') return;
      const deliveries = await Promise.all(campaign.subscriptionIds.map(sub => this.options.database.read<Delivery>(deliveryId(id, sub))));
      if (deliveries.some(delivery => !delivery || !terminalDelivery(delivery.state))) return;
      const state = deliveries.every(delivery => delivery?.state === 'accepted') ? 'completed' : 'completed_with_failures';
      if (await this.options.database.replace({ ...campaign, state, dispatchIndex: campaign.subscriptionIds.length, updatedAt: this.clock().toISOString() } as Campaign, campaign._etag!)) return;
    }
  }

  private async scan<T extends Document>(kind: string, states: string[], visit: (document: T) => Promise<void>) {
    const id = `recovery-${kind}`;
    await this.options.database.create({ id, siteId: this.options.siteId, kind: 'recovery' } as RecoveryCursor);
    const checkpoint = (await this.options.database.read<RecoveryCursor>(id))!;
    const page = await this.options.database.page<T>(kind, 100, checkpoint.cursor, states);
    let failed = false;
    for (const record of page.items) {
      try { await visit(record); } catch { failed = true; }
    }
    // Keep the cursor between invocations; conflicting scanners may repeat a page safely.
    await this.options.database.replace({ ...checkpoint, cursor: page.cursor } as RecoveryCursor, checkpoint._etag!);
    return failed;
  }

  async reconcile() {
    const now = this.clock();
    const controls = await this.controls.get();
    const campaignFailure = await this.scan<Campaign>('campaign', ['scheduled', 'pending', 'queued', 'dispatching', 'sending'], async campaign => {
      if (controls.dispatchPaused && campaign.state !== 'sending') return;
      if (campaign.state === 'scheduled' && Date.parse(campaign.scheduledAt!) <= now.getTime()) {
        if (await this.options.database.replace({ ...campaign, state: 'pending', updatedAt: now.toISOString() } as Campaign, campaign._etag!)) await this.publishCampaign(campaign.id);
      } else if (campaign.state === 'pending'
        || (campaign.state === 'queued' && now.getTime() - Date.parse(campaign.updatedAt ?? campaign.createdAt) >= 120_000)
        || (campaign.state === 'dispatching' && Date.parse(campaign.dispatchLeaseUntil!) <= now.getTime())) await this.publishCampaign(campaign.id);
      else if (campaign.state === 'sending') await this.refreshCampaign(campaign.id);
    });
    const deliveryFailure = await this.scan<Delivery>('delivery', ['pending', 'queued', 'processing'], async delivery => {
      const campaign = await this.options.database.read<Campaign>(delivery.campaignId);
      if (!campaign || campaign.state === 'cancelled') {
        if (delivery.state !== 'processing' || Date.parse(delivery.leaseUntil!) <= now.getTime()) {
          await this.options.database.replace({ ...delivery, state: 'cancelled', reason: 'campaign_cancelled', updatedAt: now.toISOString() } as Delivery, delivery._etag!);
        }
        return;
      }
      const due = delivery.state === 'pending' && new Date(delivery.nextAttemptAt) <= now;
      const abandoned = delivery.state === 'processing' && new Date(delivery.leaseUntil!) <= now;
      const stale = delivery.state === 'queued' && now.getTime() - new Date(delivery.updatedAt).getTime() >= 120_000;
      if (!controls.sendingPaused && (due || abandoned || stale)) await this.publishDelivery(delivery);
    });
    if (campaignFailure || deliveryFailure) throw new Error('Some recovery records will retry on the next scan.');
  }
}
