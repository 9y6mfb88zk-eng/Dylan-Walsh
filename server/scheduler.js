// Background services. Each run is recorded, so the health panel reports what really happened.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, kvGet, kvSet, getSettings } from "./db.js";
import { reminders } from "./services/work.js";
import { generateIdea, brainReady } from "./brain.js";
import { notify, notifications } from "./services/notify.js";
import { alarms, recomputeAll as recomputeAlarms } from "./services/alarms.js";
import { tickRoutines, seedRoutines, recomputeRoutines } from "./services/automations.js";
import { focus, habits } from "./services/records.js";
import { runDiagnostics, logError } from "./services/diagnostics.js";
import { reconcileManual } from "./services/money.js";
import * as finance from "./finance/service.js";
import * as calendar from "./services/calendar.js";
import { connections } from "./services/oauth.js";
import { getWeather } from "./integrations/weather.js";
import { register, tracked } from "./services/health.js";
import { changed } from "./realtime.js";

// ---------------- Jobs
export async function fireDueReminders() {
  let fired = 0;
  for (const r of reminders.due()) {
    if (!reminders.claim(r.id)) continue;          // exactly-once, even with overlapping runs
    fired++;
    const title = getSettings().profile?.title || "Sir";
    await notify({ kind: "reminder", title: `Reminder, ${title}`, body: r.text, tag: `reminder-${r.id}`, url: "/?tab=reminders", urgency: "high", speak: `Pardon the interruption, ${title}. A reminder: ${r.text}.`, data: { reminderId: r.id } });
    if (r.repeat && r.repeat !== "none") reminders.reschedule(r.id);
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
    await notify({ kind: "event", title: `In ${mins} minutes: ${e.title}`, body: e.location || "", tag: `event-${e.id}`, url: "/?tab=calendar", speak: `${e.title} starts in ${mins} minute${mins === 1 ? "" : "s"}.` });
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
      if (idea) await notify({ kind: "idea", title: `New idea: ${idea.title}`, body: `First move: ${idea.first_move}`, tag: `idea-${idea.id}`, url: `/?tab=intelligence&idea=${idea.id}` });
      return idea;
    });
  } finally { ideaRunning = false; }
}

