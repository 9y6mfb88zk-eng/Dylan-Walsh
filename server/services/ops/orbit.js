// Operation Orbit: public orbital elements, space weather and launch schedules. Free sources only.
//
//   CelesTrak GP data (OMM JSON). CelesTrak updates every 2 hours and blocks clients that download more often, so
//            every query is cached on disk for at least 2 hours and never fetched in the background.
//   NOAA SWPC (public domain, no key): planetary K index, GOES X-ray flares, space weather alerts.
//   NASA DONKI notifications (api.nasa.gov; DEMO_KEY allows ~10 requests/hour, a free key 1,000/hour). Cached 3 hours.
//   Launch Library 2 (The Space Devs): free for 15 requests/hour without a key. Cached 30 minutes.
// Satellite positions are CALCULATED from the orbital elements (SGP4), not observed; everything says so.
import fs from "node:fs";
import path from "node:path";
import * as satellite from "satellite.js";
import { config } from "../../config.js";
import { getKey } from "../globalops-keys.js";

const UA = "JARVIS-personal-assistant/6.6 (non-commercial; single user)";
const URL_ = {
  celestrak: () => process.env.CELESTRAK_URL || "https://celestrak.org/NORAD/elements/gp.php",
  swpc: () => (process.env.SWPC_URL || "https://services.swpc.noaa.gov").replace(/\/$/, ""),
  nasa: () => (process.env.NASA_API_URL || "https://api.nasa.gov").replace(/\/$/, ""),
  ll2: () => (process.env.LL2_URL || "https://ll.thespacedevs.com/2.3.0").replace(/\/$/, ""),
};
export const GROUPS = {
  stations: "Space stations", visual: "Brightest (visible to the eye)", science: "Science", weather: "Weather", "gps-ops": "GPS", galileo: "Galileo",
  geo: "Geostationary", amateur: "Amateur radio", noaa: "NOAA", resource: "Earth resources", starlink: "Starlink (very large)",
};
const MIN_AGE = 2 * 3600_000;
const dir = () => { const d = path.join(config.dataDir, "cache", "celestrak"); fs.mkdirSync(d, { recursive: true }); return d; };
const status = { celestrak: { lastOkAt: null, lastError: null }, swpc: { lastOkAt: null, lastError: null }, donki: { lastOkAt: null, lastError: null }, ll2: { lastOkAt: null, lastError: null } };
const mem = new Map();

async function getJson(url, headers = {}, timeoutMs = 25000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal: ctl.signal });
    const text = await r.text();
    if (r.status === 429) throw Object.assign(new Error("rate limited by the provider"), { status: 429 });
    if (!r.ok) throw new Error(`HTTP ${r.status}${text.length < 160 ? `: ${text.replace(/<[^>]+>/g, "").trim()}` : ""}`);
    try { return { json: JSON.parse(text), headers: r.headers }; } catch { throw new Error(`unexpected reply: ${text.slice(0, 100)}`); }
  } catch (e) { throw new Error(e.name === "AbortError" ? "timed out" : e.message); }
  finally { clearTimeout(t); }
}
/** Cached fetch: memory, then disk, then network (at most once per minAgeMs per key). Stale copies are used on failure. */
async function cached(key, minAgeMs, fetcher, src) {
  const file = path.join(dir(), `${key.replace(/[^\w.-]/g, "_")}.json`);
  let c = mem.get(key);
  if (!c) { try { c = JSON.parse(fs.readFileSync(file, "utf8")); mem.set(key, c); } catch {} }
  if (c && Date.now() - Date.parse(c.fetchedAt) < minAgeMs) return { ...c, cache: "fresh" };
  try {
    const data = await fetcher();
    c = { data, fetchedAt: new Date().toISOString() };
    mem.set(key, c);
    try { fs.writeFileSync(file, JSON.stringify(c)); } catch {}
    Object.assign(status[src], { lastOkAt: c.fetchedAt, lastError: null });
    return { ...c, cache: "new" };
  } catch (e) {
    status[src].lastError = `${new Date().toISOString().slice(11, 16)} UTC ${e.message}`;
    if (c) return { ...c, cache: "stale", error: e.message };
    throw e;
  }
}
const slim = (o) => ({ OBJECT_NAME: o.OBJECT_NAME, OBJECT_ID: o.OBJECT_ID, NORAD_CAT_ID: o.NORAD_CAT_ID, EPOCH: o.EPOCH, MEAN_MOTION: o.MEAN_MOTION, ECCENTRICITY: o.ECCENTRICITY, INCLINATION: o.INCLINATION,
  RA_OF_ASC_NODE: o.RA_OF_ASC_NODE, ARG_OF_PERICENTER: o.ARG_OF_PERICENTER, MEAN_ANOMALY: o.MEAN_ANOMALY, BSTAR: o.BSTAR, MEAN_MOTION_DOT: o.MEAN_MOTION_DOT, MEAN_MOTION_DDOT: o.MEAN_MOTION_DDOT,
  EPHEMERIS_TYPE: o.EPHEMERIS_TYPE, CLASSIFICATION_TYPE: o.CLASSIFICATION_TYPE, ELEMENT_SET_NO: o.ELEMENT_SET_NO, REV_AT_EPOCH: o.REV_AT_EPOCH });
