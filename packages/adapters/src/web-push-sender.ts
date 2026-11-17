import webpush from 'web-push';
import { parseSubscription, type BrowserSubscription, type PushPayload, type PushSender } from '../../core/src/index.js';

export class WebPushSender implements PushSender {
  constructor(private readonly vapid: { subject: string; publicKey: string; privateKey: string }) {}

  async send(subscription: BrowserSubscription, payload: PushPayload): Promise<{ statusCode: number }> {
    // Revalidate persisted endpoints too; never send to an arbitrary user-provided URL.
    const response = await webpush.sendNotification(parseSubscription(subscription), JSON.stringify(payload), {
      vapidDetails: this.vapid,
      TTL: 300,
      timeout: 10_000,
      urgency: 'normal',
      contentEncoding: 'aes128gcm',
    });
    return { statusCode: response.statusCode };
  }
}
