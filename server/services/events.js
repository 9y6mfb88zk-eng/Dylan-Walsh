// Global Events: published information about conflicts, attacks, unrest, disasters, humanitarian emergencies and
// diplomacy, from free public sources only. Nothing is invented: every item links to its original publication.
//
//   GDACS      UN / European Commission disaster alerts (no key). Location: the event's reported centroid.
//   USGS       earthquakes M4.5+ in the past week (no key, public domain). Location: the epicentre.
//   GDELT      DOC 2.0 news search (no key, one request per 5 s). News reports, grouped into stories; placed on the map
//              only at country level, inferred from the headline, and marked as such.
//   ReliefWeb  UN OCHA (needs a free, pre-approved appname). Disasters and humanitarian situations.
//   UCDP       Uppsala Conflict Data Program candidate events (needs a free token). Researcher-coded, published with
//              a delay of weeks; coordinates rounded to 0.1° here.
//
// Verification labels (shown on every item):
//   coded          UCDP: coded by researchers from multiple sources
//   official       GDACS / USGS / ReliefWeb: an official monitoring body (USGS "reviewed" vs "automatic" is kept)
//   corroborated   GDELT: the same story reported by 2+ independent outlets (not independent verification)
//   single         GDELT: one outlet so far — unconfirmed
// This is public information for general awareness, not tactical intelligence: no troop positions, no targeting,
// no live military movements.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kvGet, kvSet } from "../db.js";
import { getKey } from "./globalops-keys.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const COUNTRIES = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "countries.json"), "utf8"));
const BY_C3 = Object.fromEntries(COUNTRIES.map((c) => [c.c3, c]));
const UA = "JARVIS-personal-assistant/6.5 (non-commercial; single user)";
const URLS = {
  gdacs: () => process.env.GDACS_URL || "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH",
  usgs: () => process.env.USGS_URL || "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson",
  gdelt: () => process.env.GDELT_URL || "https://api.gdeltproject.org/api/v2/doc/doc",
  reliefweb: () => process.env.RELIEFWEB_URL || "https://api.reliefweb.int/v2",
  ucdp: () => process.env.UCDP_URL || "https://ucdpapi.pcr.uu.se/api",
};
export const CATEGORIES = {
  conflict: "Armed conflict", attack: "Reported attack", unrest: "Civil unrest", disaster: "Natural disaster",
  humanitarian: "Humanitarian emergency", diplomacy: "Diplomatic development", ceasefire: "Ceasefire / peace process",
};
export const STATUS_LABEL = {
  coded: "Coded by UCDP researchers", official: "Official monitoring body", reviewed: "Reviewed by seismologists (USGS)", automatic: "Automatic solution, not yet reviewed",
  corroborated: "Reported by several independent outlets (not independently verified)", single: "Single report — unconfirmed",
};
export const PROVIDERS = {
  gdacs: { name: "GDACS (UN / European Commission)", url: "https://www.gdacs.org/", ttlMin: 30, needs: null, attribution: "Disaster alerts: GDACS, a cooperation of the United Nations and the European Commission" },
  usgs: { name: "USGS Earthquake Hazards Program", url: "https://earthquake.usgs.gov/", ttlMin: 10, needs: null, attribution: "Earthquakes: U.S. Geological Survey (public domain)" },
  gdelt: { name: "GDELT Project", url: "https://www.gdeltproject.org/", ttlMin: 30, needs: null, attribution: "News monitoring: The GDELT Project" },
  reliefweb: { name: "ReliefWeb (UN OCHA)", url: "https://reliefweb.int/", ttlMin: 60, needs: "reliefwebAppname", attribution: "Humanitarian information: ReliefWeb, UN OCHA" },
  ucdp: { name: "UCDP (Uppsala University)", url: "https://ucdp.uu.se/", ttlMin: 720, needs: "ucdpToken", attribution: "Conflict data: Uppsala Conflict Data Program (UCDP), CC BY 4.0" },
};

