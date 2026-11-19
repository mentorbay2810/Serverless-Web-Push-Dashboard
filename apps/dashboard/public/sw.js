/* Push-only service worker. HTML and API responses are never cached. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function observation(data) {
  try {
    const reporting = data.reporting;
    if (!/^[a-f0-9]{64}$/.test(data.notificationId) || !reporting || !/^[A-Za-z0-9_-]{43}$/.test(reporting.token)) return;
    const url = new URL(reporting.url);
    const configured = new URL(self.location.href || self.location.origin).searchParams.get('apiOrigin') || self.location.origin;
    if (![self.location.origin, configured].includes(url.origin) || url.username || url.password || url.search || url.hash
      || url.pathname !== `/api/deliveries/${data.notificationId}/events`) return;
    return { url: url.href, token: reporting.token };
  } catch { /* Reporting configuration cannot prevent a visible notification. */ }
}
async function report(reporting, type) {
  if (!reporting) return;
  try {
    await fetch(reporting.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporting.token}` },
      body: JSON.stringify({ type }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) });
  } catch { /* Observations are best effort and must not block display or navigation. */ }
}

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Always display a notification, including malformed payloads. */ }
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.slice(0, 80) : 'Web Push update';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 240) : 'You have a new notification.';
  let url = '/';
  try {
    const candidate = new URL(payload.url || '/', self.location.origin);
    if (candidate.origin === self.location.origin) url = candidate.href;
  } catch { /* Keep notification clicks on this website. */ }
  event.waitUntil((async () => {
    const reporting = observation(payload);
    await self.registration.showNotification(title, {
      body,
      tag: typeof payload.notificationId === 'string' ? payload.notificationId : undefined,
      data: { url, notificationId: payload.notificationId, reporting },
    });
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'PUSH_RECEIVED', notificationId: payload.notificationId });
    await report(reporting, 'received');
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const reporting = report(observation(event.notification.data || {}), 'clicked');
    let target = new URL('/', self.location.origin);
    try {
      const candidate = new URL(event.notification.data?.url || '/', self.location.origin);
      if (candidate.origin === self.location.origin) target = candidate;
    } catch { /* Use the safe default. */ }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === target.origin);
    if (existing) { await existing.navigate(target.href); await existing.focus(); }
    else await self.clients.openWindow(target.href);
    await reporting;
  })());
});
