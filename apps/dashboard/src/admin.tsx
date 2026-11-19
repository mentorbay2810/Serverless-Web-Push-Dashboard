import { useState } from 'react';
import { ArrowLeft, Bell, KeyRound, LoaderCircle, LogIn, ShieldCheck } from 'lucide-react';
import { useAdminAuth } from './admin-auth';
import { CampaignWorkspace } from './campaign-workspace';
import './admin.css';

export function AdminPage() {
  const auth = useAdminAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (auth.ready && auth.signedIn) return <CampaignWorkspace request={auth.request} mode={auth.config?.mode ?? 'local'} onSignOut={() => {
    void auth.signOut().catch(() => setError('Sign-out could not reach the service. The browser session was cleared.'));
  }}/>;
  async function connect() {
    setBusy(true); setError('');
    try { await auth.exchange(code.trim()); setCode(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }
  return <div className="admin-auth-page">
    <header className="site-header"><a className="brand" href="/"><span className="brand-mark"><Bell size={22}/></span>Web Push</a><a className="admin-back" href="/"><ArrowLeft size={15}/>Browser connection</a></header>
    <main className="admin-auth-main">
      <div className="eyebrow">YOUR CAMPAIGN WORKSPACE</div><h1>A clear view of every update.</h1><p className="auth-intro">Create thoughtful notifications, choose the right audience, and follow delivery from one place.</p>
      {(auth.error || error) && <div className="message error" role="alert">{error || auth.error}</div>}
      <section className="panel auth-card"><span className="section-icon"><ShieldCheck size={24}/></span>
        {!auth.ready ? <><h2>Checking administrator access</h2><p role="status"><LoaderCircle className="spin" size={16}/>Connecting to the notification service…</p></>
          : auth.config?.localAdmin ? <><h2>Open your local workspace</h2><p>In the project terminal, run the command below. Open the sign-in link it prints to start a private session.</p><code className="terminal-command">npm run admin:login</code><p className="field-hint">The link works once for two minutes. Your session lasts one hour and ends when the API restarts.</p>
            <details><summary>Enter a sign-in code instead</summary><form onSubmit={event => { event.preventDefault(); void connect(); }}><label htmlFor="pair-code">Code from the link</label><input id="pair-code" value={code} onChange={event => setCode(event.target.value)} type="password" autoComplete="off" required minLength={43} maxLength={43}/><button className="button primary" disabled={busy}><KeyRound size={15}/>Open workspace</button></form></details>
          </> : auth.config?.admin ? <><h2>Sign in with Microsoft</h2><p>Your account needs administrator access to this notification service.</p><button className="button primary" onClick={() => void auth.signIn()?.catch(() => setError('Microsoft sign-in could not start. Retry.'))}><LogIn size={16}/>Sign in with Microsoft</button></>
            : <><h2>Start the campaign service</h2><p>Run the queued profile to use campaign management, then reload this page.</p><code className="terminal-command">npm run dev:queued</code><button className="button secondary" onClick={() => location.reload()}>Check again</button></>}
      </section><p className="auth-footnote">{auth.config?.mode === 'local' ? 'Local development · Cloud deployment is off.' : 'Administrator access is verified by the notification service.'}</p>
    </main>
  </div>;
}
