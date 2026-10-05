// Service worker de Juntos: abre al instante y permite ver lo último cargado sin conexión.
// Siempre intenta la red primero, así cada despliegue llega en la siguiente apertura.
const SHELL = 'juntos-shell-v5';
const DATA = 'juntos-data';
const FILES = ['/', '/app.js', '/finance.js', '/cloud.js', '/native.js', '/effects.js', '/tasks.js', '/push.js', '/outbox.js', '/styles.css', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];
// Datos del hogar que se pueden mostrar sin conexión (nunca la sesión ni la sincronización).
const CACHEABLE_API = /^\/api\/(me|months\/[0-9-]+|pending|tasks)$/;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== SHELL && key !== DATA).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

async function networkFirst(request, cacheName, offlineHeader) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(cacheName)).put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match(request, {cacheName});
    if (!cached) {
      if (request.mode === 'navigate') return caches.match('/', {cacheName: SHELL});
      throw error;
    }
    if (!offlineHeader) return cached;
    // Marca la respuesta para que la app avise que está mostrando datos guardados.
    const headers = new Headers(cached.headers);
    headers.set('x-juntos-offline', '1');
    return new Response(cached.body, {status: cached.status, headers});
  }
}

self.addEventListener('fetch', event => {
  const {request} = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (CACHEABLE_API.test(url.pathname)) event.respondWith(networkFirst(request, DATA, true));
    return;
  }
  event.respondWith(networkFirst(request, SHELL, false));
});

// Notificación push: llega aunque la app esté cerrada. El servidor manda {title, body, url, tag}.
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {body: event.data?.text()};
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Juntos', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag,
    data: {url: data.url || '/'},
  }));
});

// Tocar la notificación abre Juntos (o la trae al frente si ya estaba abierta); al volver se sincroniza sola.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', location.origin).href;
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(windows => {
    const open = windows.find(client => new URL(client.url).origin === location.origin);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
