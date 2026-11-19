import { performance } from 'node:perf_hooks';
import type { BrowserSubscription, PushPayload, PushSender } from '../../packages/core/src/index.js';
import { subscriptionId } from '../../packages/core/src/pipeline.js';
import { loopbackOrigin, type Attempt } from './model.js';

/** This adapter cannot use a subscription endpoint as a network target. */
export class MockHttpSender implements PushSender {
  private readonly origin: string;
  private readonly attempts = new Map<string, number>();
  constructor(private readonly options: { origin: string; token: string; runId: string; queueWait: (id: string) => number; record: (attempt: Attempt) => void }) {
    this.origin = loopbackOrigin(options.origin);
  }
  async send(subscription: BrowserSubscription, payload: PushPayload) {
    const started = performance.now(); const startedAt = new Date().toISOString();
    const attempt = (this.attempts.get(payload.notificationId) ?? 0) + 1; this.attempts.set(payload.notificationId, attempt);
    const recipientId = subscriptionId(subscription.endpoint); const queueWaitMs = this.options.queueWait(payload.notificationId);
    let status = 0;
    try {
      const response = await fetch(`${this.origin}/push`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify({ runId: this.options.runId, deliveryId: payload.notificationId, recipientId, attempt }),
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000) });
      status = response.status; await response.arrayBuffer();
      if (status < 200 || status >= 300) throw Object.assign(new Error('Controlled provider rejected the attempt.'), { statusCode: status,
        headers: { 'retry-after': response.headers.get('retry-after') ?? undefined } });
      return { statusCode: status };
    } catch (error) {
      if (status) throw error;
      throw Object.assign(new Error('Controlled provider request failed.'), { statusCode: 503 });
    } finally {
      this.options.record({ deliveryId: payload.notificationId, recipientId, attempt, status, startedAt, requestMs: performance.now() - started, queueWaitMs });
    }
  }
}
