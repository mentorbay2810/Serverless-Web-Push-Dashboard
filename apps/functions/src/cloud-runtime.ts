import { DefaultAzureCredential } from '@azure/identity';
import { CosmosDocumentDatabase } from '../../../packages/adapters/src/cosmos.js';
import { ServiceBusQueuePublisher } from '../../../packages/adapters/src/service-bus.js';
import { entraAuthenticator } from '../../../packages/adapters/src/entra.js';
import { WebPushSender } from '../../../packages/adapters/src/web-push-sender.js';
import { DurableSubscriptionStore } from '../../../packages/core/src/durable.js';
import { DeliveryPipeline } from '../../../packages/core/src/pipeline.js';
import { cloudApplication } from './cloud-application.js';

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing cloud setting: ${name}`); return value; }
function bounded(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid cloud limit: ${name}`);
  return value;
}
export function createCloudRuntime() {
  const siteId = required('SITE_ID');
  const credential = new DefaultAzureCredential();
  const database = CosmosDocumentDatabase.connect(required('COSMOS_ENDPOINT'), required('COSMOS_DATABASE'), required('COSMOS_CONTAINER'), siteId, credential);
  const subscriptions = new DurableSubscriptionStore(database, siteId);
  const queue = new ServiceBusQueuePublisher(required('SERVICEBUS_NAMESPACE'), required('CAMPAIGN_QUEUE'), required('DELIVERY_QUEUE'), credential);
  const pipeline = new DeliveryPipeline({ database, subscriptions, queue, siteId,
    eventSecret: required('VAPID_PRIVATE_KEY'),
    eventBaseUrl: process.env.PUBLIC_API_ORIGIN ?? `https://${required('WEBSITE_HOSTNAME')}`,
    dailyAttemptLimit: bounded('DAILY_ATTEMPT_LIMIT', 1000, 1000),
    sender: new WebPushSender({ subject: required('VAPID_SUBJECT'), publicKey: required('VAPID_PUBLIC_KEY'), privateKey: required('VAPID_PRIVATE_KEY') }),
  });
  const tenantId = required('ENTRA_TENANT_ID');
  const clientId = required('ENTRA_SPA_CLIENT_ID');
  const apiClientId = required('ENTRA_API_CLIENT_ID');
  const webOrigin = required('WEB_ORIGIN');
  const url = new URL(webOrigin);
  if (url.origin !== webOrigin || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Invalid website origin.');
  const handle = cloudApplication({ subscriptions, pipeline, webOrigin,
    auth: entraAuthenticator({ tenantId, apiClientId, spaClientId: clientId, adminObjectIds: (process.env.ADMIN_OBJECT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean) }),
    config: { mode: 'azure', vapidPublicKey: required('VAPID_PUBLIC_KEY'), maxSubscriptions: bounded('MAX_SUBSCRIPTIONS', 100, 100),
      admin: { tenantId, clientId, apiClientId, scope: `api://${apiClientId}/access_as_user` } },
  });
  return { handle, pipeline };
}
