import { createServer } from 'node:http';
import { createApplication } from './application.js';
import { FileSubscriptionStore } from '../../../packages/adapters/src/file-store.js';
import { WebPushSender } from '../../../packages/adapters/src/web-push-sender.js';
import { loadEnvironment } from '../../../tools/environment.js';
import { queuedLocal } from './queued-local.js';

const config = loadEnvironment();
const queued = process.env.LOCAL_PIPELINE_MODE === 'queued' ? queuedLocal(config) : undefined;
const handle = queued?.handle ?? createApplication({
  ...config,
  publicKey: config.vapid.publicKey,
  store: new FileSubscriptionStore(config.dataDirectory),
  sender: new WebPushSender(config.vapid),
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 8192) {
        outgoing.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
        outgoing.end(JSON.stringify({ error: 'Request is too large.' }));
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const request = new Request(`http://${incoming.headers.host ?? 'invalid'}${incoming.url}`, {
      method: incoming.method,
      headers,
      ...(size ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } catch {
    outgoing.writeHead(400, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'Invalid HTTP request.' }));
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(config.port, '127.0.0.1', () => console.log(`Local push API: http://127.0.0.1:${config.port}`));
server.on('error', error => { console.error(`Could not start local API: ${error.message}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { queued?.stop(); server.close(); });
