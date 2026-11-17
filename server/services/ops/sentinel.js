// Operation Sentinel: watchlists over the Global Events feed, and genuine public webcams.
//
// Watchlists: countries, regions and places (with a radius) × event categories × a minimum verification level.
// New matching events are sent to the notification centre; during quiet hours they are recorded silently.
// Alerts only ever come from events JARVIS actually retrieved.
//
// Webcams (published for public viewing only; nothing discovered by scanning, nothing behind a login):
//   Windy Webcams API (free key): a timelapse player that may be embedded, and preview images whose links expire after
//                                 15 minutes. These are periodically refreshed images, NOT continuous live video.
//   YouTube (operator-published live cameras in JARVIS's registry): embedded with YouTube's official player. Whether a
//                                 stream is live right now is checked with the YouTube Data API (free key); without the
//                                 key the status is "not verified" and JARVIS links to the operator's page instead.
// Cameras in countries with active armed conflict are not offered (see CONFLICT_EXCLUDED), so the layer can't become a
// live view of conflict areas. A camera image is never treated as evidence for or against a reported event.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kvGet, kvSet } from "../../db.js";
import { records } from "./records.js";
import { getKey } from "../globalops-keys.js";
import * as events from "../events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "data", "webcams.json"), "utf8"));
const UA = "JARVIS-personal-assistant/6.6 (non-commercial; single user)";
const URL_ = { windy: () => process.env.WINDY_URL || "https://api.windy.com/webcams/api/v3/webcams", youtube: () => (process.env.YOUTUBE_API_URL || "https://www.googleapis.com/youtube/v3").replace(/\/$/, "") };
/** ISO 3166-1 alpha-2 codes of countries with active armed conflict on their territory (reviewed 17 Nov 2026). */
export const CONFLICT_EXCLUDED = ["UA", "RU", "IL", "PS", "LB", "SY", "SD", "SS", "YE", "MM", "CD", "SO", "ML", "BF", "LY", "AF", "HT"];
export const SOURCES = {
  windy: { name: "Windy Webcams", url: "https://www.windy.com/webcams", terms: "Free tier: link images or embed the timelapse player; image links valid 15 minutes; API key required" },
  youtube: { name: "YouTube (operator-published live cameras)", url: "https://www.youtube.com/", terms: "Embedded with YouTube's official player, subject to each publisher's embedding setting" },
};

// ---------------------------------------------------------------- Watchlists
const RANK = { single: 0, contested: 0, automatic: 1, multiple: 1, corroborated: 2, reviewed: 2, official: 3, coded: 3 };
export const MIN_LEVELS = { any: "Any report", multiple: "Two or more sources", corroborated: "Corroborated or official", official: "Official bodies only" };
const LEVEL_RANK = { any: 0, multiple: 1, corroborated: 2, official: 3 };
const R = 6371, rad = (d) => (d * Math.PI) / 180;
const km = (a, b) => 2 * R * Math.asin(Math.sqrt(Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2));

