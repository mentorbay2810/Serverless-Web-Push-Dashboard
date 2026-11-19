import { Bell, Eye, Save, Users } from 'lucide-react';
import type { SubscriptionSummary } from '../../../packages/core/src/index.js';
import type { DraftForm, Preview } from './admin-model';

export function NotificationPreview({ title, body, url }: { title: string; body: string; url: string }) {
  return <aside className="campaign-preview" aria-label="Notification preview"><span className="eyebrow">NOTIFICATION PREVIEW</span><div className="notification-preview"><span className="preview-bell"><Bell size={21}/></span><div><div className="notification-source">WEB PUSH <span>now</span></div><strong>{title.trim() || 'Your notification title'}</strong><p>{body.trim() || 'Your message will appear here.'}</p></div></div><p className="field-hint">Opens {url || '/'} on this website. Appearance varies by browser and device.</p></aside>;
}
interface EditorProps {
  form: DraftForm; onChange: (form: DraftForm) => void; busy: boolean; subscribers: SubscriptionSummary[];
  saved: boolean; dirty: boolean; preview?: Preview; onPreview: () => void; onSave: () => void;
}
export function CampaignEditor({ form, onChange, busy, subscribers, saved, dirty, preview, onPreview, onSave }: EditorProps) {
  const change = (patch: Partial<DraftForm>) => onChange({ ...form, ...patch });
  return <form className="campaign-editor" onSubmit={event => { event.preventDefault(); onSave(); }}>
    <fieldset disabled={busy}><legend className="sr-only">Campaign content and audience</legend><div className="editor-grid"><div>
      <label htmlFor="campaign-name">Campaign name <span>Only visible to administrators</span></label><input id="campaign-name" placeholder="e.g. November project update" value={form.name} onChange={event => change({ name: event.target.value })} maxLength={100} required/>
      <label htmlFor="campaign-title">Notification title <span>{form.title.length}/80</span></label><input id="campaign-title" placeholder="A small update worth sharing" value={form.title} onChange={event => change({ title: event.target.value })} maxLength={80} required/>
      <label htmlFor="campaign-body">Message <span>{form.body.length}/240</span></label><textarea id="campaign-body" rows={3} placeholder="Write a clear, useful message…" value={form.body} onChange={event => change({ body: event.target.value })} maxLength={240} required/>
      <label htmlFor="campaign-url">Destination path</label><input id="campaign-url" placeholder="/updates" value={form.url} onChange={event => change({ url: event.target.value })} maxLength={512} required/><p className="field-hint">Use a path on this website, such as /updates.</p>
    </div><NotificationPreview title={form.title} body={form.body} url={form.url}/></div>
    <div className="editor-section"><h3><Users size={17}/>Choose an audience</h3><label htmlFor="audience-type" className="sr-only">Audience type</label><select id="audience-type" value={form.audienceType} onChange={event => change({ audienceType: event.target.value as DraftForm['audienceType'] })}><option value="tags">Matching tags</option><option value="selected">Selected browsers</option><option value="all">All active subscribers</option></select>
      {form.audienceType === 'tags' && <><label htmlFor="audience-tags">Target tags</label><input id="audience-tags" placeholder="demo, updates" value={form.tags} onChange={event => change({ tags: event.target.value })}/><p className="field-hint">Subscribers must have every tag. Separate tags with commas.</p></>}
      {form.audienceType === 'selected' && <div className="audience-picker">{subscribers.length ? subscribers.map(row => <label key={row.id}><input type="checkbox" checked={form.selected.includes(row.id)} onChange={event => change({ selected: event.target.checked ? [...form.selected, row.id] : form.selected.filter(id => id !== row.id) })}/><span>{row.provider}<small>{row.id.slice(0, 12)} · {(row.tags ?? []).join(', ') || 'No tags'}</small></span></label>) : <p className="field-hint">No browsers are connected. Open Browser connection to subscribe.</p>}</div>}
      {form.audienceType === 'all' && <p className="audience-note">This campaign will target every active subscriber. Review the recipient count before confirming.</p>}
      <div className="audience-preview-row"><button className="button secondary" type="button" onClick={onPreview}><Eye size={15}/>Preview audience</button><span role="status">{preview ? `${preview.count} matching browser${preview.count === 1 ? '' : 's'}` : 'Audience has not been previewed'}</span></div>
    </div><div className="editor-footer"><span>{saved ? dirty ? 'Unsaved changes' : 'All changes saved' : 'A draft sends no notifications.'}</span><button className="button primary" disabled={saved && !dirty}><Save size={15}/>{saved ? 'Save changes' : 'Save draft'}</button></div></fieldset>
  </form>;
}
