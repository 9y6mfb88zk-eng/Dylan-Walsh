// Calendar: JARVIS's own events plus Google Calendar when authorised. Conflict detection built in.
import { db, tx, getSettings } from "../db.js";
import * as google from "../integrations/google.js";
import { createState, consumeState, connections } from "./oauth.js";
import { changed } from "../realtime.js";
import { audit } from "../security/audit.js";
import { localParts, fromLocal, localDate, addDays, pad } from "./time.js";

const FREQS = ["daily", "weekly", "monthly", "yearly"];
const RRULE = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };
function cleanRecurrence(r) {
  if (!r || !FREQS.includes(r.freq)) return null;
  const out = { freq: r.freq, interval: Math.max(1, Math.min(52, Math.round(Number(r.interval) || 1))) };
  if (r.until && /^\d{4}-\d{2}-\d{2}$/.test(r.until)) out.until = r.until;
  if (r.count) out.count = Math.max(1, Math.min(500, Math.round(Number(r.count))));
  return out;
}
const shape = (e) => ({ ...e, all_day: !!e.all_day, important: !!e.important, recurrence: e.recurrence ? JSON.parse(e.recurrence) : null });
function stepDate(dateStr, freq, n) {
  if (freq === "daily") return addDays(dateStr, n);
  if (freq === "weekly") return addDays(dateStr, 7 * n);
  const [y, m, d] = dateStr.split("-").map(Number);
  const months = freq === "monthly" ? n : 12 * n;
  const total = (y * 12 + (m - 1)) + months, ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}
/** Occurrences of a recurring local event that overlap [from, to). Keeps the same local wall-clock time across DST. */
function expand(e, from, to) {
  const r = JSON.parse(e.recurrence);
  const out = [];
  const tz = getSettings().timezone;
  const durMs = Date.parse(e.end) - Date.parse(e.start);
  const startLocal = e.all_day ? { date: e.start.slice(0, 10), hm: "00:00" } : (() => { const p = localParts(new Date(e.start), tz); return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, hm: `${pad(p.h)}:${pad(p.mi)}` }; })();
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  for (let i = 0; i < 2000; i++) {
    if (r.count && i >= r.count) break;
    const date = stepDate(startLocal.date, r.freq, i * r.interval);
    if (r.until && date > r.until) break;
    const s = e.all_day ? Date.parse(`${date}T00:00:00Z`) : fromLocal(date, startLocal.hm, tz).getTime();
    if (s >= toMs) break;
    const en = s + durMs;
    if (en <= fromMs) continue;
    out.push({ ...shape(e), start: e.all_day ? date : new Date(s).toISOString(), end: e.all_day ? new Date(en).toISOString().slice(0, 10) : new Date(en).toISOString(), occurrence: i, recurring: true });
  }
  return out;
}

const clean = (s, n = 300) => String(s ?? "").trim().slice(0, n);

// ---------------- Google connection
export function startGoogle({ redirectUri, deviceId }) {
  if (!google.googleConfigured()) throw Object.assign(new Error("Google Calendar is not configured on the server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."), { status: 503 });
  return google.authorizeUrl({ state: createState("google", deviceId), redirectUri });
}
export async function finishGoogle({ state, code, redirectUri }) {
  const st = consumeState(state, "google");
  const t = await google.exchangeCode(code, redirectUri);
  const conn = connections.upsertTokens("google", { ...t, status: "active" });
  audit("calendar.connected", { deviceId: st.device_id, provider: "google" });
  await syncGoogle().catch(() => {});
  return conn;
}
async function googleToken() {
  const conn = connections.get("google");
  if (!conn || conn.status === "disconnected") return null;
  const { accessToken, refreshToken } = connections.tokens(conn);
  if (Date.parse(conn.expires_at || 0) - Date.now() > 120_000) return accessToken;
  if (!refreshToken) { connections.setStatus(conn.id, "expired", "Reconnect Google Calendar."); return null; }
  try {
    const t = await google.refresh(refreshToken);
    connections.upsertTokens("google", { ...t, status: "active" });
    return t.accessToken;
  } catch (e) { connections.setStatus(conn.id, "expired", e.message); throw e; }
}
export async function disconnectGoogle() {
  const conn = connections.get("google");
  if (!conn) return false;
  try { const { refreshToken, accessToken } = connections.tokens(conn); await google.revoke(refreshToken || accessToken); } catch {}
  tx(() => { db.prepare("DELETE FROM events WHERE source = 'google'").run(); connections.disconnect(conn.id); });
  changed("calendar");
  return true;
}
export const googleStatus = () => ({ configured: google.googleConfigured(), connection: connections.view(connections.get("google")) });

/** Mirror Google events from 14 days ago to 90 days ahead into the local table. */
export async function syncGoogle() {
  const t = await googleToken();
  if (!t) return { synced: false };
  const from = new Date(Date.now() - 14 * 86400_000).toISOString(), to = new Date(Date.now() + 90 * 86400_000).toISOString();
  const items = await google.listEvents(t, from, to);
  const seen = new Set();
  tx(() => {
    for (const e of items) {
      const ev = google.fromGoogle(e); seen.add(ev.external_id);
      db.prepare(`INSERT INTO events (source, external_id, title, start, end, all_day, location, notes, updated_at) VALUES ('google', @external_id, @title, @start, @end, @all_day, @location, @notes, datetime('now'))
        ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET title = excluded.title, start = excluded.start, end = excluded.end, all_day = excluded.all_day, location = excluded.location, notes = excluded.notes, updated_at = excluded.updated_at`).run(ev);
    }
    // Remove mirrored events in the window that no longer exist upstream.
    for (const r of db.prepare("SELECT id, external_id FROM events WHERE source = 'google' AND start >= ? AND start < ?").all(from.slice(0, 10), to)) {
      if (!seen.has(r.external_id)) db.prepare("DELETE FROM events WHERE id = ?").run(r.id);
    }
  });
  connections.markSynced(connections.get("google").id);
  changed("calendar");
  return { synced: true, events: items.length };
}

