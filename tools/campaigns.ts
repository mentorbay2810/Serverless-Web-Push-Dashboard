import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadEnvironment } from './environment.js';

async function main() {
  const config = loadEnvironment();
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    id: { type: 'string' }, file: { type: 'string' }, tags: { type: 'string' },
    at: { type: 'string' }, key: { type: 'string' }, state: { type: 'string' }, cursor: { type: 'string' },
  } });
  const requireId = () => {
    if (!values.id || !/^[a-f0-9]{64}$/.test(values.id)) throw new Error('Provide --id <campaign-or-subscriber-id>.');
    return values.id;
  };
  async function file() {
    if (!values.file) throw new Error('Provide --file <campaign.json>. See examples/campaign.json.');
    return JSON.parse(await readFile(values.file, 'utf8')) as Record<string, unknown>;
  }
  async function request(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/local/manage/${path}`, {
      method, headers: { Authorization: `Bearer ${config.adminToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
    const data = response.status === 204 ? { status: 'deleted' } : await response.json() as Record<string, unknown>;
    if (!response.ok) {
      if (response.status === 404 && data.error === 'Endpoint not found.') throw new Error('Campaign management requires npm run dev:queued.');
      throw new Error(typeof data.error === 'string' ? data.error : 'Campaign request failed.');
    }
    return { data, etag: response.headers.get('etag') };
  }
  const key = () => { const value = values.key ?? randomUUID(); console.error(`Idempotency-Key: ${value}`); return { 'Idempotency-Key': value }; };
  const precondition = async (path: string) => {
    const current = await request(path);
    if (!current.etag) throw new Error('The API did not return a record version.');
    return { 'If-Match': current.etag };
  };
  let result: Awaited<ReturnType<typeof request>>;
  if (command === 'create') result = await request('campaigns', 'POST', await file(), key());
  else if (command === 'list' || command === 'subscribers') {
    const query = new URLSearchParams({ ...(values.cursor ? { cursor: values.cursor } : {}), ...(values.state && command === 'list' ? { state: values.state } : {}) });
    result = await request(`${command === 'list' ? 'campaigns' : 'subscriptions'}?${query}`);
  } else if (command === 'tags') {
    if (values.tags === undefined) throw new Error('Provide --tags demo,updates. Use --tags "" to clear tags.');
    const path = `subscriptions/${requireId()}`;
    result = await request(`${path}/tags`, 'PATCH', { tags: values.tags ? values.tags.split(',').map(tag => tag.trim()) : [] }, await precondition(path));
  } else if (command === 'preview' && !values.id) result = await request('segments/preview', 'POST', { audience: (await file()).audience });
  else if (['get', 'update', 'delete', 'preview', 'send', 'schedule', 'cancel'].includes(command ?? '')) {
    const path = `campaigns/${requireId()}`;
    if (command === 'get') result = await request(path);
    else if (command === 'update') result = await request(path, 'PATCH', await file(), await precondition(path));
    else if (command === 'delete') result = await request(path, 'DELETE', undefined, await precondition(path));
    else {
      if (command === 'schedule' && !values.at) throw new Error('Provide --at <ISO-time-with-timezone>, at most seven days ahead.');
      result = await request(`${path}/${command}`, 'POST', command === 'schedule' ? { scheduledAt: values.at } : {},
        command === 'send' || command === 'schedule' ? key() : {});
    }
  } else throw new Error('Use npm run campaigns -- create|list|get|update|delete|preview|send|schedule|cancel|subscribers|tags [options].');
  console.log(JSON.stringify(result.data, null, 2));
}

main().catch(error => {
  console.error(error instanceof TypeError ? 'Cannot reach the local API. Start npm run dev:queued.' : error.message);
  process.exitCode = 1;
});
