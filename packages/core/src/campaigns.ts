import { createHash } from 'node:crypto';
import { AppError, parseNotification, parseTags, type NotificationContent } from './index.js';
export { parseTags } from './index.js';
import type { Audience, Campaign, Document, DocumentDatabase, DurableSubscriptionStore, SubscriptionDocument } from './durable.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const deliveryId = (campaignId: string, subscriptionId: string) => digest(`delivery:${campaignId}:${subscriptionId}`);
export const terminalCampaign = (state: Campaign['state']) => ['completed', 'completed_with_failures', 'cancelled', 'failed'].includes(state);
export function idempotencyKey(key: string) {
  if (!/^[\w-]{8,80}$/.test(key)) throw new AppError(400, 'Provide an Idempotency-Key containing 8–80 letters, digits, underscores, or hyphens.');
  return key;
}
export function parseAudience(value: unknown): Audience {
  const input = value as Record<string, unknown> | undefined;
  if (input?.type === 'all') return { type: 'all' };
  if (input?.type === 'tags') {
    const tags = parseTags(input.tags);
    if (!tags.length) throw new AppError(400, 'Select at least one target tag.');
    return { type: 'tags', tags };
  }
  if (input?.type === 'selected' && Array.isArray(input.subscriptionIds)) {
    const ids = input.subscriptionIds;
    if (ids.length && ids.length <= 100 && ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))) {
      return { type: 'selected', subscriptionIds: [...new Set(ids as string[])].sort() };
    }
  }
  throw new AppError(400, 'Choose all subscribers, matching tags, or 1–100 valid subscription IDs.');
}
export function parseDraft(value: unknown): { name: string; content: NotificationContent; audience: Audience } {
  const input = value as Record<string, unknown> | undefined;
  const content = parseNotification(input?.content);
  const name = input?.name ?? content.title;
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new AppError(400, 'Campaign name must contain 1–100 characters.');
  return { name: name.trim(), content, audience: parseAudience(input?.audience) };
}

interface Counter extends Document { count: number }
export class CampaignManager {
  constructor(private readonly database: DocumentDatabase, private readonly subscriptions: DurableSubscriptionStore,
    private readonly siteId: string, private readonly now: () => Date) {}

