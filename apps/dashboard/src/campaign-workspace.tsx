import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bell, CalendarClock, ChevronRight, CircleCheck, FileText, LoaderCircle, LogOut, Pause, Play, Plus, RefreshCw, Send, Settings2, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { parseTags, type SubscriptionSummary } from '../../../packages/core/src/index.js';
import type { AdminRequest } from './admin-auth';
import { definition, draftFrom, emptyDraft, finished, scheduleUtc, stateLabel, timeLabel, type CampaignReport as Report, type CampaignSummary, type DraftForm, type OperationsView, type Preview } from './admin-model';
import { CampaignEditor, NotificationPreview } from './campaign-editor';
import { CampaignReport } from './campaign-report';

type Tab = 'campaigns' | 'subscribers' | 'operations';
interface Review extends Preview { mode: 'send' | 'schedule'; at?: string; etag: string | null }
interface Props { request: AdminRequest; mode: 'local' | 'azure'; onSignOut: () => void }

export function CampaignWorkspace({ request, mode, onSignOut }: Props) {
  const [tab, setTab] = useState<Tab>('campaigns');
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [filter, setFilter] = useState('');
  const [subscribers, setSubscribers] = useState<SubscriptionSummary[]>([]);
  const [operations, setOperations] = useState<OperationsView>();
  const [detail, setDetail] = useState<Report>();
  const [etag, setEtag] = useState<string | null>(null);
  const [form, setForm] = useState<DraftForm>(emptyDraft);
  const [preview, setPreview] = useState<Preview>();
  const [review, setReview] = useState<Review>();
  const [schedule, setSchedule] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selection = useRef<string | undefined>(undefined);
  const keys = useRef(new Map<string, string>());
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let dirty = false;
  if (!detail) dirty = !!(form.name || form.title || form.body || form.tags || form.selected.length || form.url !== '/' || form.audienceType !== 'tags');
  else if (detail.state === 'draft') {
    try { dirty = JSON.stringify(definition(form)) !== JSON.stringify({ name: detail.name, content: detail.content, audience: detail.audience }); }
    catch { dirty = true; }
  }
  const editable = !detail || detail.state === 'draft';
  const stableKey = (operation: string) => { if (!keys.current.has(operation)) keys.current.set(operation, crypto.randomUUID()); return keys.current.get(operation)!; };

  async function perform(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The request failed. Refresh and retry.'); }
    finally { setBusy(false); }
  }
  async function listCampaigns(more = false) {
    const query = new URLSearchParams({ ...(filter ? { state: filter } : {}), ...(more && cursor ? { cursor } : {}) });
    const result = await request<{ campaigns: CampaignSummary[]; cursor?: string }>(`/campaigns?${query}`);
    setCampaigns(previous => more ? [...new Map([...previous, ...result.data.campaigns].map(row => [row.id, row])).values()] : result.data.campaigns);
    setCursor(result.data.cursor);
  }
  async function loadSubscribers() {
    const rows: SubscriptionSummary[] = []; let next: string | undefined;
    do {
      const result = await request<{ subscriptions: SubscriptionSummary[]; cursor?: string }>(`/subscriptions${next ? `?cursor=${encodeURIComponent(next)}` : ''}`);
      rows.push(...result.data.subscriptions); next = result.data.cursor;
    } while (next && rows.length < 100);
    setSubscribers(rows.slice(0, 100)); setPreview(undefined); setReview(undefined);
  }
  async function readCampaign(id: string) {
    const result = await request<Report>(`/campaigns/${id}`);
    selection.current = id; setDetail(result.data); setEtag(result.etag); setForm(draftFrom(result.data));
    setPreview(undefined); setReview(undefined); setSchedule('');
  }
  async function refresh() {
    await request('/me');
    setAuthorized(true);
    await Promise.all([listCampaigns(), loadSubscribers(), request<OperationsView>('/operations').then(result => setOperations(result.data))]);
    if (selection.current && !dirty) await readCampaign(selection.current);
    setLoaded(true);
  }
  useEffect(() => { void perform(refresh); }, [request]);
  useEffect(() => {
    if (!selection.current || editable || tab !== 'campaigns') return;
    const id = selection.current;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden' || busy) return;
      void Promise.all([request<Report>(`/campaigns/${id}`), request<OperationsView>('/operations')]).then(([result, controls]) => {
        if (selection.current !== id) return;
        setDetail(result.data); setEtag(result.etag); setOperations(controls.data);
        setError(current => current === 'Report refresh failed. Displayed figures may be out of date.' ? '' : current);
        setCampaigns(rows => rows.map(row => row.id === id ? result.data : row));
      }).catch(() => setError('Report refresh failed. Displayed figures may be out of date.'));
    }, 10_000);
    return () => clearInterval(timer);
  }, [request, detail?.id, editable, tab, busy]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function discard() { return !dirty || window.confirm('Discard the unsaved changes in this draft?'); }
  function newDraft() {
    if (!discard()) return;
    selection.current = undefined; setDetail(undefined); setForm(emptyDraft()); setEtag(null); setReview(undefined); setPreview(undefined); setSchedule(''); keys.current.clear(); setTab('campaigns'); setError(''); setNotice('');
  }
  function changeForm(value: DraftForm) { setForm(value); setReview(undefined); setPreview(undefined); }
  async function save() {
    const data = definition(form);
    const saved = await request<CampaignSummary>(detail ? `/campaigns/${detail.id}` : '/campaigns', {
      method: detail ? 'PATCH' : 'POST', body: data, ...(detail ? { etag } : { key: stableKey(`create:${JSON.stringify(data)}`) }),
    });
    await readCampaign(saved.data.id); await listCampaigns(); setNotice('Draft saved. No notifications have been sent.');
  }
  async function previewAudience() {
    const data = definition(form);
    const result = await request<Preview>('/segments/preview', { method: 'POST', body: { audience: data.audience } });
    setPreview(result.data);
  }
  async function prepare(mode: Review['mode']) {
    if (!detail || dirty) throw new Error('Save your draft changes before reviewing the send.');
    const at = mode === 'schedule' ? scheduleUtc(schedule) : undefined;
    const result = await request<Preview>(`/campaigns/${detail.id}/preview`, { method: 'POST', body: {} });
    if (!result.data.count) throw new Error('No active subscribers match this audience. Update the targeting first.');
    if (result.data.snapshot) throw new Error('This campaign is already active. Refresh its report.');
    setReview({ ...result.data, mode, at, etag: result.etag }); setPreview(result.data);
  }
  async function activate() {
    if (!detail || !review) return;
    const body = { fingerprint: review.fingerprint, ...(review.at ? { scheduledAt: review.at } : {}) };
    await request(`/campaigns/${detail.id}/${review.mode}`, { method: 'POST', body, etag: review.etag,
      key: stableKey(`${detail.id}:${review.mode}:${JSON.stringify(body)}`) });
    setReview(undefined); await readCampaign(detail.id); await listCampaigns();
    setNotice(review.mode === 'schedule' ? 'Campaign scheduled. Its audience is now fixed.' : 'Campaign queued. Its audience is now fixed.');
  }
  async function cancelOrDelete(remove = false) {
    if (!detail || !window.confirm(remove ? 'Delete this draft?' : 'Cancel future work for this campaign? Notifications already in flight cannot be recalled.')) return;
    await request(`/campaigns/${detail.id}${remove ? '' : '/cancel'}`, { method: remove ? 'DELETE' : 'POST', ...(remove ? { etag } : { body: {} }) });
    if (remove) { selection.current = undefined; setDetail(undefined); setForm(emptyDraft()); setEtag(null); setReview(undefined); setPreview(undefined); keys.current.clear(); }
    else await readCampaign(detail.id);
    await listCampaigns(); setNotice(remove ? 'Draft deleted.' : 'Campaign cancelled. Already accepted notifications remain in the report.');
  }
  async function toggleControl(field: 'dispatchPaused' | 'sendingPaused') {
    const current = await request<OperationsView>('/operations');
    const result = await request<OperationsView>('/operations', { method: 'PATCH', etag: current.etag,
      body: { dispatchPaused: current.data.dispatchPaused, sendingPaused: current.data.sendingPaused, [field]: !(operations?.[field] ?? false) } });
    setOperations(result.data); setNotice('Delivery controls updated. In-flight requests may still finish.');
  }

  if (!authorized) return <div className="admin-auth-page"><header className="site-header"><a className="brand" href="/"><span className="brand-mark"><Bell size={22}/></span>Web Push</a><button className="button secondary" onClick={onSignOut}>Sign out</button></header><main className="admin-auth-main"><section className="panel auth-card"><span className="section-icon"><ShieldCheck size={24}/></span><h2>{busy ? 'Verifying administrator access' : 'Administrator access is unavailable'}</h2>{error ? <p className="message error" role="alert">{error}</p> : <p role="status"><LoaderCircle size={16} className="spin"/>Checking access with the notification service…</p>}<button className="button secondary" disabled={busy} onClick={() => void perform(refresh)}>Check again</button></section></main></div>;

  return <div className="workspace-shell"><aside className="workspace-sidebar"><a className="brand" href="/"><span className="brand-mark"><Bell size={22}/></span><span>Web Push<span className="brand-subtitle">Campaign workspace</span></span></a><span className="sidebar-label">WORKSPACE</span><nav aria-label="Administrator navigation">
    {([{ id: 'campaigns', label: 'Campaigns', icon: FileText }, { id: 'subscribers', label: 'Subscribers', icon: Users }, { id: 'operations', label: 'Delivery controls', icon: Settings2 }] as const).map(({ id, label, icon: Icon }) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={18}/>{label}{id === 'subscribers' && <span>{subscribers.length}</span>}</button>)}
    </nav><div className="sidebar-bottom"><a href="/"><ArrowLeft size={15}/>Browser connection</a><div><ShieldCheck size={17}/><span>{mode === 'local' ? 'Local workspace' : 'Cloud workspace'}<small>{mode === 'local' ? 'Cloud deployment is off' : 'API-protected access'}</small></span></div></div></aside>
    <div className="workspace-body"><header className="workspace-topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13}/><span>{tab === 'campaigns' ? 'Campaigns' : tab === 'subscribers' ? 'Subscribers' : 'Delivery controls'}</span></div><div><span className="environment"><span/>{mode === 'local' ? 'Local development' : 'Azure'}</span><button className="icon-button" onClick={onSignOut} aria-label="Sign out" title="Sign out"><LogOut size={17}/></button></div></header>
    <main className="workspace-main"><section className="workspace-heading"><div><span className="eyebrow">YOUR NOTIFICATION SPACE</span><h1>{tab === 'campaigns' ? 'Good updates start here.' : tab === 'subscribers' ? 'Know your audience.' : 'You set the pace.'}</h1><p>{tab === 'campaigns' ? 'Create, schedule, and follow every notification.' : tab === 'subscribers' ? 'Organize connected browsers with simple tags.' : 'Pause campaign expansion and sending independently.'}</p></div><div><button className="button secondary" disabled={busy} onClick={() => void perform(refresh)}><RefreshCw size={15} className={busy ? 'spin' : ''}/>Refresh</button>{tab === 'campaigns' && <button className="button primary" disabled={busy} onClick={newDraft}><Plus size={16}/>New campaign</button>}</div></section>
      {error && <div className="message error" role="alert"><X size={17}/><span>{error}</span></div>}{notice && <div className="message success" role="status"><CircleCheck size={17}/><span>{notice}</span></div>}
      {(operations?.dispatchPaused || operations?.sendingPaused) && <div className="pause-banner"><Pause size={16}/><span>{operations.dispatchPaused && operations.sendingPaused ? 'Campaign expansion and sending are paused.' : operations.dispatchPaused ? 'Campaign expansion is paused.' : 'Sending is paused. Queued notifications will wait.'}</span><button onClick={() => setTab('operations')}>Manage controls<ChevronRight size={14}/></button></div>}
      {!loaded && busy && <p className="loading-row" role="status"><LoaderCircle className="spin" size={17}/>Loading your workspace…</p>}
      {tab === 'campaigns' && <div className="campaign-layout"><section className="panel campaign-library" aria-label="Campaign library"><div className="library-heading"><h2>Campaigns <span>{campaigns.length} shown</span></h2><label htmlFor="campaign-filter" className="sr-only">Filter campaigns by state</label><select id="campaign-filter" disabled={busy} value={filter} onChange={event => {
        const next = event.target.value; setFilter(next); void perform(async () => { const result = await request<{ campaigns: CampaignSummary[]; cursor?: string }>(`/campaigns${next ? `?state=${next}` : ''}`); setCampaigns(result.data.campaigns); setCursor(result.data.cursor); });
      }}><option value="">All states</option>{['draft', 'scheduled', 'pending', 'queued', 'dispatching', 'sending', 'completed', 'completed_with_failures', 'cancelled'].map(state => <option key={state} value={state}>{stateLabel(state)}</option>)}</select></div>
        <div className="campaign-list">{campaigns.map(row => <button disabled={busy} className={`campaign-list-item ${detail?.id === row.id ? 'selected' : ''}`} key={row.id} onClick={() => { if (discard()) void perform(() => readCampaign(row.id)); }}><div><span className={`campaign-state state-${row.state}`}>{stateLabel(row.state)}</span><ChevronRight size={14}/></div><strong>{row.name}</strong><p>{row.content.title}</p><small><CalendarClock size={12}/>{timeLabel(row.scheduledAt ?? row.createdAt)}</small></button>)}</div>
        {loaded && !campaigns.length && <div className="library-empty"><FileText size={25}/><h3>{filter ? 'No matching campaigns' : 'Your first update awaits'}</h3><p>{filter ? 'Try another state or create a draft.' : 'Create a draft, choose an audience, and send when you are ready.'}</p></div>}{cursor && <button className="button secondary load-more" disabled={busy} onClick={() => void perform(() => listCampaigns(true))}>Load more campaigns</button>}</section>
        <section className="panel campaign-detail" aria-label="Selected campaign"><div className="detail-heading"><div><span className="eyebrow">{detail ? 'CAMPAIGN DETAILS' : 'A FRESH DRAFT'}</span><h2>{detail?.name ?? 'Create a campaign'}</h2></div>{detail && <span className={`campaign-state state-${detail.state}`}>{stateLabel(detail.state)}</span>}</div>
          {editable ? <><CampaignEditor form={form} onChange={changeForm} busy={busy} subscribers={subscribers} saved={!!detail} dirty={dirty} preview={preview} onPreview={() => void perform(previewAudience)} onSave={() => void perform(save)}/>
            {detail && <section className="activation-section"><div className="section-row"><h3>Send when it matters</h3><button className="text-button danger" disabled={busy} onClick={() => void perform(() => cancelOrDelete(true))}><Trash2 size={14}/>Delete draft</button></div><p className="field-hint">Save changes, then review the audience before confirming.</p><label htmlFor="campaign-schedule">Scheduled send time · {timezone}</label><input id="campaign-schedule" type="datetime-local" disabled={busy} value={schedule} onChange={event => { setSchedule(event.target.value); setReview(undefined); }}/><div className="activation-buttons"><button className="button primary" disabled={busy || dirty} onClick={() => void perform(() => prepare('send'))}><Send size={15}/>Review immediate send</button><button className="button secondary" disabled={busy || dirty || !schedule} onClick={() => void perform(() => prepare('schedule'))}><CalendarClock size={15}/>Review schedule</button></div>
              {review && <div className="send-review" role="region" aria-label="Confirm campaign activation"><strong>{review.mode === 'schedule' ? 'Schedule this campaign?' : 'Send this campaign now?'}</strong><p>{review.count} browser{review.count === 1 ? '' : 's'} will be targeted. This audience becomes fixed when you confirm.</p>{review.at && <p>{timeLabel(review.at)} · {timezone}<small>{review.at} (UTC)</small></p>}{operations?.sendingPaused && <p>Sending is currently paused. This campaign will wait until you resume.</p>}<div><button className="button primary" disabled={busy} onClick={() => void perform(activate)}>{review.mode === 'schedule' ? 'Confirm schedule' : 'Confirm send'}</button><button className="button secondary" disabled={busy} onClick={() => setReview(undefined)}>Back to draft</button></div></div>}
            </section>}</> : detail && <><div className="saved-content"><NotificationPreview {...detail.content}/><div><h3>Audience snapshot</h3><p>{detail.recipientCount} browser{detail.recipientCount === 1 ? '' : 's'} · {detail.audience.type === 'tags' ? detail.audience.tags.join(' + ') : detail.audience.type === 'all' ? 'All active subscribers at activation' : 'Selected browsers'}</p>{detail.scheduledAt && <p>Scheduled for {timeLabel(detail.scheduledAt)} · {timezone}</p>}<code className="campaign-reference">{detail.id}</code>{!finished(detail.state) && <button className="button secondary" disabled={busy} onClick={() => void perform(() => cancelOrDelete())}>Cancel future sends</button>}</div></div><CampaignReport report={detail}/></>}
        </section></div>}
      {tab === 'subscribers' && <section className="panel subscribers-panel"><div className="section-row"><div><h2>Connected browsers</h2><p className="field-hint">{subscribers.length} / 100 demonstration slots used. Tags define your campaign audiences.</p></div><a className="button secondary" href="/">Connect a browser</a></div><div className="subscriber-cards">{subscribers.map(row => <Subscriber key={row.id} row={row} request={request} busy={busy} perform={perform} reload={loadSubscribers}/>)}</div>{loaded && !subscribers.length && <p className="empty-inline">No browsers connected yet. Open Browser connection and enable notifications.</p>}</section>}
      {tab === 'operations' && <section className="panel operations-panel"><h2>Delivery controls</h2><p className="field-hint">Pauses are saved across backend restarts. Existing provider requests may finish.</p>{([{ field: 'dispatchPaused', title: 'Campaign expansion', description: 'Create delivery jobs and release due schedules.' }, { field: 'sendingPaused', title: 'Notification sending', description: 'Send queued jobs to browser push services.' }] as const).map(({ field, title, description }) => <div className="control-row" key={field}><span className={`control-icon ${operations?.[field] ? 'paused' : ''}`}>{operations?.[field] ? <Pause size={20}/> : <Play size={20}/>}</span><div><h3>{title}</h3><p>{description}</p><small>{!operations ? 'Checking state…' : operations[field] ? 'Paused · work is retained' : 'Running'}</small></div><button className="button secondary" aria-pressed={operations?.[field] ?? false} disabled={busy || !operations} onClick={() => void perform(() => toggleControl(field))}>{operations?.[field] ? <Play size={14}/> : <Pause size={14}/>}{operations?.[field] ? `Resume ${title.toLowerCase()}` : `Pause ${title.toLowerCase()}`}</button></div>)}<p className="observation-note">These controls manage notification work. They do not enforce an Azure spending limit. {mode === 'local' && 'Cloud deployment remains off.'}</p></section>}
      <footer className="workspace-footer"><span><Bell size={14}/>Web Push Notification Service</span><span>Times shown in {timezone}.</span></footer>
    </main></div></div>;
}

