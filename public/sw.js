// JARVIS service worker: offline shell + web push.
const CACHE = "jarvis-v6.8";
const SHELL = ["/", "/index.html", "/styles.css", "/js/app.js", "/js/api.js", "/js/sync.js", "/js/voice.js", "/js/core.js", "/js/core3d.js", "/js/corestate.js", "/js/conversation.js", "/js/voicecommands.js", "/js/icons.js", "/js/util.js", "/js/views/home.js", "/js/views/talk.js", "/js/views/briefings.js", "/js/views/notifications.js", "/js/views/alarms.js", "/js/views/calendar.js", "/js/views/tasks.js", "/js/views/focus.js", "/js/views/goals.js", "/js/views/projects.js", "/js/views/business.js", "/js/views/money.js", "/js/views/intelligence.js", "/js/views/documents.js", "/js/views/memory.js", "/js/views/world.js", "/js/views/automations.js", "/js/views/computer.js", "/js/views/smarthome.js", "/js/views/diagnostics.js", "/js/views/settings.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png", "/vendor/fonts/rajdhani-latin-600-normal.woff2", "/vendor/fonts/inter-latin-400-normal.woff2", "/sounds/chime.wav", "/js/commands.js", "/js/iphone.js", "/js/mc-panels.js", "/js/mission.js", "/js/resample.js", "/js/resample-worker.js", "/js/startup.js", "/js/sounds.js", "/js/phrases.js", "/js/speech-text.js", "/js/corehost.js", "/js/goc.js", "/vendor/leaflet/leaflet-src.esm.js", "/vendor/leaflet/leaflet.css", "/vendor/countries-110m.geojson", "/js/ops/blackbox.js", "/js/ops/wayfinder.js", "/js/ops/sentinel.js", "/js/ops/orbit.js", "/js/ops/report.js", "/vendor/satellite.es.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/tiles/") || url.pathname.startsWith("/oauth/") || url.pathname === "/ws") return;
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
    requireInteraction: data.kind === "reminder" || data.kind === "alarm",
    vibrate: data.kind === "alarm" ? [500, 200, 500, 200, 900] : undefined,
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
