import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationContent, PublicConfig, SubscriptionSummary } from '../../../packages/core/src/index.js';
import { apiUrl } from './api';

interface Credential { id: string; token: string }
class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface Activity { id: string; title: string; detail: string; time: Date }
export type Connection = 'loading' | 'unsupported' | 'blocked' | 'disconnected' | 'reconnect' | 'connected';
const storageKey = 'webpush.browser.v1';

function readCredential(): Credential | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Credential | null;
    return value && typeof value.id === 'string' && typeof value.token === 'string' ? value : null;
  } catch { return null; }
}

function serverKey(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const result = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) result[i] = decoded.charCodeAt(i);
  return result;
}

async function api<T>(path: string, options: { credential?: Credential; body?: unknown; method?: string } = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: {
      ...(options.credential ? { Authorization: `Bearer ${options.credential.token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'The connection could not be updated.');
  return data;
}

export function usePush() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [connection, setConnection] = useState<Connection>('loading');
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [workerReady, setWorkerReady] = useState(false);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [summary, setSummary] = useState<SubscriptionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activity, setActivity] = useState<Activity[]>([]);
  const receivedIds = useRef(new Set<string>());

  const log = useCallback((title: string, detail: string) => {
    setActivity(items => [{ id: crypto.randomUUID(), title, detail, time: new Date() }, ...items].slice(0, 8));
  }, []);

  const refresh = useCallback(async () => {
    setError('');
    // The API and frontend restart independently during local hot reload.
    let currentConfig: PublicConfig | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { currentConfig = await api<PublicConfig>('/api/config'); break; }
      catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1))); }
    }
    if (!currentConfig) throw new Error('The local notification service is unavailable.');
    setConfig(currentConfig);
    if (!isSecureContext || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setConnection('unsupported');
      return;
    }
    setPermission(Notification.permission);
    if (Notification.permission === 'denied') { setCredential(readCredential()); setConnection('blocked'); return; }
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Background delivery did not become ready. Reload this page and retry.')), 10_000)),
    ]);
    setWorkerReady(!!ready.active);
    const subscription = await registration.pushManager.getSubscription();
    const saved = readCredential();
    if (subscription && saved) {
      const existingKey = subscription.options.applicationServerKey;
      const expectedKey = serverKey(currentConfig.vapidPublicKey);
      const matches = existingKey && new Uint8Array(existingKey).every((byte, index) => byte === expectedKey[index])
        && existingKey.byteLength === expectedKey.length;
      if (matches) {
        try {
          const record = await api<SubscriptionSummary>(`/api/subscriptions/${saved.id}`, { credential: saved });
          setCredential(saved); setSummary(record); setConnection('connected'); return;
        } catch { /* Keep browser state visible and let an explicit reconnect replace it. */ }
      }
    }
    setCredential(null); setSummary(null);
    setConnection(subscription ? 'reconnect' : 'disconnected');
  }, []);

  useEffect(() => {
    refresh().catch(() => { setConnection('disconnected'); setError('The notification service is unavailable. Check that the local API is running, then retry.'); });
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'PUSH_RECEIVED') {
        if (typeof event.data.notificationId === 'string') {
          receivedIds.current.add(event.data.notificationId);
          if (receivedIds.current.size > 32) receivedIds.current.delete(receivedIds.current.values().next().value!);
        }
        log('Notification received', 'This browser displayed an incoming push notification.');
        setNotice('Notification received by this browser.');
      }
    };
    const onFocus = () => {
      if ('Notification' in window) {
        setPermission(Notification.permission);
        if (Notification.permission === 'denied') setConnection('blocked');
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    return () => { navigator.serviceWorker?.removeEventListener('message', onMessage); window.removeEventListener('focus', onFocus); };
  }, [refresh, log]);

  async function connect() {
    if (!config || busy) return;
    setBusy(true); setError(''); setNotice('');
    let fresh: PushSubscription | null = null;
    try {
      // Request permission directly from the user gesture, before other awaits.
      const result = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setConnection(result === 'denied' ? 'blocked' : 'disconnected');
        setNotice(result === 'denied' ? 'Notifications are blocked. Allow them in this website’s browser settings to reconnect.' : 'No changes made. You can enable notifications whenever you are ready.');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const previous = await registration.pushManager.getSubscription();
      if (previous) {
        const oldOwnership = readCredential();
        if (oldOwnership) {
          try { await api(`/api/subscriptions/${oldOwnership.id}`, { credential: oldOwnership, method: 'DELETE' }); }
          catch (cause) { if (!(cause instanceof ApiError) || ![403, 404].includes(cause.status)) throw cause; }
        }
        await previous.unsubscribe();
      }
      fresh = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey(config.vapidPublicKey) });
      const saved = await api<SubscriptionSummary & { token: string }>('/api/subscriptions', { body: { subscription: fresh.toJSON() } });
      const ownership = { id: saved.id, token: saved.token };
      try { localStorage.setItem(storageKey, JSON.stringify(ownership)); }
      catch {
        await api(`/api/subscriptions/${saved.id}`, { credential: ownership, method: 'DELETE' });
        throw new Error('Browser storage is unavailable. Allow website storage, then connect again.');
      }
      setCredential(ownership); setSummary(saved); setConnection('connected'); setWorkerReady(true);
      setNotice('This browser is connected. Try sending your first notification below.');
      log('Browser connected', 'Notification permission granted and subscription saved.');
    } catch (cause) {
      if (fresh) await fresh.unsubscribe().catch(() => {});
      setConnection('disconnected');
      setError(cause instanceof Error ? cause.message : 'The browser could not connect. Try again.');
    } finally { setBusy(false); }
  }

  async function disconnect() {
    if (!credential || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      try { await api(`/api/subscriptions/${credential.id}`, { credential, method: 'DELETE' }); }
      catch (cause) { if (!(cause instanceof ApiError) || cause.status !== 404) throw cause; }
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      if (current) await current.unsubscribe();
      localStorage.removeItem(storageKey);
      setCredential(null); setSummary(null); setConnection('disconnected');
      setNotice('Disconnected. This service will no longer send to this browser.');
      log('Browser disconnected', 'The subscription was removed from this service.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not disconnect. Try again.'); }
    finally { setBusy(false); }
  }

  async function sendTest(content: NotificationContent) {
    if (!credential || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ notificationId: string; status: 'queued' | 'accepted' }>(`/api/subscriptions/${credential.id}/test`, { credential, body: content });
      setNotice(receivedIds.current.has(result.notificationId) ? 'Notification received by this browser.'
        : result.status === 'queued' ? 'Your test is queued for delivery. Watch for a notification on this device.'
          : 'The push service accepted your test. Watch for a notification on this device.');
      log(result.status === 'queued' ? 'Test queued' : 'Test accepted by push service', result.status === 'queued'
        ? 'The notification is queued for delivery to this browser.' : 'The encrypted test message was accepted by the browser’s push service.');
    } catch (cause) {
      if (cause instanceof ApiError && [404, 410].includes(cause.status)) {
        localStorage.removeItem(storageKey); setCredential(null); setSummary(null); setConnection('reconnect');
      }
      setError(cause instanceof Error ? cause.message : 'The test could not be sent.');
    }
    finally { setBusy(false); }
  }

  async function check() {
    setBusy(true);
    try { await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check the connection.'); }
    finally { setBusy(false); }
  }

  return { config, connection, permission, workerReady, summary, canDisconnect: !!credential, busy, error, notice, activity, connect, disconnect, sendTest, check };
}
