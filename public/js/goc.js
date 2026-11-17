// Global Operations: the Mission Control operations display.
//   left    the living JARVIS core (the real 3D core, moved here) and live system readings
//   centre  an interactive world map with selectable layers, public civil flight positions and event markers
//   right   the Global Events feed (or flight controls / places, depending on the section)
//   bottom  compact status panels
// Every number and marker comes from a real source; when a source is unavailable the panel says so.
import { api } from "./api.js";
import * as sync from "./sync.js";
import { core, STATE_LABEL } from "./corestate.js";
import { $, $$, esc, ago, toast } from "./util.js";
import { spark, SERIES_MAX } from "./mc-panels.js";

const SVG = {
  plane: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15.5v-2l-8-5V3.6a1.5 1.5 0 0 0-3 0v4.9l-8 5v2l8-2.5v5l-2 1.5V21l3.5-1 3.5 1v-1.5l-2-1.5v-5z" fill="currentColor"/></svg>',
  layers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 8l10 5 10-5-10-5zm-8.2 9.4L2 13.3l10 5 10-5-1.8-.9L12 16.4zm0 4L2 17.3l10 5 10-5-1.8-.9L12 20.4z" fill="currentColor"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="1.6"/></svg>',
  world: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
};
export const CAT_COLOR = { conflict: "#c98a9a", attack: "#d39b6a", unrest: "#b9a66b", disaster: "#6fb7c9", humanitarian: "#8fbf9f", diplomacy: "#9aa7e0", ceasefire: "#c8d3de" };
const ALT_BANDS = [["all", "All altitudes"], ["ground", "On the ground"], ["low", "Below 10,000 ft"], ["mid", "10,000–25,000 ft"], ["high", "Above 25,000 ft"]];
export const REGIONS = {
  world: ["Worldwide", [-58, -170, 75, 190]], europe: ["Europe", [35, -12, 62, 32]], mediterranean: ["Mediterranean", [30, -6, 46, 37]], cyprus: ["Cyprus", [34.3, 31.9, 35.9, 34.8]],
  uk: ["UK & Ireland", [49.8, -10.7, 59, 2]], middleeast: ["Middle East", [12, 32, 42, 63]], northamerica: ["North America", [15, -130, 55, -60]], southamerica: ["South America", [-56, -82, 13, -34]],
  africa: ["Africa", [-35, -18, 37, 52]], southasia: ["South Asia", [5, 60, 35, 95]], eastasia: ["East Asia", [20, 100, 46, 146]], oceania: ["Oceania", [-47, 110, -8, 180]],
};
const BASES = [["dark", "Standard"], ["satellite", "Satellite"], ["today", "Satellite · latest day"], ["terrain", "Terrain"], ["relief", "Relief"], ["osm", "OpenStreetMap"]];
const OVERLAYS = [["boundaries", "Country boundaries"], ["labels", "Country names"], ["events", "Global events"], ["conflict", "War & conflict reporting"], ["flights", "Public civil flights"], ["trails", "Flight trails"], ["radar", "Weather radar"]];
const MODE_DEFAULTS = {
  globalops: { events: true, conflict: true, flights: true },
  world: { events: false, conflict: false, flights: false },
  events: { events: true, conflict: true, flights: false },
  flights: { events: false, conflict: false, flights: true },
};
const altColor = (a) => (a.ground ? "#6b7785" : a.alt == null ? "#8893a0" : a.alt < 10000 ? "#5fb3b3" : a.alt < 25000 ? "#7aa2d6" : "#dfe8f2");
const EMERGENCY = new Set(["7500", "7600", "7700"]);
const reducedMotion = () => document.documentElement.classList.contains("reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmtN = (n) => (n == null ? "—" : Number(n).toLocaleString("en-GB"));
const nowIn = (tz, o) => { try { return new Date().toLocaleString("en-GB", { timeZone: tz, ...o }); } catch { return "—"; } };
const hhmm = (iso, tz) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const stDot = (s) => `<span class="goc-dot ${s === "operational" || s === "ok" || s === "connected" ? "ok" : s === "not_configured" || s === "off" || s === "not_used" ? "off" : s === "failed" || s === "error" || s === "exhausted" ? "bad" : "warn"}"></span>`;
const STATE_WORD = { operational: "operational", ok: "operational", connected: "connected", degraded: "degraded", stale: "stale data", failed: "failed", initialising: "initialising", not_configured: "not configured", backoff: "paused (backing off)", exhausted: "daily allowance used", not_used: "idle", off: "off", warn: "attention", error: "fault", unknown: "not verified" };

let L = null;
async function leaflet() {
  if (L) return L;
  if (!document.querySelector('link[href="/vendor/leaflet/leaflet.css"]')) document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/vendor/leaflet/leaflet.css" }));
  L = await import("/vendor/leaflet/leaflet-src.esm.js");
  return L;
}

/**
 * Mount Global Operations into `el`. coreHost receives the JARVIS core panel (moved by Mission Control).
 * Returns { setMode, command, ready, coreHost, destroy, info }.
 */
export async function mountGoc(el, ctx, { mode = "globalops" } = {}) {
  const tz = ctx.settings.timezone;
  const st = {
    mode, layers: { boundaries: true, labels: false, radar: false, trails: true, ...MODE_DEFAULTS[mode] }, base: "dark",
    flights: null, flightErr: null, flightsAt: 0, nextFlightT: 0, selected: null, follow: false, history: new Map(),
    filter: { type: "", alt: "all" }, events: null, eventsErr: null, evFilter: { cats: new Set(), region: "", country: "", days: "3", provider: "", status: "" },
    status: null, diag: null, perf: null, activity: null, world: null, series: { cpu: [], ram: [], lag: [] }, globe: null, view3d: false, destroyed: false,
    selectedEvent: null, firstFlights: null, firstEvents: null,
  };
  const timers = [], offs = [];
  el.innerHTML = `<div class="goc" data-mode="${mode}">
    <header class="goc-strip" aria-label="Operations status">
      <div class="goc-brand"><b>J.A.R.V.I.S.</b><span>Global Operations</span></div>
      <div class="goc-clocks" id="gocClocks"></div>
      <div class="goc-pills" id="gocPills"></div>
    </header>
    <aside class="goc-left" aria-label="JARVIS core and systems">
      <div class="goc-core-host"></div>
      <section class="goc-box"><h3>Systems</h3><dl class="goc-sys" id="gocSys"><div class="goc-muted">Reading live status…</div></dl></section>
    </aside>
    <main class="goc-centre">
      <div class="goc-maptools" role="toolbar" aria-label="Map controls">
        <button class="goc-tb" id="gocLayersBtn" aria-expanded="false">${SVG.layers}<span>Layers</span></button>
        <select class="goc-sel" id="gocRegion" aria-label="Go to region">${Object.entries(REGIONS).map(([k, [n]]) => `<option value="${k}">${esc(n)}</option>`).join("")}</select>
        <button class="goc-tb" id="gocWorld" title="Return to global view">${SVG.world}<span>Global view</span></button>
        <button class="goc-tb" id="goc3d" aria-pressed="false">3D</button>
        <span class="goc-maphint" id="gocMapHint"></span>
      </div>
      <div class="goc-layers" id="gocLayers" hidden>
        <div class="goc-layers-col"><h4>Base map</h4>${BASES.map(([k, n]) => `<label><input type="radio" name="gocBase" value="${k}" ${k === "dark" ? "checked" : ""}> ${esc(n)}</label>`).join("")}</div>
        <div class="goc-layers-col"><h4>Overlays</h4>${OVERLAYS.map(([k, n]) => `<label><input type="checkbox" data-ov="${k}"> ${esc(n)}</label>`).join("")}</div>
        <p class="goc-muted goc-layer-note" id="gocLayerNote"></p>
      </div>
      <div class="goc-map" id="gocMap" aria-label="World map"></div>
      <canvas class="goc-overlay" id="gocOverlay" aria-hidden="true"></canvas>
      <div class="goc-globe" id="gocGlobe" hidden><canvas aria-label="3D globe"></canvas><div class="goc-globe-labels"></div></div>
      <div class="goc-tip" id="gocTip" hidden></div>
      <div class="goc-card" id="gocCard" hidden aria-live="polite"></div>
      <div class="goc-legend" id="gocLegend"></div>
    </main>
    <aside class="goc-right" id="gocRight" aria-label="Global events"></aside>
    <footer class="goc-bottom">
      <section class="goc-box" data-b="flights"><h3>Flight tracking</h3><div></div></section>
      <section class="goc-box" data-b="imagery"><h3>Satellite & imagery</h3><div></div></section>
      <section class="goc-box" data-b="events"><h3>Global event activity</h3><div></div></section>
      <section class="goc-box" data-b="timeline"><h3>System activity</h3><div></div></section>
      <section class="goc-box" data-b="network"><h3>Network</h3><div></div></section>
      <section class="goc-box" data-b="ops"><h3>Recent JARVIS operations</h3><div></div></section>
    </footer>
  </div>`;
  const root = $(".goc", el);
  const box = (k) => $(`[data-b="${k}"] > div`, root);

  // ------------------------------------------------------------ Map
  const Lf = await leaflet();
  const mq = ctx.settings.appearance?.mapQuality || "auto";
  const map = Lf.map($("#gocMap", root), { zoomControl: true, attributionControl: true, worldCopyJump: true, minZoom: 2, maxZoom: 12, zoomAnimation: false, fadeAnimation: !reducedMotion(), markerZoomAnimation: false, preferCanvas: true, zoomSnap: 0.5, wheelPxPerZoomLevel: 90 });
  map.attributionControl.setPrefix(false);
  map.fitBounds([[REGIONS.world[1][0], REGIONS.world[1][1]], [REGIONS.world[1][2], REGIONS.world[1][3]]]);
  const tileOpts = (k, extra = {}) => ({ maxNativeZoom: k === "today" ? 9 : k === "relief" ? 8 : k === "terrain" ? 17 : k === "satellite" ? 15 : 18, maxZoom: 12, detectRetina: mq === "high", updateWhenIdle: mq === "low", keepBuffer: mq === "low" ? 1 : 2, crossOrigin: false, ...extra });
  let layerInfo = {};
  const baseLayer = (k) => Lf.tileLayer(`/tiles/${k}/{z}/{x}/{y}`, { ...tileOpts(k), className: k === "dark" ? "goc-dark-tiles" : "", attribution: esc(layerInfo[k]?.attribution || "") });
  let base = null, radar = null, bounds = null, labelData = null;
  const tileErrors = { n: 0, last: null };
  function setBase(k) {
    st.base = k;
    if (base) map.removeLayer(base);
    base = baseLayer(k).addTo(map);
    base.on("tileerror", () => { tileErrors.n++; tileErrors.last = k; renderLegend(); });
    base.bringToBack();
    renderLegend(); renderBottom("imagery");
  }
  function setOverlay(k, on) {
    st.layers[k] = on;
    const cb = $(`[data-ov="${k}"]`, root); if (cb) cb.checked = on;
    if (k === "labels" && on) loadLabels();
    if (k === "radar") { if (on && !radar) radar = Lf.tileLayer("/tiles/radar/{z}/{x}/{y}", { ...tileOpts("radar"), maxNativeZoom: 7, opacity: 0.7, attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">Weather data by RainViewer</a>' }).addTo(map); else if (!on && radar) { map.removeLayer(radar); radar = null; } }
    if (k === "boundaries") { if (on) loadBoundaries(); else if (bounds) { map.removeLayer(bounds); bounds = null; } }
    if (k === "flights") { if (on) pollFlights(true); else { st.selected = null; hideCard(); } renderBottom("flights"); if (st.mode === "flights") renderRight(); }
    if (k === "trails" && st.mode === "flights") renderRight();
    if (k === "events" || k === "conflict") renderRight();
    draw(); renderLegend();
  }
  async function loadLabels() {
    if (labelData) return;
    try { labelData = (await api("/api/globalops/countries")).sort((a, b) => b.area - a.area); draw(); } catch (e) { $("#gocLayerNote", root).textContent = `Place labels couldn't load: ${e.message}`; }
  }
  async function loadBoundaries() {
    if (bounds) return;
    try {
      const gj = await fetch("/vendor/countries-110m.geojson").then((r) => r.json());
      if (!st.layers.boundaries || st.destroyed) return;
      bounds = Lf.geoJSON(gj, { style: { color: "#4b6278", weight: 0.7, opacity: 0.8, fill: false }, interactive: false, attribution: "Boundaries: Natural Earth" }).addTo(map);
    } catch (e) { $("#gocLayerNote", root).textContent = `Country boundaries couldn't load: ${e.message}`; }
  }

  // ------------------------------------------------------------ Overlay canvas (events + aircraft, one draw for all)
  const cv = $("#gocOverlay", root), g2 = cv.getContext("2d");
  let hits = [], drawQueued = false;
  function sizeCanvas() { const r = $("#gocMap", root).getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, mq === "low" ? 1 : 2); cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); cv.style.width = `${r.width}px`; cv.style.height = `${r.height}px`; g2.setTransform(dpr, 0, 0, dpr, 0, 0); }
  function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawNow(); }); } }
  const drawStats = { ms: 0, n: 0 };
  function visibleEvents() {
    if (!st.events?.items) return [];
    const showAll = st.layers.events, showConflict = st.layers.conflict;
    return filteredEvents().filter((e) => e.lat != null && e.lon != null && (showAll || (showConflict && (e.category === "conflict" || e.category === "attack" || e.category === "ceasefire"))));
  }
  function drawNow() {
    if (st.destroyed || st.view3d) return;
    const t0 = performance.now();
    const W = cv.width, H = cv.height;
    g2.clearRect(0, 0, W, H);
    hits = [];
    const size = map.getSize(), z = map.getZoom();
    // Country names (offline gazetteer), largest first, skipping any that would overlap.
    if (st.layers.labels && labelData) {
      const placed = [];
      g2.font = `${z >= 5 ? 12 : 10.5}px var(--mono, ui-monospace, monospace)`; g2.textAlign = "center"; g2.textBaseline = "middle";
      for (const c of labelData) {
        if (z < 3 && c.area < 400000) continue;
        if (z < 4 && c.area < 60000) continue;
        const p = map.latLngToContainerPoint([c.lat, c.lon]);
        if (p.x < 0 || p.y < 0 || p.x > size.x || p.y > size.y) continue;
        const name = c.name.toUpperCase(), w = g2.measureText(name).width + 8, r = [p.x - w / 2, p.y - 8, p.x + w / 2, p.y + 8];
        if (placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
        placed.push(r);
        g2.fillStyle = "rgba(3,6,10,.55)"; g2.fillText(name, p.x + 1, p.y + 1);
        g2.fillStyle = "rgba(190,205,220,.72)"; g2.fillText(name, p.x, p.y);
      }
    }
    // Events
    for (const e of visibleEvents()) {
      const p = map.latLngToContainerPoint([e.lat, e.lon]);
      if (p.x < -20 || p.y < -20 || p.x > size.x + 20 || p.y > size.y + 20) continue;
      const approx = /country|unknown|district/.test(e.locAccuracy || "");
      const r = 3 + (e.severity || 1) * 1.6;
      g2.beginPath(); g2.arc(p.x, p.y, r, 0, Math.PI * 2);
      const col = CAT_COLOR[e.category] || "#9fb4c8";
      if (approx) { g2.strokeStyle = col; g2.lineWidth = 1.4; g2.stroke(); }
      else { g2.fillStyle = col; g2.globalAlpha = 0.85; g2.fill(); g2.globalAlpha = 1; }
      if (e.alertLevel === "Red") { g2.beginPath(); g2.arc(p.x, p.y, r + 3, 0, Math.PI * 2); g2.strokeStyle = "#e05a4f"; g2.lineWidth = 1.2; g2.stroke(); }
      if (st.selectedEvent === e.id) { g2.beginPath(); g2.arc(p.x, p.y, r + 5, 0, Math.PI * 2); g2.strokeStyle = "#c4b5fd"; g2.lineWidth = 1.5; g2.stroke(); }
      hits.push({ x: p.x, y: p.y, r: r + 3, kind: "event", e });
    }
    // Aircraft
    if (st.layers.flights && st.flights?.list) {
      const list = filteredAircraft();
      if (z < 4 && list.length > 400) {
        // Clusters: counts in a 44 px grid so a worldwide view stays readable and cheap to draw.
        const cell = 44, grid = new Map();
        for (const a of list) { const p = map.latLngToContainerPoint([a.lat, a.lon]); if (p.x < 0 || p.y < 0 || p.x > size.x || p.y > size.y) continue; const k = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`; const c = grid.get(k) || { n: 0, x: 0, y: 0 }; c.n++; c.x += p.x; c.y += p.y; grid.set(k, c); }
        g2.font = "600 10px var(--mono, ui-monospace, monospace)"; g2.textAlign = "center"; g2.textBaseline = "middle";
        for (const c of grid.values()) {
          const x = c.x / c.n, y = c.y / c.n, r = Math.min(16, 5 + Math.log2(c.n + 1) * 1.8);
          g2.beginPath(); g2.arc(x, y, r, 0, Math.PI * 2); g2.fillStyle = "rgba(122,162,214,.22)"; g2.fill(); g2.strokeStyle = "rgba(160,190,225,.55)"; g2.lineWidth = 1; g2.stroke();
          if (c.n > 1) { g2.fillStyle = "#cfdae6"; g2.fillText(c.n > 999 ? `${Math.round(c.n / 100) / 10}k` : String(c.n), x, y); }
          hits.push({ x, y, r, kind: "cluster", n: c.n });
        }
      } else {
        // Trails: positions this JARVIS actually received, nothing interpolated.
        if (st.layers.trails) {
          g2.lineWidth = 1; g2.strokeStyle = "rgba(122,162,214,.35)";
          for (const a of list) { const h = st.history.get(a.hex); if (!h || h.length < 2) continue; g2.beginPath(); h.forEach((q, i) => { const p = map.latLngToContainerPoint([q[0], q[1]]); if (i) g2.lineTo(p.x, p.y); else g2.moveTo(p.x, p.y); }); g2.stroke(); }
        }
        const s = z >= 7 ? 7 : z >= 5 ? 5.5 : 4.2;
        for (const a of list) {
          const p = map.latLngToContainerPoint([a.lat, a.lon]);
          if (p.x < -10 || p.y < -10 || p.x > size.x + 10 || p.y > size.y + 10) continue;
          const sel = st.selected?.hex === a.hex;
          g2.save(); g2.translate(p.x, p.y); g2.rotate(((a.track ?? 0) * Math.PI) / 180);
          g2.beginPath(); g2.moveTo(0, -s); g2.lineTo(s * 0.7, s * 0.75); g2.lineTo(0, s * 0.35); g2.lineTo(-s * 0.7, s * 0.75); g2.closePath();
          g2.fillStyle = a.squawk && EMERGENCY.has(a.squawk) ? "#e05a4f" : sel ? "#c4b5fd" : altColor(a);
          g2.globalAlpha = a.posAge > 60 ? 0.45 : 1;
          if (a.track == null) { g2.restore(); g2.beginPath(); g2.arc(p.x, p.y, s * 0.45, 0, Math.PI * 2); g2.fillStyle = altColor(a); g2.fill(); }
          else { g2.fill(); g2.restore(); }
          g2.globalAlpha = 1;
          if (sel) { g2.beginPath(); g2.arc(p.x, p.y, s + 5, 0, Math.PI * 2); g2.strokeStyle = "#c4b5fd"; g2.lineWidth = 1.2; g2.stroke(); }
          hits.push({ x: p.x, y: p.y, r: s + 3, kind: "aircraft", a });
        }
        if (z >= 7) {
          g2.font = "10px var(--mono, ui-monospace, monospace)"; g2.textAlign = "left"; g2.textBaseline = "middle"; g2.fillStyle = "rgba(207,218,230,.8)";
          for (const h of hits) if (h.kind === "aircraft" && h.a.callsign) g2.fillText(h.a.callsign, h.x + 9, h.y);
        }
      }
      // Selected aircraft's full trail (from the server's observed history).
      if (st.selected?.trail?.length > 1 && st.layers.trails) {
        g2.beginPath(); g2.lineWidth = 1.6; g2.strokeStyle = "rgba(196,181,253,.8)";
        st.selected.trail.forEach((q, i) => { const p = map.latLngToContainerPoint([q.lat, q.lon]); if (i) g2.lineTo(p.x, p.y); else g2.moveTo(p.x, p.y); });
        g2.stroke();
      }
    }
    drawStats.ms = Math.round((performance.now() - t0) * 10) / 10; drawStats.n++;
    window.__jarvisGoc = { drawMs: drawStats.ms, draws: drawStats.n, aircraft: st.flights?.list?.length || 0, events: st.events?.items?.length || 0, hits: hits.length, zoom: z };
  }
  window.__jarvisGocRedraw = drawNow;   // used by scripts/perf-goc.mjs to time a full redraw
  map.on("move resize zoom", draw);
  map.on("resize", () => { sizeCanvas(); draw(); });
  map.on("moveend", () => { scheduleFlights(700); hint(); });
  const ro = new ResizeObserver(() => { map.invalidateSize({ pan: false }); sizeCanvas(); draw(); });
  ro.observe($("#gocMap", root));
  sizeCanvas();

  function hitAt(x, y) { let best = null, bd = 1e9; for (const h of hits) { const d = Math.hypot(h.x - x, h.y - y); if (d <= h.r + 2 && d < bd) { best = h; bd = d; } } return best; }
  const mapEl = $("#gocMap", root), tip = $("#gocTip", root);
  mapEl.addEventListener("mousemove", (ev) => {
    const r = mapEl.getBoundingClientRect(), h = hitAt(ev.clientX - r.left, ev.clientY - r.top);
    mapEl.style.cursor = h ? "pointer" : "";
    if (!h) { tip.hidden = true; return; }
    tip.hidden = false; tip.style.left = `${ev.clientX - r.left + 14}px`; tip.style.top = `${ev.clientY - r.top + 10}px`;
    tip.innerHTML = h.kind === "aircraft" ? `<b>${esc(h.a.callsign || h.a.hex.toUpperCase())}</b> ${esc(h.a.type || "")}<br><span>${h.a.ground ? "on ground" : h.a.alt != null ? `${fmtN(h.a.alt)} ft` : "altitude unknown"} · ${h.a.gs != null ? `${Math.round(h.a.gs)} kt` : "—"}</span>`
      : h.kind === "cluster" ? `<b>${fmtN(h.n)} aircraft</b><br><span>zoom in to see them individually</span>`
      : `<b>${esc(h.e.title.slice(0, 90))}</b><br><span>${esc(h.e.placeName || h.e.country || "location unknown")} · ${esc(ctx.goc?.cats?.[h.e.category] || h.e.category)}</span>`;
  });
  mapEl.addEventListener("mouseleave", () => { tip.hidden = true; });
  map.on("click", (ev) => {
    const h = hitAt(ev.containerPoint.x, ev.containerPoint.y);
    if (!h) return;
    if (h.kind === "aircraft") selectAircraft(h.a.hex);
    else if (h.kind === "cluster") map.setView(ev.latlng, Math.min(map.getZoom() + 2, 8));
    else if (h.kind === "event") { st.selectedEvent = h.e.id; renderRight(); draw(); const it = $(`[data-ev="${CSS.escape(h.e.id)}"]`, root); it?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }); it?.classList.add("open"); }
  });

  // ------------------------------------------------------------ Flights
  function filteredAircraft() {
    const f = st.filter, type = f.type.trim().toUpperCase();
    return (st.flights?.list || []).filter((a) => (!type || (a.type || "").toUpperCase().startsWith(type))
      && (f.alt === "all" || (f.alt === "ground" ? a.ground : !a.ground && a.alt != null && (f.alt === "low" ? a.alt < 10000 : f.alt === "mid" ? a.alt >= 10000 && a.alt < 25000 : a.alt >= 25000))));
  }
  let flightT = 0, flightBusy = false;
  function scheduleFlights(ms) { clearTimeout(flightT); if (st.layers.flights && !st.destroyed) flightT = setTimeout(() => pollFlights(), ms); }
  async function pollFlights(force = false) {
    if (!st.layers.flights || st.destroyed || flightBusy) return;
    if (document.visibilityState === "hidden" && !force) return scheduleFlights(15000);
    flightBusy = true;
    const b = map.getBounds().pad(0.08);
    const q = new URLSearchParams({ limit: map.getZoom() < 4 ? "12000" : "6000", lamin: Math.max(-85, b.getSouth()).toFixed(2), lomin: Math.max(-180, b.getWest()).toFixed(2), lamax: Math.min(85, b.getNorth()).toFixed(2), lomax: Math.min(180, b.getEast()).toFixed(2) });
    if (b.getEast() - b.getWest() >= 300) { q.set("lomin", "-180"); q.set("lomax", "180"); }
    try {
      const r = await api(`/api/flights?${q}`);
      st.flightErr = r.ok ? null : r.error;
      if (r.ok) {
        const idx = Object.fromEntries(r.fields.map((f, i) => [f, i]));
        const list = r.aircraft.map((x) => ({ hex: x[idx.hex], callsign: x[idx.callsign], reg: x[idx.reg], type: x[idx.type], lat: x[idx.lat], lon: x[idx.lon], alt: x[idx.alt], gs: x[idx.gs], track: x[idx.track], vs: x[idx.vs], ground: !!x[idx.ground], posAge: x[idx.posAge], cat: x[idx.cat], src: x[idx.src] }));
        st.flights = { ...r, list }; st.flightsAt = Date.now();
        // Client-side trails from the positions actually received (kept for the session, 40 points per aircraft).
        for (const a of list) { const h = st.history.get(a.hex) || []; const l = h[h.length - 1]; if (!l || l[0] !== a.lat || l[1] !== a.lon) { h.push([a.lat, a.lon]); if (h.length > 40) h.shift(); st.history.set(a.hex, h); } }
        if (st.history.size > 30000) for (const k of [...st.history.keys()].slice(0, 6000)) st.history.delete(k);
        if (st.selected) { const a = list.find((x) => x.hex === st.selected.hex); if (a) { Object.assign(st.selected, { live: a }); if (st.follow) map.panTo([a.lat, a.lon], { animate: !reducedMotion() }); renderCard(); } }
        st.firstFlights ||= { ok: true, n: list.length, source: r.attribution?.name };
      } else st.firstFlights ||= { ok: false, error: r.error };
    } catch (e) { st.flightErr = e.message; st.firstFlights ||= { ok: false, error: e.message }; }
    finally { flightBusy = false; }
    draw(); renderBottom("flights"); renderLegend(); if (st.mode === "flights") renderRight();
    const next = st.flights?.nextUpdateSec ?? 30;
    st.nextFlightT = Date.now() + Math.max(15, next) * 1000;
    scheduleFlights(Math.max(15, next) * 1000 + 300);
  }
  async function selectAircraft(hex, { follow = false } = {}) {
    st.selected = { hex, live: st.flights?.list?.find((a) => a.hex === hex) || null, detail: null, trail: [] };
    st.follow = follow;
    renderCard(); draw();
    try {
      const r = await api(`/api/flights/aircraft/${hex}`);
      if (st.selected?.hex !== hex) return r;
      if (!r.ok) { st.selected.error = r.error; renderCard(); return r; }
      Object.assign(st.selected, { detail: r.aircraft, trail: r.trail, note: r.note, attribution: r.attribution });
      if (!st.selected.live) map.setView([r.aircraft.lat, r.aircraft.lon], Math.max(map.getZoom(), 6));
      renderCard(); draw();
      return r;
    } catch (e) { if (st.selected) { st.selected.error = e.message; renderCard(); } return { ok: false, error: e.message }; }
  }
  const card = $("#gocCard", root);
  function hideCard() { card.hidden = true; st.selected = null; st.follow = false; draw(); }
  function renderCard() {
    const s = st.selected; if (!s) { card.hidden = true; return; }
    const d = s.detail, a = s.live, x = { ...(d || {}), ...(a ? { lat: a.lat, lon: a.lon, alt: a.alt, gs: a.gs, track: a.track, vs: a.vs, ground: a.ground, posAgeSec: a.posAge } : {}) };
    const age = x.posAgeSec, fresh = age == null ? "unknown" : age <= 15 ? "live" : age <= 60 ? "recent" : "stale";
    const row = (k, v) => `<div><dt>${k}</dt><dd>${v ?? '<span class="goc-muted">not reported</span>'}</dd></div>`;
    card.hidden = false;
    card.innerHTML = `<div class="goc-card-head"><span>${SVG.plane}</span><b>${esc(x.callsign || s.hex.toUpperCase())}</b><button class="goc-x" id="gocCardX" aria-label="Close">×</button></div>
      ${s.error && !d && !a ? `<p class="goc-muted">${esc(s.error)}</p>` : `<dl class="goc-kv">
        ${row("ICAO24", esc(s.hex.toUpperCase()))}${row("Registration", x.reg ? esc(x.reg) : null)}${row("Aircraft type", x.type ? esc(x.type) : null)}
        ${row("Position", x.lat != null ? `${x.lat.toFixed(3)}°, ${x.lon.toFixed(3)}°` : null)}${row("Altitude", x.ground ? "on the ground" : x.alt != null ? `${fmtN(x.alt)} ft` : null)}
        ${row("Ground speed", x.gs != null ? `${Math.round(x.gs)} kt` : null)}${row("Heading (track)", x.track != null ? `${Math.round(x.track)}°` : null)}${row("Vertical speed", x.vs != null ? `${x.vs > 0 ? "+" : ""}${fmtN(x.vs)} ft/min` : null)}
        ${row("Last observed", age != null ? `${age} s ago <span class="goc-tag ${fresh}">${fresh}</span>` : null)}${row("Position source", d?.positionSource ? esc(d.positionSource) : null)}
        ${row("Data source", esc((s.attribution || st.flights?.attribution)?.name || "—"))}${x.squawk && EMERGENCY.has(x.squawk) ? row("Squawk", `<span class="goc-alert">${esc(x.squawk)} (emergency code)</span>`) : ""}
      </dl>
      <p class="goc-muted goc-small">${s.trail?.length > 1 ? `Trail: ${s.trail.length} positions observed by JARVIS in the last hour.` : "No track history yet — JARVIS draws the trail from positions it receives."}${s.note ? ` ${esc(s.note)}` : ""}</p>
      <div class="goc-card-actions"><button class="goc-btn" id="gocFollow" aria-pressed="${st.follow}">${st.follow ? "Following" : "Follow"}</button><button class="goc-btn" id="gocZoomTo">Zoom to</button></div>`}`;
    $("#gocCardX", card).onclick = hideCard;
    const fb = $("#gocFollow", card); if (fb) fb.onclick = () => { st.follow = !st.follow; renderCard(); if (st.follow && x.lat != null) map.setView([x.lat, x.lon], Math.max(map.getZoom(), 7)); };
    const zb = $("#gocZoomTo", card); if (zb) zb.onclick = () => x.lat != null && map.setView([x.lat, x.lon], 8);
  }

  // ------------------------------------------------------------ Events
  function filteredEvents() {
    const f = st.evFilter, since = Date.now() - Number(f.days || 3) * 86400_000, c = f.country.trim().toLowerCase();
    return (st.events?.items || []).filter((e) => (!f.cats.size || f.cats.has(e.category)) && (!f.region || e.region === f.region || e.subregion === f.region)
      && (!c || (e.country || "").toLowerCase().includes(c) || (e.placeName || "").toLowerCase().includes(c)) && (!f.provider || e.provider === f.provider) && (!f.status || e.status === f.status)
      && Date.parse(e.publishedAt || e.eventDate || e.retrievedAt) >= since);
  }
  async function loadEvents() {
    try { st.events = await api("/api/events?limit=600"); st.eventsErr = null; ctx.goc = { cats: st.events.categories }; st.firstEvents ||= { ok: true, n: st.events.total, providers: st.events.providers }; }
    catch (e) { st.eventsErr = e.message; st.firstEvents ||= { ok: false, error: e.message }; }
    renderRight(); renderBottom("events"); draw(); renderSys();
    if (st.globe) st.globe.setPoints(visibleEvents().map((e) => ({ lat: e.lat, lon: e.lon, color: CAT_COLOR[e.category] })));
  }

  // ------------------------------------------------------------ Right column
  const right = $("#gocRight", root);
  function renderRight() {
    if (st.mode === "flights") return renderFlightPanel();
    if (st.mode === "world") return renderPlaces();
    const E = st.events, f = st.evFilter;
    if (!E) { right.innerHTML = `<section class="goc-box goc-feed"><h3>Global events</h3><p class="goc-muted">${st.eventsErr ? `Global events unavailable — ${esc(st.eventsErr)}` : "Retrieving published reports…"}</p></section>`; return; }
    const items = filteredEvents();
    const regions = [...new Set(E.items.map((e) => e.region).filter(Boolean))].sort();
    const provs = Object.entries(E.providers);
    right.innerHTML = `<section class="goc-box goc-feed">
      <h3>Global events <span class="goc-count">${items.length}</span></h3>
      <div class="goc-chips" role="group" aria-label="Event categories">${Object.entries(E.categories).map(([k, n]) => `<button class="goc-chip ${f.cats.has(k) ? "on" : ""}" data-cat="${k}" style="--c:${CAT_COLOR[k]}" aria-pressed="${f.cats.has(k)}">${esc(n)}</button>`).join("")}</div>
      <div class="goc-filters">
        <select class="goc-sel" id="gocEvRegion" aria-label="Region"><option value="">All regions</option>${regions.map((r) => `<option ${f.region === r ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>
        <input class="goc-in" id="gocEvCountry" placeholder="Country" value="${esc(f.country)}" aria-label="Country">
        <select class="goc-sel" id="gocEvDays" aria-label="Date range">${[["1", "24 h"], ["3", "3 days"], ["7", "7 days"], ["14", "14 days"], ["120", "All held"]].map(([v, n]) => `<option value="${v}" ${f.days === v ? "selected" : ""}>${n}</option>`).join("")}</select>
        <select class="goc-sel" id="gocEvProv" aria-label="Source"><option value="">All sources</option>${provs.filter(([, p]) => p.configured).map(([k, p]) => `<option value="${k}" ${f.provider === k ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
        <select class="goc-sel" id="gocEvStatus" aria-label="Verification"><option value="">Any verification</option>${Object.entries(E.statusLabels).map(([k, n]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
      </div>
      <div class="goc-provs">${provs.map(([k, p]) => `<span title="${esc(p.lastError || p.attribution)}">${stDot(p.state)}${esc(p.name.split(" (")[0])} · ${esc(STATE_WORD[p.state] || p.state)}${p.lastOkAt ? ` · ${esc(ago(p.lastOkAt))}` : ""}</span>`).join("")}</div>
      <ol class="goc-evlist">${items.slice(0, 150).map((e) => evItem(e)).join("") || `<li class="goc-muted">No reports match these filters.</li>`}</ol>
      ${items.length > 150 ? `<p class="goc-muted goc-small">Showing the newest 150 of ${items.length}. Narrow the filters to see others.</p>` : ""}
    </section>`;
    $$("[data-cat]", right).forEach((b) => b.onclick = () => { const k = b.dataset.cat; f.cats.has(k) ? f.cats.delete(k) : f.cats.add(k); renderRight(); draw(); renderBottom("events"); });
    const bind = (id, key, ev = "change") => { const x = $(id, right); x[`on${ev}`] = () => { f[key] = x.value; if (ev === "input") { clearTimeout(x.__t); x.__t = setTimeout(() => { renderRight(); draw(); const n = $(id, right); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 350); } else { renderRight(); draw(); } }; };
    bind("#gocEvRegion", "region"); bind("#gocEvCountry", "country", "input"); bind("#gocEvDays", "days"); bind("#gocEvProv", "provider"); bind("#gocEvStatus", "status");
    $$("[data-ev]", right).forEach((li) => li.querySelector(".goc-ev-head").onclick = () => {
      const e = E.items.find((x) => x.id === li.dataset.ev); li.classList.toggle("open");
      st.selectedEvent = e?.id; draw();
      if (e?.lat != null) map.setView([e.lat, e.lon], Math.max(map.getZoom(), /country/.test(e.locAccuracy) ? 4 : 6), { animate: !reducedMotion() });
    });
  }
  function evItem(e) {
    const when = e.publishedAt || e.eventDate;
    return `<li class="goc-ev ${st.selectedEvent === e.id ? "open sel" : ""}" data-ev="${esc(e.id)}">
      <button class="goc-ev-head"><span class="goc-ev-cat" style="--c:${CAT_COLOR[e.category]}"></span><span class="goc-ev-title">${esc(e.title)}</span></button>
      <div class="goc-ev-meta"><span>${esc(e.placeName || e.country || "Location not stated")}</span><span>${esc(st.events.categories[e.category] || e.category)}${e.subtype ? ` · ${esc(e.subtype)}` : ""}</span><span>${when ? esc(hhmm(when, tz)) : "date not published"}</span></div>
      <div class="goc-ev-status s-${e.status}">${esc(st.events.statusLabels[e.status] || e.status)}</div>
      <div class="goc-ev-more">
        ${e.summary ? `<p>${esc(e.summary)}</p>` : ""}
        <dl class="goc-kv">
          <div><dt>Country / region</dt><dd>${esc([e.country, e.subregion || e.region].filter(Boolean).join(" · ") || "not determined")}</dd></div>
          <div><dt>${esc(e.eventDateLabel === "first reported" ? "First reported" : "Event date")}</dt><dd>${esc(hhmm(e.eventDate, tz))}</dd></div>
          <div><dt>Published</dt><dd>${e.publishedAt ? esc(hhmm(e.publishedAt, tz)) : esc(e.publishedNote || "—")}</dd></div>
          <div><dt>Retrieved</dt><dd>${esc(hhmm(e.retrievedAt, tz))}</dd></div>
          <div><dt>Location accuracy</dt><dd>${esc(e.locAccuracy || "unknown")}</dd></div>
          <div><dt>Source</dt><dd>${esc(st.events.providers[e.provider]?.name || e.provider)}</dd></div>
        </dl>
        <ul class="goc-srcs">${(e.sources || []).map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)} ↗</a>` : esc(s.name)}${s.publishedAt ? ` <span class="goc-muted">${esc(hhmm(s.publishedAt, tz))}</span>` : ""}${s.text ? `<div class="goc-muted goc-small">${esc(s.text)}</div>` : ""}</li>`).join("")}</ul>
      </div></li>`;
  }
  function renderFlightPanel() {
    const F = st.flights, list = filteredAircraft();
    const top = list.filter((a) => !a.ground).sort((a, b) => (a.posAge - b.posAge) || ((b.alt || 0) - (a.alt || 0))).slice(0, 60);
    right.innerHTML = `<section class="goc-box goc-feed">
      <h3>Flight tracking</h3>
      <form class="goc-search" id="gocFSearch"><input class="goc-in" id="gocFQ" placeholder="Callsign, ICAO24 or registration" aria-label="Find a flight" autocomplete="off"><button class="goc-btn">Find</button></form>
      <p class="goc-muted goc-small" id="gocFRes"></p>
      <div class="goc-filters">
        <input class="goc-in" id="gocFType" placeholder="Aircraft type (e.g. A320, B77)" value="${esc(st.filter.type)}" aria-label="Filter by aircraft type">
        <select class="goc-sel" id="gocFAlt" aria-label="Altitude band">${ALT_BANDS.map(([k, n]) => `<option value="${k}" ${st.filter.alt === k ? "selected" : ""}>${n}</option>`).join("")}</select>
        <select class="goc-sel" id="gocFRegion" aria-label="Region"><option value="">Region…</option>${Object.entries(REGIONS).map(([k, [n]]) => `<option value="${k}">${esc(n)}</option>`).join("")}</select>
      </div>
      <div class="goc-toggles"><label><input type="checkbox" id="gocFShow" ${st.layers.flights ? "checked" : ""}> Show aircraft</label><label><input type="checkbox" id="gocFTrails" ${st.layers.trails ? "checked" : ""}> Show trails</label></div>
      <p class="goc-muted goc-small">${F ? `${fmtN(list.length)} aircraft in this view${list.length !== F.list.length ? ` (of ${fmtN(F.list.length)} before filters)` : ""} · ${esc(F.attribution?.name || "")}` : st.flightErr ? `Flight data unavailable — ${esc(st.flightErr)}` : st.layers.flights ? "Retrieving aircraft…" : "Aircraft hidden."}</p>
      <ol class="goc-flist">${top.map((a) => `<li><button data-hex="${a.hex}" class="${st.selected?.hex === a.hex ? "sel" : ""}"><b>${esc(a.callsign || a.hex.toUpperCase())}</b><span>${esc(a.type || "type n/a")}</span><span>${a.alt != null ? `${fmtN(a.alt)} ft` : "—"}</span><span>${a.gs != null ? `${Math.round(a.gs)} kt` : "—"}</span></button></li>`).join("")}</ol>
      <p class="goc-muted goc-small goc-honest">Coverage depends on volunteer receivers and aircraft equipment: many aircraft are not visible, and positions can be delayed or wrong. Aircraft flagged as military, LADD or privacy (PIA) are not shown.</p>
    </section>`;
    $("#gocFSearch", right).onsubmit = async (ev) => { ev.preventDefault(); await findFlight($("#gocFQ", right).value); };
    $("#gocFType", right).oninput = (ev) => { st.filter.type = ev.target.value; clearTimeout(ev.target.__t); ev.target.__t = setTimeout(() => { draw(); renderBottom("flights"); }, 250); };
    $("#gocFAlt", right).onchange = (ev) => { st.filter.alt = ev.target.value; draw(); renderFlightPanel(); };
    $("#gocFRegion", right).onchange = (ev) => ev.target.value && goRegion(ev.target.value);
    $("#gocFShow", right).onchange = (ev) => setOverlay("flights", ev.target.checked);
    $("#gocFTrails", right).onchange = (ev) => setOverlay("trails", ev.target.checked);
    $$("[data-hex]", right).forEach((b) => b.onclick = () => selectAircraft(b.dataset.hex));
  }
  async function findFlight(q) {
    const out = $("#gocFRes", right);
    if (!String(q || "").trim()) return null;
    if (out) out.textContent = "Searching…";
    try {
      const r = await api(`/api/flights/search?q=${encodeURIComponent(q)}`);
      if (!r.ok || !r.results.length) { if (out) out.textContent = r.error || `${r.query} is not visible in the available data right now.`; return r; }
      const a = r.results[0];
      if (!st.layers.flights) setOverlay("flights", true);
      map.setView([a.lat, a.lon], 7);
      await selectAircraft(a.hex, { follow: true });
      if (out) out.textContent = `Found ${a.callsign || a.hex.toUpperCase()}${r.results.length > 1 ? ` (${r.results.length} matches)` : ""} — from ${r.from}.`;
      return r;
    } catch (e) { if (out) out.textContent = e.message; return { ok: false, error: e.message }; }
  }
  async function renderPlaces() {
    if (!st.world) try { st.world = await api("/api/world"); } catch (e) { right.innerHTML = `<section class="goc-box"><h3>World Explorer</h3><p class="goc-muted">Places unavailable — ${esc(e.message)}</p></section>`; return; }
    right.innerHTML = `<section class="goc-box goc-feed"><h3>World Explorer</h3>
      <p class="goc-muted goc-small">Your places with live local time and weather. Use Layers for satellite, terrain, relief, radar and the 3D globe.</p>
      <ol class="goc-places">${st.world.map((p) => `<li><button data-fly="${p.lat},${p.lon}"><b>${esc(p.name.split(",")[0])}${p.home ? ' <span class="goc-tag">home</span>' : ""}</b><span>${esc(nowIn(p.timezone, { hour: "2-digit", minute: "2-digit" }))} · ${esc(p.offset || "")}</span><span>${p.weather ? `${esc(p.weather.temp)}${esc(p.weather.unit)} · ${esc(p.weather.summary)}` : esc(p.error || "weather n/a")}</span></button></li>`).join("")}</ol>
      <div class="goc-regions">${Object.entries(REGIONS).map(([k, [n]]) => `<button class="goc-chip" data-reg="${k}">${esc(n)}</button>`).join("")}</div></section>`;
    $$("[data-fly]", right).forEach((b) => b.onclick = () => { const [la, lo] = b.dataset.fly.split(",").map(Number); if (st.view3d) st.globe?.flyTo(la, lo); else map.setView([la, lo], 7); });
    $$("[data-reg]", right).forEach((b) => b.onclick = () => goRegion(b.dataset.reg));
  }
  function goRegion(k) { const R = REGIONS[k]; if (!R) return; if (st.view3d) toggle3d(false); map.fitBounds([[R[1][0], R[1][1]], [R[1][2], R[1][3]]], { animate: !reducedMotion() }); $("#gocRegion", root).value = k; }

  // ------------------------------------------------------------ Left column: system readings
  function renderSys() {
    const d = st.diag, p = st.perf, s = st.status, ck = (n) => d?.checks?.find((c) => c.name === n);
    const rows = [];
    const add = (label, state, detail) => rows.push(`<div title="${esc(`${label}: ${detail}`)}"><dt>${stDot(state)}${esc(label)}</dt><dd>${esc(detail)}</dd></div>`);
    const ai = ck("ai"); add("AI", ai?.status || "unknown", ai ? `${ai.detail.split(" · ")[0]}` : "checking…");
    const stt = ck("stt"), tts = ck("tts");
    add("Voice interface", stt?.status === "error" ? "error" : core.state === "idle" ? stt?.status || "unknown" : "ok", `${STATE_LABEL[core.state] || core.state}${stt ? ` · recognition ${stt.status === "ok" ? "ready" : stt.status}` : ""}${tts ? ` · voice ${tts.status === "ok" ? "ready" : tts.status === "error" ? "fault" : "not verified"}` : ""}`);
    const db = ck("database"); add("Database", db?.status || "unknown", db ? db.detail.split(" · ").slice(0, 2).join(" · ") : "checking…");
    add("Background services", s?.scheduler?.status || "unknown", s?.scheduler?.detail || "checking…");
    add("World Explorer", tileErrors.n > 5 ? "warn" : s ? "ok" : "unknown", `${BASES.find((b) => b[0] === st.base)?.[1] || st.base} map${tileErrors.n ? ` · ${tileErrors.n} tile errors` : ""}${s?.tiles ? ` · cache ${s.tiles.hits} hits` : ""}`);
    if (st.events) { const pv = Object.values(st.events.providers).filter((x) => x.configured), okN = pv.filter((x) => x.state === "operational").length; add("Global events feed", okN === pv.length ? "ok" : okN ? "warn" : "error", `${okN}/${pv.length} sources live · ${fmtN(st.events.total)} items`); }
    else add("Global events feed", st.eventsErr ? "error" : "unknown", st.eventsErr || "retrieving…");
    const fs = s?.flights?.providers;
    add("Flight data", !st.layers.flights ? "off" : st.flightErr ? "error" : st.flights ? "ok" : "unknown", !st.layers.flights ? "layer hidden" : st.flightErr || (st.flights ? `${st.flights.attribution?.name} · ${fmtN(st.flights.list.length)} aircraft` : "retrieving…") + (fs?.adsb.remaining != null ? ` · ADSB.lol ${fs.adsb.remaining} left today` : ""));
    add("CPU", p ? (p.cpuPct > 90 ? "warn" : "ok") : "unknown", p ? `${p.cpuPct}% · ${p.cores} cores` : "measuring…");
    add("RAM", p ? (p.ramPct > 92 ? "warn" : "ok") : "unknown", p ? `${p.ramPct}% in use` : "measuring…");
    const gpu = window.__jarvisBoot?.lines?.find?.((l) => /3D rendering/i.test(l.label));
    add("GPU", gpu?.status === "degraded" ? "warn" : gpu ? "ok" : "unknown", `${gpu?.detail ? gpu.detail.split(" · ")[1] || gpu.detail : "renderer not reported"} · usage not measurable from the app`);
    const fps = window.__jarvisCore?.fps;
    add("Frame rate", fps == null ? "unknown" : fps < 20 ? "warn" : "ok", `${fps != null ? `core ${Math.round(fps)} fps` : "core not drawing"} · map draw ${drawStats.ms} ms`);
    $("#gocSys", root).innerHTML = rows.join("");
    // Top strip pills
    const online = sync.status.online;
    const issues = d ? (d.counts.error || 0) + (d.counts.warn || 0) : null;
    $("#gocPills", root).innerHTML = [
      `<span>${stDot(ai?.status || "unknown")}AI ${ai?.status === "ok" ? "connected" : esc(STATE_WORD[ai?.status] || "…")}</span>`,
      `<span>${stDot(online ? "ok" : "error")}Network ${online ? "online" : "offline"}</span>`,
      `<span>${stDot(issues == null ? "unknown" : issues ? "warn" : "ok")}Systems ${issues == null ? "…" : issues ? `${issues} to check` : "nominal"}</span>`,
    ].join("");
  }
  function renderClocks() {
    const places = (st.world || []).filter((p) => !p.home).slice(0, 4);
    $("#gocClocks", root).innerHTML = [[`Local`, tz, true], ["UTC", "UTC"], ...places.map((p) => [p.name.split(",")[0], p.timezone])].map(([n, z, loc]) =>
      `<div class="goc-clock"><span>${esc(n)}</span><b>${esc(nowIn(z, { hour: "2-digit", minute: "2-digit", second: loc ? "2-digit" : undefined }))}</b>${loc ? `<i>${esc(nowIn(z, { weekday: "short", day: "numeric", month: "short" }))}</i>` : ""}</div>`).join("");
  }

  // ------------------------------------------------------------ Bottom panels
  function renderBottom(k) {
    const el2 = box(k); if (!el2) return;
    if (k === "flights") {
      const F = st.flights, P = st.status?.flights?.providers;
      el2.innerHTML = !st.layers.flights ? '<p class="goc-muted">Aircraft layer hidden.</p>' : `<dl class="goc-kv tight">
        <div><dt>In view</dt><dd>${F ? fmtN(filteredAircraft().length) : "—"}${F?.truncated ? " (capped)" : ""}</dd></div>
        <div><dt>Source</dt><dd>${esc(F?.attribution?.name || (st.flightErr ? "unavailable" : "—"))}</dd></div>
        <div><dt>Updated</dt><dd>${st.flightsAt ? `${Math.round((Date.now() - st.flightsAt) / 1000 + (F?.ageSec || 0))} s ago` : "—"} · next ${st.nextFlightT ? `${Math.max(0, Math.round((st.nextFlightT - Date.now()) / 1000))} s` : "—"}</dd></div>
        <div><dt>Stale / hidden</dt><dd>${F ? `${F.counts.stale} stale · ${F.counts.hiddenPrivacy} privacy` : "—"}</dd></div>
        <div><dt>Allowance</dt><dd>${P ? ["adsb", "opensky"].map((k) => `${k === "adsb" ? "ADSB.lol" : "OpenSky"} ${P[k].remaining != null ? `${fmtN(P[k].remaining)}/${fmtN(P[k].limit)} left` : "not used yet"}`).join(" · ") : "—"}</dd></div>
      </dl>${st.flightErr ? `<p class="goc-warnline">${esc(st.flightErr)}</p>` : ""}`;
    } else if (k === "imagery") {
      const s = st.status;
      el2.innerHTML = `<dl class="goc-kv tight"><div><dt>Base map</dt><dd>${esc(layerInfo[st.base]?.name || st.base)}</dd></div>
        <div><dt>Imagery date</dt><dd>${st.base === "today" ? esc(new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10)) + " (NASA GIBS)" : st.base === "satellite" ? "2023 composite" : "—"}</dd></div>
        <div><dt>Tile cache</dt><dd>${s?.tiles ? `${fmtN(s.tiles.hits)} hits · ${fmtN(s.tiles.misses)} fetched · ${s.tiles.errors} errors` : "—"}</dd></div>
        <div><dt>Radar frame</dt><dd>${s?.radarFrame ? esc(hhmm(s.radarFrame, tz)) : "unavailable"}</dd></div></dl>${tileErrors.n ? `<p class="goc-warnline">${tileErrors.n} tiles failed to load (${esc(tileErrors.last)})</p>` : ""}`;
    } else if (k === "events") {
      const items = filteredEvents(), by = {};
      for (const e of items) by[e.category] = (by[e.category] || 0) + 1;
      const max = Math.max(1, ...Object.values(by));
      el2.innerHTML = st.events ? `<div class="goc-bars">${Object.entries(st.events.categories).map(([c, n]) => `<div><span>${esc(n)}</span><i style="--w:${((by[c] || 0) / max) * 100}%;--c:${CAT_COLOR[c]}"></i><b>${by[c] || 0}</b></div>`).join("")}</div>` : `<p class="goc-muted">${esc(st.eventsErr || "Retrieving…")}</p>`;
    } else if (k === "timeline") {
      el2.innerHTML = `<div class="goc-spark"><span>CPU</span>${spark(st.series.cpu, 100)}</div><div class="goc-spark"><span>RAM</span>${spark(st.series.ram, 100)}</div><div class="goc-spark"><span>Server lag</span>${spark(st.series.lag)}</div>`;
    } else if (k === "network") {
      const n = st.diag?.checks?.find((c) => c.name === "network"), cl = st.diag?.checks?.find((c) => c.name === "clients");
      el2.innerHTML = `<dl class="goc-kv tight"><div><dt>Live link</dt><dd>${stDot(sync.status.online ? "ok" : "error")}${sync.status.online ? `up${sync.status.since ? ` · ${esc(ago(new Date(sync.status.since).toISOString()))}` : ""}` : "down"}</dd></div>
        <div><dt>Internet</dt><dd>${n ? `${stDot(n.status)}${esc(n.detail)}` : "—"}</dd></div><div><dt>Devices</dt><dd>${cl ? esc(cl.detail) : "—"}</dd></div></dl>`;
    } else if (k === "ops") {
      el2.innerHTML = st.activity?.length ? `<ol class="goc-ops">${st.activity.slice(0, 6).map((a) => `<li><span>${esc(ago(a.at || a.created_at))}</span>${esc(a.summary || a.text || a.kind || "")}</li>`).join("")}</ol>` : '<p class="goc-muted">No recent operations.</p>';
    }
  }
  function renderLegend() {
    const parts = [];
    if (st.layers.flights) parts.push(`<span class="goc-lg"><i style="background:#5fb3b3"></i>&lt;10k ft</span><span class="goc-lg"><i style="background:#7aa2d6"></i>10–25k</span><span class="goc-lg"><i style="background:#dfe8f2"></i>&gt;25k</span><span class="goc-lg"><i style="background:#6b7785"></i>ground</span>`);
    if (st.layers.events || st.layers.conflict) parts.push(`<span class="goc-lg"><i class="ring"></i>approximate location</span><span class="goc-lg"><i class="solid"></i>reported site</span>`);
    $("#gocLegend", root).innerHTML = parts.join("");
  }
  function hint() {
    const z = map.getZoom();
    $("#gocMapHint", root).textContent = st.layers.flights && z < 4 && (st.flights?.list?.length || 0) > 400 ? "Aircraft grouped — zoom in to see individual flights" : "";
  }

  // ------------------------------------------------------------ 3D view (the World Explorer globe)
  async function toggle3d(on = !st.view3d) {
    st.view3d = on;
    $("#goc3d", root).setAttribute("aria-pressed", String(on));
    $("#gocGlobe", root).hidden = !on; $("#gocMap", root).style.visibility = on ? "hidden" : ""; cv.style.visibility = on ? "hidden" : "";
    if (on && !st.globe) {
      try {
        const { mountGlobe } = await import("./views/world.js");
        const gEl = $("#gocGlobe", root);
        st.globe = await mountGlobe($("canvas", gEl), $(".goc-globe-labels", gEl), ctx.settings.appearance?.animation, mq);
        if (!st.world) st.world = await api("/api/world").catch(() => []);
        st.globe.setPlaces(st.world || []);
        st.globe.setPoints(visibleEvents().map((e) => ({ lat: e.lat, lon: e.lon, color: CAT_COLOR[e.category] })));
        const c = map.getCenter(); st.globe.flyTo(c.lat, c.lng);
      } catch (e) { toast(`The 3D view isn't available here: ${e.message}`); st.view3d = false; $("#gocGlobe", root).hidden = true; $("#gocMap", root).style.visibility = ""; cv.style.visibility = ""; }
    } else if (!on && st.globe) { st.globe.destroy(); st.globe = null; draw(); }
  }

  // ------------------------------------------------------------ Controls
  $("#gocLayersBtn", root).onclick = () => { const p = $("#gocLayers", root); p.hidden = !p.hidden; $("#gocLayersBtn", root).setAttribute("aria-expanded", String(!p.hidden)); };
  $$('input[name="gocBase"]', root).forEach((r) => r.onchange = () => r.checked && setBase(r.value));
  $$("[data-ov]", root).forEach((c) => c.onchange = () => setOverlay(c.dataset.ov, c.checked));
  $("#gocRegion", root).onchange = (ev) => goRegion(ev.target.value);
  $("#gocWorld", root).onclick = () => goRegion("world");
  $("#goc3d", root).onclick = () => toggle3d();

  // ------------------------------------------------------------ Data loops
  async function loadStatus() { try { st.status = await api("/api/globalops/status"); layerInfo = st.status.layers || layerInfo; $("#gocLayerNote", root).textContent = layerInfo[st.base]?.terms ? `${layerInfo[st.base].name}: ${layerInfo[st.base].terms}.` : ""; } catch {} renderSys(); renderBottom("imagery"); renderBottom("flights"); }
  async function loadDiag() { try { st.diag = await api("/api/diagnostics"); } catch {} renderSys(); renderBottom("network"); }
  async function loadPerf() {
    try { st.perf = await api("/api/performance"); const push = (k, v) => { if (v == null) return; const s = st.series[k]; s.push(v); if (s.length > SERIES_MAX) s.shift(); }; push("cpu", st.perf.cpuPct); push("ram", st.perf.ramPct); push("lag", (st.perf.lagMs || 0) + (st.perf.dbMs || 0)); } catch {}
    renderSys(); renderBottom("timeline");
  }
  async function loadActivity() { try { st.activity = await api("/api/activity?limit=8"); } catch {} renderBottom("ops"); }
  const slow = ctx.settings.appearance?.updates === "reduced" ? 2 : 1;
  const every = (ms, fn) => timers.push(setInterval(() => { if (document.visibilityState !== "hidden" && !st.destroyed) fn(); }, ms * slow));
  every(1000, () => { renderClocks(); if (st.layers.flights) renderBottom("flights"); });
  every(5000, loadPerf); every(30_000, loadDiag); every(30_000, loadStatus); every(120_000, loadEvents); every(60_000, loadActivity);
  offs.push(core.on(() => renderSys()));
  offs.push(sync.on?.("status", () => { renderSys(); renderBottom("network"); }) || (() => {}));

  // ------------------------------------------------------------ Modes and startup
  function setMode(m) {
    if (!MODE_DEFAULTS[m]) return;
    st.mode = m; root.dataset.mode = m;
    for (const [k, v] of Object.entries(MODE_DEFAULTS[m])) if (st.layers[k] !== v) setOverlay(k, v);
    if (m === "world") { $("#gocLayers", root).hidden = false; $("#gocLayersBtn", root).setAttribute("aria-expanded", "true"); }
    renderRight(); draw(); renderLegend();
    requestAnimationFrame(() => { map.invalidateSize({ pan: false }); sizeCanvas(); draw(); });
  }
  await loadStatus();
  setBase("dark");
  for (const [k] of OVERLAYS) { const cb = $(`[data-ov="${k}"]`, root); if (cb) cb.checked = !!st.layers[k]; }
  if (st.layers.boundaries) loadBoundaries();
  renderClocks(); renderSys(); renderRight(); renderLegend();
  const ready = Promise.allSettled([
    api("/api/world").then((w) => { st.world = w; renderClocks(); }),
    loadDiag(), loadPerf(), loadActivity(), loadEvents(),
    st.layers.flights ? pollFlights(true) : Promise.resolve(),
  ]).then(() => ({ flights: st.firstFlights, events: st.firstEvents }));

  return {
    root, map, ready,
    get coreHost() { return $(".goc-core-host", root); },
    setMode,
    info: () => ({ mode: st.mode, layers: { ...st.layers }, base: st.base, aircraft: st.flights?.list?.length ?? null, events: st.events?.total ?? null, selected: st.selected?.hex || null, flightSource: st.flights?.attribution?.name || null, flightError: st.flightErr, view3d: st.view3d, center: map.getCenter(), zoom: map.getZoom() }),
    /** Voice / AI commands. Each answers only from data actually retrieved. */
    async command(c) {
      if (c.action === "flights_show" || c.action === "flights_hide") { setOverlay("flights", c.action === "flights_show"); return { ok: true }; }
      if (c.action === "flights_world") { if (!st.layers.flights) setOverlay("flights", true); goRegion("world"); await pollFlights(true); return { ok: true, aircraft: st.flights?.list?.length ?? 0, source: st.flights?.attribution?.name, error: st.flightErr }; }
      if (c.action === "flights_area" || c.action === "region") {
        if (c.region && REGIONS[c.region]) goRegion(c.region);
        else if (c.lat != null) { const nm = c.nm || 120, dLat = nm / 60, dLon = nm / (60 * Math.max(0.2, Math.cos(c.lat * Math.PI / 180))); if (st.view3d) toggle3d(false); map.fitBounds([[c.lat - dLat, c.lon - dLon], [c.lat + dLat, c.lon + dLon]], { animate: !reducedMotion() }); }
        if (c.action === "flights_area") { if (!st.layers.flights) setOverlay("flights", true); await pollFlights(true); return { ok: !st.flightErr, aircraft: filteredAircraft().length, source: st.flights?.attribution?.name, error: st.flightErr }; }
        return { ok: true };
      }
      if (c.action === "flights_find") return findFlight(c.query);
      if (c.action === "select") return selectAircraft(c.hex, { follow: !!c.follow });
      if (c.action === "nearest") {
        if (!st.layers.flights) setOverlay("flights", true);
        if (!st.flights) await pollFlights(true);
        const ctr = c.lat != null ? { lat: c.lat, lng: c.lon } : map.getCenter();
        const list = filteredAircraft().filter((a) => !a.ground);
        if (!list.length) return { ok: false, error: st.flightErr || "No aircraft are visible in this view." };
        let best = null, bd = 1e9; for (const a of list) { const d = (a.lat - ctr.lat) ** 2 + ((a.lon - ctr.lng) * Math.cos(ctr.lat * Math.PI / 180)) ** 2; if (d < bd) { bd = d; best = a; } }
        await selectAircraft(best.hex);
        return { ok: true, aircraft: best };
      }
      if (c.action === "layer") { if (c.base) { const r = $(`input[name="gocBase"][value="${c.base}"]`, root); if (r) { r.checked = true; setBase(c.base); } } if (c.layer) { if (c.layer === "3d") await toggle3d(c.on !== false); else setOverlay(c.layer, c.on !== false); } return { ok: true }; }
      if (c.action === "events") { if (c.category) st.evFilter.cats = new Set([c.category]); if (c.country != null) st.evFilter.country = c.country; if (st.mode !== "events" && st.mode !== "globalops") setMode("events"); renderRight(); draw(); return { ok: true, count: filteredEvents().length }; }
      return { ok: false, error: "unknown command" };
    },
    destroy() {
      st.destroyed = true;
      timers.forEach(clearInterval); clearTimeout(flightT); offs.forEach((f) => f?.());
      ro.disconnect(); st.globe?.destroy(); map.remove(); el.innerHTML = "";
      delete window.__jarvisGoc; delete window.__jarvisGocRedraw;
    },
  };
}
