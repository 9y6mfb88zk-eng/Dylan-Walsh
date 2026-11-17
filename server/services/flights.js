// Public civil flight tracking from free ADS-B sources, with the providers' own limits respected.
//
//   ADSB.lol   community-fed, ODbL. No key: 500 requests/day per IP (free key: 1,000). Point queries up to 250 nm.
//   OpenSky    non-commercial use. Anonymous: 400 API credits/day; a bounding box costs 1–4 credits (the whole
//              world 4). A free account (OAuth2 client credentials) gives 4,000.
//
// How the budget is spent:
//   • One request per map view, never one per aircraft. Views up to 250 nm across use ADSB.lol; wider views use
//     OpenSky's bounding-box query. A fresh wider result also serves any smaller view inside it.
//   • Results are cached; how long depends on how much of the day's allowance is left (read from the providers'
//     rate-limit headers), so the allowance lasts. A 429 or error backs off (Retry-After when given).
//   • Polling happens only while someone has the flight layer open; the server never polls on its own.
//
// Privacy and scope: this is public civil-aviation awareness. Aircraft that ADSB.lol flags as military, PIA
// (privacy ICAO address) or LADD (owner asked not to be displayed) are removed from every result, including OpenSky's,
// using ADSB.lol's own lists (refreshed every 6 hours, used only to hide those aircraft). There is no military
// filter, search or follow. Coverage depends on volunteer receivers: many aircraft are not visible.
import { kvGet, kvSet } from "../db.js";
import { getKey } from "./globalops-keys.js";

const ADSB = () => (process.env.ADSB_LOL_URL || "https://api.adsb.lol").replace(/\/$/, "");
const OPENSKY = () => (process.env.OPENSKY_URL || "https://opensky-network.org/api").replace(/\/$/, "");
const OPENSKY_AUTH = () => process.env.OPENSKY_AUTH_URL || "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const UA = "JARVIS-personal-assistant/6.5 (non-commercial; single user)";
export const FIELDS = ["hex", "callsign", "reg", "type", "lat", "lon", "alt", "gs", "track", "vs", "ground", "posAge", "cat", "src"];
export const ATTRIBUTION = {
  adsb: { name: "ADSB.lol", url: "https://www.adsb.lol/", licence: "ODbL 1.0", text: "Aircraft data © ADSB.lol contributors, ODbL" },
  opensky: { name: "OpenSky Network", url: "https://opensky-network.org/", licence: "non-commercial", text: "Aircraft data: The OpenSky Network, https://opensky-network.org" },
};
const MAX_POINT_NM = 250;
const STALE_SEC = 60, DROP_SEC = 300;

// ---------------------------------------------------------------- Provider state (budgets, backoff, health)
const P = {
  adsb: { limit: null, remaining: null, resetAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, backoffUntil: 0, fails: 0, requestsToday: 0, day: "" },
  opensky: { limit: null, remaining: null, resetAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, backoffUntil: 0, fails: 0, requestsToday: 0, day: "" },
};
Object.assign(P.adsb, kvGet("flights.adsb", {}), { backoffUntil: 0 });
Object.assign(P.opensky, kvGet("flights.opensky", {}), { backoffUntil: 0 });
const today = () => new Date().toISOString().slice(0, 10);
function count(p) { const d = today(); if (P[p].day !== d) { P[p].day = d; P[p].requestsToday = 0; } P[p].requestsToday++; }
function remaining(p) {
  const s = P[p];
  if (s.resetAt && Date.now() > s.resetAt) { s.remaining = s.limit; s.resetAt = null; }
  return s.remaining;
}
function available(p) { return Date.now() >= P[p].backoffUntil && (remaining(p) == null || remaining(p) > (p === "adsb" ? 15 : 4)); }
function ok(p) { P[p].lastOkAt = new Date().toISOString(); P[p].fails = 0; P[p].lastError = null; persist(p); }
function fail(p, msg, retryAfterSec) {
  const s = P[p];
  s.fails++; s.lastError = msg; s.lastErrorAt = new Date().toISOString();
  s.backoffUntil = Date.now() + 1000 * (retryAfterSec || Math.min(1800, 30 * 2 ** Math.min(s.fails - 1, 6)));
  persist(p);
}
const persist = (p) => { const { backoffUntil, ...rest } = P[p]; kvSet(`flights.${p}`, rest); };

