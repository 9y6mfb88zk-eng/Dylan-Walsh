// Map tiles for Global Operations, fetched through JARVIS so they can be cached on disk and the providers' usage rules
// enforced in one place (identifying User-Agent, zoom limits, cache lifetimes, a polite number of parallel requests).
// Only free sources whose terms allow this personal, non-commercial use. Attribution for each is shown on the map.
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const UA = "JARVIS-personal-assistant/6.6 (non-commercial; single user; tile cache)";
const day = 86400;
const yesterday = () => new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10);   // GIBS daily imagery is complete ~a day later
export const LAYERS = {
  // OpenStreetMap's standard tiles, darkened in the browser (CARTO's dark tiles now need an account key).
  dark: { name: "Standard (dark)", url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, max: 18, ttl: 7 * day, ext: "png", base: true, shared: "osm",
    attribution: "© OpenStreetMap contributors", terms: "OSMF tile usage policy: cached ≥7 days, no bulk downloads; shown darkened" },
  osm: { name: "OpenStreetMap", url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, max: 18, ttl: 7 * day, ext: "png", base: true,
    attribution: "© OpenStreetMap contributors", terms: "OSMF tile usage policy: cached ≥7 days, no bulk downloads" },
  terrain: { name: "Terrain", url: (z, x, y) => `https://a.tile.opentopomap.org/${z}/${x}/${y}.png`, max: 17, ttl: 14 * day, ext: "png", base: true,
    attribution: "© OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)", terms: "OpenTopoMap: free with attribution, fair use" },
  satellite: { name: "Satellite (Sentinel-2 cloudless)", url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/${z}/${y}/${x}.jpg`, max: 15, ttl: 30 * day, ext: "jpg", base: true,
    attribution: "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2023)", terms: "CC BY-NC-SA 4.0: non-commercial use with attribution" },
  today: { name: "Satellite (NASA, latest day)", url: (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${yesterday()}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`, max: 9, ttl: day, ext: "jpg", base: true, dated: true,
    attribution: "Imagery: NASA EOSDIS GIBS / Worldview (MODIS Terra)", terms: "NASA imagery: no restrictions, attribution requested" },
  relief: { name: "Relief (NASA Blue Marble)", url: (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`, max: 8, ttl: 90 * day, ext: "jpg", base: true,
    attribution: "Imagery: NASA Blue Marble, GIBS", terms: "NASA imagery: no restrictions, attribution requested" },
  radar: { name: "Weather radar", url: null, max: 7, ttl: day, ext: "png",
    attribution: "Weather data by RainViewer", terms: "RainViewer: free for personal use with attribution; cache responses" },
};
const DIR = () => path.join(config.dataDir, "tiles");
const CAP = Number(process.env.JARVIS_TILE_CACHE_MB || 400) * 1024 * 1024;
const inflight = new Map();
let active = 0; const queue = [];
const slot = () => new Promise((r) => { if (active < 6) { active++; r(); } else queue.push(r); });
const release = () => { const n = queue.shift(); if (n) n(); else active--; };
const stats = { hits: 0, misses: 0, errors: 0, lastError: null, bytesWritten: 0 };

// RainViewer publishes a new radar frame every 10 minutes; tile URLs carry the frame's path.
let radar = { at: 0, host: null, path: null, time: null };
export async function radarFrame() {
  if (Date.now() - radar.at < 5 * 60_000 && radar.path) return radar;
  const r = await fetch(process.env.RAINVIEWER_URL || "https://api.rainviewer.com/public/weather-maps.json", { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`RainViewer HTTP ${r.status}`);
  const j = await r.json();
  const f = j.radar?.past?.at(-1);
  if (!f) throw new Error("RainViewer has no radar frame right now");
  radar = { at: Date.now(), host: j.host, path: f.path, time: new Date(f.time * 1000).toISOString() };
  return radar;
}

/** Returns { file, type } for a tile, from the disk cache or the provider. */
export async function tile(layer, z, x, y) {
  const L = LAYERS[layer];
  if (!L) throw Object.assign(new Error("Unknown map layer"), { status: 404 });
  [z, x, y] = [z, x, y].map((n) => Number.parseInt(n, 10));
  const n = 2 ** z;
  if (!(z >= 0 && z <= L.max && x >= 0 && x < n && y >= 0 && y < n)) throw Object.assign(new Error("Tile out of range"), { status: 404 });
  let url = process.env.TILES_TEST_URL ? `${process.env.TILES_TEST_URL}/${layer}/${z}/${x}/${y}` : L.url && L.url(z, x, y), key = `${L.shared || layer}/${z}/${x}/${y}`;
  if (layer === "radar") { const f = await radarFrame(); url = `${f.host}${f.path}/256/${z}/${x}/${y}/2/1_1.png`; key = `radar${f.path.replace(/[^\w]/g, "_")}/${z}/${x}/${y}`; }
  else if (L.dated) key = `${layer}-${yesterday()}/${z}/${x}/${y}`;
  const file = path.join(DIR(), `${key}.${L.ext}`);
  const type = L.ext === "png" ? "image/png" : "image/jpeg";
  try { const st = fs.statSync(file); if (Date.now() - st.mtimeMs < L.ttl * 1000) { stats.hits++; return { file, type }; } } catch {}
  if (inflight.has(file)) return inflight.get(file);
  const p = (async () => {
    await slot();
    try {
      stats.misses++;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
      let r;
      try { r = await fetch(url, { headers: { "user-agent": UA }, signal: ctl.signal }); }
      finally { clearTimeout(t); }
      if (!r.ok) throw Object.assign(new Error(`${L.name}: HTTP ${r.status}`), { status: r.status === 404 ? 404 : 502 });
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      stats.bytesWritten += buf.length;
      if (stats.bytesWritten > 20 * 1024 * 1024) { stats.bytesWritten = 0; setTimeout(prune, 1000); }
      return { file, type };
    } catch (e) {
      stats.errors++; stats.lastError = `${new Date().toISOString()} ${e.message}`;
      // An old cached copy is better than nothing when the provider is unreachable.
      if (fs.existsSync(file)) return { file, type, stale: true };
      throw Object.assign(e, { status: e.status || 502 });
    } finally { release(); inflight.delete(file); }
  })();
  inflight.set(file, p);
  return p;
}

/** Keep the cache under its size cap by deleting the least recently written tiles. */
export function prune() {
  const files = [];
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { try { const s = fs.statSync(f); files.push([f, s.size, s.mtimeMs]); } catch {} } } };
  walk(DIR());
  let total = files.reduce((a, f) => a + f[1], 0);
  const before = total;
  if (total > CAP) { files.sort((a, b) => a[2] - b[2]); for (const [f, size] of files) { if (total <= CAP * 0.85) break; try { fs.unlinkSync(f); total -= size; } catch {} } }
  return { files: files.length, mb: +(before / 1048576).toFixed(1), afterMb: +(total / 1048576).toFixed(1) };
}
export function tileStatus() { return { ...stats, capMb: CAP / 1048576, radar: radar.time ? { frame: radar.time } : null }; }
export function layerInfo() { return Object.fromEntries(Object.entries(LAYERS).map(([k, l]) => [k, { name: l.name, max: l.max, base: !!l.base, attribution: l.attribution, terms: l.terms }])); }