const celestrak = async (q) => { const { json } = await getJson(`${URL_.celestrak()}?${q}&FORMAT=json`, {}, 60000); if (!Array.isArray(json)) throw new Error("CelesTrak returned no element sets"); return json.map(slim); };

export async function group(g) {
  if (!GROUPS[g]) throw Object.assign(new Error("Unknown satellite group"), { status: 400 });
  const r = await cached(`group-${g}`, MIN_AGE, () => celestrak(`GROUP=${encodeURIComponent(g)}`), "celestrak");
  return { group: g, name: GROUPS[g], elements: r.data, fetchedAt: r.fetchedAt, cache: r.cache, error: r.error || null, source: SOURCE.celestrak };
}
export async function search(q) {
  const s = String(q || "").trim();
  if (!s || s.length > 40) throw Object.assign(new Error("Search with a satellite name or NORAD catalogue number"), { status: 400 });
  const query = /^\d{1,9}$/.test(s) ? `CATNR=${s}` : `NAME=${encodeURIComponent(s)}`;
  const r = await cached(`q-${query.toLowerCase()}`, MIN_AGE, () => celestrak(query).catch((e) => { if (/No GP data found/i.test(e.message)) return []; throw e; }), "celestrak");
  return { query: s, elements: r.data.slice(0, 50), total: r.data.length, fetchedAt: r.fetchedAt, cache: r.cache, error: r.error || null, source: SOURCE.celestrak };
}

/** Derived orbit facts and a calculated position for one OMM element set (server-side, for reports and voice). */
export function describe(omm, at = new Date()) {
  const rec = satellite.json2satrec(omm);
  const pv = satellite.propagate(rec, at);
  const n = omm.MEAN_MOTION, e = omm.ECCENTRICITY, mu = 398600.4418, Re = 6378.137;
  const a = Math.cbrt(mu / ((n * 2 * Math.PI) / 86400) ** 2);
  const out = { name: omm.OBJECT_NAME, norad: omm.NORAD_CAT_ID, intlDesignator: omm.OBJECT_ID, epoch: `${omm.EPOCH}Z`.replace(/ZZ$/, "Z"), epochAgeHours: Math.round((at - Date.parse(`${omm.EPOCH}Z`)) / 360_000) / 10,
    inclinationDeg: omm.INCLINATION, periodMin: +(1440 / n).toFixed(1), apogeeKm: Math.round(a * (1 + e) - Re), perigeeKm: Math.round(a * (1 - e) - Re), eccentricity: e };
  if (pv && pv.position && typeof pv.position === "object") {
    const gmst = satellite.gstime(at), g = satellite.eciToGeodetic(pv.position, gmst);
    const v = pv.velocity;
    out.position = { at: at.toISOString(), lat: +satellite.degreesLat(g.latitude).toFixed(3), lon: +satellite.degreesLong(g.longitude).toFixed(3), altKm: Math.round(g.height), speedKms: +Math.hypot(v.x, v.y, v.z).toFixed(2), kind: "calculated (SGP4 from published orbital elements)" };
  } else out.position = null;
  return out;
}
export async function iss() {
  const r = await search("25544");
  const omm = r.elements.find((x) => x.NORAD_CAT_ID === 25544);
  if (!omm) throw new Error("ISS elements not available");
  return { ...describe(omm), fetchedAt: r.fetchedAt, source: SOURCE.celestrak };
}

