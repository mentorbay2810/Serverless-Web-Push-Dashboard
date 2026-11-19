import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLocalLock } from '../../packages/adapters/src/local-lock.js';
import { deliveryId, terminalCampaign } from '../../packages/core/src/campaigns.js';
import type { Campaign, Document } from '../../packages/core/src/durable.js';

type Row = Document & Record<string, unknown>;
interface Snapshot { bytes: Buffer; rows: Row[] }
interface PlanBody {
  version: 1; policy: 'terminal-history-v1'; createdAt: string; cutoff: string; days: number;
  before: { documents: string; queues: string | null };
  campaignIds: string[]; deliveryIds: string[];
}
export interface RetentionPlan extends PlanBody { id: string }
interface Backup {
  version: 1; id: string; planId: string; createdAt: string;
  before: PlanBody['before']; after: string;
}
const documentFile = 'phase2-documents.json', queueFile = 'phase2-queues.json';
const day = 86400000;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const validId = (value: string) => /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
};
function failure(message: string): never { throw new Error(message); }

async function privateDirectory(path: string, create = false) {
  if (create) await mkdir(path, { mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) failure('Retention requires private directories without symbolic links.');
}
async function ensureDirectory(path: string) {
  try { await privateDirectory(path, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await privateDirectory(path); }
}
async function readPrivate(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077)) failure('Retention requires private regular files without links.');
    return await file.readFile();
  } finally { await file.close(); }
}
async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function writeNew(path: string, bytes: string | Buffer) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
function envelope(bytes: Buffer): Row[] {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || value.version !== 1 || !Array.isArray(value.documents) || Object.keys(value).some(key => !['version', 'documents'].includes(key))) throw new Error();
    const ids = new Set<string>();
    for (const row of value.documents) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || !['id', 'kind', 'siteId', '_etag'].every(key => typeof row[key] === 'string' && row[key].length > 0)
        || ids.has(row.id)) throw new Error();
      ids.add(row.id);
    }
    return value.documents;
  } catch { return failure('Invalid local snapshot. Preserve the files and inspect them before retention.'); }
}
async function snapshots(root: string) {
  const bytes = await readPrivate(join(root, documentFile));
  const documents: Snapshot = { bytes, rows: envelope(bytes) };
  let queues: Snapshot | undefined;
  try {
    const bytes = await readPrivate(join(root, queueFile));
    queues = { bytes, rows: envelope(bytes) };
    for (const row of queues.rows) {
      if (!['message', 'dead-letter'].includes(row.kind) || !['campaign', 'delivery'].includes(row.queue as string)
        || typeof row.bodyId !== 'string' || !row.bodyId) failure('Unknown queue record. Preserve queue history before retention.');
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { documents, queues, before: { documents: hash(bytes), queues: queues ? hash(queues.bytes) : null } };
}

/** Only complete terminal groups qualify. Unfamiliar or incomplete rows stay intact. */
export function selectHistory(rows: Row[], queues: Row[], cutoff: number, now: number) {
  const campaigns = rows.filter(row => row.kind === 'campaign');
  const deliveries = rows.filter(row => row.kind === 'delivery');
  if (deliveries.some(row => typeof row.campaignId !== 'string' || !row.campaignId)) failure('A delivery has no campaign identity. Preserve the snapshot before retention.');
  const byCampaign = new Map<string, Row[]>();
  for (const row of deliveries) {
    const children = byCampaign.get(row.campaignId as string) ?? [];
    children.push(row); byCampaign.set(row.campaignId as string, children);
  }
  const references = new Set(queues.map(row => row.bodyId));
  const campaignIds: string[] = [], deliveryIds: string[] = [];
  const old = (value: unknown) => { const time = date(value); return time !== undefined && time <= cutoff; };
  const optionalOld = (value: unknown) => value === undefined || old(value);
  const expired = (value: unknown) => { const time = date(value); return value === undefined || (time !== undefined && time <= now); };
  for (const campaign of campaigns) {
    if (!validId(campaign.id) || !terminalCampaign(campaign.state as Campaign['state'])
      || !old(campaign.createdAt) || !optionalOld(campaign.updatedAt) || !optionalOld(campaign.scheduledAt)
      || !expired(campaign.dispatchLeaseUntil) || (campaign.dispatchLeaseId !== undefined && campaign.dispatchLeaseUntil === undefined)
      || !Array.isArray(campaign.subscriptionIds) || !campaign.subscriptionIds.every(id => typeof id === 'string' && validId(id))
      || new Set(campaign.subscriptionIds).size !== campaign.subscriptionIds.length || references.has(campaign.id)
      || campaign.subscriptionIds.some(id => references.has(deliveryId(campaign.id, id)))) continue;
    const children = byCampaign.get(campaign.id) ?? [];
    if (children.some(row => row.siteId !== campaign.siteId || typeof row.subscriptionId !== 'string'
      || !(campaign.subscriptionIds as string[]).includes(row.subscriptionId)
      || row.id !== deliveryId(campaign.id, row.subscriptionId)
      || !['accepted', 'expired', 'failed', 'cancelled'].includes(row.state as string)
      || !old(row.updatedAt) || !old(row.nextAttemptAt) || !optionalOld(row.receivedAt) || !optionalOld(row.clickedAt)
      || !expired(row.eventExpiresAt) || !expired(row.leaseUntil) || (row.leaseId !== undefined && row.leaseUntil === undefined)
      || references.has(row.id))) continue;
    if (['completed', 'completed_with_failures'].includes(campaign.state as string) && children.length !== campaign.subscriptionIds.length) continue;
    campaignIds.push(campaign.id); deliveryIds.push(...children.map(row => row.id));
  }
  return { campaignIds: campaignIds.sort(), deliveryIds: deliveryIds.sort() };
}

async function withStore<T>(directory: string, task: (root: string, artifacts: string) => Promise<T>) {
  await privateDirectory(directory);
  const root = await realpath(directory);
  const release = await acquireLocalLock(join(root, 'backend.lock'));
  try {
    const artifacts = join(root, 'retention'); await ensureDirectory(artifacts);
    return await task(root, artifacts);
  } finally { await release(); }
}
export async function planRetention(directory: string, days = 30, now = new Date()): Promise<RetentionPlan> {
  if (!Number.isInteger(days) || days < 30 || days > 3650 || !Number.isFinite(now.getTime())) failure('Retention age must be an integer from 30 to 3650 days.');
  return withStore(directory, async (root, artifacts) => {
    const snapshot = await snapshots(root);
    const cutoff = new Date(now.getTime() - days * day).toISOString();
    const body: PlanBody = { version: 1, policy: 'terminal-history-v1', createdAt: now.toISOString(), cutoff, days, before: snapshot.before,
      ...selectHistory(snapshot.documents.rows, snapshot.queues?.rows ?? [], Date.parse(cutoff), now.getTime()) };
    const plan: RetentionPlan = { ...body, id: hash(JSON.stringify(body)) };
    const path = join(artifacts, `${plan.id}.plan.json`);
    try { await writeNew(path, JSON.stringify(plan)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !((await readPrivate(path)).equals(Buffer.from(JSON.stringify(plan))))) throw error;
    }
    await syncDirectory(artifacts);
    return plan;
  });
}
async function readPlan(artifacts: string, id: string): Promise<RetentionPlan> {
  if (!validId(id)) failure('Use the 64-character plan ID returned by preview.');
  try {
    const value = JSON.parse((await readPrivate(join(artifacts, `${id}.plan.json`))).toString('utf8'));
    const { id: storedId, ...body } = value;
    if (storedId !== id || hash(JSON.stringify(body)) !== id || body.version !== 1 || body.policy !== 'terminal-history-v1'
      || !Number.isInteger(body.days) || body.days < 30 || body.days > 3650 || date(body.createdAt) === undefined
      || date(body.cutoff) !== Date.parse(body.createdAt) - body.days * day) throw new Error();
    return value;
  } catch { return failure('Cannot verify the retention plan. Generate a new preview.'); }
}
async function atomicDocuments(root: string, bytes: Buffer) {
  const temporary = join(root, `.retention-${randomUUID()}.tmp`);
  try { await writeNew(temporary, bytes); await rename(temporary, join(root, documentFile)); await syncDirectory(root); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function applyRetention(directory: string, id: string, now = new Date()) {
  return withStore(directory, async (root, artifacts) => {
    const plan = await readPlan(artifacts, id);
    const age = now.getTime() - Date.parse(plan.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > day) failure('The preview must be less than 24 hours old. Generate a new preview.');
    const snapshot = await snapshots(root);
    if (JSON.stringify(snapshot.before) !== JSON.stringify(plan.before)) failure('Local state changed since preview. Generate a new preview; nothing was removed.');
    const selected = selectHistory(snapshot.documents.rows, snapshot.queues?.rows ?? [], Date.parse(plan.cutoff), Date.parse(plan.createdAt));
    if (JSON.stringify(selected.campaignIds) !== JSON.stringify(plan.campaignIds) || JSON.stringify(selected.deliveryIds) !== JSON.stringify(plan.deliveryIds)) failure('Plan selection could not be verified. Generate a new preview.');
    if (!selected.campaignIds.length) return { changed: false as const };
    const campaigns = new Set(selected.campaignIds), deliveries = new Set(selected.deliveryIds);
    const rows = snapshot.documents.rows.filter(row => !deliveries.has(row.id)).map(row => campaigns.has(row.id)
      ? { id: row.id, siteId: row.siteId, kind: 'campaign-archive', _etag: randomUUID(), archivedAt: now.toISOString() } : row);
    const after = Buffer.from(JSON.stringify({ version: 1, documents: rows }));
    const backupId = hash(`${id}:${randomUUID()}`);
    const backupDirectory = join(artifacts, backupId); await privateDirectory(backupDirectory, true);
    await writeNew(join(backupDirectory, documentFile), snapshot.documents.bytes);
    if (snapshot.queues) await writeNew(join(backupDirectory, queueFile), snapshot.queues.bytes);
    const backup: Backup = { version: 1, id: backupId, planId: id, createdAt: now.toISOString(), before: snapshot.before, after: hash(after) };
    // A durable complete backup exists before the single live-file replacement.
    await writeNew(join(backupDirectory, 'manifest.json'), JSON.stringify(backup));
    await syncDirectory(backupDirectory); await syncDirectory(artifacts);
    if (JSON.stringify((await snapshots(root)).before) !== JSON.stringify(snapshot.before)) failure('Local state changed while making the backup. Nothing was removed.');
    await atomicDocuments(root, after);
    return { changed: true as const, backupId, archivedCampaigns: campaigns.size, removedDeliveries: deliveries.size };
  });
}
/** Undo only this retention edit, before any other queued state changes. */
export async function restoreRetention(directory: string, id: string) {
  if (!validId(id)) failure('Use the 64-character backup ID returned by apply.');
  return withStore(directory, async (root, artifacts) => {
    const directory = join(artifacts, id); await privateDirectory(directory);
    let backup: Backup;
    try {
      backup = JSON.parse((await readPrivate(join(directory, 'manifest.json'))).toString('utf8'));
      if (backup.version !== 1 || backup.id !== id || !validId(backup.planId) || !validId(backup.after)
        || !validId(backup.before.documents) || (backup.before.queues !== null && !validId(backup.before.queues))) throw new Error();
    } catch { return failure('Cannot verify the retention backup. Preserve it for inspection.'); }
    const original = await snapshots(directory);
    if (JSON.stringify(original.before) !== JSON.stringify(backup.before)) failure('Backup bytes changed. Restore refused.');
    const current = await snapshots(root);
    if (current.before.documents !== backup.after || current.before.queues !== backup.before.queues) failure('Local state changed after retention. Restore refused to avoid overwriting newer work.');
    await atomicDocuments(root, original.documents.bytes);
    return { restored: true as const };
  });
}
