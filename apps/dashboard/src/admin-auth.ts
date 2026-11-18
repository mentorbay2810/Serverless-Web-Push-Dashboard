import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicClientApplication } from '@azure/msal-browser';
import type { PublicConfig } from '../../../packages/core/src/index.js';
import { apiUrl } from './api';

export interface RequestOptions { method?: string; body?: unknown; etag?: string | null; key?: string }
export type AdminRequest = <T>(path: string, options?: RequestOptions) => Promise<{ data: T; etag: string | null }>;
const storageKey = 'webpush.admin.session.v1';
interface Session { token: string; expiresAt: string }

export function useAdminAuth() {
  const [config, setConfig] = useState<PublicConfig>();
  const [client, setClient] = useState<PublicClientApplication>();
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState('');
  const session = useRef<Session | undefined>(undefined);
  const saveSession = (value?: Session) => {
    session.current = value;
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch { /* Memory-only access remains usable until reload. */ }
    setSignedIn(!!value);
  };
  async function exchange(code: string) {
    const response = await fetch(apiUrl('/api/local/session/exchange'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }), signal: AbortSignal.timeout(10_000), credentials: 'omit', redirect: 'error' });
    const data = await response.json() as Session & { error?: string };
    if (!response.ok) throw new Error(data.error ?? 'Local sign-in failed. Generate a fresh link.');
    saveSession(data); setError('');
  }
  useEffect(() => {
    let active = true;
    const code = new URLSearchParams(location.hash.slice(1)).get('pair');
    if (code) history.replaceState(null, '', `${location.pathname}${location.search}`);
    (async () => {
      const response = await fetch(apiUrl('/api/config'), { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('The notification service is unavailable. Start the local service and reload.');
      const settings = await response.json() as PublicConfig;
      if (!active) return;
      setConfig(settings);
      if (settings.localAdmin && settings.mode === 'local') {
        if (code) await exchange(code);
        else {
          try {
            const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Session | null;
            if (stored && typeof stored.token === 'string' && Date.parse(stored.expiresAt) > Date.now()) saveSession(stored);
          } catch { saveSession(); }
        }
      } else if (settings.admin) {
        const { PublicClientApplication } = await import('@azure/msal-browser');
        const msal = new PublicClientApplication({ auth: { clientId: settings.admin.clientId,
          authority: `https://login.microsoftonline.com/${settings.admin.tenantId}`, redirectUri: `${location.origin}/admin`, postLogoutRedirectUri: location.origin },
          cache: { cacheLocation: 'sessionStorage' } });
        await msal.initialize(); const result = await msal.handleRedirectPromise();
        msal.setActiveAccount(result?.account ?? msal.getAllAccounts()[0] ?? null);
        if (active) { setClient(msal); setSignedIn(!!msal.getActiveAccount()); }
      }
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Administrator access could not load.'); })
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  const request: AdminRequest = useCallback(async <T,>(path: string, options: RequestOptions = {}) => {
    let token: string;
    let base = '/api/admin';
    if (config?.localAdmin && config.mode === 'local') {
      if (!session.current || Date.parse(session.current.expiresAt) <= Date.now()) { saveSession(); throw new Error('Generate a new local administrator link to continue.'); }
      token = session.current.token; base = '/api/local/manage';
    } else {
      if (!client || !config?.admin || !client.getActiveAccount()) throw new Error('Sign in to continue.');
      try { token = (await client.acquireTokenSilent({ scopes: [config.admin.scope], account: client.getActiveAccount()! })).accessToken; }
      catch (cause) {
        const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
        if (cause instanceof InteractionRequiredAuthError) { await client.acquireTokenRedirect({ scopes: [config.admin.scope] }); throw new Error('Finish Microsoft sign-in to continue.'); }
        throw cause;
      }
    }
    const response = await fetch(apiUrl(`${base}${path}`), { method: options.method ?? 'GET', headers: {
      Authorization: `Bearer ${token}`, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.etag ? { 'If-Match': options.etag } : {}), ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}), signal: AbortSignal.timeout(15_000), credentials: 'omit', redirect: 'error' });
    const data = response.status === 204 ? undefined : await response.json();
    if (!response.ok) {
      if (response.status === 401) { saveSession(); setSignedIn(false); }
      throw new Error(data?.error ?? 'The administrator request failed.');
    }
    return { data: data as T, etag: response.headers.get('etag') };
  }, [config, client]);

  async function signOut() {
    if (session.current) {
      try { await fetch(apiUrl('/api/local/session/logout'), { method: 'POST', headers: { Authorization: `Bearer ${session.current.token}` }, signal: AbortSignal.timeout(5000) }); }
      finally { saveSession(); }
    } else await client?.logoutRedirect();
  }
  return { config, ready, signedIn, error, request, exchange, signOut,
    signIn: () => client?.loginRedirect({ scopes: config?.admin ? [config.admin.scope] : [] }) };
}
