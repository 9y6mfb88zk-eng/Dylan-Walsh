// Operation Orbit (Mission Control workspace): satellites, the ISS, space weather and launches.
// Positions are CALCULATED here with SGP4 (satellite.js) from CelesTrak's published orbital elements. They are not
// sensor observations, and every view shows the element epoch and its age.
import * as sat from "/vendor/satellite.es.js";

const TABS = [["track", "Satellites"], ["weather", "Space weather"], ["launches", "Launches"]];
const COL = { iss: "#e8eef5", sel: "#c4b5fd", sat: "#7aa2d6", stale: "#6b7785" };
const ageH = (iso) => (Date.now() - Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`)) / 3600_000;

export async function mount(el, A) {
  const { api, esc, tz } = A;
  const S = { tab: "track", group: "stations", elements: [], recs: new Map(), selected: 25544, groupInfo: null, timer: 0, sw: null, launches: null, err: null, track: [] };
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const meta = await api("/api/ops/meta").catch(() => ({ satelliteGroups: {} }));

  function recFor(o) { let r = S.recs.get(o.NORAD_CAT_ID); if (!r) { try { r = sat.json2satrec(o); } catch { r = null; } S.recs.set(o.NORAD_CAT_ID, r); } return r; }
  function posAt(o, t) {
    const r = recFor(o); if (!r) return null;
    const pv = sat.propagate(r, t); if (!pv || !pv.position || typeof pv.position !== "object") return null;
    const g = sat.eciToGeodetic(pv.position, sat.gstime(t)), v = pv.velocity;
    return { lat: sat.degreesLat(g.latitude), lon: sat.degreesLong(g.longitude), altKm: g.height, kms: Math.hypot(v.x, v.y, v.z) };
  }
  const facts = (o) => {
    const n = o.MEAN_MOTION, e = o.ECCENTRICITY, a = Math.cbrt(398600.4418 / ((n * 2 * Math.PI) / 86400) ** 2);
    return { periodMin: 1440 / n, apogee: a * (1 + e) - 6378.137, perigee: a * (1 - e) - 6378.137, inc: o.INCLINATION, epochAge: ageH(o.EPOCH) };
  };
  async function loadGroup(g) {
    S.group = g; S.err = null;
    try { const r = await api(`/api/orbit/group/${g}`); S.elements = r.elements; S.groupInfo = r; S.recs.clear(); }
    catch (e) { S.err = e.message; S.elements = []; }
    if (!S.elements.some((o) => o.NORAD_CAT_ID === S.selected)) S.selected = S.elements[0]?.NORAD_CAT_ID ?? null;
    computeTrack(); tick(); render();
  }
  function computeTrack() {
    const o = S.elements.find((x) => x.NORAD_CAT_ID === S.selected); S.track = [];
    if (!o) return;
    const period = 1440 / o.MEAN_MOTION, now = Date.now();
    for (let m = -period * 0.25; m <= period * 1.0; m += Math.max(0.5, period / 180)) { const p = posAt(o, new Date(now + m * 60_000)); if (p) S.track.push({ ...p, future: m > 0 }); }
  }
  function tick() {
    const now = new Date(), pts = [];
    const max = S.elements.length > 1500 ? 1500 : S.elements.length;    // keep the canvas light for very large groups
    for (let i = 0; i < max; i++) {
      const o = S.elements[i], p = posAt(o, now); if (!p) continue;
      const selected = o.NORAD_CAT_ID === S.selected, stale = ageH(o.EPOCH) > 72;
      pts.push({ lat: p.lat, lon: p.lon, altKm: p.altKm, r: selected ? 5 : o.NORAD_CAT_ID === 25544 ? 4.5 : 2.6, color: selected ? COL.sel : o.NORAD_CAT_ID === 25544 ? COL.iss : stale ? COL.stale : COL.sat, shape: "diamond", selected,
        label: selected || o.NORAD_CAT_ID === 25544 ? o.OBJECT_NAME : null, labelZoom: 0, sub: `${Math.round(p.altKm)} km · calculated position`, onClick: () => select(o.NORAD_CAT_ID) });
    }
    const past = S.track.filter((t) => !t.future).map((t) => [t.lat, t.lon]), fut = S.track.filter((t) => t.future).map((t) => [t.lat, t.lon]);
    A.setLayer("satellites", { points: pts, lines: [{ coords: past, color: "rgba(196,181,253,.55)", width: 1.4 }, { coords: fut, color: "rgba(196,181,253,.8)", width: 1.4, dash: [5, 4] }] });
    const g = A.globe();
    if (g) {
      g.setPoints(pts.map((p) => ({ lat: p.lat, lon: p.lon, altKm: p.altKm, color: p.color })));
      g.setPaths(S.track.length ? [{ points: S.track.map((t) => ({ lat: t.lat, lon: t.lon, altKm: t.altKm })), color: 0xa394e8 }] : []);
    }
    renderLive();
  }
  A.on3d = () => tick();
  function select(id) { S.selected = id; computeTrack(); tick(); render(); const o = S.elements.find((x) => x.NORAD_CAT_ID === id); const p = o && posAt(o, new Date()); if (p) A.fly(p.lat, p.lon, 3); A.setContext({ operation: "orbit", selectedSatellite: o ? { name: o.OBJECT_NAME, norad: o.NORAD_CAT_ID } : null }); }
  function renderLive() {
    const box = el.querySelector("#orbLive"); if (!box) return;
    const o = S.elements.find((x) => x.NORAD_CAT_ID === S.selected); if (!o) { box.innerHTML = ""; return; }
    const p = posAt(o, new Date()), f = facts(o);
    box.innerHTML = `<dl class="goc-kv">
      <div><dt>Object</dt><dd>${esc(o.OBJECT_NAME)}</dd></div><div><dt>NORAD / COSPAR</dt><dd>${o.NORAD_CAT_ID} · ${esc(o.OBJECT_ID)}</dd></div>
      <div><dt>Position</dt><dd>${p ? `${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°` : "propagation failed"} <span class="goc-tag">calculated</span></dd></div>
      <div><dt>Altitude / speed</dt><dd>${p ? `${Math.round(p.altKm)} km · ${p.kms.toFixed(2)} km/s` : "—"}</dd></div>
      <div><dt>Orbit</dt><dd>${f.periodMin.toFixed(1)} min · ${Math.round(f.perigee)}–${Math.round(f.apogee)} km · ${f.inc.toFixed(2)}°</dd></div>
      <div><dt>Elements epoch</dt><dd>${esc(fmt(o.EPOCH.endsWith("Z") ? o.EPOCH : `${o.EPOCH}Z`))} <span class="goc-tag ${f.epochAge > 72 ? "stale" : "recent"}">${f.epochAge.toFixed(1)} h old</span></dd></div>
    </dl><p class="goc-muted goc-small">Position calculated with SGP4 from CelesTrak's published elements — not a live observation. Accuracy falls as the elements age. Track: solid = past 25 %, dashed = next orbit (predicted).</p>`;
  }
  function render() {
    el.innerHTML = `<h3>Operation Orbit</h3>
      <div class="goc-chips">${TABS.map(([k, n]) => `<button class="goc-chip ${S.tab === k ? "on" : ""}" data-tab="${k}">${n}</button>`).join("")}</div><div id="orbBody" class="goc-op-body"></div>`;
    el.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; render(); });
    const body = el.querySelector("#orbBody");
    if (S.tab === "track") {
      const list = S.elements.slice(0, 300);
      body.innerHTML = `<div class="goc-filters"><select class="goc-sel" id="orbGroup" aria-label="Satellite group">${Object.entries(meta.satelliteGroups || {}).map(([k, n]) => `<option value="${k}" ${k === S.group ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
        <form id="orbSearch" class="goc-search"><input class="goc-in" id="orbQ" placeholder="Name or NORAD number" aria-label="Search satellites"><button class="goc-btn">Find</button></form></div>
        <div class="goc-toggles"><button class="goc-btn" id="orbIss">Track the ISS</button><button class="goc-btn" id="orb3d">3D orbit view</button></div>
        <div id="orbLive"></div>
        <p class="goc-muted goc-small">${S.err ? `<span class="goc-warnline">CelesTrak unavailable: ${esc(S.err)}</span>` : S.groupInfo ? `${S.groupInfo.elements.length} objects in “${esc(S.groupInfo.name)}” · elements retrieved ${esc(fmt(S.groupInfo.fetchedAt))} (${S.groupInfo.cache === "stale" ? "older copy — CelesTrak didn't answer" : "cached ≥ 2 h per CelesTrak's rules"})${S.groupInfo.elements.length > 1500 ? " · map shows the first 1,500" : ""}` : "Loading…"}</p>
        <ol class="goc-flist">${list.map((o) => `<li><button data-id="${o.NORAD_CAT_ID}" class="${o.NORAD_CAT_ID === S.selected ? "sel" : ""}"><b>${esc(o.OBJECT_NAME)}</b><span>${o.NORAD_CAT_ID}</span><span>${(1440 / o.MEAN_MOTION).toFixed(0)} min</span><span>${o.INCLINATION.toFixed(0)}°</span></button></li>`).join("")}</ol>
        <p class="goc-muted goc-small">Source: <a href="https://celestrak.org/" target="_blank" rel="noopener">CelesTrak</a> GP data (OMM). Orbital propagation: satellite.js (SGP4).</p>`;
      body.querySelector("#orbGroup").onchange = (e) => loadGroup(e.target.value);
      body.querySelector("#orbSearch").onsubmit = async (e) => {
        e.preventDefault(); const q = body.querySelector("#orbQ").value.trim(); if (!q) return;
        try { const r = await api(`/api/orbit/search?q=${encodeURIComponent(q)}`); if (!r.elements.length) { A.toast(`No catalogued object matches “${q}”.`); return; } S.elements = r.elements; S.groupInfo = { ...r, name: `search: ${q}` }; S.recs.clear(); select(r.elements[0].NORAD_CAT_ID); }
        catch (err) { A.toast(err.message); }
      };
      body.querySelector("#orbIss").onclick = () => command({ action: "iss" });
      body.querySelector("#orb3d").onclick = () => A.show3d(!A.globe());
      body.querySelectorAll("[data-id]").forEach((b) => b.onclick = () => select(+b.dataset.id));
      renderLive();
    } else if (S.tab === "weather") renderWeather(body);
    else renderLaunches(body);
  }
  async function renderWeather(body) {
    body.innerHTML = `<p class="goc-muted">Retrieving space weather…</p>`;
    try { S.sw = await api("/api/orbit/spaceweather"); } catch (e) { body.innerHTML = `<p class="goc-warnline">Space weather unavailable: ${esc(e.message)}</p>`; return; }
    const w = S.sw, k = w.kp;
    body.innerHTML = `<dl class="goc-kv">
      <div><dt>Planetary K index</dt><dd>${k ? `<b>${k.latest}</b> · ${esc(k.storm)} · for ${esc(fmt(k.time))}` : "unavailable"}</dd></div>
      <div><dt>X-ray flux (GOES)</dt><dd>${w.flare ? `${esc(w.flare.currentClass)} now${w.flare.latestFlare ? ` · latest flare ${esc(w.flare.latestFlare.class)}, peak ${esc(fmt(w.flare.latestFlare.peak))}` : ""}` : "unavailable"}</dd></div>
      <div><dt>Retrieved</dt><dd>${esc(fmt(w.retrievedAt))}</dd></div></dl>
      ${k?.series?.length ? `<div class="goc-spark"><span>Kp (last ${k.series.length} × 3 h)</span><svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><polyline class="line" points="${k.series.map((x, i) => `${(i / (k.series.length - 1)) * 100},${40 - (x.kp / 9) * 38}`).join(" ")}"/></svg></div>` : ""}
      <h4>NOAA SWPC alerts</h4><ul class="goc-srcs">${(w.alerts || []).map((a) => `<li><span class="goc-muted">${esc(fmt(a.issued))}</span> ${esc(a.text)}</li>`).join("") || "<li class='goc-muted'>No current alerts.</li>"}</ul>
      <h4>NASA DONKI notifications (7 days)</h4><ul class="goc-srcs">${(w.donki || []).map((d) => `<li><b>${esc(d.type)}</b> <span class="goc-muted">${esc(fmt(d.issued))}</span> ${esc(d.summary)} ${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">source ↗</a>` : ""}</li>`).join("") || "<li class='goc-muted'>None retrieved.</li>"}</ul>
      ${w.donkiKey ? `<p class="goc-muted goc-small">NASA key: ${esc(w.donkiKey)}.</p>` : ""}
      ${w.errors?.length ? `<p class="goc-warnline">${w.errors.map(esc).join(" · ")}</p>` : ""}
      <p class="goc-muted goc-small">Sources: <a href="https://www.swpc.noaa.gov/" target="_blank" rel="noopener">NOAA SWPC</a> (public domain), <a href="https://ccmc.gsfc.nasa.gov/tools/DONKI/" target="_blank" rel="noopener">NASA DONKI</a>.</p>`;
  }
  async function renderLaunches(body) {
    body.innerHTML = `<p class="goc-muted">Retrieving launch schedule…</p>`;
    try { S.launches = await api("/api/orbit/launches?limit=12"); } catch (e) { body.innerHTML = `<p class="goc-warnline">Launch schedule unavailable: ${esc(e.message)}</p>`; return; }
    const L = S.launches;
    A.setLayer("satellites", { points: L.items.filter((l) => l.lat != null).map((l) => ({ lat: l.lat, lon: l.lon, color: "#d39b6a", shape: "square", r: 4, label: l.name, sub: `${l.site} · ${fmt(l.net)}`, onClick: () => A.fly(l.lat, l.lon, 8) })), lines: [] });
    body.innerHTML = `<ol class="goc-evlist">${L.items.map((l) => `<li class="goc-ev"><div class="goc-ev-head"><span class="goc-ev-cat" style="--c:${l.confirmed ? "#5fb88a" : "#b9a66b"}"></span><span class="goc-ev-title">${esc(l.name)}</span></div>
      <div class="goc-ev-meta"><span>${esc(l.provider || "")}</span><span>${esc(l.site || "")}</span><span>${esc(fmt(l.net))}${l.netPrecision && !/Second|Minute/.test(l.netPrecision) ? ` · ${esc(l.netPrecision)} precision (estimate)` : ""}</span></div>
      <div class="goc-ev-status">${l.confirmed ? "Go for launch (per Launch Library)" : `Status: ${esc(l.statusName || l.status || "unknown")} — not confirmed`}</div>
      ${l.mission ? `<p class="goc-muted goc-small">${esc(l.mission)}${l.orbit ? ` · ${esc(l.orbit)}` : ""}</p>` : ""}${l.infoUrls?.length ? `<a href="${esc(l.infoUrls[0])}" target="_blank" rel="noopener" class="goc-small">Official source ↗</a>` : ""}</li>`).join("")}</ol>
      <p class="goc-muted goc-small">Schedule retrieved ${esc(fmt(L.fetchedAt))}${L.cache === "stale" ? " (older copy)" : ""} from <a href="https://thespacedevs.com/llapi" target="_blank" rel="noopener">Launch Library 2</a>. Times are announced plans and change often.</p>`;
  }
  async function command(c) {
    if (c.action === "iss") {
      if (S.group !== "stations") await loadGroup("stations");
      if (S.tab !== "track") { S.tab = "track"; render(); }
      select(25544);
      const o = S.elements.find((x) => x.NORAD_CAT_ID === 25544), p = o && posAt(o, new Date());
      return p ? { ok: true, lat: p.lat, lon: p.lon, altKm: Math.round(p.altKm), epochAgeH: +facts(o).epochAge.toFixed(1) } : { ok: false, error: "ISS elements unavailable" };
    }
    if (c.action === "spaceweather") { S.tab = "weather"; render(); for (let i = 0; i < 50 && !S.sw; i++) await new Promise((r) => setTimeout(r, 100)); return { ok: !!S.sw, kp: S.sw?.kp?.latest, storm: S.sw?.kp?.storm, flare: S.sw?.flare?.currentClass }; }
    if (c.action === "launches") { S.tab = "launches"; render(); return { ok: true }; }
    if (c.action === "search" && c.query) { const r = await api(`/api/orbit/search?q=${encodeURIComponent(c.query)}`); if (!r.elements.length) return { ok: false, error: "not found in the catalogue" }; S.elements = r.elements; S.groupInfo = { ...r, name: `search: ${c.query}` }; S.recs.clear(); S.tab = "track"; render(); select(r.elements[0].NORAD_CAT_ID); return { ok: true, name: r.elements[0].OBJECT_NAME }; }
    return { ok: false, error: "unknown Orbit command" };
  }
  render();
  await loadGroup("stations");
  A.setContext({ operation: "orbit" });
  S.timer = setInterval(() => { if (document.visibilityState !== "hidden" && S.tab === "track") tick(); }, 2000);
  return { command, refresh: () => tick(), unmount() { clearInterval(S.timer); A.clearLayer("satellites"); A.on3d = null; A.globe()?.setPaths([]); } };
}
