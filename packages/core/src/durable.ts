import { AppError, type NotificationContent, type StoredSubscription, type SubscriptionStore } from './index.js';

export interface Document {
  id: string;
  siteId: string;
  kind: string;
  _etag?: string;
  ttl?: number;
}
export type Write = { type: 'create'; document: Document } | { type: 'replace'; document: Document; etag: string } | { type: 'delete'; id: string; etag: string };
export interface DocumentDatabase {
  read<T extends Document>(id: string): Promise<T | undefined>;
  create(document: Document): Promise<boolean>;
  replace(document: Document, etag: string): Promise<boolean>;
  transact(operations: Write[]): Promise<boolean>;
  page<T extends Document>(kind: string, limit: number, cursor?: string, states?: string[]): Promise<{ items: T[]; cursor?: string }>;
}
export interface QueuePublisher {
  campaign(id: string): Promise<void>;
  delivery(id: string): Promise<void>;
}
/** Stable local keyset paging tolerates records leaving the active-state query. */
export function documentPage<T extends Document>(records: Document[], kind: string, limit: number, cursor?: string, states?: string[]) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !/^[\w-]{1,256}$/.test(cursor))) throw new AppError(400, 'Invalid page cursor or size.');
  const rows = records.filter(row => row.kind === kind && (!cursor || row.id > cursor)
    && (!states || states.includes((row as Document & { state: string }).state))).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const items = rows.slice(0, limit) as T[];
  return { items, ...(rows.length > limit ? { cursor: items.at(-1)!.id } : {}) };
}
export interface Campaign extends Document {
  kind: 'campaign';
  content: NotificationContent;
  subscriptionIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
  name?: string;
  audience?: Audience;
  requestFingerprint?: string;
  activation?: { key: string; scheduledAt?: string };
  scheduledAt?: string;
  dispatchIndex?: number;
  dispatchLeaseId?: string;
  dispatchLeaseUntil?: string;
  state: 'draft' | 'scheduled' | 'pending' | 'queued' | 'dispatching' | 'sending' | 'completed' | 'completed_with_failures' | 'cancelled' | 'failed';
}
export type Audience = { type: 'all' } | { type: 'tags'; tags: string[] } | { type: 'selected'; subscriptionIds: string[] };
export interface Delivery extends Document {
  kind: 'delivery';
  campaignId: string;
  subscriptionId: string;
  state: 'pending' | 'queued' | 'processing' | 'accepted' | 'expired' | 'failed' | 'cancelled';
  attempts: number;
  updatedAt: string;
  nextAttemptAt: string;
  leaseUntil?: string;
  leaseId?: string;
  reason?: string;
  providerStatus?: number;
}
export type SubscriptionDocument = Document & StoredSubscription & { kind: 'subscription' };
interface Counter extends Document { count: number }

export class DurableSubscriptionStore implements SubscriptionStore {
  constructor(public readonly database: DocumentDatabase, public readonly siteId: string) {}
  async list(): Promise<StoredSubscription[]> {
    const records: StoredSubscription[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.database.page<SubscriptionDocument>('subscription', 100 - records.length, cursor);
      records.push(...page.items); cursor = page.cursor;
    } while (cursor && records.length < 100);
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async get(id: string): Promise<StoredSubscription | undefined> {
    const record = await this.database.read<SubscriptionDocument>(id);
    return record?.kind === 'subscription' ? record : undefined;
  }
  private async quota() {
    await this.database.create({ id: 'subscription-quota', siteId: this.siteId, kind: 'quota', count: 0 } as Counter);
    const record = await this.database.read<Counter>('subscription-quota');
    if (!record?._etag) throw new AppError(503, 'Subscriber quota is unavailable.');
    return record;
  }
  async insert(record: StoredSubscription, limit: number): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const quota = await this.quota();
      if (quota.count >= limit) throw new AppError(429, 'The demonstration subscriber limit has been reached.');
      const document: SubscriptionDocument = { ...record, siteId: this.siteId, kind: 'subscription' };
      if (await this.database.transact([
        { type: 'create', document },
        { type: 'replace', document: { ...quota, count: quota.count + 1 } as Counter, etag: quota._etag! },
      ])) return;
      if (await this.get(record.id)) throw new AppError(409, 'This browser is already registered. Reconnect to create a new subscription.');
    }
    throw new AppError(503, 'Registration is busy. Retry shortly.');
  }
  async remove(id: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await this.database.read<SubscriptionDocument>(id);
      if (!record || record.kind !== 'subscription') return;
      const quota = await this.quota();
      if (await this.database.transact([
        { type: 'delete', id, etag: record._etag! },
        { type: 'replace', document: { ...quota, count: Math.max(0, quota.count - 1) } as Counter, etag: quota._etag! },
      ])) return;
    }
    throw new AppError(503, 'Subscription is busy. Retry shortly.');
  }
  async markAccepted(id: string, date: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await this.database.read<SubscriptionDocument>(id);
      if (!record || record.kind !== 'subscription') return;
      if (await this.database.replace({ ...record, lastAcceptedAt: date } as SubscriptionDocument, record._etag!)) return;
    }
    throw new AppError(503, 'Could not record send outcome.');
  }
}

export async function change<T extends Document>(database: DocumentDatabase, id: string, update: (record: T) => T): Promise<T | undefined> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const record = await database.read<T>(id);
    if (!record) return undefined;
    const next = update(record);
    if (await database.replace(next, record._etag!)) return next;
  }
  throw new AppError(503, 'Concurrent update could not be completed.');
}
