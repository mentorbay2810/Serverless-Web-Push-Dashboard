import { randomUUID } from 'node:crypto';
import type { Document, DocumentDatabase, QueuePublisher } from '../../core/src/durable.js';

interface QueueMessage extends Document {
  kind: 'message' | 'dead-letter';
  queue: 'campaign' | 'delivery';
  bodyId: string;
  visibleAt: string;
  attempts: number;
}
export class LocalQueuePublisher implements QueuePublisher {
  constructor(private readonly database: DocumentDatabase) {}
  private async publish(queue: QueueMessage['queue'], bodyId: string) {
    await this.database.create({ id: randomUUID(), siteId: 'local', kind: 'message', queue, bodyId,
      visibleAt: new Date().toISOString(), attempts: 0 } as QueueMessage);
  }
  async campaign(id: string) { await this.publish('campaign', id); }
  async delivery(id: string) { await this.publish('delivery', id); }
  async consume(queue: QueueMessage['queue'], handler: (id: string) => Promise<void>) {
    const page = await this.database.page<QueueMessage>('message', 100);
    const record = page.items.find(row => row.queue === queue && new Date(row.visibleAt).getTime() <= Date.now());
    if (!record) return;
    const claimed: QueueMessage = { ...record, attempts: record.attempts + 1, visibleAt: new Date(Date.now() + 60_000).toISOString() };
    if (!await this.database.replace(claimed, record._etag!)) return;
    const owned = await this.database.read<QueueMessage>(record.id);
    if (!owned) return;
    try {
      await handler(owned.bodyId);
      await this.database.transact([{ type: 'delete', id: owned.id, etag: owned._etag! }]);
    } catch {
      await this.database.replace({ ...owned, kind: owned.attempts >= 5 ? 'dead-letter' : 'message', visibleAt: new Date(Date.now() + 2000).toISOString() } as QueueMessage, owned._etag!);
    }
  }
}
