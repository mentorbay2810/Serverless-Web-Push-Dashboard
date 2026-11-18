import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, type NotificationContent } from '../../packages/core/src/index.js';

export const CONTENT: NotificationContent = { title: 'Controlled benchmark', body: 'Synthetic local delivery; no real browser is targeted.', url: '/' };
export interface Workload { audience: number; seed: number; concurrency: number }
export function integer(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new AppError(400, `${name} must be an integer from ${min} to ${max}.`);
  return value;
}
export function workload(input: unknown): Workload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Provide a benchmark workload.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['audience', 'seed', 'concurrency'].includes(key))) throw new AppError(400, 'Unknown workload field.');
  return { audience: integer(value.audience, 'audience', 1, 1000), seed: integer(value.seed, 'seed', 0, 0xffffffff), concurrency: integer(value.concurrency, 'concurrency', 1, 8) };
}
export function loopbackOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024) throw new Error();
    return value;
  } catch { throw new Error('Benchmark transport requires a literal HTTP 127.0.0.1 origin and an unprivileged port.'); }
}
export function authorized(header: string | null, token: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return !!header?.startsWith('Bearer ') && header.length <= 512 && timingSafeEqual(digest(header.slice(7)), digest(token));
}
export const fingerprint = (spec: Workload, delayMs: number) => createHash('sha256').update(JSON.stringify({ audience: spec.audience, seed: spec.seed, concurrency: spec.concurrency, delayMs, content: CONTENT,
  database: 'memory', queue: 'memory-fifo', dispatch: 'all fan-out before bounded-parallel delivery', encryption: false })).digest('hex');
export interface Attempt {
  deliveryId: string; recipientId: string; attempt: number; status: number; startedAt: string; requestMs: number; queueWaitMs: number;
}
export interface Outcome { deliveryId: string; state: string; attempts: number; endToEndMs: number }
export function distribution(values: number[]) {
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid latency sample.');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null;
  return { count: sorted.length, mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    min: sorted[0] ?? null, p50: rank(.5), p95: rank(.95), p99: rank(.99), max: sorted.at(-1) ?? null };
}
