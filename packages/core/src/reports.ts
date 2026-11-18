import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from './index.js';
import type { Campaign, Delivery, DocumentDatabase } from './durable.js';
import { deliveryId } from './campaigns.js';

export class DeliveryReports {
  constructor(private readonly database: DocumentDatabase, private readonly siteId: string, private readonly now: () => Date,
    private readonly secret?: string, private readonly baseUrl?: string) {
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (url.origin !== baseUrl || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Invalid reporting origin.');
    }
  }
  private token(delivery: Delivery) {
    if (!this.secret) throw new AppError(503, 'Observation reporting is unavailable.');
    return createHmac('sha256', this.secret).update(`webpush-events:v1:${this.siteId}:${delivery.id}:${delivery.eventExpiresAt}`).digest('base64url');
  }
  payload(delivery: Delivery) {
    if (!this.secret || !this.baseUrl || !delivery.eventExpiresAt) return undefined;
    return { url: `${this.baseUrl}/api/deliveries/${delivery.id}/events`, token: this.token(delivery) };
  }
  async record(id: string, header: string | null, input: Record<string, unknown>) {
    const delivery = await this.database.read<Delivery>(id);
    if (!delivery || delivery.kind !== 'delivery' || !delivery.eventExpiresAt) throw new AppError(404, 'Delivery observation is unavailable.');
    const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token(delivery)))) throw new AppError(401, 'A delivery-scoped observation capability is required.');
    if (Date.parse(delivery.eventExpiresAt) <= this.now().getTime()) throw new AppError(410, 'This delivery observation capability expired.');
    if (input.type !== 'received' && input.type !== 'clicked') throw new AppError(400, 'Observation type must be received or clicked.');
    const field = input.type === 'received' ? 'receivedAt' : 'clickedAt';
    // First observed timestamp is the unique delivery/type event. Replays cannot inflate counts.
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.database.read<Delivery>(id);
      if (!current || current.kind !== 'delivery') throw new AppError(404, 'Delivery observation is unavailable.');
      if (current[field]) return { status: 'recorded', duplicate: true };
      if (await this.database.replace({ ...current, [field]: this.now().toISOString() } as Delivery, current._etag!)) return { status: 'recorded', duplicate: false };
    }
    throw new AppError(503, 'Observation recording is busy. Retry shortly.');
  }
  async campaign(campaign: Campaign) {
    const jobs = await Promise.all(campaign.subscriptionIds.map(id => this.database.read<Delivery>(deliveryId(campaign.id, id))));
    const counts: Record<string, number> = {};
    const deliveries = campaign.subscriptionIds.map((id, index) => {
      const job = jobs[index];
      const state = job?.state ?? (campaign.state === 'cancelled' ? 'cancelled' : 'not_dispatched');
      counts[state] = (counts[state] ?? 0) + 1;
      return { id: deliveryId(campaign.id, id), subscriptionId: id, state, attempts: job?.attempts ?? 0,
        reason: job?.reason, providerStatus: job?.providerStatus, updatedAt: job?.updatedAt,
        nextAttemptAt: job?.nextAttemptAt, receivedAt: job?.receivedAt, clickedAt: job?.clickedAt };
    });
    return { counts, metrics: { targeted: campaign.subscriptionIds.length, accepted: counts.accepted ?? 0,
      received: jobs.filter(job => job?.receivedAt).length, clicked: jobs.filter(job => job?.clickedAt).length,
      failed: counts.failed ?? 0, expired: counts.expired ?? 0, cancelled: counts.cancelled ?? 0 },
      deliveries, reportedAt: this.now().toISOString() };
  }
}