// GDELT searches, one per category. English sources; past 3 days.
const GDELT_Q = {
  conflict: '(airstrike OR "air strike" OR shelling OR "armed clashes" OR "military offensive" OR "drone strike" OR "fighting between")',
  attack: '("suicide bombing" OR "bomb attack" OR "terrorist attack" OR "gunmen attacked" OR "militants attacked" OR "car bomb")',
  unrest: '(protesters OR "anti-government protest" OR riots OR "clashes with police" OR "mass protest")',
  humanitarian: '("humanitarian crisis" OR famine OR "displaced people" OR "cholera outbreak" OR "aid convoy" OR "refugee camp")',
  diplomacy: '("peace talks" OR "summit" OR "foreign minister" OR sanctions OR "diplomatic talks")',
  ceasefire: '(ceasefire OR "cease-fire" OR truce OR "peace deal" OR armistice)',
};

// ---------------------------------------------------------------- State
const S = kvGet("events.cache", null) || { items: {}, prov: {} };
for (const p of Object.keys(PROVIDERS)) S.prov[p] ||= { lastOkAt: null, lastTryAt: null, lastError: null, count: 0 };
const save = () => kvSet("events.cache", S);
let refreshing = null;

async function getJson(url, { headers = {}, timeoutMs = 25000 } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal: ctl.signal });
    const text = await r.text();
    if (r.status === 429) throw Object.assign(new Error("rate limited by the provider"), { rateLimited: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}${text && text.length < 200 ? `: ${text.replace(/<[^>]+>/g, " ").trim().slice(0, 140)}` : ""}`);
    try { return JSON.parse(text || "{}"); } catch { throw new Error(`unexpected reply: ${text.replace(/<[^>]+>/g, " ").trim().slice(0, 120)}`); }
  } catch (e) { if (e.rateLimited) throw e; throw new Error(e.name === "AbortError" ? "timed out" : e.cause?.code ? `${e.cause.code}` : e.message); }
  finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => { const t = d instanceof Date ? d : new Date(d); return Number.isNaN(t.getTime()) ? null : t.toISOString(); };
const countryOf = (c3) => (c3 && BY_C3[c3]) || null;
const place = (c) => (c ? { country: c.name, c3: c.c3, region: c.region, subregion: c.subregion } : { country: null, c3: null, region: null, subregion: null });
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// ---------------------------------------------------------------- Headline → country (country level only)
const ALIAS = [];
for (const c of COUNTRIES) {
  for (const a of new Set(c.aliases.filter(Boolean))) ALIAS.push([a, c, false]);
  if (c.demonym) ALIAS.push([c.demonym, c, true]);
}
ALIAS.sort((a, b) => b[0].length - a[0].length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Words that are also common nouns or names must be capitalised; the people's/US-state names also need a location word.
const AMBIGUOUS = new Set(["Turkey", "Guinea", "Dominica", "Jersey", "Panama", "China", "Chile", "Niger", "Georgia", "Jordan", "Chad"]);
const NEEDS_PLACE = new Set(["Georgia", "Jordan", "Chad"]);
const ALIAS_RE = ALIAS.map(([a, c, dem]) => [new RegExp(`(^|[^\\p{L}])${esc(a)}(s)?(?=[^\\p{L}]|$)`, a.length <= 3 || AMBIGUOUS.has(a) ? "gu" : "giu"), c, dem, a]);
const PLACE_WORD = /(?:^|\s)(?:in|near|across|over|at|into|inside|outside|around|of)\s+(?:the\s+)?$/i;
/**
 * The country a headline is about, at country level only. Preference: a place named after "in/near/over…",
 * then any country or city name, then a nationality ("Israeli", "Russian"); earlier mentions win ties.
 */
export function countryFromText(text) {
  const t = String(text || "");
  let best = null;
  for (const [re, c, dem, word] of ALIAS_RE) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(t));) {
      const idx = m.index + m[1].length, before = t.slice(Math.max(0, idx - 14), idx);
      const located = PLACE_WORD.test(before);
      if (NEEDS_PLACE.has(word) && !located) continue;
      const score = (located ? 0 : dem ? 2 : 1) * 1000 + idx;
      if (!best || score < best.score) best = { score, c };
    }
  }
  return best?.c || null;
}

// ---------------------------------------------------------------- Providers
async function fetchUsgs() {
  const j = await getJson(URLS.usgs());
  return (j.features || []).map((f) => {
    const p = f.properties || {}, [lon, lat, depth] = f.geometry?.coordinates || [];
    const c = countryFromText(p.place);
    return {
      id: `usgs:${f.id}`, provider: "usgs", category: "disaster", subtype: "Earthquake", title: p.title || `M ${p.mag} earthquake`, summary: `Magnitude ${p.mag}${p.magType ? ` (${p.magType})` : ""} at ${Math.round(depth)} km depth${p.tsunami ? " · tsunami flag set" : ""}${p.alert ? ` · PAGER alert ${p.alert}` : ""}`,
      ...place(c), placeName: p.place || null, lat, lon, locAccuracy: "epicentre", eventDate: iso(p.time), publishedAt: iso(p.updated || p.time),
      sources: [{ name: "USGS", url: p.url, publishedAt: iso(p.updated || p.time) }], status: p.status === "reviewed" ? "reviewed" : "automatic", severity: p.mag >= 7 ? 3 : p.mag >= 6 ? 2 : 1,
    };
  });
}
const GDACS_TYPE = { EQ: "Earthquake", TC: "Tropical cyclone", FL: "Flood", VO: "Volcano", DR: "Drought", WF: "Wildfire", TS: "Tsunami" };
async function fetchGdacs() {
  const to = new Date(), from = new Date(Date.now() - 14 * 86400_000);
  const q = new URLSearchParams({ eventlist: "EQ;TC;FL;VO;DR;WF", fromDate: from.toISOString().slice(0, 10), toDate: to.toISOString().slice(0, 10), alertlevel: "Green;Orange;Red" });
  const j = await getJson(`${URLS.gdacs()}?${q}`);
  return (j.features || []).filter((f) => f.properties && f.properties.iscurrent !== "false").map((f) => {
    const p = f.properties, [lon, lat] = f.geometry?.coordinates || [];
    const c = countryOf(p.iso3) || countryFromText(p.country);
    const level = p.alertlevel || "Green";
    return {
      id: `gdacs:${p.eventtype}:${p.eventid}`, provider: "gdacs", category: "disaster", subtype: GDACS_TYPE[p.eventtype] || p.eventtype,
      title: `${level} alert: ${p.name || p.description || GDACS_TYPE[p.eventtype]}`, summary: (p.htmldescription || "").replace(/<[^>]+>/g, "").slice(0, 240),
      ...place(c), placeName: p.country || null, lat, lon, locAccuracy: p.polygonlabel === "Centroid" ? "affected-area centre" : "reported location",
      eventDate: iso(p.fromdate + "Z"), publishedAt: iso((p.datemodified || p.fromdate) + "Z"), sources: [{ name: "GDACS", url: p.url?.report || "https://www.gdacs.org/", publishedAt: iso((p.datemodified || p.fromdate) + "Z") }],
      status: "official", severity: level === "Red" ? 3 : level === "Orange" ? 2 : 1, alertLevel: level,
    };
  });
}
const STOP = new Set("the a an and or of in on at to for from with by as after over amid into says said say new more than about its their his her has have was were will would could be been is are this that who what why how not no but up out".split(" "));
const words = (t) => new Set(String(t).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };
async function fetchGdelt() {
  const out = [];
  let lastErr = null, okCount = 0;
  for (const [cat, q] of Object.entries(GDELT_Q)) {
    if (okCount || lastErr) await sleep(process.env.GDELT_SPACING_MS ? +process.env.GDELT_SPACING_MS : 6000);
    const url = `${URLS.gdelt()}?${new URLSearchParams({ query: `${q} sourcelang:english`, mode: "artlist", format: "json", maxrecords: "75", timespan: "3d", sort: "datedesc" })}`;
    let j = null, limited = false;
    for (let attempt = 0; attempt < 2 && !j && !limited; attempt++) {
      try { j = await getJson(url, { timeoutMs: 30000 }); }
      catch (e) { lastErr = e.message; limited = !!e.rateLimited; if (attempt === 0 && !limited) await sleep(process.env.GDELT_SPACING_MS ? +process.env.GDELT_SPACING_MS : 8000); }
    }
    // GDELT allows one request every 5 seconds per connection. If it says we're over that, stop now and try again later.
    if (limited) { lastErr = "GDELT is rate-limiting this internet connection (it allows one request every 5 seconds); retrying in 15 minutes"; break; }
    if (!j) continue;
    okCount++;
    const stories = [];
    for (const a of j.articles || []) {
      if (!a.url || !a.title) continue;
      const at = a.seendate ? iso(a.seendate.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z")) : null;
      const c = countryFromText(a.title);
      const w = words(a.title);
      const s = stories.find((x) => (x.c3 || null) === (c?.c3 || null) && jaccard(x.w, w) >= 0.3);
      const src = { name: a.domain || domainOf(a.url), url: a.url, publishedAt: at, sourceCountry: a.sourcecountry || null };
      if (s) { if (!s.sources.some((x) => x.name === src.name)) s.sources.push(src); for (const x of w) s.w.add(x); if (at && at < s.eventDate) s.eventDate = at; if (at && at > s.publishedAt) s.publishedAt = at; }
      else stories.push({ c3: c?.c3 || null, c, w, title: a.title, eventDate: at, publishedAt: at, sources: [src] });
    }
    for (const s of stories) {
      const domains = new Set(s.sources.map((x) => x.name));
      out.push({
        id: `gdelt:${cat}:${s.sources[0].url}`, provider: "gdelt", category: cat, subtype: null, title: s.title, summary: null,
        ...place(s.c), placeName: s.c?.name || null, lat: s.c ? s.c.lat : null, lon: s.c ? s.c.lon : null, locAccuracy: s.c ? "country (from headline)" : "unknown",
        eventDate: s.eventDate, eventDateLabel: "first reported", publishedAt: s.publishedAt, sources: s.sources.slice(0, 8), sourceCount: domains.size,
        status: domains.size >= 2 ? "corroborated" : "single", severity: Math.min(3, domains.size),
      });
    }
  }
  if (!okCount) throw new Error(lastErr || "no response");
  if (lastErr) out.partial = `${Object.keys(GDELT_Q).length - okCount} of ${Object.keys(GDELT_Q).length} searches failed (${lastErr})`;
  return out;
}
async function fetchReliefweb() {
  const app = getKey("reliefwebAppname");
  const q = new URLSearchParams({ appname: app, preset: "latest", limit: "60", profile: "list" });
  for (const f of ["name", "status", "date.created", "date.event", "country.name", "country.iso3", "primary_country.iso3", "primary_country.location", "type.name", "url_alias", "url", "glide"]) q.append("fields[include][]", f);
  const j = await getJson(`${URLS.reliefweb()}/disasters?${q}`);
  return (j.data || []).map((d) => {
    const f = d.fields || {}, c3 = f.primary_country?.iso3?.toUpperCase() || f.country?.[0]?.iso3?.toUpperCase();
    const c = countryOf(c3), loc = f.primary_country?.location;
    const type = f.type?.[0]?.name || "Disaster";
    const human = /complex emergency|epidemic|insect|famine|refugee|displacement/i.test(type);
    return {
      id: `reliefweb:${d.id}`, provider: "reliefweb", category: human ? "humanitarian" : "disaster", subtype: type, title: f.name, summary: `${f.status === "alert" ? "Alert" : f.status === "ongoing" ? "Ongoing" : "Past"} · ${type}${f.glide ? ` · GLIDE ${f.glide}` : ""}`,
      ...place(c), placeName: c?.name || f.country?.[0]?.name || null, lat: loc?.lat ?? c?.lat ?? null, lon: loc?.lon ?? c?.lon ?? null, locAccuracy: "country",
      eventDate: iso(f.date?.event || f.date?.created), publishedAt: iso(f.date?.created), sources: [{ name: "ReliefWeb", url: f.url_alias || f.url || `https://reliefweb.int/node/${d.id}`, publishedAt: iso(f.date?.created) }],
      status: "official", severity: f.status === "alert" ? 2 : 1,
    };
  });
}
const UCDP_KIND = { 1: ["conflict", "State-based armed conflict"], 2: ["conflict", "Non-state conflict"], 3: ["attack", "One-sided violence against civilians"] };
async function fetchUcdp() {
  const token = getKey("ucdpToken"), headers = { "x-ucdp-access-token": token };
  // Candidate releases are monthly ("YY.0.M"); use the newest one the API has.
  const now = new Date();
  let version = S.prov.ucdp.version || null, j = null, lastErr = null;
  const tries = version ? [version] : [];
  for (let back = 0; back < 6; back++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); tries.push(`${String(d.getUTCFullYear()).slice(2)}.0.${d.getUTCMonth() + 1}`); }
  const start = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 10);
  for (const v of [...new Set(tries)]) {
    try { j = await getJson(`${URLS.ucdp()}/gedevents/${v}?pagesize=500&StartDate=${start}`, { headers }); if (j && Array.isArray(j.Result)) { version = v; break; } j = null; }
    catch (e) { lastErr = e.message; if (/401|403/.test(e.message)) throw new Error(`UCDP refused the token (${e.message})`); }
  }
  if (!j) throw new Error(lastErr || "no UCDP candidate release found");
  S.prov.ucdp.version = version;
  return j.Result.map((e) => {
    const c = countryFromText(e.country);
    const [cat, kind] = UCDP_KIND[e.type_of_violence] || ["conflict", "Organised violence"];
    const prec = e.where_prec;
    return {
      id: `ucdp:${e.id}`, provider: "ucdp", category: cat, subtype: kind, title: `${kind}: ${e.dyad_name || e.conflict_name || "unnamed actors"}`, summary: `${e.best ?? "?"} reported deaths (UCDP best estimate)${e.adm_1 ? ` · ${e.adm_1}` : ""}`,
      ...place(c), placeName: [e.adm_1, e.country].filter(Boolean).join(", "), lat: e.latitude != null ? Math.round(e.latitude * 10) / 10 : null, lon: e.longitude != null ? Math.round(e.longitude * 10) / 10 : null,
      locAccuracy: prec <= 2 ? "town (rounded to ~10 km)" : prec <= 4 ? "district or province" : "country", eventDate: iso(e.date_start), publishedAt: null, publishedNote: `UCDP Candidate ${version}`,
      sources: [{ name: `UCDP GED Candidate ${version}`, url: "https://ucdp.uu.se/", publishedAt: null }, ...(e.source_article ? [{ name: "Original sources (as cited by UCDP)", url: null, text: String(e.source_article).slice(0, 300) }] : [])],
      status: "coded", severity: e.best >= 25 ? 3 : e.best >= 5 ? 2 : 1,
    };
  });
}
const FETCH = { usgs: fetchUsgs, gdacs: fetchGdacs, gdelt: fetchGdelt, reliefweb: fetchReliefweb, ucdp: fetchUcdp };

