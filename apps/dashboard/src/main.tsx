import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { ArrowRight, Bell, BellRing, Check, CheckCheck, ChevronRight, Circle, CircleCheck, Clock3, Globe2, LoaderCircle, LockKeyhole, Monitor, RefreshCw, Send, ShieldCheck, Unplug, X } from 'lucide-react';
import { DEFAULT_NOTIFICATION } from '../../../packages/core/src/index.js';
import { usePush } from './use-push';
import './styles.css';
const AdminPage = lazy(() => import('./admin').then(module => ({ default: module.AdminPage })));

function App() {
  const push = usePush();
  const [title, setTitle] = useState(DEFAULT_NOTIFICATION.title);
  const [body, setBody] = useState(DEFAULT_NOTIFICATION.body);
  const connected = push.connection === 'connected';
  const unsupported = push.connection === 'unsupported';
  const blocked = push.connection === 'blocked';
  const labels = {
    loading: 'Checking connection', unsupported: 'Browser not supported', blocked: 'Permission blocked',
    disconnected: 'Not connected', reconnect: 'Reconnect needed', connected: 'Connected',
  };
  const loading = push.busy || push.connection === 'loading';
  const iconSize = 18;

  function submit(event: FormEvent) { event.preventDefault(); void push.sendTest({ title, body, url: '/' }); }

  return <>
    <header className="site-header">
      <a className="brand" href="/" aria-label="Web Push home"><span className="brand-mark"><Bell size={22} strokeWidth={1.8}/></span><span>Web Push<span className="brand-subtitle">Notification service</span></span></a>
      <nav aria-label="Main navigation"><a className="nav-active" href="#connection">Browser connection</a><a href="#delivery-guide">How it works</a><a href="/admin">Admin access</a></nav>
      <span className="environment"><span/>{push.config?.mode === 'azure' ? 'Cloud connection' : 'Local development'}</span>
    </header>

    <main>
      <div className="breadcrumb"><span>Workspace</span><ChevronRight size={13}/><span>Browser connection</span></div>
      <section className="page-heading">
        <div><div className="eyebrow">YOUR NOTIFICATION SPACE</div><h1>Connect your browser.</h1><p>Receive updates right where you are, even after you close this tab.</p></div>
        <span className="private-label"><ShieldCheck size={16}/>Your browser. Your permission.</span>
      </section>

      {push.error && <div className="message error" role="alert"><X size={18}/><span>{push.error}</span></div>}
      {push.notice && <div className="message success" role="status"><CircleCheck size={18}/><span>{push.notice}</span></div>}

      <div className="connection-grid" id="connection">
        <section className="panel connection-panel" aria-labelledby="connection-title">
          <div className="panel-top"><span className="section-icon"><Monitor size={23} strokeWidth={1.7}/></span><span className={`status-badge ${connected ? 'is-connected' : blocked ? 'is-blocked' : ''}`}><span/>{labels[push.connection]}</span></div>
          <h2 id="connection-title">Browser notifications</h2>
          <p className="panel-description">A direct connection for the updates that matter.<br className="desktop-break"/> You can disconnect this browser at any time.</p>

          <div className="connection-checks">
            <div><span className="check-icon"><LockKeyhole size={iconSize}/></span><span>Notification permission</span><strong>{unsupported ? 'Unavailable' : push.permission === 'granted' ? 'Allowed' : blocked ? 'Blocked' : 'Your choice'}</strong>{push.permission === 'granted' ? <Check size={16} className="positive"/> : <Circle size={7} className="pending-dot"/>}</div>
            <div><span className="check-icon"><Globe2 size={iconSize}/></span><span>Background delivery</span><strong>{push.workerReady ? 'Ready' : unsupported ? 'Unavailable' : 'Not ready'}</strong>{push.workerReady ? <Check size={16} className="positive"/> : <Circle size={7} className="pending-dot"/>}</div>
            <div><span className="check-icon"><BellRing size={iconSize}/></span><span>This browser</span><strong>{connected ? 'Connected' : 'Not connected'}</strong>{connected ? <Check size={16} className="positive"/> : <Circle size={7} className="pending-dot"/>}</div>
          </div>

          {unsupported ? <div className="connection-help">Open this page in Chrome, Edge, Firefox, or a supported Safari browser. Web Push also requires a secure website or localhost.</div>
            : blocked ? <div className="connection-help">Allow notifications in this website’s browser settings, then check your connection.</div>
            : push.connection === 'reconnect' ? <div className="connection-help">Reconnect to refresh this browser’s saved notification subscription.</div> : null}

          <div className="connection-actions">
            {push.canDisconnect ? <button className="button secondary" onClick={() => void push.disconnect()} disabled={loading}><Unplug size={16}/>Disconnect browser</button>
              : <button className="button primary" onClick={() => void push.connect()} disabled={loading || unsupported || blocked || !push.config}>{loading ? <LoaderCircle className="spin" size={17}/> : <Bell size={17}/>}Enable notifications<ArrowRight size={16}/></button>}
            <button className="refresh-button" aria-label="Check connection" title="Check connection" onClick={() => void push.check()} disabled={loading}><RefreshCw size={17}/></button>
          </div>
          <p className="quiet-note"><LockKeyhole size={12}/>Permission is requested only when you choose to connect.</p>
        </section>

        <aside className="preview-panel" aria-label="Notification preview">
          <div className="preview-heading"><span className="eyebrow">A SMALL UPDATE. RIGHT ON TIME.</span><Bell size={17}/></div>
          <div className="preview-scene">
            <div className="preview-window"><span/><span/><span/><div>your browser</div></div>
            <div className="notification-preview"><span className="preview-bell"><Bell size={21}/></span><div><div className="notification-source">WEB PUSH <span>now</span></div><strong>{title.trim() || 'Your notification title'}</strong><p>{body.trim() || 'Your notification message appears here.'}</p></div></div>
            <div className="preview-caption"><span className="caption-line"/>Notification preview<span className="caption-line"/></div>
          </div>
          <div className="preview-footer"><ShieldCheck size={20}/><div><strong>Private by design</strong><p>Messages are encrypted for this browser.<br/>You stay in control of the connection.</p></div></div>
        </aside>
      </div>

      <div className="lower-grid">
        <section className="panel test-panel" aria-labelledby="test-title">
          <div className="section-heading"><span className="step-label">01</span><div><h2 id="test-title">Try your first notification</h2><p>A small message, sent only to this browser.</p></div></div>
          <form onSubmit={submit}>
            <label htmlFor="notification-title">Notification title<span>{title.length}/80</span></label>
            <input id="notification-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={80} required/>
            <label htmlFor="notification-body">Message<span>{body.length}/240</span></label>
            <textarea id="notification-body" value={body} onChange={event => setBody(event.target.value)} maxLength={240} rows={3} required/>
            <div className="form-bottom"><span>{connected ? <><CircleCheck size={14}/>Ready to send to this browser</> : <><LockKeyhole size={14}/>Connect your browser to send a test</>}</span><button className="button primary" type="submit" disabled={!connected || loading || !title.trim() || !body.trim()}>{push.busy && connected ? <LoaderCircle className="spin" size={16}/> : <Send size={16}/>}Send test notification</button></div>
          </form>
        </section>

        <section className="panel activity-panel" aria-labelledby="activity-title">
          <div className="activity-heading"><h2 id="activity-title">Connection activity</h2><span className="session-label">This session</span></div>
          {push.activity.length === 0 ? <div className="activity-empty"><span><Clock3 size={23} strokeWidth={1.5}/></span><h3>A fresh start.</h3><p>Your connection and test notifications<br/>will appear here as they happen.</p></div>
            : <ol className="activity-list" aria-live="polite">{push.activity.map(item => <li key={item.id}><span className="activity-dot"><CheckCheck size={14}/></span><div><strong>{item.title}</strong><p>{item.detail}</p><time dateTime={item.time.toISOString()}>{item.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div></li>)}</ol>}
          {push.summary && <div className="connected-detail"><span>Connected via</span><strong>{push.summary.provider}</strong></div>}
        </section>
      </div>

      <section className="delivery-guide" id="delivery-guide" aria-labelledby="guide-title">
        <div><span className="eyebrow">BEHIND EVERY NOTIFICATION</span><h2 id="guide-title">One connection. Three simple steps.</h2></div>
        <div className="guide-steps"><div><span>1</span><strong>You give permission</strong><p>Your browser asks before connecting.</p></div><ChevronRight size={17}/><div><span>2</span><strong>We send your update</strong><p>An encrypted message reaches the push service.</p></div><ChevronRight size={17}/><div><span>3</span><strong>Your browser delivers</strong><p>A notification appears on your device.</p></div></div>
      </section>
      <footer><span><Bell size={14}/>Web Push Notification Service</span><span>Built with your permission.</span></footer>
    </main>
  </>;
}

createRoot(document.getElementById('root')!).render(location.pathname === '/admin'
  ? <Suspense fallback={<main><p role="status">Loading administrator access…</p></main>}><AdminPage/></Suspense> : <App/>);
