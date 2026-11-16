// Alarm engine (source of truth). The Windows app's background agent rings alarms locally from this schedule
// (full-screen, real audio); the server also pushes them to phones and records every ring/snooze/dismiss.
import fs from "node:fs";
import path from "node:path";
import { db, getSettings } from "../db.js";
import { config } from "../config.js";
import { changed, broadcast } from "../realtime.js";
import { randomId } from "../security/crypto.js";
import { nextAt, repeatDays, fromLocal, localDate, localHM, userTz, spokenTime, partOfDay, describeLocal } from "./time.js";
import { notify, logActivity } from "./notify.js";

export const BUILTIN_SOUNDS = { chime: "Chime", classic: "Classic bell", radar: "Radar", gentle: "Gentle rise", digital: "Digital" };
const REPEATS = ["once", "daily", "weekdays", "weekends", "custom"];
const LATE_LIMIT_MS = 15 * 60_000;          // a ring more than 15 minutes late is recorded as missed, not played
const bad = (m) => Object.assign(new Error(m), { status: 400, expose: true });

/** Accepts "7", "7:30", "07:30", "7.30", "7:30pm", "19:30" → "HH:MM". */
export function parseTime(t) {
  const m = String(t ?? "").trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) throw bad("Alarm time must look like 07:30");
  let h = +m[1]; const mi = +(m[2] || 0);
  if (m[3]?.startsWith("p") && h < 12) h += 12;
  if (m[3]?.startsWith("a") && h === 12) h = 0;
  if (h > 23 || mi > 59) throw bad("Alarm time must be a real time of day");
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function computeNext(a, after = new Date()) {
  if (!a.enabled) return null;
  if (a.repeat === "once") {
    if (!a.date) return null;
    const t = fromLocal(a.date, a.time);
    return t > after ? t : null;
  }
  return nextAt(a.time, repeatDays(a.repeat, JSON.parse(typeof a.days === "string" ? a.days : JSON.stringify(a.days || []))), after);
}

function hydrate(a) {
  if (!a) return null;
  const days = JSON.parse(a.days || "[]");
  const effective = [a.snoozed_until, a.next_at].filter(Boolean).sort()[0] || null;
  return {
    ...a, days, enabled: !!a.enabled, gradual: !!a.gradual, effective_next: effective,
    next_local: effective ? describeLocal(effective) : null,
    sound_name: BUILTIN_SOUNDS[a.sound] || (a.sound.startsWith("custom:") ? db.prepare("SELECT name FROM alarm_sounds WHERE id = ?").get(a.sound.slice(7))?.name || "Custom sound" : a.sound),
  };
}

