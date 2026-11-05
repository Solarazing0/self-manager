const SHELL = 'self-shell-v2';
const files = ['/', '/app.js', '/styles.css', '/app.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(files)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('self-shell-') && key !== SHELL)
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Self-Manager', {
    body: 'Legion ждёт тебя. Открой приложение, чтобы посмотреть напоминание.',
    icon: '/icon-192.png',
    tag: 'self-reminders',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const current = windows.find((client) => new URL(client.url).pathname === '/');
    if (current) return current.focus();
    return self.clients.openWindow('/');
  }));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !files.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname)));
});