  async get(id: string): Promise<Campaign> {
    const campaign = await this.database.read<Campaign>(id);
    if (!campaign || campaign.kind !== 'campaign') throw new AppError(404, 'Campaign not found.');
    return campaign;
  }
  private version(record: Document, version: string) {
    if (!version) throw new AppError(428, 'Read the current version and supply its ETag in If-Match.');
    if (record._etag !== version) throw new AppError(412, 'This record changed. Read it again before editing.');
  }
  async preview(input: unknown) {
    const audience = parseAudience(input);
    const records = (await this.subscriptions.list()).filter(row => !row.subscription.expirationTime || row.subscription.expirationTime > this.now().getTime());
    const matched = records.filter(row => audience.type === 'all'
      || (audience.type === 'selected' ? audience.subscriptionIds.includes(row.id) : audience.tags.every(tag => (row.tags ?? []).includes(tag))));
    if (audience.type === 'selected' && matched.length !== audience.subscriptionIds.length) throw new AppError(409, 'Some selected subscriptions are missing or expired. Refresh the audience.');
    const subscriptionIds = matched.map(row => row.id).sort();
    return { audience, subscriptionIds, count: matched.length, fingerprint: digest(JSON.stringify(subscriptionIds)) };
  }
  async setTags(id: string, input: unknown, version: string) {
    const tags = parseTags(input);
    const record = await this.database.read<SubscriptionDocument>(id);
    if (!record || record.kind !== 'subscription') throw new AppError(404, 'Subscription not found.');
    this.version(record, version);
    if (!await this.database.replace({ ...record, tags } as SubscriptionDocument, version)) throw new AppError(412, 'This subscription changed. Read it again.');
    return this.database.read<SubscriptionDocument>(id);
  }
  async create(actor: string, key: string, input: unknown, ready = false): Promise<Campaign> {
    const draft = parseDraft(input);
    const id = digest(`campaign:${this.siteId}:${actor}:${idempotencyKey(key)}`);
    const fingerprint = digest(JSON.stringify({ ...draft, ready }));
    const existing = await this.database.read<Campaign>(id);
    if (existing) {
      // Support retries of test campaigns saved by the previous local phase.
      const legacyMatch = ready && !existing.requestFingerprint && JSON.stringify(existing.content) === JSON.stringify(draft.content)
        && draft.audience.type === 'selected' && JSON.stringify(existing.subscriptionIds) === JSON.stringify(draft.audience.subscriptionIds);
      if (existing.requestFingerprint !== fingerprint && !legacyMatch) throw new AppError(409, 'This idempotency key was already used for a different campaign.');
      return existing;
    }
    const target = ready ? await this.preview(draft.audience) : undefined;
    if (ready && !target?.count) throw new AppError(400, 'This audience has no active subscribers.');
    const timestamp = this.now().toISOString();
    const campaign: Campaign = { ...draft, id, siteId: this.siteId, kind: 'campaign', createdBy: actor,
      createdAt: timestamp, updatedAt: timestamp, requestFingerprint: fingerprint, subscriptionIds: target?.subscriptionIds ?? [],
      dispatchIndex: 0, state: ready ? 'pending' : 'draft', ttl: 1209600 };
    const counterId = `campaigns-${timestamp.slice(0, 10)}`;
    await this.database.create({ id: counterId, siteId: this.siteId, kind: 'budget', count: 0, ttl: 172800 } as Counter);
    for (let retry = 0; retry < 8; retry++) {
      const counter = await this.database.read<Counter>(counterId);
      if (!counter?._etag) throw new Error('Campaign budget unavailable.');
      if (counter.count >= 100) throw new AppError(429, 'The daily demonstration campaign limit has been reached.');
      if (await this.database.transact([
        { type: 'create', document: campaign },
        { type: 'replace', document: { ...counter, count: counter.count + 1 } as Counter, etag: counter._etag },
      ])) return this.get(id);
      if (await this.database.read<Campaign>(id)) return this.create(actor, key, input, ready);
    }
    throw new AppError(503, 'Campaign submission is busy. Retry shortly.');
  }
  async update(id: string, input: unknown, version: string) {
    const draft = parseDraft(input);
    const campaign = await this.get(id); this.version(campaign, version);
    if (campaign.state !== 'draft') throw new AppError(409, 'Only drafts can be edited.');
    if (!await this.database.replace({ ...campaign, ...draft, updatedAt: this.now().toISOString() } as Campaign, version)) throw new AppError(412, 'This campaign changed. Read it again.');
    return this.get(id);
  }
  async remove(id: string, version: string) {
    const campaign = await this.get(id); this.version(campaign, version);
    if (campaign.state !== 'draft') throw new AppError(409, 'Only drafts can be deleted. Cancel an active campaign instead.');
    if (!await this.database.transact([{ type: 'delete', id, etag: version }])) throw new AppError(412, 'This campaign changed. Read it again.');
  }
  async activate(id: string, key: string, scheduledAt?: unknown, expected?: { fingerprint?: string; version?: string }) {
    idempotencyKey(key);
    let timestamp: string | undefined;
    if (scheduledAt !== undefined) {
      if (typeof scheduledAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledAt) || !Number.isFinite(Date.parse(scheduledAt))) throw new AppError(400, 'Use an ISO send time with an explicit timezone.');
      timestamp = new Date(scheduledAt).toISOString();
    }
    for (let retry = 0; retry < 8; retry++) {
      const campaign = await this.get(id);
      if (campaign.activation?.key === key && campaign.activation.scheduledAt === timestamp) return campaign;
      if (campaign.state !== 'draft') throw new AppError(409, 'Only a draft can be sent or scheduled.');
      if (expected?.version) this.version(campaign, expected.version);
      const delay = timestamp ? Date.parse(timestamp) - this.now().getTime() : 0;
      if (timestamp && (delay <= 0 || delay > 604800000)) throw new AppError(400, 'Schedule a time in the next seven days.');
      const target = await this.preview(campaign.audience);
      if (expected?.fingerprint && target.fingerprint !== expected.fingerprint) throw new AppError(409, 'The audience changed after preview. Review the recipients again.');
      if (!target.count) throw new AppError(400, 'This audience has no active subscribers.');
      const next: Campaign = { ...campaign, subscriptionIds: target.subscriptionIds, scheduledAt: timestamp,
        activation: { key, ...(timestamp ? { scheduledAt: timestamp } : {}) }, dispatchIndex: 0,
        state: timestamp ? 'scheduled' : 'pending', updatedAt: this.now().toISOString() };
      if (await this.database.replace(next, campaign._etag!)) return this.get(id);
    }
    throw new AppError(503, 'Campaign activation is busy. Retry shortly.');
  }
  async cancel(id: string) {
    for (let retry = 0; retry < 8; retry++) {
      const campaign = await this.get(id);
      if (campaign.state === 'cancelled') return campaign;
      if (terminalCampaign(campaign.state)) throw new AppError(409, 'This campaign has already finished.');
      if (await this.database.replace({ ...campaign, state: 'cancelled', updatedAt: this.now().toISOString(),
        dispatchLeaseId: undefined, dispatchLeaseUntil: undefined } as Campaign, campaign._etag!)) return this.get(id);
    }
    throw new AppError(503, 'Campaign cancellation is busy. Retry shortly.');
  }
}
