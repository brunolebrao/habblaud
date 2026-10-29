// Service worker dos avisos no celular (Web Push; servidor em server/push). Só mostra o aviso que o escritório mandou e,
// no toque, abre (ou traz para a frente) o escritório no agente ou no Estúdio. Não guarda nada em cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Habblaud';
  const params = new URLSearchParams();
  if (typeof data.agentId === 'string') params.set('agent', data.agentId);
  if (data.studio) params.set('studio', '1');
  const url = params.toString() ? `/?${params}` : '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/assets/brand/apple-touch-icon.png',
      badge: '/assets/brand/favicon-32.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        open.postMessage({ type: 'habblaud-open', url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
