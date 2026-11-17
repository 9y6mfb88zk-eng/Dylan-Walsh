// Operation Sentinel (Mission Control workspace): watchlists over the Global Events feed, public webcams and
// source status. The events themselves stay in the shared Global Events feed and map layer.
// Webcams are separate from event verification: a camera image is never shown as evidence about an event.
const TABS = [["watch", "Watchlists"], ["cams", "Public webcams"], ["sources", "Sources"]];
const STATUS_WORD = { live: "Live (verified)", offline: "Offline", not_verified: "Live status not verified", unknown: "Status unknown", active: "Active (Windy)", error: "Check failed" };

export async function mount(el, A) {
  const { api, esc, tz } = A;
  const S = { tab: "watch", lists: [], cams: null, camSel: null, camQ: "", events: null };
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const evMeta = await api("/api/events?limit=1").catch(() => ({ categories: {}, statusLabels: {}, providers: {} }));
  const meta = await api("/api/ops/meta").catch(() => ({ watchLevels: {} }));

  async function loadLists() { S.lists = await api("/api/ops/records?op=sentinel&kind=watchlist").catch(() => []); }
  function render() {
    el.innerHTML = `<h3>Operation Sentinel</h3><p class="goc-muted goc-small">Public-information monitoring. Events appear in the Global Events feed and on the map; watchlists alert you when new reports match.</p>
      <div class="goc-chips">${TABS.map(([k, n]) => `<button class="goc-chip ${S.tab === k ? "on" : ""}" data-tab="${k}">${n}</button>`).join("")}</div><div class="goc-op-body" id="snBody"></div>`;
    el.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; render(); });
    ({ watch: renderWatch, cams: renderCams, sources: renderSources })[S.tab](el.querySelector("#snBody"));
    A.setContext({ operation: "sentinel", tab: S.tab, watchlists: S.lists.map((w) => ({ id: w.id, title: w.title })) });
  }
  function renderWatch(body) {
    body.innerHTML = `<form id="snNew" class="bb-new"><input class="goc-in" id="snName" placeholder="Watchlist name — e.g. Eastern Mediterranean" required>
      <input class="goc-in" id="snCountries" placeholder="Countries (comma separated) — e.g. Cyprus, Lebanon">
      <input class="goc-in" id="snRegions" placeholder="Regions — e.g. Western Asia, Southern Europe">
      <input class="goc-in" id="snPlace" placeholder="Or a city/place to watch around (optional)"><div class="goc-filters"><input class="goc-in" id="snRadius" type="number" min="5" max="1000" value="150" aria-label="Radius km"><span class="goc-muted goc-small">km radius</span></div>
      <div class="goc-chips">${Object.entries(evMeta.categories).map(([k, n]) => `<label class="goc-chip"><input type="checkbox" data-cat="${k}"> ${esc(n)}</label>`).join("")}</div>
      <div class="goc-filters"><select class="goc-sel" id="snLevel">${Object.entries(meta.watchLevels).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join("")}</select><select class="goc-sel" id="snSev"><option value="1">Any severity</option><option value="2">Moderate and above</option><option value="3">Highest only</option></select></div>
      <div class="goc-filters"><label class="goc-small">Quiet from <input class="goc-in" type="time" id="snQ1"></label><label class="goc-small">to <input class="goc-in" type="time" id="snQ2"></label></div>
      <button class="goc-btn">Create watchlist</button></form>
      <ol class="goc-evlist">${S.lists.map((w) => { const d = w.data; return `<li class="goc-ev"><div class="goc-ev-head"><span class="goc-ev-cat" style="--c:${d.enabled ? "#5fb88a" : "#6b7785"}"></span><span class="goc-ev-title">${esc(w.title)}</span></div>
        <div class="goc-ev-meta"><span>${esc([...(d.countries || []), ...(d.regions || []), ...(d.places || []).map((p) => `${p.name} +${p.radiusKm} km`)].join(", ") || "Worldwide")}</span><span>${esc((d.categories || []).map((c) => evMeta.categories[c] || c).join(", ") || "all categories")}</span><span>${esc(meta.watchLevels[d.minLevel] || "")}</span>${d.quiet?.start ? `<span>quiet ${esc(d.quiet.start)}–${esc(d.quiet.end)}</span>` : ""}</div>
        <div class="goc-ev-status">${d.lastCheckAt ? `Checked ${esc(fmt(d.lastCheckAt))} · ${(d.lastMatches || []).length} matching reports held` : "Not checked yet — the first check records current reports without alerting about all of them"}</div>
        <ul class="goc-srcs">${(d.lastMatches || []).slice(0, 5).map((m) => `<li>${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.title)}</a>` : esc(m.title)} <span class="goc-muted">${esc(m.place || "")} · ${esc(evMeta.statusLabels[m.status] || m.status)} · ${esc(fmt(m.publishedAt))}</span></li>`).join("")}</ul>
        <div class="goc-card-actions"><button class="goc-btn" data-toggle="${w.id}">${d.enabled ? "Pause alerts" : "Enable alerts"}</button><button class="goc-btn" data-del="${w.id}">Delete</button></div></li>`; }).join("") || '<li class="goc-muted">No watchlists yet.</li>'}</ol>
      ${S.lists.length ? `<button class="goc-btn" id="snCheck">Check now</button>` : ""}`;
    body.querySelector("#snNew").onsubmit = async (e) => {
      e.preventDefault();
      const places = [];
      const pq = body.querySelector("#snPlace").value.trim();
      if (pq) { const x = await api(`/api/wayfinder/destination?q=${encodeURIComponent(pq)}`).catch(() => null); if (!x?.ok) return A.toast(`Couldn't find ${pq}.`); places.push({ name: x.place.name, lat: x.place.lat, lon: x.place.lon, radiusKm: +body.querySelector("#snRadius").value || 150 }); }
      const data = { countries: body.querySelector("#snCountries").value, regions: body.querySelector("#snRegions").value, places, categories: [...body.querySelectorAll("[data-cat]:checked")].map((c) => c.dataset.cat), minLevel: body.querySelector("#snLevel").value, minSeverity: +body.querySelector("#snSev").value, quiet: { start: body.querySelector("#snQ1").value, end: body.querySelector("#snQ2").value }, enabled: true };
      await api("/api/ops/records", { method: "POST", body: { op: "sentinel", kind: "watchlist", title: body.querySelector("#snName").value, data } });
      await api("/api/sentinel/check", { method: "POST" }).catch(() => {});
      await loadLists(); render();
    };
    body.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = async () => { const w = S.lists.find((x) => x.id === +b.dataset.toggle); await api(`/api/ops/records/${w.id}`, { method: "PATCH", body: { data: { enabled: !w.data.enabled } } }); await loadLists(); render(); });
    body.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => { if (!confirm("Delete this watchlist?")) return; await api(`/api/ops/records/${b.dataset.del}`, { method: "DELETE" }); await loadLists(); render(); });
    const ck = body.querySelector("#snCheck"); if (ck) ck.onclick = async () => { ck.disabled = true; ck.textContent = "Checking…"; const r = await api("/api/sentinel/check", { method: "POST" }).catch((e) => (A.toast(e.message), [])); A.toast(r.map?.((x) => `${x.title}: ${x.matches} matching, ${x.new} new`).join(" · ") || "Checked."); await loadLists(); render(); };
    const pts = S.lists.flatMap((w) => (w.data.places || []).map((p) => ({ lat: p.lat, lon: p.lon, color: "#b9a66b", hollow: true, r: 7, label: w.title, sub: `${p.name} · ${p.radiusKm} km watch radius` })));
    A.setLayer("webcams", { points: pts, lines: [] });
  }
  async function loadCams(params = "") { S.cams = await api(`/api/sentinel/webcams${params}`).catch((e) => ({ cams: [], error: e.message })); drawCams(); }
  function drawCams() {
    A.setLayer("webcams", { points: (S.cams?.cams || []).filter((c) => c.lat != null).map((c) => ({ lat: c.lat, lon: c.lon, color: c.liveStatus === "live" || c.provider === "windy" ? "#8fc1cf" : "#6b7785", shape: "square", r: 4, label: c.name, labelZoom: 6, sub: `${c.city}, ${c.country} · ${c.kind}`, selected: S.camSel === c.id, onClick: () => { S.camSel = c.id; S.tab = "cams"; render(); } })), lines: [] });
  }
  function renderCams(body) {
    const C = S.cams;
    if (!C) { body.innerHTML = '<p class="goc-muted">Loading the webcam registry…</p>'; loadCams().then(render); return; }
    const sel = C.cams.find((c) => c.id === S.camSel);
    const list = C.cams.filter((c) => !S.camQ || `${c.name} ${c.city} ${c.country} ${c.category}`.toLowerCase().includes(S.camQ.toLowerCase()));
    body.innerHTML = `<div class="goc-filters"><input class="goc-in" id="snCamQ" placeholder="Search city, country or category" value="${esc(S.camQ)}"><button class="goc-btn" id="snCamArea">Search this map area${C.windy?.available ? "" : " (needs Windy key)"}</button></div>
      ${sel ? camCard(sel) : ""}
      <ol class="goc-flist">${list.map((c) => `<li><button data-cam="${esc(c.id)}" class="${c.id === S.camSel ? "sel" : ""}"><b>${esc(c.name)}</b><span>${esc(c.city)}</span><span>${esc(c.country)}</span><span>${esc(STATUS_WORD[c.liveStatus] || c.liveStatus)}</span></button></li>`).join("") || "<li class='goc-muted'>No cameras match.</li>"}</ol>
      <p class="goc-muted goc-small">${esc(C.note || "")} ${C.windy?.reason ? esc(C.windy.reason) : ""} ${C.youtubeKey ? "" : "Add a free YouTube Data API key in Settings → Global Operations to verify which streams are live; until then streams aren't embedded."} Cameras in countries with active armed conflict (${esc((C.excludedCountries || []).join(", "))}) aren't offered.</p>
      ${C.youtubeKey ? `<button class="goc-btn" id="snVerify">Re-check stream status</button>` : ""}`;
    body.querySelector("#snCamQ").oninput = (e) => { S.camQ = e.target.value; const pos = e.target.selectionStart; render(); const n = el.querySelector("#snCamQ"); n.focus(); n.setSelectionRange(pos, pos); };
    body.querySelector("#snCamArea").onclick = async () => { const c = A.map.getCenter(), b = A.map.getBounds(); const r = Math.min(250, Math.round(A.map.distance(c, b.getNorthEast()) / 1000)); await loadCams(`?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&radiusKm=${r}`); render(); };
    body.querySelectorAll("[data-cam]").forEach((b) => b.onclick = () => { S.camSel = b.dataset.cam; const c = C.cams.find((x) => x.id === S.camSel); if (c?.lat != null) A.fly(c.lat, c.lon, 10); drawCams(); render(); });
    const v = body.querySelector("#snVerify"); if (v) v.onclick = async () => { v.disabled = true; await api("/api/sentinel/webcams/verify", { method: "POST", body: { force: true } }).catch((e) => A.toast(e.message)); await loadCams(); render(); };
    const x = body.querySelector("#snCamX"); if (x) x.onclick = () => { S.camSel = null; drawCams(); render(); };
  }
  function camCard(c) {
    const player = c.embedUrl ? `<div class="sn-player"><iframe src="${esc(c.embedUrl)}" title="${esc(c.name)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" loading="lazy"></iframe></div>`
      : c.preview ? `<img class="sn-preview" src="${esc(c.preview)}" alt="Latest still image from ${esc(c.name)}" referrerpolicy="no-referrer">` : `<p class="goc-muted goc-small">No verified stream to embed. <a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">Open the operator's page ↗</a></p>`;
    return `<div class="goc-box sn-cam"><div class="goc-card-head"><b>${esc(c.name)}</b><button class="goc-x" id="snCamX" aria-label="Close">×</button></div>${player}
      <dl class="goc-kv tight"><div><dt>Where</dt><dd>${esc(c.city)}, ${esc(c.country)}${c.lat != null ? ` · ${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}` : ""}</dd></div><div><dt>Type</dt><dd>${esc(c.kind)}</dd></div>
      <div><dt>Status</dt><dd>${esc(STATUS_WORD[c.liveStatus] || c.liveStatus)}${c.lastVerifiedAt ? ` · checked ${esc(fmt(c.lastVerifiedAt))}` : ""}${c.verifyError ? ` · ${esc(c.verifyError)}` : ""}</dd></div>
      <div><dt>Operator</dt><dd>${esc(c.operator)}</dd></div><div><dt>Permission</dt><dd>${esc(c.permission)}</dd></div><div><dt>Attribution</dt><dd>${esc(c.attribution)}</dd></div></dl>
      <p class="goc-small"><a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">Original source ↗</a>${c.previewExpiresAt ? ` · preview link valid until ${esc(fmt(c.previewExpiresAt))}` : ""}</p></div>`;
  }
  async function renderSources(body) {
    body.innerHTML = '<p class="goc-muted">Reading source status…</p>';
    const ev = await api("/api/events?limit=1").catch(() => null);
    body.innerHTML = `<table class="wf-tbl"><thead><tr><th>Source</th><th>State</th><th>Last success</th><th>Items</th></tr></thead><tbody>${Object.values(ev?.providers || {}).map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a></td><td>${esc(p.state.replace(/_/g, " "))}${p.lastError ? `<div class="goc-muted goc-small">${esc(p.lastError)}</div>` : ""}</td><td>${esc(fmt(p.lastOkAt))}</td><td>${p.count}</td></tr>`).join("")}</tbody></table>
      <h4>Verification labels</h4><ul class="goc-srcs">${Object.entries(ev?.statusLabels || {}).map(([k, v]) => `<li><b>${esc(k)}</b> — ${esc(v)}</li>`).join("")}</ul>
      <p class="goc-muted goc-small">Reports older than 48 hours are marked as older, never as live. ReliefWeb and UCDP need free credentials (Settings → Global Operations).</p>`;
  }
  async function command(c) {
    if (c.action === "webcams") { S.tab = "cams"; if (c.q) S.camQ = c.q; await loadCams(); render(); return { ok: true, count: S.cams.cams.length, verified: S.cams.cams.filter((x) => x.liveStatus === "live").length, windy: S.cams.windy?.available }; }
    if (c.action === "watchlists") { S.tab = "watch"; render(); return { ok: true, count: S.lists.length }; }
    S.tab = "watch"; render(); return { ok: true };
  }
  await loadLists(); render();
  return { command, refresh: async () => { await loadLists(); if (S.tab === "watch") render(); }, unmount() { A.clearLayer("webcams"); } };
}