// ---------------------------------------------------------------- Refresh (only on demand, never on a timer)
function due(p) {
  const pr = S.prov[p], def = PROVIDERS[p];
  if (def.needs && !getKey(def.needs)) return false;
  if (!pr.lastTryAt) return true;
  const since = Date.now() - Date.parse(pr.lastTryAt);
  return since > (pr.lastError ? Math.min(def.ttlMin, 15) : def.ttlMin) * 60_000;
}
async function refreshOne(p) {
  const pr = S.prov[p];
  pr.lastTryAt = new Date().toISOString();
  pr.refreshing = true;
  try {
    const items = await FETCH[p]();
    const retrievedAt = new Date().toISOString();
    S.items[p] = items.map((x) => ({ ...x, retrievedAt }));
    Object.assign(pr, { lastOkAt: retrievedAt, lastError: items.partial || null, count: items.length });
  } catch (e) { pr.lastError = e.message; }
  finally { pr.refreshing = false; save(); }
}
export function refresh({ force = false } = {}) {
  if (refreshing) return refreshing;
  const ps = Object.keys(PROVIDERS).filter((p) => force ? !PROVIDERS[p].needs || getKey(PROVIDERS[p].needs) : due(p));
  if (!ps.length) return Promise.resolve();
  refreshing = Promise.all(ps.map(refreshOne)).finally(() => { refreshing = null; });
  return refreshing;
}