// ---------------- Queries
export function list(from, to) {
  const single = db.prepare("SELECT * FROM events WHERE recurrence IS NULL AND end > ? AND start < ? ORDER BY start").all(from, to).map(shape);
  const rec = db.prepare("SELECT * FROM events WHERE recurrence IS NOT NULL AND start < ?").all(to).flatMap((e) => expand(e, from, to));
  return [...single, ...rec].sort((a, b) => String(a.start).localeCompare(String(b.start)));
}
export function get(id) { const e = db.prepare("SELECT * FROM events WHERE id = ?").get(id); return e && shape(e); }
export function find(q, { from = new Date(Date.now() - 86400_000).toISOString() } = {}) {
  return list(from, new Date(Date.now() + 365 * 86400_000).toISOString()).filter((e) => e.title.toLowerCase().includes(clean(q, 100).toLowerCase())).slice(0, 5);
}
/** Search titles, places and notes (past and future). */
export function search(q, limit = 30) {
  const like = `%${clean(q, 100)}%`;
  return db.prepare("SELECT * FROM events WHERE title LIKE ? OR location LIKE ? OR notes LIKE ? ORDER BY start DESC LIMIT ?").all(like, like, like, limit).map(shape);
}
export function nextEvent(now = new Date()) {
  return list(now.toISOString(), new Date(now.getTime() + 30 * 86400_000).toISOString()).find((e) => !e.all_day && Date.parse(e.start) >= now.getTime()) || null;
}
export function conflicts(start, end, ignoreId = null) {
  return list(start, end).filter((e) => !e.all_day && e.id !== ignoreId);
}

function normalize(ev) {
  const all_day = !!ev.all_day;
  const start = all_day ? String(ev.start).slice(0, 10) : new Date(ev.start).toISOString();
  let end = ev.end ? (all_day ? String(ev.end).slice(0, 10) : new Date(ev.end).toISOString()) : null;
  if (!end) end = all_day ? new Date(Date.parse(start) + 86400_000).toISOString().slice(0, 10) : new Date(Date.parse(start) + 60 * 60_000).toISOString();
  if (!clean(ev.title)) throw Object.assign(new Error("Event title required"), { status: 400 });
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) throw Object.assign(new Error("Event needs a valid start and an end after it"), { status: 400 });
  const rec = cleanRecurrence(typeof ev.recurrence === "string" ? JSON.parse(ev.recurrence) : ev.recurrence);
  return { title: clean(ev.title, 200), start, end, all_day: all_day ? 1 : 0, location: clean(ev.location, 200), notes: clean(ev.notes, 2000), important: ev.important ? 1 : 0, recurrence: rec ? JSON.stringify(rec) : null };
}

// ---------------- Writes (callers decide when confirmation is required)
export async function create(input) {
  const ev = normalize(input);
  let source = "local", external_id = null;
  const t = await googleToken().catch(() => null);
  if (t && input.target !== "local") {
    const body = google.toGoogle(ev, getSettings().timezone);
    if (ev.recurrence) { const r = JSON.parse(ev.recurrence); body.recurrence = [`RRULE:FREQ=${RRULE[r.freq]};INTERVAL=${r.interval}${r.count ? `;COUNT=${r.count}` : ""}${r.until ? `;UNTIL=${r.until.replace(/-/g, "")}T235959Z` : ""}`]; }
    const g = await google.insertEvent(t, body);
    source = "google"; external_id = g.id;
  }
  const r = db.prepare("INSERT INTO events (source, external_id, title, start, end, all_day, location, notes, important, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(source, external_id, ev.title, ev.start, ev.end, ev.all_day, ev.location, ev.notes, ev.important, source === "google" ? null : ev.recurrence);
  changed("calendar");
  return get(r.lastInsertRowid);
}
export async function update(id, patch) {
  const cur = get(id);
  if (!cur) throw Object.assign(new Error("Event not found"), { status: 404 });
  const ev = normalize({ ...cur, ...patch });
  if (cur.source === "google") {
    const t = await googleToken();
    if (!t) throw Object.assign(new Error("Google Calendar is not connected, so this event can't be changed."), { status: 409 });
    await google.patchEvent(t, cur.external_id, google.toGoogle(ev, getSettings().timezone));
  }
  db.prepare("UPDATE events SET title = ?, start = ?, end = ?, all_day = ?, location = ?, notes = ?, important = ?, recurrence = ?, updated_at = datetime('now') WHERE id = ?")
    .run(ev.title, ev.start, ev.end, ev.all_day, ev.location, ev.notes, ev.important, cur.source === "google" ? null : ev.recurrence, id);
  changed("calendar");
  return get(id);
}
export async function remove(id) {
  const cur = get(id);
  if (!cur) return false;
  if (cur.source === "google") {
    const t = await googleToken();
    if (!t) throw Object.assign(new Error("Google Calendar is not connected, so this event can't be deleted."), { status: 409 });
    await google.deleteEvent(t, cur.external_id);
  }
  db.prepare("DELETE FROM events WHERE id = ?").run(id);
  changed("calendar");
  return true;
}
