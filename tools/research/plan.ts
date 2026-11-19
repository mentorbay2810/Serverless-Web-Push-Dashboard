import { integer } from '../benchmark/model.js';

export type Condition = 'fresh-process' | 'reused-process';
export interface Plan {
  schemaVersion: 1; name: string; audiences: number[]; concurrencies: number[]; conditions: Condition[];
  repetitions: number; warmup: number; seed: number; mockDelayMs: number; maxDurationMs: number; orderSeed: number;
}
export interface Cell { audience: number; concurrency: number; condition: Condition }
export function parsePlan(input: unknown): Plan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provide a bounded local research plan.');
  const data = input as Record<string, unknown>;
  const keys = ['schemaVersion', 'name', 'audiences', 'concurrencies', 'conditions', 'repetitions', 'warmup', 'seed', 'mockDelayMs', 'maxDurationMs', 'orderSeed'];
  if (Object.keys(data).some(key => !keys.includes(key)) || data.schemaVersion !== 1 || typeof data.name !== 'string' || !/^[a-z0-9-]{1,64}$/.test(data.name)) throw new Error('Invalid research plan fields.');
  const numbers = (value: unknown, name: string, max: number) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error(`Use one to three ${name}.`);
    const values = value.map(item => integer(item, name, 1, max));
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${name}.`);
    return values;
  };
  if (!Array.isArray(data.conditions) || data.conditions.length !== 2 || !['fresh-process', 'reused-process'].every(condition => (data.conditions as unknown[]).includes(condition))) throw new Error('Compare fresh-process and reused-process conditions.');
  const plan: Plan = { schemaVersion: 1, name: data.name, audiences: numbers(data.audiences, 'audiences', 1000), concurrencies: numbers(data.concurrencies, 'concurrencies', 4),
    conditions: ['fresh-process', 'reused-process'], repetitions: integer(data.repetitions, 'repetitions', 2, 5), warmup: integer(data.warmup, 'warmup', 1, 2),
    seed: integer(data.seed, 'seed', 0, 0xffffffff), mockDelayMs: integer(data.mockDelayMs, 'mockDelayMs', 0, 25),
    maxDurationMs: integer(data.maxDurationMs, 'maxDurationMs', 1000, 60000), orderSeed: integer(data.orderSeed, 'orderSeed', 0, 0xffffffff) };
  if (deliveryCount(plan) > 50000) throw new Error('The local plan exceeds 50,000 synthetic deliveries including warm-ups.');
  return plan;
}
export const deliveryCount = (plan: Plan) => plan.audiences.reduce((sum, value) => sum + value, 0) * plan.concurrencies.length * (plan.repetitions * 2 + plan.warmup);
export function schedule(plan: Plan): Cell[] {
  const cells = plan.audiences.flatMap(audience => plan.concurrencies.flatMap(concurrency => plan.conditions.map(condition => ({ audience, concurrency, condition }))));
  let state = plan.orderSeed >>> 0;
  for (let index = cells.length - 1; index > 0; index--) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const target = Math.floor((state / 0x100000000) * (index + 1));
    [cells[index], cells[target]] = [cells[target]!, cells[index]!];
  }
  return cells;
}
export const smokePlan = () => parsePlan({ schemaVersion: 1, name: 'local-smoke', audiences: [3], concurrencies: [1], conditions: ['fresh-process', 'reused-process'],
  repetitions: 2, warmup: 1, seed: 42, mockDelayMs: 0, maxDurationMs: 5000, orderSeed: 42 });