/** Cache lifetime (seconds) for a provider's view query, from how much of today's allowance is left. */
function ttl(p, global = false) {
  const r = remaining(p);
  if (p === "adsb") return r == null || r > 300 ? 20 : r > 150 ? 45 : r > 60 ? 90 : 300;
  const keyed = !!openskyCreds();
  if (global) return r == null ? (keyed ? 60 : 180) : r > 2000 ? 60 : r > 200 ? 180 : r > 80 ? 300 : 900;
  return r == null ? (keyed ? 20 : 45) : r > 2000 ? 20 : r > 200 ? 45 : r > 80 ? 120 : 300;
}

async function get(url, headers = {}, timeoutMs = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal: ctl.signal }); }
  catch (e) { throw new Error(e.name === "AbortError" ? "timed out" : e.cause?.code || e.message); }
  finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- ADSB.lol
function adsbHeaders() { const k = getKey("adsbKey"); return k ? { "x-api-key": k } : {}; }
async function adsb(path) {
  if (Date.now() < P.adsb.backoffUntil) throw Object.assign(new Error(`ADSB.lol paused after errors until ${new Date(P.adsb.backoffUntil).toISOString().slice(11, 19)} UTC`), { code: "backoff" });
  count("adsb");
  let r;
  try { r = await get(`${ADSB()}${path}`, adsbHeaders()); } catch (e) { fail("adsb", e.message); throw e; }
  const lim = r.headers.get("x-ratelimit-limit"), rem = r.headers.get("x-ratelimit-remaining"), reset = r.headers.get("x-ratelimit-reset");
  if (lim) P.adsb.limit = parseInt(lim, 10);
  if (rem != null) P.adsb.remaining = parseInt(rem, 10);
  if (reset) P.adsb.resetAt = Date.now() + parseInt(reset, 10) * 1000;
  if (r.status === 429) { P.adsb.remaining = 0; fail("adsb", "daily request allowance used up", parseInt(r.headers.get("retry-after") || reset || "1800", 10)); throw new Error("ADSB.lol daily allowance used up"); }
  if (!r.ok) { fail("adsb", `HTTP ${r.status}`); throw new Error(`ADSB.lol answered HTTP ${r.status}`); }
  const j = await r.json();
  ok("adsb");
  return j;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function fromAdsb(a, now) {
  if (num(a.lat) == null || num(a.lon) == null) return null;
  const posAge = num(a.seen_pos) ?? num(a.seen) ?? 0;
  return {
    hex: String(a.hex || "").toLowerCase(), callsign: (a.flight || "").trim() || null, reg: a.r || null, type: a.t || null,
    lat: a.lat, lon: a.lon, alt: a.alt_baro === "ground" ? 0 : num(a.alt_baro) ?? num(a.alt_geom), gs: num(a.gs), track: num(a.track) ?? num(a.true_heading),
    vs: num(a.baro_rate) ?? num(a.geom_rate), ground: a.alt_baro === "ground", posAt: now - posAge * 1000, cat: a.category || null, src: "adsb",
    flags: a.dbFlags || 0, squawk: a.squawk || null, emergency: a.emergency && a.emergency !== "none" ? a.emergency : null, mlat: Array.isArray(a.mlat) && a.mlat.length > 0, srcType: a.type || null,
  };
}

// ---------------------------------------------------------------- OpenSky
let osToken = null;
function openskyCreds() { const id = getKey("openskyClientId"), secret = getKey("openskyClientSecret"); return id && secret ? { id, secret } : null; }
async function openskyAuth() {
  const c = openskyCreds(); if (!c) return {};
  if (osToken && osToken.exp > Date.now()) return { authorization: `Bearer ${osToken.token}` };
  const r = await fetch(OPENSKY_AUTH(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.id, client_secret: c.secret }) }).catch((e) => { throw new Error(`OpenSky sign-in failed: ${e.message}`); });
  if (!r.ok) throw new Error(`OpenSky sign-in failed (HTTP ${r.status}) — check the client ID and secret`);
  const j = await r.json();
  osToken = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 1800) - 60) * 1000 };
  return { authorization: `Bearer ${osToken.token}` };
}
async function opensky(path) {
  if (Date.now() < P.opensky.backoffUntil) throw Object.assign(new Error(`OpenSky paused until ${new Date(P.opensky.backoffUntil).toISOString().slice(11, 19)} UTC`), { code: "backoff" });
  count("opensky");
  let r;
  try { r = await get(`${OPENSKY()}${path}`, await openskyAuth(), 30000); } catch (e) { fail("opensky", e.message); throw e; }
  const rem = r.headers.get("x-rate-limit-remaining");
  if (rem != null) P.opensky.remaining = parseInt(rem, 10);
  P.opensky.limit = openskyCreds() ? 4000 : 400;
  if (r.status === 429) {
    const wait = parseInt(r.headers.get("x-rate-limit-retry-after-seconds") || "3600", 10);
    P.opensky.remaining = 0; P.opensky.resetAt = Date.now() + wait * 1000;
    fail("opensky", "daily API credits used up", wait); throw new Error("OpenSky daily credits used up");
  }
  if (r.status === 401 || r.status === 403) { osToken = null; fail("opensky", `refused (HTTP ${r.status})`); throw new Error(`OpenSky refused the request (HTTP ${r.status})`); }
  if (!r.ok) { fail("opensky", `HTTP ${r.status}`); throw new Error(`OpenSky answered HTTP ${r.status}`); }
  const j = await r.json();
  ok("opensky");
  return j;
}
function fromOpensky(s, now) {
  const [icao24, callsign, , timePos, lastContact, lon, lat, baroAlt, onGround, vel, track, vr, , geoAlt, squawk, , , cat] = s;
  if (num(lat) == null || num(lon) == null) return null;
  const posT = (timePos || lastContact || 0) * 1000;
  return {
    hex: String(icao24 || "").toLowerCase(), callsign: (callsign || "").trim() || null, reg: null, type: null, lat, lon,
    alt: onGround ? 0 : num(baroAlt) != null ? Math.round(baroAlt * 3.28084) : num(geoAlt) != null ? Math.round(geoAlt * 3.28084) : null,
    gs: num(vel) != null ? Math.round(vel * 1.94384 * 10) / 10 : null, track: num(track), vs: num(vr) != null ? Math.round(vr * 196.85) : null,
    ground: !!onGround, posAt: posT || now, cat: num(cat) ? `OS${cat}` : null, src: "opensky", flags: 0, squawk: squawk || null,
  };
}