/** Manual "brief me now" (the scheduled briefings run as built-in routines in Automations). */
export async function runBriefingJob({ kind = "morning" } = {}) {
  const { deliverBriefing } = await import("./services/briefings.js");
  return tracked("briefing", () => deliverBriefing(kind, { trigger: "manual" }).then((b) => ({ kind, chars: b.text.length })));
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

let stopScheduler = null;
export function startScheduler() {
  if (stopScheduler) return stopScheduler;          // never run two copies of the background loops
  const s = () => getSettings();
  seedRoutines();
  import("./services/automations.js").then((a) => a.seedMacros()).catch((e) => console.error("[macros] seed failed", e.message));
  // The starting personal profile (once) and the KILL HOUSE workspace, if it doesn't exist yet.
  import("./services/memory.js").then(async ({ seedProfile }) => {
    const fresh = !kvGet("profile.seeded");
    await seedProfile({ kvGet, kvSet });
    if (fresh) {
      const { projects } = await import("./services/work.js");
      if (!projects.find("KILL HOUSE")) projects.create({ title: "KILL HOUSE", kind: "creative", goal: "A gritty British dystopian survival thriller set during a fictional civil war. Keep characters, world-building, plot outlines and chapter notes here." });
    }
  }).catch((e) => console.error("[profile] seed failed", e.message));
  recomputeAlarms();
  recomputeRoutines();
  const syncFinance = async () => { const r = await finance.syncAll(); reconcileManual(); return r; };
  const weather = () => getWeather({ ...s().home, units: s().units }).then((w) => ({ place: w.place, temp: w.current.temp }));
  const hasBank = () => connections.all().some((c) => ["monzo", "demo"].includes(c.provider));

  register("alarms", { label: "Alarms", everyMs: 5_000, note: "Checked every 5 seconds. The Windows app rings alarms itself, even with the window closed." });
  register("reminders", { label: "Reminder delivery", everyMs: config.reminderPollSeconds * 1000, note: "Runs on the server, so reminders arrive even when your apps are closed." });
  register("routines", { label: "Automations & briefings", everyMs: 30_000, note: "Morning briefing, evening review, weekly review and your own routines." });
  register("event_alerts", { label: "Calendar alerts", everyMs: 60_000 });
  register("briefing", { label: "Briefings", everyMs: 0, enabled: () => s().briefing.enabled !== false, note: `Morning briefing ${s().briefing.time} (${s().timezone}); evening and weekly reviews in Automations.` });
  register("focus", { label: "Focus timer", everyMs: 15_000 });
  register("habits", { label: "Habit reminders", everyMs: 60_000 });
  register("notifications", { label: "Snoozed notifications", everyMs: 30_000 });
  register("ideas", { label: "Idea engine", everyMs: 0, configured: brainReady, enabled: () => s().ideas.enabled });
  register("weather", { label: "Weather updates", everyMs: 15 * 60_000 });
  register("finance_sync", { label: "Bank sync", everyMs: config.financeSyncMinutes * 60_000, configured: hasBank, note: "Read-only." });
  register("calendar_sync", { label: "Google Calendar sync", everyMs: config.calendarSyncMinutes * 60_000, configured: () => !!connections.get("google") });
  register("diagnostics", { label: "Diagnostics history", everyMs: 10 * 60_000 });
  register("backup", { label: "Database backup", everyMs: 24 * 3600_000, note: "Keeps 7 daily copies in the data folder." });

  const safe = (name, fn) => () => tracked(name, fn).catch((e) => logError(name, e.message));
  const timers = [
    every(5_000, safe("alarms", () => alarms.processDue())),
    every(config.reminderPollSeconds * 1000, safe("reminders", fireDueReminders)),
    every(30_000, safe("routines", () => tickRoutines())),
    every(60_000, safe("event_alerts", eventAlerts)),
    every(15_000, safe("focus", () => focus.tick())),
    every(60_000, safe("habits", () => habits.remind())),
    every(30_000, safe("notifications", () => notifications.deliverSnoozed())),
    every(60_000, () => runIdeaJob().catch((e) => logError("ideas", e.message))),
    every(15 * 60_000, safe("weather", weather)),
    every(config.financeSyncMinutes * 60_000, () => (hasBank() ? safe("finance_sync", syncFinance)() : Promise.resolve())),
    every(config.calendarSyncMinutes * 60_000, () => (connections.get("google") ? safe("calendar_sync", calendar.syncGoogle)() : Promise.resolve())),
    every(10 * 60_000, safe("diagnostics", () => runDiagnostics({ record: true }).then((d) => ({ overall: d.overall, errors: d.counts.error || 0 })))),
    every(3600_000, () => (Date.now() - Date.parse(kvGet("backup.last", { at: 0 }).at || 0) > 23 * 3600_000 ? safe("backup", backup)() : Promise.resolve())),
  ];
  // Catch up after a restart: overdue alarms/reminders are handled straight away, data refreshes soon after.
  safe("alarms", () => alarms.processDue())();
  safe("reminders", fireDueReminders)();
  safe("routines", () => tickRoutines())();
  setTimeout(() => {
    safe("weather", weather)();
    if (hasBank()) safe("finance_sync", syncFinance)();
    if (connections.get("google")) safe("calendar_sync", calendar.syncGoogle)();
    if (Date.now() - Date.parse(kvGet("backup.last", { at: 0 }).at || 0) > 23 * 3600_000) safe("backup", backup)();
    safe("diagnostics", () => runDiagnostics({ record: true }).then((d) => ({ overall: d.overall })))();
  }, 5_000).unref?.();
  if (s().ideas.enabled) setTimeout(() => runIdeaJob().catch(() => {}), 20_000).unref?.();
  console.log(`[scheduler] alarms every 5s · reminders every ${config.reminderPollSeconds}s · routines every 30s · ${s().timezone} · ideas ${s().ideas.enabled ? `every ${s().ideas.everyMinutes}m` : "off"}`);
  stopScheduler = () => { timers.forEach(clearInterval); stopScheduler = null; };
  return stopScheduler;
}
