// Offline support for the online copy: keeps the viewer page and its icons in the
// browser's cache so the installed app opens without a connection.
// It never sees your data: exports are read by the page itself, not fetched.
const CACHE = "hcv-2.0.0-0688fb712e51";
const FILES = ["health-connect-viewer.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon.svg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("hcv-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// cache first for the app's own files; when online, refresh the cached copy in the background
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