// ---------------------------------------------------------------- Privacy exclusions (military, PIA, LADD)
const HIDE = { set: new Set(), loadedAt: 0, loading: null, partial: true };
const HIDE_FLAGS = 1 | 4 | 8;               // ADSB.lol dbFlags: 1 military, 4 PIA, 8 LADD
async function refreshExclusions() {
  if (HIDE.loading) return HIDE.loading;
  if (Date.now() - HIDE.loadedAt < 6 * 3600_000) return;
  if (!available("adsb")) return;
  HIDE.loading = (async () => {
    const next = new Set(); let okCount = 0;
    for (const list of ["mil", "pia", "ladd"]) {
      try { const j = await adsb(`/v2/${list}`); for (const a of j.ac || []) next.add(String(a.hex).toLowerCase()); okCount++; } catch {}
    }
    if (okCount) { HIDE.set = next; HIDE.loadedAt = Date.now(); HIDE.partial = okCount < 3; }
  })().finally(() => { HIDE.loading = null; });
  return HIDE.loading;
}
const visible = (a) => a && a.hex && !a.hex.startsWith("~") && !(a.flags & HIDE_FLAGS) && !HIDE.set.has(a.hex);

// ---------------------------------------------------------------- Trails (built from what this JARVIS has observed)
const TRAILS = new Map();
function remember(list) {
  for (const a of list) {
    let t = TRAILS.get(a.hex);
    if (!t) { t = []; TRAILS.set(a.hex, t); }
    const last = t[t.length - 1];
    if (!last || (a.posAt - last[0] > 8000 && (last[1] !== a.lat || last[2] !== a.lon))) { t.push([a.posAt, a.lat, a.lon, a.alt]); if (t.length > 240) t.shift(); }
  }
  if (TRAILS.size > 40000) for (const k of [...TRAILS.keys()].slice(0, 5000)) TRAILS.delete(k);
}
setInterval(() => { const cut = Date.now() - 3600_000; for (const [k, t] of TRAILS) { while (t.length && t[0][0] < cut) t.shift(); if (!t.length) TRAILS.delete(k); } }, 300_000).unref();
export function trail(hex) { return (TRAILS.get(String(hex).toLowerCase()) || []).map(([t, lat, lon, alt]) => ({ t: new Date(t).toISOString(), lat, lon, alt })); }

