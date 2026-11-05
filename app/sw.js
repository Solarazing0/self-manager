const SHELL = 'self-shell-v1';
const files = ['/', '/app.js', '/styles.css', '/app.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(files)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('self-shell-') && key !== SHELL)
    .map((key) => caches.delete(key)))));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !files.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname)));
});
