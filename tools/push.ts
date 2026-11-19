import { parseArgs } from 'node:util';
import { DEFAULT_NOTIFICATION, type SubscriptionSummary } from '../packages/core/src/index.js';
import { loadEnvironment } from './environment.js';

async function main() {
  const config = loadEnvironment();
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { id: { type: 'string' }, latest: { type: 'boolean' }, title: { type: 'string' }, body: { type: 'string' }, url: { type: 'string' } },
  });
  async function request(path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Authorization': `Bearer ${config.adminToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Local API request failed.');
    return data;
  }
  if (command === 'list') {
    const data = await request('/api/local/subscriptions');
    const records = data.subscriptions as SubscriptionSummary[];
    if (!records.length) { console.log('No browsers connected. Open http://localhost:5173 and enable notifications.'); return; }
    console.table(records.map(row => ({ id: row.id, provider: row.provider, connected: row.createdAt })));
    return;
  }
  if (command !== 'send' || (!values.id && !values.latest) || (values.id && values.latest)) {
    throw new Error('Choose one browser: npm run push:send -- --latest OR --id <subscription-id>.');
  }
  let id = values.id;
  if (values.latest) {
    const data = await request('/api/local/subscriptions');
    id = (data.subscriptions as SubscriptionSummary[]).at(-1)?.id;
  }
  if (!id) throw new Error('No browsers connected. Enable notifications on the subscriber page first.');
  const result = await request('/api/local/send-test', {
    id,
    title: values.title ?? DEFAULT_NOTIFICATION.title,
    body: values.body ?? DEFAULT_NOTIFICATION.body,
    url: values.url ?? '/',
  });
  if (result.status === 'queued') console.log(`Queued campaign ${result.campaignId}. Watch the connected device for delivery.`);
  else {
    console.log(`Push service accepted notification ${result.notificationId}.`);
    console.log('Check the connected device for display. Provider acceptance is separate from browser receipt.');
  }
}

main().catch(error => {
  console.error(error instanceof TypeError ? 'Cannot reach the local API. Start npm run dev first.' : error.message);
  process.exitCode = 1;
});