// ---------------------------------------------------------------- View queries
const CACHE = [];                  // { kind: "adsb"|"box"|"global", lat, lon, nm, box, at, ttl, list }
const LAST = new Map();            // hex → latest record seen anywhere (for details and search without a request)
const R_NM = 3440.065;
export function distNm(lat1, lon1, lat2, lon2) {
  const toR = Math.PI / 180, dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function normBox(b) {
  const lamin = Math.max(-85, Math.min(85, +b.lamin)), lamax = Math.max(-85, Math.min(85, +b.lamax));
  let lomin = +b.lomin, lomax = +b.lomax;
  if (![lamin, lamax, lomin, lomax].every(Number.isFinite) || lamax <= lamin) throw Object.assign(new Error("Invalid map area"), { status: 400 });
  if (lomax - lomin >= 360) { lomin = -180; lomax = 180; }
  lomin = Math.max(-180, lomin); lomax = Math.min(180, lomax);
  return { lamin, lamax, lomin, lomax };
}
const inBox = (a, b) => a.lat >= b.lamin && a.lat <= b.lamax && a.lon >= b.lomin && a.lon <= b.lomax;
const boxArea = (b) => (b.lamax - b.lamin) * (b.lomax - b.lomin);
function store(entry) {
  CACHE.push(entry); while (CACHE.length > 24) CACHE.shift();
  for (const a of entry.list) LAST.set(a.hex, a);
  if (LAST.size > 60000) for (const k of [...LAST.keys()].slice(0, 10000)) LAST.delete(k);
  remember(entry.list);
}
function fresh(e) { return Date.now() - e.at < e.ttl * 1000; }
function covering(box, centre, radiusNm) {
  // Small views prefer ADSB.lol (it adds aircraft type and registration) while its allowance is healthy;
  // otherwise a fresh wider OpenSky result is reused to save requests.
  const preferAdsb = radiusNm != null && available("adsb") && (remaining("adsb") == null || remaining("adsb") > 150);
  return CACHE.filter(fresh).reverse().find((e) =>
    (!preferAdsb && (e.kind === "global" || (e.kind === "box" && box.lamin >= e.box.lamin && box.lamax <= e.box.lamax && box.lomin >= e.box.lomin && box.lomax <= e.box.lomax)))
    || (e.kind === "adsb" && radiusNm != null && distNm(e.lat, e.lon, centre.lat, centre.lon) + radiusNm <= e.nm));
}
const inflight = new Map();
const once = (key, fn) => { if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key))); return inflight.get(key); };

/**
 * Aircraft in a map view. box: { lamin, lomin, lamax, lomax }. Returns compact rows plus provenance and honesty notes.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** The privacy lists must be in place before the first aircraft are shown (waits up to 6 s, once). */
