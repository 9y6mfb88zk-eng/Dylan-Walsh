// JARVIS service worker: offline shell + web push.
const CACHE = "jarvis-v3";
const SHELL = ["/", "/index.html", "/styles.css", "/js/app.js", "/js/api.js", "/js/sync.js", "/js/voice.js", "/js/core.js", "/js/util.js", "/js/views/home.js", "/js/views/talk.js", "/js/views/agenda.js", "/js/views/money.js", "/js/views/projects.js", "/js/views/intel.js", "/js/views/memory.js", "/js/views/settings.js", "/js/views/more.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/oauth/") || url.pathname === "/ws") return;
  // Network first, falling back to the cached shell when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html")))
  );
});

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || "JARVIS";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    tag: data.tag,
    renotify: !!data.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/" },
    requireInteraction: data.kind === "reminder",
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", location.origin).href;
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === location.origin) { await c.focus(); c.postMessage({ type: "navigate", url: target }); return; }
    }
    await clients.openWindow(target);
  })());
});
