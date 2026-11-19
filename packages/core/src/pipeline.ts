import { createHash, randomUUID } from 'node:crypto';
import { AppError, parseNotification, type PushSender } from './index.js';
import { change, type Campaign, type Delivery, type Document, type DocumentDatabase, type QueuePublisher, type DurableSubscriptionStore } from './durable.js';

export const message = (id: string) => ({ version: 1 as const, id });
export function messageId(value: unknown): string {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('id' in value)
    || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id)) throw new Error('Invalid queue envelope.');
  return value.id;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const subscriptionId = (endpoint: string) => hash(`subscription:${endpoint}`);

interface Counter extends Document { count: number }
interface PipelineOptions {
  database: DocumentDatabase;
  subscriptions: DurableSubscriptionStore;
  queue: QueuePublisher;
  sender: PushSender;
  siteId: string;
  dailyAttemptLimit: number;
  now?: () => Date;
}

export class DeliveryPipeline {
  private readonly clock: () => Date;
  constructor(private readonly options: PipelineOptions) { this.clock = options.now ?? (() => new Date()); }

  async submit(createdBy: string, key: string, input: unknown, ids: string[]): Promise<{ id: string; state: Campaign['state'] }> {
    if (!/^[\w-]{8,80}$/.test(key)) throw new AppError(400, 'Provide an Idempotency-Key containing 8–80 letters, digits, underscores, or hyphens.');
    const content = parseNotification(input);
    const subscriptionIds = [...new Set(ids)].sort();
    if (!subscriptionIds.length || subscriptionIds.length > 100 || subscriptionIds.some(id => !/^[a-f0-9]{64}$/.test(id))) {
      throw new AppError(400, 'Select 1–100 valid subscription IDs.');
    }
    const id = hash(`campaign:${this.options.siteId}:${createdBy}:${key}`);
    const campaign: Campaign = { id, siteId: this.options.siteId, kind: 'campaign', createdBy,
      createdAt: this.clock().toISOString(), content, subscriptionIds, state: 'pending', ttl: 604800 };
    const existing = await this.options.database.read<Campaign>(id);
    if (existing) {
      if (JSON.stringify(existing.content) !== JSON.stringify(content)
        || JSON.stringify(existing.subscriptionIds) !== JSON.stringify(subscriptionIds)) {
        throw new AppError(409, 'This idempotency key was already used for a different campaign.');
      }
      return { id, state: existing.state };
    }
    const counterId = `campaigns-${this.clock().toISOString().slice(0, 10)}`;
    await this.options.database.create({ id: counterId, siteId: this.options.siteId, kind: 'budget', count: 0, ttl: 172800 } as Counter);
    let created = false;
    for (let retry = 0; retry < 8; retry++) {
      const counter = await this.options.database.read<Counter>(counterId);
      if (!counter?._etag) throw new Error('Campaign budget unavailable.');
      if (counter.count >= 100) throw new AppError(429, 'The daily demonstration campaign limit has been reached.');
      if (await this.options.database.transact([
        { type: 'create', document: campaign },
        { type: 'replace', document: { ...counter, count: counter.count + 1 } as Counter, etag: counter._etag },
      ])) { created = true; break; }
      if (await this.options.database.read<Campaign>(id)) return this.submit(createdBy, key, input, ids);
    }
    if (!created) throw new AppError(503, 'Campaign submission is busy. Retry shortly.');
    await this.publishCampaign(id);
    return { id, state: (await this.options.database.read<Campaign>(id))!.state };
  }

  private async publishCampaign(id: string) {
    try {
      await this.options.queue.campaign(id);
      await change<Campaign>(this.options.database, id, record => record.state === 'pending' ? { ...record, state: 'queued' } : record);
    } catch { /* The persisted pending campaign is an outbox entry; the timer retries it. */ }
  }