async function exclusionsReady() {
  if (HIDE.loadedAt) { refreshExclusions().catch(() => {}); return; }
  await Promise.race([refreshExclusions().catch(() => {}), wait(6000)]);
}
export async function aircraftInView(rawBox, { limit = 6000 } = {}) {
  const box = normBox(rawBox);
  await exclusionsReady();
  const centre = { lat: (box.lamin + box.lamax) / 2, lon: (box.lomin + box.lomax) / 2 };
  const radiusNm = Math.max(distNm(centre.lat, centre.lon, box.lamax, box.lomax), distNm(centre.lat, centre.lon, box.lamin, box.lomin));
  const notes = [];
  let entry = covering(box, centre, radiusNm <= MAX_POINT_NM ? radiusNm : null), error = null;
  if (!entry) {
    try {
      if (radiusNm <= MAX_POINT_NM && available("adsb")) {
        const lat = Math.round(centre.lat * 4) / 4, lon = Math.round(centre.lon * 4) / 4;
        const nm = Math.min(MAX_POINT_NM, Math.ceil(radiusNm * 1.25 + distNm(lat, lon, centre.lat, centre.lon)));
        entry = await once(`a:${lat}:${lon}:${nm}`, async () => { const now = Date.now(); const j = await adsb(`/v2/point/${lat}/${lon}/${nm}`); const e = { kind: "adsb", lat, lon, nm, at: now, ttl: ttl("adsb"), list: (j.ac || []).map((a) => fromAdsb(a, j.now || now)).filter(Boolean), source: "adsb" }; store(e); return e; });
      } else if (available("opensky")) {
        const global = boxArea(box) > 2500;
        const q = global ? { lamin: -85, lamax: 85, lomin: -180, lomax: 180 } : { lamin: Math.floor(box.lamin), lamax: Math.ceil(box.lamax), lomin: Math.floor(box.lomin), lomax: Math.ceil(box.lomax) };
        entry = await once(`o:${JSON.stringify(q)}`, async () => {
          const now = Date.now();
          const j = await opensky(global ? "/states/all?extended=1" : `/states/all?extended=1&lamin=${q.lamin}&lomin=${q.lomin}&lamax=${q.lamax}&lomax=${q.lomax}`);
          const e = { kind: global ? "global" : "box", box: q, at: now, ttl: ttl("opensky", global), list: (j.states || []).map((s) => fromOpensky(s, (j.time || now / 1000) * 1000)).filter(Boolean), source: "opensky" };
          store(e); return e;
        });
      } else if (radiusNm <= MAX_POINT_NM) {
        error = P.adsb.lastError ? `ADSB.lol unavailable: ${P.adsb.lastError}` : "ADSB.lol allowance for today is used up";
      } else error = P.opensky.lastError ? `OpenSky unavailable: ${P.opensky.lastError}` : "OpenSky credits for today are used up";
    } catch (e) { error = e.message; }
  }
  if (!entry) {
    // Nothing fresh: offer the most recent data that covers the view, clearly marked as old.
    const old = CACHE.slice().reverse().find((e) => e.kind === "global" || (e.kind === "box" && box.lamin >= e.box.lamin && box.lamax <= e.box.lamax && box.lomin >= e.box.lomin && box.lomax <= e.box.lomax) || (e.kind === "adsb" && distNm(e.lat, e.lon, centre.lat, centre.lon) + Math.min(radiusNm, MAX_POINT_NM) <= e.nm));
    if (!old) return { ok: false, error: error || "No flight data provider is available right now.", aircraft: [], fields: FIELDS, providers: status().providers };
    entry = old; notes.push(`Showing data from ${Math.round((Date.now() - old.at) / 1000)} s ago: ${error}`);
  }
  const now = Date.now();
  const rows = [];
  let hidden = 0, dropped = 0, stale = 0;
  for (const a of entry.list) {
    if (!inBox(a, box)) continue;
    if (!visible(a)) { hidden++; continue; }
    const age = Math.round((now - a.posAt) / 1000);
    if (age > DROP_SEC) { dropped++; continue; }
    if (age > STALE_SEC) stale++;
    rows.push([a.hex, a.callsign, a.reg, a.type, +a.lat.toFixed(4), +a.lon.toFixed(4), a.alt, a.gs, a.track, a.vs, a.ground ? 1 : 0, age, a.cat, a.src]);
  }
  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;
  if (entry.source === "opensky" && HIDE.loadedAt === 0) notes.push("Privacy list not loaded yet, so OpenSky results can't be checked against military/LADD/PIA lists.");
  return {
    ok: true, source: entry.source, attribution: ATTRIBUTION[entry.source], fetchedAt: new Date(entry.at).toISOString(), ageSec: Math.round((now - entry.at) / 1000),
    nextUpdateSec: Math.max(0, Math.round(entry.ttl - (now - entry.at) / 1000)), ttlSec: entry.ttl, fields: FIELDS, aircraft: rows, truncated,
    counts: { shown: rows.length, stale, dropped, hiddenPrivacy: hidden }, notes, coverage: entry.kind === "adsb" ? { kind: "radius", lat: entry.lat, lon: entry.lon, nm: entry.nm } : { kind: entry.kind, box: entry.box },
  };
}