// ---------------------------------------------------------------- Space weather
export async function spaceWeather() {
  const out = { retrievedAt: new Date().toISOString(), sources: [SOURCE.swpc], errors: [] };
  try {
    const kp = await cached("swpc-kp", 15 * 60_000, async () => (await getJson(`${URL_.swpc()}/products/noaa-planetary-k-index.json`)).json, "swpc");
    const rows = Array.isArray(kp.data[0]) ? kp.data.slice(1).map((r) => ({ time: r[0], kp: +r[1] })) : kp.data.map((r) => ({ time: r.time_tag, kp: +r.Kp }));
    const last = rows.at(-1);
    out.kp = { latest: last?.kp ?? null, time: last ? `${last.time.replace(" ", "T")}Z`.replace(/ZZ$/, "Z") : null, series: rows.slice(-24), storm: last?.kp >= 5 ? `G${Math.min(5, Math.floor(last.kp) - 4)} geomagnetic storm` : "below storm level (Kp < 5)", fetchedAt: kp.fetchedAt, url: "https://www.swpc.noaa.gov/products/planetary-k-index" };
  } catch (e) { out.errors.push(`Kp index: ${e.message}`); }
  try {
    const fl = await cached("swpc-flares", 15 * 60_000, async () => (await getJson(`${URL_.swpc()}/json/goes/primary/xray-flares-latest.json`)).json, "swpc");
    const f = fl.data[0];
    out.flare = f ? { currentClass: f.current_class, latestFlare: f.max_class ? { class: f.max_class, begin: f.begin_time, peak: f.max_time, end: f.end_time } : null, fetchedAt: fl.fetchedAt, url: "https://www.swpc.noaa.gov/products/goes-x-ray-flux" } : null;
  } catch (e) { out.errors.push(`X-ray flares: ${e.message}`); }
  try {
    const al = await cached("swpc-alerts", 15 * 60_000, async () => (await getJson(`${URL_.swpc()}/products/alerts.json`)).json, "swpc");
    out.alerts = (al.data || []).slice(0, 8).map((a) => ({ issued: `${String(a.issue_datetime).replace(" ", "T").slice(0, 19)}Z`, code: a.product_id, text: String(a.message || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6).join(" · ").slice(0, 320) }));
    out.alertsFetchedAt = al.fetchedAt;
  } catch (e) { out.errors.push(`SWPC alerts: ${e.message}`); }
  try {
    const key = getKey("nasaKey") || "DEMO_KEY";
    const end = new Date(), start = new Date(Date.now() - 7 * 86400_000);
    const dn = await cached("donki-notifications", 3 * 3600_000, async () => (await getJson(`${URL_.nasa()}/DONKI/notifications?startDate=${start.toISOString().slice(0, 10)}&endDate=${end.toISOString().slice(0, 10)}&type=all&api_key=${encodeURIComponent(key)}`)).json, "donki");
    out.donki = (dn.data || []).slice(0, 12).map((m) => ({ type: m.messageType, issued: m.messageIssueTime, url: m.messageURL, summary: (String(m.messageBody || "").match(/## Summary:\s*([\s\S]*?)(##|$)/)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 300) }));
    out.donkiFetchedAt = dn.fetchedAt; out.donkiKey = key === "DEMO_KEY" ? "DEMO_KEY (shared, ~10 requests/hour)" : "your free NASA key";
    out.sources.push(SOURCE.donki);
  } catch (e) { out.errors.push(`NASA DONKI: ${e.message}`); }
  return out;
}

// ---------------------------------------------------------------- Launches
export async function launches(limit = 10) {
  const r = await cached("ll2-upcoming", 30 * 60_000, async () => (await getJson(`${URL_.ll2()}/launches/upcoming/?limit=15&mode=normal`)).json, "ll2");
  const items = (r.data.results || []).slice(0, limit).map((l) => ({
    id: l.id, name: l.name, net: l.net, netPrecision: l.net_precision?.name || null, windowStart: l.window_start, windowEnd: l.window_end,
    status: l.status?.abbrev || null, statusName: l.status?.name || null, confirmed: l.status?.abbrev === "Go",
    provider: l.launch_service_provider?.name || null, rocket: l.rocket?.configuration?.full_name || l.rocket?.configuration?.name || null,
    mission: l.mission?.name || null, missionType: l.mission?.type || null, orbit: l.mission?.orbit?.name || null, description: l.mission?.description?.slice(0, 400) || null,
    pad: l.pad?.name || null, site: l.pad?.location?.name || null, lat: l.pad?.latitude != null ? +l.pad.latitude : null, lon: l.pad?.longitude != null ? +l.pad.longitude : null,
    url: l.url || null, infoUrls: (l.infoURLs || l.info_urls || []).slice(0, 2).map((u) => u.url || u), image: null,
  }));
  return { items, fetchedAt: r.fetchedAt, cache: r.cache, error: r.error || null, source: SOURCE.ll2 };
}

export const SOURCE = {
  celestrak: { name: "CelesTrak", url: "https://celestrak.org/", terms: "Free; data updates every 2 hours — JARVIS caches each query for at least 2 hours" },
  swpc: { name: "NOAA Space Weather Prediction Center", url: "https://www.swpc.noaa.gov/", terms: "US government, public domain" },
  donki: { name: "NASA DONKI (CCMC)", url: "https://ccmc.gsfc.nasa.gov/tools/DONKI/", terms: "NASA open data via api.nasa.gov" },
  ll2: { name: "Launch Library 2 (The Space Devs)", url: "https://thespacedevs.com/llapi", terms: "Free for 15 requests/hour; JARVIS caches 30 minutes" },
};
export function orbitStatus() { return { ...status, key: getKey("nasaKey") ? "NASA key set" : "DEMO_KEY" }; }