function clean(data, cur = {}) {
  const tz = userTz();
  const out = {};
  if (data.time !== undefined || !cur.time) out.time = parseTime(data.time ?? cur.time);
  const repeat = data.repeat ?? cur.repeat ?? "once";
  if (!REPEATS.includes(repeat)) throw bad(`Repeat must be one of ${REPEATS.join(", ")}`);
  out.repeat = repeat;
  if (data.days !== undefined) {
    const days = (Array.isArray(data.days) ? data.days : []).map(Number).filter((d) => d >= 0 && d <= 6);
    out.days = JSON.stringify([...new Set(days)].sort());
  }
  if (repeat === "custom" && JSON.parse(out.days ?? cur.days ?? "[]").length === 0) throw bad("Choose at least one day for a custom repeat");
  if (data.date !== undefined) {
    if (data.date && !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw bad("Alarm date must be YYYY-MM-DD");
    out.date = data.date || null;
  }
  const time = out.time ?? cur.time;
  if (repeat === "once") {
    const date = out.date !== undefined ? out.date : cur.date;
    // One-off alarm without a date: the next time this clock time comes round.
    if (!date || fromLocal(date, time) <= new Date()) {
      const today = localDate(new Date(), tz);
      out.date = fromLocal(today, time) > new Date() ? today : localDate(new Date(Date.now() + 86400_000), tz);
      if (date && fromLocal(date, time) <= new Date() && data.date) throw bad("That alarm time has already passed");
    }
  } else out.date = null;
  if (data.label !== undefined) out.label = String(data.label).trim().slice(0, 60) || "Alarm";
  if (data.sound !== undefined) {
    const s = String(data.sound);
    if (!BUILTIN_SOUNDS[s] && !(s.startsWith("custom:") && db.prepare("SELECT 1 FROM alarm_sounds WHERE id = ?").get(s.slice(7)))) throw bad("Unknown alarm sound");
    out.sound = s;
  }
  if (data.volume !== undefined) out.volume = Math.max(5, Math.min(100, Math.round(Number(data.volume) || 80)));
  if (data.gradual !== undefined) out.gradual = data.gradual ? 1 : 0;
  if (data.snooze_minutes !== undefined) out.snooze_minutes = Math.max(1, Math.min(60, Math.round(Number(data.snooze_minutes) || 10)));
  if (data.message !== undefined) out.message = String(data.message).trim().slice(0, 200);
  if (data.enabled !== undefined) out.enabled = data.enabled ? 1 : 0;
  return out;
}

export const alarms = {
  list() { return db.prepare("SELECT * FROM alarms ORDER BY enabled DESC, COALESCE(snoozed_until, next_at, '9999'), time").all().map(hydrate); },
  get(id) { return hydrate(db.prepare("SELECT * FROM alarms WHERE id = ?").get(Number(id))); },
  create(data = {}, { deviceId } = {}) {
    const d = getSettings().alarms || {};
    const c = clean({ sound: d.defaultSound || "chime", volume: d.defaultVolume ?? 80, gradual: d.gradual ?? true, snooze_minutes: d.snoozeMinutes ?? 10, ...data });
    const row = { label: "Alarm", days: "[]", enabled: 1, message: "", ...c };
    row.next_at = computeNext({ ...row, enabled: true })?.toISOString() || null;
    const cols = Object.keys(row);
    const r = db.prepare(`INSERT INTO alarms (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((k) => row[k]));
    const a = alarms.get(r.lastInsertRowid);
    logActivity("alarm", `Alarm set: ${a.label} — ${a.next_local}`, { id: a.id }, deviceId);
    changed("alarms");
    return a;
  },
  update(id, data = {}, { deviceId } = {}) {
    const cur = db.prepare("SELECT * FROM alarms WHERE id = ?").get(Number(id));
    if (!cur) return null;
    const c = clean(data, cur);
    const merged = { ...cur, ...c };
    merged.next_at = computeNext({ ...merged, enabled: !!merged.enabled })?.toISOString() || null;
    const sets = { ...c, next_at: merged.next_at, snoozed_until: null };
    db.prepare(`UPDATE alarms SET ${Object.keys(sets).map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(sets), Number(id));
    const a = alarms.get(id);
    logActivity("alarm", `Alarm updated: ${a.label} — ${a.enabled ? a.next_local || "not scheduled" : "off"}`, { id: a.id }, deviceId);
    changed("alarms");
    return a;
  },
  remove(id, { deviceId } = {}) {
    const a = alarms.get(id);
    const ok = db.prepare("DELETE FROM alarms WHERE id = ?").run(Number(id)).changes > 0;
    if (ok) { logActivity("alarm", `Alarm deleted: ${a.label}`, { id: Number(id) }, deviceId); changed("alarms"); broadcast({ type: "alarm.dismissed", id: Number(id) }); }
    return ok;
  },

  /** What the desktop agent needs to ring alarms on its own for the next 48 hours (and what is ringing now). */
  schedule(hours = 48) {
    const until = Date.now() + hours * 3600_000;
    const upcoming = [];
    for (const raw of db.prepare("SELECT * FROM alarms WHERE enabled = 1").all()) {
      const a = hydrate(raw);
      const base = { alarmId: a.id, label: a.label, sound: a.sound, volume: a.volume, gradual: a.gradual, message: a.message, snoozeMinutes: a.snooze_minutes };
      if (a.snoozed_until) upcoming.push({ ...base, at: a.snoozed_until, snoozed: true });
      let t = a.next_at ? new Date(a.next_at) : null;
      for (let i = 0; t && t.getTime() <= until && i < 4; i++) {
        upcoming.push({ ...base, at: t.toISOString() });
        if (a.repeat === "once") break;
        t = computeNext(raw, new Date(t.getTime() + 1000));
      }
    }
    upcoming.sort((x, y) => x.at.localeCompare(y.at));
    return { generatedAt: new Date().toISOString(), timezone: userTz(), upcoming, ringing: alarms.ringing() };
  },

  /** Alarms that rang in the last 20 minutes and haven't been snoozed or dismissed since. */
  ringing() {
    const since = new Date(Date.now() - 20 * 60_000).toISOString();
    return db.prepare(`SELECT e.alarm_id, e.scheduled_for, e.at, a.label, a.sound, a.volume, a.gradual, a.message, a.snooze_minutes
      FROM alarm_events e JOIN alarms a ON a.id = e.alarm_id
      WHERE e.event = 'rang' AND e.at >= ? AND NOT EXISTS (
        SELECT 1 FROM alarm_events x WHERE x.alarm_id = e.alarm_id AND x.event IN ('snoozed','dismissed') AND x.at >= e.at)
      GROUP BY e.alarm_id ORDER BY e.at DESC`).all(since);
  },

  /** Record that an alarm went off (idempotent per alarm, scheduled time and device) and move it on. */
  rang(id, scheduledFor, { deviceId = "server", detail = "", now = new Date() } = {}) {
    const a = db.prepare("SELECT * FROM alarms WHERE id = ?").get(Number(id));
    if (!a) return null;
    const sf = scheduledFor ? new Date(scheduledFor).toISOString() : new Date().toISOString();
    const dup = db.prepare("SELECT 1 FROM alarm_events WHERE alarm_id = ? AND scheduled_for = ? AND event = 'rang' AND device_id IS ?").get(a.id, sf, deviceId);
    if (!dup) db.prepare("INSERT INTO alarm_events (alarm_id, label, scheduled_for, event, device_id, detail) VALUES (?, ?, ?, 'rang', ?, ?)").run(a.id, a.label, sf, deviceId, String(detail).slice(0, 300));
    // The ring belongs to the occurrence at scheduledFor: move the alarm past it even if reported a little early.
    advance(a, new Date(Math.max(now.getTime(), Date.parse(sf))));
    broadcast({ type: "alarm.ringing", alarm: alarms.get(a.id), scheduledFor: sf, speech: alarms.speech(a, new Date(sf)) });
    changed("alarms");
    return alarms.get(a.id);
  },
  snooze(id, minutes, { deviceId } = {}) {
    const a = db.prepare("SELECT * FROM alarms WHERE id = ?").get(Number(id));
    if (!a) return null;
    const mins = Math.max(1, Math.min(60, Math.round(Number(minutes) || a.snooze_minutes || 10)));
    const until = new Date(Date.now() + mins * 60_000).toISOString();
    db.prepare("UPDATE alarms SET snoozed_until = ? WHERE id = ?").run(until, a.id);
    db.prepare("INSERT INTO alarm_events (alarm_id, label, scheduled_for, event, device_id, detail) VALUES (?, ?, ?, 'snoozed', ?, ?)").run(a.id, a.label, until, deviceId || null, `${mins} minutes`);
    broadcast({ type: "alarm.snoozed", id: a.id, until, minutes: mins });
    changed("alarms");
    return { until, minutes: mins, alarm: alarms.get(a.id) };
  },
  dismiss(id, { deviceId } = {}) {
    const a = db.prepare("SELECT * FROM alarms WHERE id = ?").get(Number(id));
    if (!a) return null;
    db.prepare("UPDATE alarms SET snoozed_until = NULL WHERE id = ?").run(a.id);
    db.prepare("INSERT INTO alarm_events (alarm_id, label, scheduled_for, event, device_id) VALUES (?, ?, ?, 'dismissed', ?)").run(a.id, a.label, new Date().toISOString(), deviceId || null);
    broadcast({ type: "alarm.dismissed", id: a.id });
    changed("alarms");
    return alarms.get(a.id);
  },
  event(id, event, detail = "", { deviceId } = {}) {
    const a = db.prepare("SELECT * FROM alarms WHERE id = ?").get(Number(id));
    db.prepare("INSERT INTO alarm_events (alarm_id, label, scheduled_for, event, device_id, detail) VALUES (?, ?, ?, ?, ?, ?)").run(a?.id ?? null, a?.label ?? "Test alarm", new Date().toISOString(), event, deviceId || null, String(detail).slice(0, 300));
    changed("alarms");
  },
  history(limit = 100) { return db.prepare("SELECT * FROM alarm_events ORDER BY id DESC LIMIT ?").all(limit); },

  /** Spoken greeting when an alarm goes off, e.g. "Good morning, Sir. It is 7 AM. Time to wake up." */
  speech(alarm, at = new Date()) {
    const title = getSettings().profile?.title || "Sir";
    const pod = partOfDay(at);
    const msg = alarm.message || (alarm.label && alarm.label !== "Alarm" ? `This is your ${alarm.label} alarm.` : pod === "morning" ? "Time to wake up." : "This is your alarm.");
    return `Good ${pod}, ${title}. It is ${spokenTime(at)}. ${msg}`;
  },

  /** Server loop: alarms that are due now — record, push to phones, and move on. */
  async processDue(now = new Date()) {
    let fired = 0;
    for (const a of db.prepare("SELECT * FROM alarms WHERE enabled = 1 OR snoozed_until IS NOT NULL").all()) {
      const due = [a.snoozed_until, a.enabled ? a.next_at : null].filter((t) => t && t <= now.toISOString()).sort()[0];
      if (!due) continue;
      const late = now - new Date(due);
      if (late > LATE_LIMIT_MS) {
        db.prepare("INSERT INTO alarm_events (alarm_id, label, scheduled_for, event, device_id, detail) VALUES (?, ?, ?, 'missed', 'server', ?)").run(a.id, a.label, due, `${Math.round(late / 60000)} minutes late (JARVIS was not running)`);
        advance(a, now);
        await notify({ kind: "alarm", title: `Missed alarm: ${a.label}`, body: `It was set for ${describeLocal(due)}.`, url: "/?tab=alarms" });
        changed("alarms");
        continue;
      }
      fired++;
      alarms.rang(a.id, due, { deviceId: "server", now });
      await notify({ kind: "alarm", title: `⏰ ${a.label}`, body: a.message || `It's ${localHM(now)}.`, url: "/?tab=alarms", urgency: "high", speak: alarms.speech(a, new Date(due)), data: { alarmId: a.id, scheduledFor: due } });
    }
    return { fired };
  },

  // ---------------- Custom sounds
  sounds() {
    return [
      ...Object.entries(BUILTIN_SOUNDS).map(([id, name]) => ({ id, name, builtin: true, url: `/sounds/${id}.wav` })),
      ...db.prepare("SELECT * FROM alarm_sounds ORDER BY created_at").all().map((s) => ({ id: `custom:${s.id}`, name: s.name, builtin: false, size: s.size, url: `/api/alarms/sounds/${s.id}/file` })),
    ];
  },
  addSound(buffer, { name, mime }) {
    if (!buffer?.length) throw bad("No audio file received");
    if (buffer.length > 8 * 1024 * 1024) throw bad("Alarm sounds must be under 8 MB");
    const ext = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/webm": "webm" }[mime];
    if (!ext) throw bad("Upload an MP3, WAV, OGG, M4A or AAC file");
    const id = randomId().slice(0, 12);
    const dir = path.join(config.dataDir, "sounds");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.${ext}`), buffer);
    db.prepare("INSERT INTO alarm_sounds (id, name, file, mime, size) VALUES (?, ?, ?, ?, ?)").run(id, String(name || "Custom sound").slice(0, 60), `${id}.${ext}`, mime, buffer.length);
    changed("alarms");
    return { id: `custom:${id}`, name };
  },
  soundFile(id) {
    const s = db.prepare("SELECT * FROM alarm_sounds WHERE id = ?").get(String(id));
    return s ? { path: path.join(config.dataDir, "sounds", s.file), mime: s.mime } : null;
  },
  removeSound(id) {
    const s = db.prepare("SELECT * FROM alarm_sounds WHERE id = ?").get(String(id));
    if (!s) return false;
    db.prepare("UPDATE alarms SET sound = 'chime' WHERE sound = ?").run(`custom:${id}`);
    db.prepare("DELETE FROM alarm_sounds WHERE id = ?").run(s.id);
    try { fs.rmSync(path.join(config.dataDir, "sounds", s.file)); } catch {}
    changed("alarms");
    return true;
  },
};

/** Move an alarm past the occurrence that just happened (clears an expired snooze, disables a finished one-off). */
function advance(a, now = new Date()) {
  const nowIso = now.toISOString();
  const sets = [];
  if (a.snoozed_until && a.snoozed_until <= nowIso) sets.push(["snoozed_until", null]);
  if (a.next_at && a.next_at <= nowIso) {
    const next = a.repeat === "once" ? null : computeNext({ ...a, enabled: true }, new Date(Math.max(now.getTime(), new Date(a.next_at).getTime()) + 1000));
    sets.push(["next_at", next ? next.toISOString() : null]);
    if (a.repeat === "once") sets.push(["enabled", 0]);
  }
  if (sets.length) db.prepare(`UPDATE alarms SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...sets.map(([, v]) => v), a.id);
}

/** Re-derive next ring times (after a time-zone change or start-up). */
export function recomputeAll() {
  for (const a of db.prepare("SELECT * FROM alarms").all()) {
    if (a.next_at && a.next_at <= new Date().toISOString()) continue;    // due ones are handled by processDue
    const next = computeNext({ ...a, enabled: !!a.enabled });
    db.prepare("UPDATE alarms SET next_at = ? WHERE id = ?").run(next ? next.toISOString() : null, a.id);
  }
}