/** One aircraft: the latest record (re-fetched from ADSB.lol if it's old and the budget allows) and its observed trail. */
export async function aircraft(hex) {
  hex = String(hex || "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) throw Object.assign(new Error("Unknown aircraft identifier"), { status: 400 });
  await exclusionsReady();
  let a = LAST.get(hex), note = null;
  if (a && !visible(a)) return { ok: false, error: "This aircraft is not shown (privacy rules)." };
  if ((!a || Date.now() - a.posAt > 20000) && available("adsb")) {
    try { const j = await once(`h:${hex}`, () => adsb(`/v2/hex/${hex}`)); const f = (j.ac || []).map((x) => fromAdsb(x, j.now || Date.now())).find(Boolean); if (f) { a = f; store({ kind: "hex", at: Date.now(), ttl: 0, list: [f] }); } else if (a) note = "No newer position: the aircraft is not currently visible to ADSB.lol receivers."; }
    catch (e) { note = `Couldn't refresh: ${e.message}`; }
  }
  if (!a) return { ok: false, error: "That aircraft isn't in the available data right now." };
  if (!visible(a)) return { ok: false, error: "This aircraft is not shown (privacy rules)." };
  return { ok: true, aircraft: detail(a), trail: trail(hex), note, attribution: ATTRIBUTION[a.src] };
}
const SRC_TYPE = { adsb_icao: "ADS-B", adsb_icao_nt: "ADS-B (non-transponder)", adsr_icao: "ADS-R (rebroadcast)", tisb_icao: "TIS-B (ground radar rebroadcast)", tisb_trackfile: "TIS-B (ground radar track)", tisb_other: "TIS-B", adsb_other: "ADS-B (anonymous address)", adsr_other: "ADS-R", mode_s: "Mode S (no position)", mlat: "MLAT (multilateration)", adsc: "ADS-C (satellite)", other: "other" };
function detail(a) {
  const age = Math.round((Date.now() - a.posAt) / 1000);
  return { hex: a.hex, callsign: a.callsign, reg: a.reg, type: a.type, lat: a.lat, lon: a.lon, alt: a.alt, gs: a.gs, track: a.track, vs: a.vs, ground: a.ground, squawk: a.squawk || null, emergency: a.emergency || null,
    lastSeen: new Date(a.posAt).toISOString(), posAgeSec: age, freshness: age <= 15 ? "live" : age <= STALE_SEC ? "recent" : "stale", positionSource: a.src === "adsb" ? (a.mlat ? "MLAT (multilateration)" : SRC_TYPE[a.srcType] || "ADS-B") : "ADS-B/MLAT via OpenSky", source: a.src };
}

/** Search by callsign, ICAO24 hex or registration. Uses data already held first; one ADSB.lol request otherwise. */
export async function search(q) {
  const s = String(q || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s || s.length < 2 || s.length > 10 || !/^[A-Z0-9-]+$/.test(s)) throw Object.assign(new Error("Search with a callsign (e.g. BAW123), ICAO24 code (e.g. 4CA2D1) or registration (e.g. G-EZAA)."), { status: 400 });
  await exclusionsReady();
  const kind = /^[0-9A-F]{6}$/.test(s) && /\d/.test(s) ? "hex" : /-/.test(s) || /^N\d{1,5}[A-Z]{0,2}$/.test(s) ? "reg" : "callsign";
  const now = Date.now();
  const held = [...LAST.values()].filter((a) => now - a.posAt < 60_000 && visible(a) && ((kind === "hex" && a.hex === s.toLowerCase()) || (kind === "reg" && (a.reg || "").toUpperCase() === s) || (kind === "callsign" && (a.callsign || "").toUpperCase() === s)));
  if (held.length) return { ok: true, kind, query: s, results: held.map(detail), from: "recent data" };
  if (!available("adsb")) return { ok: false, kind, query: s, results: [], error: P.adsb.lastError ? `ADSB.lol unavailable: ${P.adsb.lastError}` : "Today's ADSB.lol allowance is used up, so I can't look it up." };
  const path = kind === "hex" ? `/v2/hex/${s.toLowerCase()}` : kind === "reg" ? `/v2/reg/${encodeURIComponent(s)}` : `/v2/callsign/${encodeURIComponent(s)}`;
  try {
    const j = await adsb(path);
    const list = (j.ac || []).map((a) => fromAdsb(a, j.now || now)).filter(Boolean);
    store({ kind: "search", at: now, ttl: 0, list });
    const shown = list.filter(visible);
    return { ok: true, kind, query: s, results: shown.map(detail), from: "ADSB.lol", hiddenPrivacy: list.length - shown.length };
  } catch (e) { return { ok: false, kind, query: s, results: [], error: e.message }; }
}

/** Aircraft near a point (for "show me aircraft around Cyprus" and "nearest aircraft"). */
export async function near(lat, lon, nm = 100) {
  nm = Math.max(5, Math.min(MAX_POINT_NM, nm));
  const dLat = nm / 60, dLon = nm / (60 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const r = await aircraftInView({ lamin: lat - dLat, lamax: lat + dLat, lomin: lon - dLon, lomax: lon + dLon });
  if (!r.ok) return r;
  const idx = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
  const list = r.aircraft.map((row) => ({ hex: row[idx.hex], callsign: row[idx.callsign], reg: row[idx.reg], type: row[idx.type], alt: row[idx.alt], gs: row[idx.gs], ground: !!row[idx.ground], posAgeSec: row[idx.posAge], nm: Math.round(distNm(lat, lon, row[idx.lat], row[idx.lon])) }))
    .filter((a) => a.nm <= nm).sort((a, b) => a.nm - b.nm);
  return { ...r, aircraft: undefined, nearby: list, count: list.length };
}

export function status() {
  const now = Date.now();
  const st = (p) => {
    const s = P[p];
    const state = now < s.backoffUntil ? (s.remaining === 0 ? "exhausted" : "backoff") : s.lastError && !s.lastOkAt ? "failed" : s.lastOkAt ? "operational" : "not_used";
    return { state, limit: s.limit, remaining: remaining(p), resetAt: s.resetAt ? new Date(s.resetAt).toISOString() : null, requestsToday: s.day === today() ? s.requestsToday : 0, lastOkAt: s.lastOkAt, lastError: s.lastError, lastErrorAt: s.lastErrorAt,
      retryAt: now < s.backoffUntil ? new Date(s.backoffUntil).toISOString() : null, keyed: p === "adsb" ? !!getKey("adsbKey") : !!openskyCreds(), attribution: ATTRIBUTION[p] };
  };
  return { providers: { adsb: st("adsb"), opensky: st("opensky") }, privacy: { loadedAt: HIDE.loadedAt ? new Date(HIDE.loadedAt).toISOString() : null, partial: HIDE.partial, hiddenCount: HIDE.set.size }, trails: TRAILS.size };
}
/** Tests only. */
export function _reset() { CACHE.length = 0; LAST.clear(); TRAILS.clear(); HIDE.set.clear(); HIDE.loadedAt = 0; for (const p of Object.values(P)) Object.assign(p, { backoffUntil: 0, fails: 0, lastError: null, remaining: null, resetAt: null }); }
