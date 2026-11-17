/* Push-only service worker. HTML and API responses are never cached. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

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
    await self.registration.showNotification(title, {
      body,
      tag: typeof payload.notificationId === 'string' ? payload.notificationId : undefined,
      data: { url },
    });
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'PUSH_RECEIVED', notificationId: payload.notificationId });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL('/', self.location.origin);
    try {
      const candidate = new URL(event.notification.data?.url || '/', self.location.origin);
      if (candidate.origin === self.location.origin) target = candidate;
    } catch { /* Use the safe default. */ }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === target.origin);
    if (existing) { await existing.navigate(target.href); await existing.focus(); }
    else await self.clients.openWindow(target.href);
  })());
});
