import { ServiceBusClient } from '@azure/service-bus';
import type { TokenCredential } from '@azure/core-auth';
import { message } from '../../core/src/pipeline.js';
import type { QueuePublisher } from '../../core/src/durable.js';

export class ServiceBusQueuePublisher implements QueuePublisher {
  private readonly client: ServiceBusClient;
  private readonly campaigns;
  private readonly deliveries;
  constructor(namespace: string, campaignQueue: string, deliveryQueue: string, credential: TokenCredential) {
    this.client = new ServiceBusClient(namespace, credential, { retryOptions: { maxRetries: 3, timeoutInMs: 10_000 } });
    this.campaigns = this.client.createSender(campaignQueue);
    this.deliveries = this.client.createSender(deliveryQueue);
  }
  async campaign(id: string) { await this.campaigns.sendMessages({ body: message(id), contentType: 'application/json', messageId: id, timeToLive: 3_600_000 }); }
  async delivery(id: string) { await this.deliveries.sendMessages({ body: message(id), contentType: 'application/json', messageId: id, timeToLive: 3_600_000 }); }
  async close() { await this.client.close(); }
}
