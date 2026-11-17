import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, type StoredSubscription, type SubscriptionStore } from '../../core/src/index.js';

/** Local-only adapter. One API process owns writes; the CLI uses the API. */
export class FileSubscriptionStore implements SubscriptionStore {
  private pending: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(private readonly directory: string) { this.path = join(directory, 'subscriptions.json'); }

  private async read(): Promise<StoredSubscription[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1
        || !('subscriptions' in data) || !Array.isArray(data.subscriptions)) throw new Error('format');
      return data.subscriptions as StoredSubscription[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Cannot read local subscription data. Check the .data directory; existing data was preserved.');
    }
  }

  private mutate(change: (records: StoredSubscription[]) => void): Promise<void> {
    const operation = this.pending.then(async () => {
      const records = await this.read();
      change(records);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, subscriptions: records }, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async list(): Promise<StoredSubscription[]> { await this.pending; return this.read(); }
  async get(id: string): Promise<StoredSubscription | undefined> { return (await this.list()).find(row => row.id === id); }

  insert(record: StoredSubscription, limit: number): Promise<void> {
    return this.mutate(records => {
      if (records.some(row => row.subscription.endpoint === record.subscription.endpoint)) {
        throw new AppError(409, 'This subscription is already registered. Reconnect this browser to create a fresh subscription.');
      }
      if (records.length >= limit) throw new AppError(429, 'The local demo subscriber limit has been reached.');
      records.push(record);
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(records => {
      const index = records.findIndex(row => row.id === id);
      if (index >= 0) records.splice(index, 1);
    });
  }

  markAccepted(id: string, date: string): Promise<void> {
    return this.mutate(records => {
      const record = records.find(row => row.id === id);
      if (record) record.lastAcceptedAt = date;
    });
  }
}