export function normaliseWatchlist(d = {}) {
  const arr = (v, n = 30) => (Array.isArray(v) ? v : String(v || "").split(",")).map((x) => String(x).trim()).filter(Boolean).slice(0, n);
  return {
    countries: arr(d.countries), regions: arr(d.regions), categories: arr(d.categories).filter((c) => events.CATEGORIES[c]),
    places: (Array.isArray(d.places) ? d.places : []).filter((p) => Number.isFinite(+p.lat) && Number.isFinite(+p.lon)).slice(0, 20).map((p) => ({ name: String(p.name || "").slice(0, 80), lat: +p.lat, lon: +p.lon, radiusKm: Math.max(5, Math.min(1000, +p.radiusKm || 100)) })),
    minLevel: LEVEL_RANK[d.minLevel] !== undefined ? d.minLevel : "any", minSeverity: Math.max(1, Math.min(3, +d.minSeverity || 1)),
    quiet: { start: /^\d\d:\d\d$/.test(d.quiet?.start || "") ? d.quiet.start : "", end: /^\d\d:\d\d$/.test(d.quiet?.end || "") ? d.quiet.end : "" },
    enabled: d.enabled !== false, seen: Array.isArray(d.seen) ? d.seen.slice(-800) : [], lastCheckAt: d.lastCheckAt || null, lastMatches: Array.isArray(d.lastMatches) ? d.lastMatches.slice(0, 50) : [],
  };
}
export function matches(w, e) {
  if (w.categories.length && !w.categories.includes(e.category)) return false;
  if ((RANK[e.status] ?? 0) < LEVEL_RANK[w.minLevel]) return false;
  if ((e.severity || 1) < w.minSeverity) return false;
  const geo = w.countries.length || w.regions.length || w.places.length;
  if (!geo) return true;
  const lc = (s) => String(s || "").toLowerCase();
  if (w.countries.some((c) => lc(c) === lc(e.country) || lc(c) === lc(e.c3) || (e.placeName && lc(e.placeName).includes(lc(c))))) return true;
  if (w.regions.some((r) => lc(r) === lc(e.region) || lc(r) === lc(e.subregion))) return true;
  if (e.lat != null && w.places.some((p) => km(p, e) <= p.radiusKm)) return true;
  return false;
}
function inQuiet(q, tz) {
  if (!q.start || !q.end) return false;
  const now = new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return q.start <= q.end ? now >= q.start && now < q.end : now >= q.start || now < q.end;
}
/** Run every enabled watchlist against the events held now; notify about new matches. Returns counts per watchlist. */
export async function checkWatchlists({ tz = "UTC", notify } = {}) {
  const lists = records.list({ op: "sentinel", kind: "watchlist" }).filter((w) => w.data.enabled !== false);
  if (!lists.length) return [];
  const all = (await events.list({ limit: 1000, days: 3 })).items;
  const out = [];
  for (const rec of lists) {
    const w = normaliseWatchlist(rec.data);
    const first = !w.lastCheckAt;   // the first run records what's already there without alerting about all of it
    const seen = new Set(w.seen);
    const hits = all.filter((e) => matches(w, e));
    const fresh = hits.filter((e) => !seen.has(e.id));
    const quiet = inQuiet(w.quiet, tz);
    if (!first && fresh.length && notify) {
      const top = fresh.slice(0, 3);
      await notify({ kind: "sentinel", title: `Sentinel · ${rec.title}: ${fresh.length} new report${fresh.length === 1 ? "" : "s"}`, body: top.map((e) => `${e.title} (${events.STATUS_LABEL[e.status] || e.status}; ${e.sources?.[0]?.name || e.provider})`).join(" · ").slice(0, 900),
        url: "/?tab=home&mission=op-sentinel", push: !quiet, speak: null, data: { watchlist: rec.id, events: top.map((e) => e.id), quiet } }).catch(() => {});
    }
    const nextSeen = [...seen, ...fresh.map((e) => e.id)].slice(-800);
    records.update(rec.id, { data: { ...w, seen: nextSeen, lastCheckAt: new Date().toISOString(), lastMatches: hits.slice(0, 50).map((e) => ({ id: e.id, title: e.title, category: e.category, status: e.status, publishedAt: e.publishedAt, url: e.sources?.[0]?.url, place: e.placeName || e.country })) } });
    out.push({ id: rec.id, title: rec.title, matches: hits.length, new: first ? 0 : fresh.length, quiet, firstRun: first });
  }
  return out;
}

// ---------------------------------------------------------------- Webcams
const camState = () => kvGet("sentinel.webcams", {});
const saveCamState = (s) => kvSet("sentinel.webcams", s);
const windyCache = new Map();

