import { app } from '@azure/functions';
import { createCloudRuntime } from './cloud-runtime.js';
import { messageId } from '../../../packages/core/src/pipeline.js';

let runtime: ReturnType<typeof createCloudRuntime> | undefined;
const current = () => runtime ??= createCloudRuntime();

app.http('cloudApi', {
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], authLevel: 'anonymous', route: '{*path}',
  handler: async request => {
    if (request.url.endsWith('/api/health')) return { jsonBody: { status: 'ok', mode: 'azure' } };
    const text = ['GET', 'OPTIONS', 'DELETE'].includes(request.method) ? undefined : await request.text();
    const response = await current().handle(new Request(request.url, { method: request.method, headers: request.headers, ...(text ? { body: text } : {}) }));
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  },
});
app.serviceBusQueue('campaignFanOut', {
  connection: 'ServiceBusConnection', queueName: '%CAMPAIGN_QUEUE%', cardinality: 'one',
  handler: async body => current().pipeline.fanOut(messageId(body)),
});
app.serviceBusQueue('notificationDelivery', {
  connection: 'ServiceBusConnection', queueName: '%DELIVERY_QUEUE%', cardinality: 'one',
  handler: async body => current().pipeline.deliver(messageId(body)),
});
app.timer('recoverPendingWork', {
  schedule: '0 * * * * *', useMonitor: true, runOnStartup: false,
  handler: async () => current().pipeline.reconcile(),
});
