// Service worker de Juntos: abre al instante y permite ver lo último cargado sin conexión.
// Siempre intenta la red primero, así cada despliegue llega en la siguiente apertura.
const SHELL = 'juntos-shell-v2';
const DATA = 'juntos-data';
const FILES = ['/', '/app.js', '/finance.js', '/cloud.js', '/native.js', '/effects.js', '/styles.css', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];
// Datos del hogar que se pueden mostrar sin conexión (nunca la sesión ni la sincronización).
const CACHEABLE_API = /^\/api\/(me|months\/[0-9-]+|pending)$/;

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