async function getJson(url, headers = {}, timeoutMs = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal: ctl.signal }); const text = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status}${text.length < 200 ? `: ${text}` : ""}`); return JSON.parse(text); }
  catch (e) { throw new Error(e.name === "AbortError" ? "timed out" : e.message); } finally { clearTimeout(t); }
}
function registryCams() {
  const st = camState();
  return REGISTRY.cameras.filter((c) => !CONFLICT_EXCLUDED.includes(c.c2)).map((c) => {
    const s = st[c.id] || {};
    return { ...c, kind: "live video (YouTube)", videoId: s.videoId || null, liveStatus: s.status || "not_verified", lastVerifiedAt: s.at || null, verifyError: s.error || null, streamTitle: s.title || null,
      embedUrl: s.status === "live" && s.embeddable !== false ? `https://www.youtube-nocookie.com/embed/${s.videoId}?autoplay=1&mute=1` : null,
      attribution: `${c.operator} via YouTube`, permission: "Published by the operator on YouTube; embedding governed by the publisher's setting", source: SOURCES.youtube };
  });
}
/** Check registry cameras with the YouTube Data API (search for the operator's live stream, then its embeddable flag). */
export async function verifyYoutube({ force = false, ids = null } = {}) {
  const key = getKey("youtubeKey");
  if (!key) return { ok: false, error: "Add a free YouTube Data API key in Settings → Global Operations to verify camera streams." };
  const st = camState(); const out = [];
  for (const c of REGISTRY.cameras) {
    if (ids && !ids.includes(c.id)) continue;
    if (CONFLICT_EXCLUDED.includes(c.c2)) continue;
    const prev = st[c.id];
    if (!force && prev?.at && Date.now() - Date.parse(prev.at) < 6 * 3600_000) { out.push({ id: c.id, status: prev.status, cached: true }); continue; }
    try {
      const s = await getJson(`${URL_.youtube()}/search?part=snippet&channelId=${c.channelId}&eventType=live&type=video&maxResults=5&q=${encodeURIComponent(c.match)}&key=${encodeURIComponent(key)}`);
      const hit = (s.items || []).find((i) => i.snippet?.title?.toLowerCase().includes(c.match.toLowerCase())) || null;
      if (!hit) { st[c.id] = { status: "offline", at: new Date().toISOString(), error: null }; out.push({ id: c.id, status: "offline" }); continue; }
      const vid = hit.id.videoId;
      const v = await getJson(`${URL_.youtube()}/videos?part=status,liveStreamingDetails,snippet&id=${vid}&key=${encodeURIComponent(key)}`);
      const it = v.items?.[0];
      const live = it?.snippet?.liveBroadcastContent === "live" && !it?.liveStreamingDetails?.actualEndTime;
      st[c.id] = { status: live ? "live" : "offline", videoId: vid, title: it?.snippet?.title?.slice(0, 160) || hit.snippet.title, embeddable: it?.status?.embeddable !== false, at: new Date().toISOString(), error: it?.status?.embeddable === false ? "the publisher doesn't allow embedding" : null };
      out.push({ id: c.id, status: st[c.id].status });
    } catch (e) { st[c.id] = { ...(prev || {}), status: prev?.status === "live" ? "unknown" : prev?.status || "not_verified", at: new Date().toISOString(), error: e.message }; out.push({ id: c.id, status: "error", error: e.message }); }
  }
  saveCamState(st);
  return { ok: true, checked: out };
}
/** Windy cameras near a point (radius ≤ 250 km) or in a country. Requires the free key. Cached 10 minutes. */
async function windyCams({ lat, lon, radiusKm = 100, country } = {}) {
  const key = getKey("windyKey");
  if (!key) return { available: false, reason: "Add a free Windy Webcams API key in Settings → Global Operations for Windy's cameras.", cams: [] };
  const q = new URLSearchParams({ include: "location,player,images,urls,categories", limit: "50", lang: "en" });
  if (country) q.set("countries", String(country).toUpperCase());
  else if (lat != null && lon != null) q.set("nearby", `${(+lat).toFixed(3)},${(+lon).toFixed(3)},${Math.min(250, Math.max(5, +radiusKm || 100))}`);
  const k = q.toString();
  const hit = windyCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  const j = await getJson(`${URL_.windy()}?${k}`, { "x-windy-api-key": key });
  const cams = (j.webcams || []).filter((w) => w.status === "active" && !CONFLICT_EXCLUDED.includes(w.location?.country_code)).map((w) => ({
    id: `windy-${w.webcamId}`, name: w.title, city: w.location?.city || "", country: w.location?.country || "", c2: w.location?.country_code || "", lat: w.location?.latitude, lon: w.location?.longitude,
    category: (w.categories || []).map((c) => c.name).join(", ") || "webcam", operator: "Windy.com (camera owner credited on Windy)", sourceUrl: w.urls?.detail || "https://www.windy.com/webcams", provider: "windy",
    kind: "timelapse / periodic still images (not live video)", liveStatus: "active", lastVerifiedAt: w.lastUpdatedOn || null, preview: w.images?.current?.preview || null, previewExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    embedUrl: w.player?.day || w.player?.lifetime || null, attribution: "Webcams provided by windy.com — add a webcam", permission: "Windy free tier: embedding the timelapse player is permitted", source: SOURCES.windy,
  }));
  const v = { available: true, cams, retrievedAt: new Date().toISOString() };
  windyCache.set(k, { at: Date.now(), v });
  return v;
}
export async function webcams({ lat, lon, radiusKm, country, q, category } = {}) {
  let cams = registryCams();
  let windy = { available: false, reason: null, cams: [] };
  try { if (lat != null || country) windy = await windyCams({ lat, lon, radiusKm, country }); else if (!getKey("windyKey")) windy.reason = "Add a free Windy Webcams API key in Settings → Global Operations for Windy's cameras."; }
  catch (e) { windy = { available: false, reason: `Windy unavailable: ${e.message}`, cams: [] }; }
  cams = [...cams, ...windy.cams];
  const lc = (s) => String(s || "").toLowerCase();
  if (q) cams = cams.filter((c) => lc(`${c.name} ${c.city} ${c.country}`).includes(lc(q)));
  if (country && !windy.available) cams = cams.filter((c) => lc(c.country).includes(lc(country)) || lc(c.c2) === lc(country));
  if (category) cams = cams.filter((c) => lc(c.category).includes(lc(category)));
  return { cams, windy: { available: windy.available, reason: windy.reason, retrievedAt: windy.retrievedAt || null }, youtubeKey: !!getKey("youtubeKey"), excludedCountries: CONFLICT_EXCLUDED, sources: SOURCES,
    note: "Cameras published by their operators for public viewing. A camera image is not evidence for or against any reported event." };
}
