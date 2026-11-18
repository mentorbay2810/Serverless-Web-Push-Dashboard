import { AppError } from './index.js';
import type { Document, DocumentDatabase } from './durable.js';

export interface Operations extends Document {
  kind: 'operations';
  dispatchPaused: boolean;
  sendingPaused: boolean;
  updatedAt: string;
}
export class DeliveryControls {
  constructor(private readonly database: DocumentDatabase, private readonly siteId: string, private readonly now: () => Date) {}
  async get(): Promise<Operations> {
    await this.database.create({ id: 'operations', siteId: this.siteId, kind: 'operations', dispatchPaused: false, sendingPaused: false,
      updatedAt: this.now().toISOString() } as Operations);
    return (await this.database.read<Operations>('operations'))!;
  }
  async set(input: Record<string, unknown>, version: string) {
    if (typeof input.dispatchPaused !== 'boolean' || typeof input.sendingPaused !== 'boolean') throw new AppError(400, 'Provide both dispatchPaused and sendingPaused.');
    const record = await this.get();
    if (record._etag !== version) throw new AppError(412, 'Delivery controls changed. Refresh and retry.');
    if (!await this.database.replace({ ...record, dispatchPaused: input.dispatchPaused, sendingPaused: input.sendingPaused,
      updatedAt: this.now().toISOString() } as Operations, version)) throw new AppError(412, 'Delivery controls changed. Refresh and retry.');
    return this.get();
  }
}