  async fanOut(id: string) {
    const campaign = await this.options.database.read<Campaign>(id);
    if (!campaign || campaign.kind !== 'campaign') throw new Error('Campaign does not exist.');
    for (const subscriptionId of campaign.subscriptionIds) {
      const deliveryId = hash(`delivery:${id}:${subscriptionId}`);
      const now = this.clock().toISOString();
      const delivery: Delivery = { id: deliveryId, siteId: this.options.siteId, kind: 'delivery', campaignId: id,
        subscriptionId, state: 'pending', attempts: 0, updatedAt: now, nextAttemptAt: now, ttl: 604800 };
      await this.options.database.create(delivery);
      const stored = await this.options.database.read<Delivery>(deliveryId);
      if (stored && ['pending', 'queued'].includes(stored.state)) await this.publishDelivery(stored);
    }
    await change<Campaign>(this.options.database, id, record => ({ ...record, state: 'sending' }));
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
      if (!delivery || delivery.kind !== 'delivery' || ['accepted', 'expired', 'failed'].includes(delivery.state)) return;
      if (new Date(delivery.nextAttemptAt) > now || (delivery.state === 'processing' && new Date(delivery.leaseUntil!) > now)) return;
      const counter = await this.options.database.read<Counter>(counterId);
      if (!counter?._etag) throw new Error('Attempt budget is unavailable.');
      if (delivery.attempts >= 5 || counter.count >= this.options.dailyAttemptLimit) {
        if (await this.options.database.replace({ ...delivery, state: 'failed', reason: delivery.attempts >= 5 ? 'retry_limit' : 'daily_limit', updatedAt: now.toISOString() } as Delivery, delivery._etag!)) return;
        continue;
      }
      const claimed: Delivery = { ...delivery, state: 'processing', attempts: delivery.attempts + 1,
        leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + 120_000).toISOString(), updatedAt: now.toISOString() };
      if (await this.options.database.transact([
        { type: 'replace', document: claimed, etag: delivery._etag! },
        { type: 'replace', document: { ...counter, count: counter.count + 1 } as Counter, etag: counter._etag },
      ])) return claimed;
    }
    throw new Error('Could not acquire delivery claim.');
  }

  async deliver(id: string) {
    const job = await this.claim(id);
    if (!job) return;
    const finish = async (state: Delivery['state'], reason?: string, providerStatus?: number) => {
      await change<Delivery>(this.options.database, id, current => current.leaseId !== job.leaseId ? current : ({
        ...current, state, reason, providerStatus, leaseId: undefined, leaseUntil: undefined,
        updatedAt: this.clock().toISOString(), nextAttemptAt: new Date(this.clock().getTime() + Math.min(300_000, 30_000 * 2 ** (job.attempts - 1))).toISOString(),
      }));
    };
    const subscription = await this.options.subscriptions.get(job.subscriptionId);
    const campaign = await this.options.database.read<Campaign>(job.campaignId);
    if (!subscription || (subscription.subscription.expirationTime && subscription.subscription.expirationTime < this.clock().getTime())) {
      await this.options.subscriptions.remove(job.subscriptionId); await finish('expired', 'subscription_expired'); return;
    }
    if (!campaign || campaign.kind !== 'campaign') { await finish('failed', 'campaign_missing'); return; }
    let status: number;
    try {
      status = (await this.options.sender.send(subscription.subscription, {
        ...campaign.content, version: 1, notificationId: id, sentAt: this.clock().toISOString(),
      })).statusCode;
    } catch (error) { status = Number((error as { statusCode?: number }).statusCode) || 503; }
    if (status >= 200 && status < 300) {
      await finish('accepted', undefined, status);
      await this.options.subscriptions.markAccepted(job.subscriptionId, this.clock().toISOString());
    } else if ([404, 410].includes(status)) {
      await this.options.subscriptions.remove(job.subscriptionId); await finish('expired', 'provider_expired', status);
    } else if (status === 408 || status === 429 || status >= 500) {
      await finish(job.attempts >= 5 ? 'failed' : 'pending', job.attempts >= 5 ? 'retry_limit' : 'provider_retry', status);
    } else await finish('failed', 'provider_rejected', status);
  }

  async reconcile() {
    // Phase 2 is deliberately bounded to a small demonstration audience.
    const campaigns = await this.options.database.page<Campaign>('campaign', 100, undefined, ['pending']);
    for (const campaign of campaigns.items) if (campaign.state === 'pending') await this.publishCampaign(campaign.id);
    const deliveries = await this.options.database.page<Delivery>('delivery', 100, undefined, ['pending', 'queued', 'processing']);
    const now = this.clock();
    for (const delivery of deliveries.items) {
      const due = delivery.state === 'pending' && new Date(delivery.nextAttemptAt) <= now;
      const abandoned = delivery.state === 'processing' && new Date(delivery.leaseUntil!) <= now;
      const stale = delivery.state === 'queued' && now.getTime() - new Date(delivery.updatedAt).getTime() >= 120_000;
      if (due || abandoned || stale) await this.publishDelivery(delivery);
    }
  }
}