export function providerStatus() {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([p, def]) => {
    const pr = S.prov[p], configured = !def.needs || !!getKey(def.needs);
    const ageMin = pr.lastOkAt ? (Date.now() - Date.parse(pr.lastOkAt)) / 60_000 : null;
    const state = !configured ? "not_configured" : pr.refreshing && !pr.lastOkAt ? "initialising" : !pr.lastOkAt ? (pr.lastError ? "failed" : "initialising") : pr.lastError && !/searches failed/.test(pr.lastError) ? (ageMin > def.ttlMin * 3 ? "stale" : "degraded") : ageMin > def.ttlMin * 3 ? "stale" : pr.lastError ? "degraded" : "operational";
    return [p, { name: def.name, url: def.url, attribution: def.attribution, state, configured, needs: def.needs, lastOkAt: pr.lastOkAt, lastTryAt: pr.lastTryAt, lastError: pr.lastError, count: pr.lastOkAt ? pr.count : 0, refreshing: !!pr.refreshing, ageMin: ageMin == null ? null : Math.round(ageMin) }];
  }));
}

/** All held events, newest first, with filters. Starts a background refresh when data is due; waits briefly on first use. */
export async function list(f = {}) {
  const p = refresh();
  const empty = !Object.values(S.items).some((x) => x?.length);
  if (empty || f.wait) await Promise.race([p, sleep(f.wait ? 60_000 : 9000)]);
  const since = f.days ? Date.now() - Number(f.days) * 86400_000 : null;
  let items = Object.entries(S.items).filter(([prov]) => !PROVIDERS[prov].needs || getKey(PROVIDERS[prov].needs)).flatMap(([, x]) => x || []);
  if (f.category) items = items.filter((e) => String(f.category).split(",").includes(e.category));
  if (f.provider) items = items.filter((e) => String(f.provider).split(",").includes(e.provider));
  if (f.status) items = items.filter((e) => String(f.status).split(",").includes(e.status));
  if (f.region) items = items.filter((e) => e.region === f.region || e.subregion === f.region);
  if (f.country) { const q = String(f.country).toLowerCase(); items = items.filter((e) => (e.country || "").toLowerCase() === q || (e.c3 || "").toLowerCase() === q || (e.placeName || "").toLowerCase().includes(q)); }
  if (since) items = items.filter((e) => Date.parse(e.publishedAt || e.eventDate || e.retrievedAt) >= since);
  if (f.q) { const q = String(f.q).toLowerCase(); items = items.filter((e) => `${e.title} ${e.summary || ""} ${e.placeName || ""}`.toLowerCase().includes(q)); }
  items.sort((a, b) => Date.parse(b.publishedAt || b.eventDate || 0) - Date.parse(a.publishedAt || a.eventDate || 0));
  const limit = Math.min(Number(f.limit) || 400, 1000);
  return { items: items.slice(0, limit), total: items.length, providers: providerStatus(), categories: CATEGORIES, statusLabels: STATUS_LABEL, refreshing: !!refreshing, generatedAt: new Date().toISOString() };
}
/** Tests only. */
export function _reset() { S.items = {}; for (const p of Object.keys(PROVIDERS)) S.prov[p] = { lastOkAt: null, lastTryAt: null, lastError: null, count: 0 }; save(); }
