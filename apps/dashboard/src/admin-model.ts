import { parseNotification, parseTags, type NotificationContent } from '../../../packages/core/src/index.js';
import type { Audience, Campaign } from '../../../packages/core/src/durable.js';

export interface CampaignSummary {
  id: string; name: string; content: NotificationContent; audience: Audience; state: Campaign['state'];
  createdAt: string; updatedAt: string; scheduledAt?: string; recipientCount: number; dispatchedCount: number;
}
export interface DeliveryView {
  id: string; subscriptionId: string; state: string; attempts: number; reason?: string; providerStatus?: number;
  updatedAt?: string; nextAttemptAt?: string; receivedAt?: string; clickedAt?: string;
}
export interface CampaignReport extends CampaignSummary {
  counts: Record<string, number>;
  metrics: { targeted: number; accepted: number; received: number; clicked: number; failed: number; expired: number; cancelled: number };
  deliveries: DeliveryView[]; reportedAt: string;
}
export interface OperationsView { dispatchPaused: boolean; sendingPaused: boolean; updatedAt: string }
export interface Preview { count: number; subscriptionIds: string[]; fingerprint: string; snapshot?: boolean }
export interface DraftForm { name: string; title: string; body: string; url: string; audienceType: Audience['type']; tags: string; selected: string[] }
export const emptyDraft = (): DraftForm => ({ name: '', title: '', body: '', url: '/', audienceType: 'tags', tags: '', selected: [] });
export const draftFrom = (value: CampaignSummary): DraftForm => ({ name: value.name, ...value.content, audienceType: value.audience.type,
  tags: value.audience.type === 'tags' ? value.audience.tags.join(', ') : '', selected: value.audience.type === 'selected' ? value.audience.subscriptionIds : [] });
export function definition(form: DraftForm) {
  if (!form.name.trim() || form.name.length > 100) throw new Error('Give this campaign a name of up to 100 characters.');
  const audience: Audience = form.audienceType === 'all' ? { type: 'all' }
    : form.audienceType === 'tags' ? { type: 'tags', tags: parseTags(form.tags.split(',').map(tag => tag.trim()).filter(Boolean)) }
      : { type: 'selected', subscriptionIds: [...new Set(form.selected)].sort() };
  if (audience.type === 'tags' && !audience.tags.length) throw new Error('Add at least one audience tag.');
  if (audience.type === 'selected' && !audience.subscriptionIds.length) throw new Error('Choose at least one browser.');
  return { name: form.name.trim(), content: parseNotification({ title: form.title, body: form.body, url: form.url }), audience };
}
export function scheduleUtc(value: string, now = Date.now()) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()) || date.getTime() <= now || date.getTime() - now > 604800000) throw new Error('Choose a send time in the next seven days.');
  return date.toISOString();
}
export const stateLabel = (state: string) => state.replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
export const timeLabel = (value?: string) => value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const finished = (state: string) => ['completed', 'completed_with_failures', 'cancelled', 'failed'].includes(state);