function Subscriber({ row, request, busy, perform, reload }: { row: SubscriptionSummary; request: AdminRequest; busy: boolean; perform: (work: () => Promise<void>) => Promise<void>; reload: () => Promise<void> }) {
  const [edit, setEdit] = useState<{ tags: string; etag: string | null }>();
  async function start() { const result = await request<SubscriptionSummary>(`/subscriptions/${row.id}`); setEdit({ tags: (result.data.tags ?? []).join(', '), etag: result.etag }); }
  async function save() {
    if (!edit) return;
    await request(`/subscriptions/${row.id}/tags`, { method: 'PATCH', body: { tags: parseTags(edit.tags.split(',').map(tag => tag.trim()).filter(Boolean)) }, etag: edit.etag });
    setEdit(undefined); await reload();
  }
  return <article className="subscriber-card"><div className="subscriber-title"><span className="section-icon"><Users size={19}/></span><div><h3>{row.provider}</h3><code>{row.id.slice(0, 16)}</code></div>{!edit && <button className="button secondary" disabled={busy} onClick={() => void perform(start)}>Edit tags</button>}</div><div className="subscriber-dates"><span>Connected {timeLabel(row.createdAt)}</span><span>Last accepted {timeLabel(row.lastAcceptedAt)}</span></div>
    {edit ? <form onSubmit={event => { event.preventDefault(); void perform(save); }}><label htmlFor={`tags-${row.id}`}>Tags, separated by commas</label><input id={`tags-${row.id}`} disabled={busy} value={edit.tags} onChange={event => setEdit({ ...edit, tags: event.target.value })}/><div className="tag-edit-actions"><button className="button primary" disabled={busy}>Save tags</button><button className="button secondary" disabled={busy} type="button" onClick={() => void perform(start)}>Reload tags</button><button className="text-button" type="button" disabled={busy} onClick={() => setEdit(undefined)}>Cancel</button></div></form>
      : <div className="tag-list">{row.tags?.length ? row.tags.map(tag => <span key={tag}>{tag}</span>) : <small>No tags assigned</small>}</div>}
  </article>;
}
