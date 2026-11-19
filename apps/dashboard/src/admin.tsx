import { useEffect, useState } from 'react';
import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-browser';
import { ArrowLeft, Bell, LogIn, Send, ShieldCheck } from 'lucide-react';
import { DEFAULT_NOTIFICATION, type PublicConfig, type SubscriptionSummary } from '../../../packages/core/src/index.js';
import { apiUrl } from './api';

export function AdminPage() {
  const [config, setConfig] = useState<PublicConfig>();
  const [client, setClient] = useState<PublicClientApplication>();
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [subscriptions, setSubscriptions] = useState<SubscriptionSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState(DEFAULT_NOTIFICATION.title);
  const [body, setBody] = useState(DEFAULT_NOTIFICATION.body);

  useEffect(() => {
    (async () => {
      const response = await fetch(apiUrl('/api/config'));
      if (!response.ok) throw new Error('The notification service is unavailable.');
      const settings = await response.json() as PublicConfig;
      setConfig(settings);
      if (settings.admin) {
        const msal = new PublicClientApplication({ auth: {
          clientId: settings.admin.clientId, authority: `https://login.microsoftonline.com/${settings.admin.tenantId}`,
          redirectUri: `${location.origin}/admin`, postLogoutRedirectUri: location.origin,
        }, cache: { cacheLocation: 'sessionStorage' } });
        await msal.initialize();
        const result = await msal.handleRedirectPromise();
        if (result?.account) msal.setActiveAccount(result.account);
        else if (msal.getAllAccounts()[0]) msal.setActiveAccount(msal.getAllAccounts()[0]!);
        setClient(msal); setSignedIn(!!msal.getActiveAccount());
      }
    })().catch(cause => setError(cause instanceof Error ? cause.message : 'Administrator access could not load.')).finally(() => setReady(true));
  }, []);

  async function request(path: string, payload?: unknown) {
    if (!client || !config?.admin || !client.getActiveAccount()) throw new Error('Sign in first.');
    let accessToken: string;
    try { accessToken = (await client.acquireTokenSilent({ scopes: [config.admin.scope], account: client.getActiveAccount()! })).accessToken; }
    catch (cause) {
      if (cause instanceof InteractionRequiredAuthError) { await client.acquireTokenRedirect({ scopes: [config.admin.scope] }); throw new Error('Finish sign-in to continue.'); }
      throw cause;
    }
    const response = await fetch(apiUrl(path), { method: payload ? 'POST' : 'GET', headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(payload ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } : {}),
    }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'The administrator request failed.');
    return result;
  }
  async function loadSubscribers() {
    setBusy(true); setError('');
    try {
      await request('/api/admin/me');
      let cursor: string | undefined;
      const rows: SubscriptionSummary[] = [];
      do {
        const result = await request(`/api/admin/subscriptions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        rows.push(...result.subscriptions); cursor = result.cursor;
      } while (cursor && rows.length < 100);
      setSubscriptions(rows.slice(0, 100));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load subscribers.'); }
    finally { setBusy(false); }
  }
  async function send() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request('/api/admin/campaigns/test', { title, body, url: '/', subscriptionIds: selected });
      setNotice(`Campaign queued for ${selected.length} selected browser${selected.length === 1 ? '' : 's'}. Reference: ${result.id.slice(0, 12)}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not queue the campaign.'); }
    finally { setBusy(false); }
  }
  return <>
    <header className="site-header"><a className="brand" href="/"><span className="brand-mark"><Bell size={22}/></span>Web Push</a><a className="admin-back" href="/"><ArrowLeft size={15}/>Browser connection</a></header>
    <main className="admin-main"><section className="page-heading"><div><div className="eyebrow">ADMINISTRATOR WORKSPACE</div><h1>Administrator access</h1><p>Manage registered browsers and verify queued notification delivery.</p></div><ShieldCheck size={28}/></section>
      {error && <div className="message error" role="alert">{error}</div>}
      {notice && <div className="message success" role="status">{notice}</div>}
      <section className="panel admin-panel">
        {!ready ? <p role="status">Checking administrator access…</p> : !config?.admin ? <><h2>Local demonstration</h2><p>Microsoft administrator sign-in is disabled in this local environment. Subscriber connections and local queued delivery remain available.</p><a className="button secondary" href="/">Return to browser connection<ArrowLeft size={15}/></a></>
          : !signedIn ? <><h2>Sign in with Microsoft</h2><p>This area requires an authorized administrator account.</p><button className="button primary" onClick={() => void client?.loginRedirect({ scopes: [config.admin!.scope] })}><LogIn size={16}/>Sign in</button></>
          : <><div className="admin-toolbar"><h2>Registered browsers</h2><button className="button secondary" disabled={busy} onClick={() => void loadSubscribers()}>Load browsers</button><button className="button secondary" onClick={() => void client?.logoutRedirect()}>Sign out</button></div>
            {subscriptions.length === 0 ? <p>Load registered browsers to choose recipients.</p> : <div className="subscriber-list">{subscriptions.map(row => <label key={row.id}><input type="checkbox" checked={selected.includes(row.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id))}/><span>{row.provider}<small>{row.id.slice(0, 12)}</small></span></label>)}</div>}
            <form onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="admin-title">Notification title</label><input id="admin-title" required maxLength={80} value={title} onChange={event => setTitle(event.target.value)}/><label htmlFor="admin-body">Message</label><textarea id="admin-body" required maxLength={240} value={body} onChange={event => setBody(event.target.value)}/><div className="form-bottom"><span>{selected.length} browser(s) selected</span><button className="button primary" disabled={busy || !selected.length}><Send size={15}/>Queue test campaign</button></div></form>
          </>}
      </section>
    </main>
  </>;
}
