// Background services. Each run is recorded, so the health panel reports what really happened.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, kvGet, kvSet, getSettings } from "./db.js";
import { reminders } from "./services/work.js";
import { notifyAll } from "./push.js";
import { generateIdea, briefing, brainReady } from "./brain.js";
import * as finance from "./finance/service.js";
import * as calendar from "./services/calendar.js";
import { connections } from "./services/oauth.js";
import { getWeather } from "./integrations/weather.js";
import { register, tracked } from "./services/health.js";
import { changed } from "./realtime.js";

function localParts(tz, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}

// ---------------- Jobs
export async function fireDueReminders() {
  let fired = 0;
  for (const r of reminders.due()) {
    if (!reminders.claim(r.id)) continue;          // exactly-once, even with overlapping runs
    fired++;
    await notifyAll({ title: "Reminder, sir", body: r.text, tag: `reminder-${r.id}`, url: "/?tab=agenda", urgency: "high", kind: "reminder", speak: `Pardon the interruption, sir. A reminder: ${r.text}.` });
  }
  if (fired) changed("reminders");
  return { fired };
}

export async function eventAlerts() {
  const soon = calendar.list(new Date().toISOString(), new Date(Date.now() + 15 * 60_000).toISOString()).filter((e) => !e.all_day && Date.parse(e.start) > Date.now());
  const sent = new Set(kvGet("eventAlerts", []));
  let n = 0;
  for (const e of soon) {
    const key = `${e.id}@${e.start}`;
    if (sent.has(key)) continue;
    sent.add(key); n++;
    const mins = Math.max(1, Math.round((Date.parse(e.start) - Date.now()) / 60000));
    await notifyAll({ title: `In ${mins} minutes: ${e.title}`, body: e.location || "", tag: `event-${e.id}`, url: "/?tab=agenda", kind: "event" });
  }
  kvSet("eventAlerts", [...sent].slice(-200));
  return { alerts: n };
}

let ideaRunning = false;
export async function runIdeaJob({ force = false } = {}) {
  const s = getSettings();
  if (ideaRunning || !brainReady() || (!force && !s.ideas.enabled)) return null;
  if (!force && Date.now() - kvGet("ideas.lastRun", 0) < s.ideas.everyMinutes * 60_000 - 5_000) return null;
  ideaRunning = true;
  kvSet("ideas.lastRun", Date.now());
  try {
    return await tracked("ideas", async () => {
      const idea = await generateIdea();
      if (idea) await notifyAll({ title: `New idea: ${idea.title}`, body: `First move: ${idea.first_move}`, tag: `idea-${idea.id}`, url: `/?tab=ideas&idea=${idea.id}`, kind: "idea" });
      return idea;
    });
  } finally { ideaRunning = false; }
}

export async function runBriefingJob({ force = false } = {}) {
  const s = getSettings();
  const { date, hm } = localParts(s.timezone);
  if (!force && (!s.briefing.enabled || hm < s.briefing.time || kvGet("briefing.lastDate") === date)) return null;
  kvSet("briefing.lastDate", date);
  return tracked("briefing", async () => {
    const b = await briefing({});
    kvSet("briefing.latest", { text: b.text, sources: b.sources || [], at: new Date().toISOString() });
    await notifyAll({ title: "Your briefing, sir", body: b.text.split(/(?<=[.!?])\s/)[0], tag: "briefing", url: "/?briefing=1", kind: "briefing" });
    changed("briefing");
    return { chars: b.text.length };
  });
}

export async function backup() {
  const dir = path.join(config.dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `jarvis-${new Date().toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try { fs.chmodSync(file, 0o600); } catch {}
  const old = fs.readdirSync(dir).filter((f) => /^jarvis-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -7);
  for (const f of old) fs.rmSync(path.join(dir, f));
  kvSet("backup.last", { file: path.basename(file), at: new Date().toISOString() });
  return { file: path.basename(file), kept: Math.min(7, fs.readdirSync(dir).length) };
}

// ---------------- Registry + loops
const every = (ms, fn) => { const t = setInterval(() => fn().catch(() => {}), ms); t.unref?.(); return t; };

export function startScheduler() {
  const s = () => getSettings();
  register("reminders", { label: "Reminder delivery", everyMs: config.reminderPollSeconds * 1000, note: "Runs on the server, so reminders arrive even when your apps are closed." });
  register("event_alerts", { label: "Calendar alerts", everyMs: 60_000 });
  register("briefing", { label: "Daily briefing", everyMs: 0, enabled: () => s().briefing.enabled, note: `Daily at ${s().briefing.time} (${s().timezone}).` });
  register("ideas", { label: "Idea engine", everyMs: 0, configured: brainReady, enabled: () => s().ideas.enabled });
  register("weather", { label: "Weather updates", everyMs: 15 * 60_000 });
  register("finance_sync", { label: "Bank sync", everyMs: config.financeSyncMinutes * 60_000, configured: () => connections.all().some((c) => ["monzo", "demo"].includes(c.provider)), note: "Read-only." });
  register("calendar_sync", { label: "Google Calendar sync", everyMs: config.calendarSyncMinutes * 60_000, configured: () => !!connections.get("google") });
  register("backup", { label: "Database backup", everyMs: 24 * 3600_000, note: "Keeps 7 daily copies in the data folder." });

  const timers = [
    every(config.reminderPollSeconds * 1000, () => tracked("reminders", fireDueReminders)),
    every(60_000, () => tracked("event_alerts", eventAlerts)),
    every(60_000, () => runBriefingJob()),
    every(60_000, () => runIdeaJob()),
    every(15 * 60_000, () => tracked("weather", () => getWeather({ ...s().home, units: s().units }).then((w) => ({ place: w.place, temp: w.current.temp })))),
    every(config.financeSyncMinutes * 60_000, () => connections.all().some((c) => ["monzo", "demo"].includes(c.provider)) ? tracked("finance_sync", finance.syncAll) : Promise.resolve()),
    every(config.calendarSyncMinutes * 60_000, () => connections.get("google") ? tracked("calendar_sync", calendar.syncGoogle) : Promise.resolve()),
    every(3600_000, () => (Date.now() - Date.parse(kvGet("backup.last", { at: 0 }).at || 0) > 23 * 3600_000 ? tracked("backup", backup) : Promise.resolve())),
  ];
  // Catch up after a restart: overdue reminders fire straight away, data refreshes soon after.
  tracked("reminders", fireDueReminders).catch(() => {});
  setTimeout(() => {
    tracked("weather", () => getWeather({ ...s().home, units: s().units }).then((w) => ({ place: w.place, temp: w.current.temp }))).catch(() => {});
    if (connections.all().some((c) => ["monzo", "demo"].includes(c.provider))) tracked("finance_sync", finance.syncAll).catch(() => {});
    if (connections.get("google")) tracked("calendar_sync", calendar.syncGoogle).catch(() => {});
    if (Date.now() - Date.parse(kvGet("backup.last", { at: 0 }).at || 0) > 23 * 3600_000) tracked("backup", backup).catch(() => {});
  }, 5_000).unref?.();
  if (s().ideas.enabled) setTimeout(() => runIdeaJob().catch(() => {}), 20_000).unref?.();
  console.log(`[scheduler] reminders every ${config.reminderPollSeconds}s · briefing ${s().briefing.time} ${s().timezone} · ideas ${s().ideas.enabled ? `every ${s().ideas.everyMinutes}m` : "off"}`);
  return () => timers.forEach(clearInterval);
}
