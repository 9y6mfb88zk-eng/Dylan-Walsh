// Automations: scheduled routines made of safe, allowlisted steps. Every run is recorded with its real output.
// Built-in routines (created once): Morning briefing 07:00, Evening review 21:00, Weekly review Sunday 18:00.
import { db, kvGet, kvSet, getSettings } from "../db.js";
import { crud } from "./crud.js";
import { changed } from "../realtime.js";
import { nextAt, repeatDays, describeLocal } from "./time.js";
import { notify, logActivity } from "./notify.js";

export const ACTION_TYPES = {
  briefing: "Deliver a briefing (morning, afternoon, evening or weekly) — spoken on the laptop and sent to your phone",
  notify: "Send a notification",
  speak: "Say something out loud on the laptop",
  sync: "Refresh data (finance, calendar or weather)",
  backup: "Back up the database",
  focus: "Start a focus session",
  computer: "Run an allowlisted computer action (open an app, folder or website)",
  smarthome: "Control an allowed smart-home device",
};
const SCHEDULES = ["daily", "weekdays", "weekends", "weekly", "custom"];
const bad = (m) => Object.assign(new Error(m), { status: 400, expose: true });
const CATCH_UP_MS = 2 * 3600_000;   // a routine missed by less than two hours (laptop asleep) still runs on wake

function cleanSchedule(s = {}) {
  const type = SCHEDULES.includes(s.type) ? s.type : "daily";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time || ""))) throw bad("Routine time must be HH:MM");
  const days = (Array.isArray(s.days) ? s.days : []).map(Number).filter((d) => d >= 0 && d <= 6);
  if ((type === "weekly" || type === "custom") && !days.length) throw bad("Choose the day(s) this routine runs");
  return { type, time: s.time, days: [...new Set(days)].sort() };
}
function cleanActions(list) {
  if (!Array.isArray(list) || !list.length) throw bad("A routine needs at least one step");
  return list.slice(0, 12).map((a) => {
    if (!ACTION_TYPES[a?.type]) throw bad(`Unknown step type "${a?.type}"`);
    const out = { type: a.type };
    for (const k of ["kind", "title", "body", "text", "target", "label", "action", "entity_id", "service"]) if (a[k] != null) out[k] = String(a[k]).slice(0, k === "text" || k === "body" ? 500 : 120);
    if (a.minutes != null) out.minutes = Math.max(1, Math.min(240, Math.round(Number(a.minutes))));
    if (a.args && typeof a.args === "object") out.args = JSON.parse(JSON.stringify(a.args).slice(0, 2000));
    if (a.type === "briefing" && !["morning", "afternoon", "evening", "weekly"].includes(out.kind || "morning")) throw bad("Briefing kind must be morning, afternoon, evening or weekly");
    if (a.type === "sync" && !["finance", "calendar", "weather"].includes(out.target)) throw bad("Sync target must be finance, calendar or weather");
    return out;
  });
}
function computeNext(r, after = new Date()) {
  if (!r.enabled) return null;
  const s = typeof r.schedule === "string" ? JSON.parse(r.schedule) : r.schedule;
  const days = s.type === "weekly" || s.type === "custom" ? s.days : repeatDays(s.type, s.days);
  return nextAt(s.time, days, after)?.toISOString() || null;
}

const base = crud("routines", {
  entity: "routines", order: "builtin IS NULL, id", touch: true,
  fields: { name: { type: "text", required: true, max: 80 }, description: { type: "text", max: 300 }, enabled: { type: "bool", default: true }, schedule: { type: "json" }, actions: { type: "json" } },
  hydrate: (r) => ({ ...r, next_local: r.next_run_at ? describeLocal(r.next_run_at) : null, lastRun: db.prepare("SELECT id, status, started_at, finished_at, error FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1").get(r.id) || null }),
});
function refreshNext(id) {
  const r = db.prepare("SELECT * FROM routines WHERE id = ?").get(id);
  if (r) db.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").run(computeNext({ ...r, enabled: !!r.enabled }), id);
}

export const routines = {
  ...base,
  create(data = {}) {
    const r = base.create({ ...data, schedule: cleanSchedule(data.schedule), actions: cleanActions(data.actions) });
    refreshNext(r.id); return base.get(r.id);
  },
  update(id, data = {}) {
    const patch = { ...data };
    if (data.schedule) patch.schedule = cleanSchedule(data.schedule);
    if (data.actions) patch.actions = cleanActions(data.actions);
    const r = base.update(id, patch);
    if (r) { refreshNext(id); syncBriefingSetting(base.get(id)); }
    return r && base.get(id);
  },
  remove(id) {
    const r = base.get(id);
    if (r?.builtin) throw bad("Built-in routines can be switched off but not deleted");
    return base.remove(id);
  },
  runs(id, limit = 30) { return db.prepare("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?").all(Number(id), limit); },
  allRuns(limit = 50) { return db.prepare("SELECT rr.*, r.name FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id ORDER BY rr.id DESC LIMIT ?").all(limit); },
  find(q) { return db.prepare("SELECT * FROM routines WHERE name LIKE ? OR builtin = ? LIMIT 1").get(`%${String(q).slice(0, 60)}%`, String(q).toLowerCase()); },
  byBuiltin(kind) { const r = db.prepare("SELECT id FROM routines WHERE builtin = ?").get(kind); return r ? base.get(r.id) : null; },
};

/** Keep Settings → Briefing time/enabled in step with the built-in morning routine. */
function syncBriefingSetting(r) {
  if (r?.builtin !== "morning") return;
  const s = getSettings();
  if (s.briefing.time !== r.schedule.time || s.briefing.enabled !== r.enabled) {
    kvSet("settings", { ...s, briefing: { ...s.briefing, time: r.schedule.time, enabled: r.enabled } });
    changed("settings");
  }
}
export function applyBriefingSetting({ time, enabled }) {
  const r = routines.byBuiltin("morning");
  if (!r) return;
  const patch = {};
  if (time && time !== r.schedule.time) patch.schedule = { ...r.schedule, time };
  if (enabled !== undefined && enabled !== r.enabled) patch.enabled = enabled;
  if (Object.keys(patch).length) base.update(r.id, patch), refreshNext(r.id);
}

/** Create the three built-in routines once (never re-created after the user deletes or edits them). */
export function seedRoutines() {
  if (kvGet("routines.seeded")) return;
  const s = getSettings();
  const defs = [
    { builtin: "morning", name: "Morning briefing", description: "Weather, schedule, priorities, money and projects, spoken when you're up.", schedule: { type: "daily", time: "07:00", days: [] }, actions: [{ type: "briefing", kind: "morning" }], enabled: s.briefing.enabled !== false },
    { builtin: "evening", name: "Evening review", description: "What got done today, tomorrow's schedule, weather and your alarm.", schedule: { type: "daily", time: "21:00", days: [] }, actions: [{ type: "briefing", kind: "evening" }], enabled: true },
    { builtin: "weekly", name: "Weekly review", description: "Your week in numbers: tasks, focus, habits, goals, money and the week ahead.", schedule: { type: "weekly", time: "18:00", days: [0] }, actions: [{ type: "briefing", kind: "weekly" }], enabled: true },
  ];
  for (const d of defs) {
    if (db.prepare("SELECT 1 FROM routines WHERE builtin = ?").get(d.builtin)) continue;
    const r = db.prepare("INSERT INTO routines (name, description, enabled, schedule, actions, builtin) VALUES (?, ?, ?, ?, ?, ?)")
      .run(d.name, d.description, d.enabled ? 1 : 0, JSON.stringify(d.schedule), JSON.stringify(d.actions), d.builtin);
    refreshNext(Number(r.lastInsertRowid));
  }
  kvSet("routines.seeded", true);
  // The spec's default: the morning briefing at 07:00.
  const m = routines.byBuiltin("morning");
  if (m) kvSet("settings", { ...getSettings(), briefing: { ...getSettings().briefing, time: m.schedule.time, enabled: m.enabled } });
  changed("routines");
}

// ---------------------------------------------------------------- Running
async function runStep(step, ctx) {
  switch (step.type) {
    case "briefing": {
      const [{ deliverBriefing }, { tracked }] = await Promise.all([import("./briefings.js"), import("./health.js")]);
      const b = await tracked("briefing", () => deliverBriefing(step.kind || "morning", { trigger: ctx.trigger }));
      return `${step.kind || "morning"} briefing delivered (${b.text.length} characters)`;
    }
    case "notify": await notify({ kind: "automation", title: step.title || ctx.routine.name, body: step.body || "", url: "/?tab=automations" }); return "Notification sent";
    case "speak": await notify({ kind: "automation", title: ctx.routine.name, body: step.text, speak: step.text, push: false }); return "Spoken on connected laptops";
    case "sync": {
      if (step.target === "finance") { const f = await import("../finance/service.js"); const r = await f.syncAll(); return `Finance synced (${r.connections} connection(s), ${r.errors} error(s))`; }
      if (step.target === "calendar") { const c = await import("./calendar.js"); const r = await c.syncGoogle(); return r.synced ? `Calendar synced (${r.events} events)` : "Google Calendar not connected"; }
      const { getWeather } = await import("../integrations/weather.js"); const s = getSettings(); const w = await getWeather({ ...s.home, units: s.units }); return `Weather refreshed: ${w.current.temp}${w.unitTemp}, ${w.current.summary}`;
    }
    case "backup": { const { backup } = await import("../scheduler.js"); const r = await backup(); return `Backup saved (${r.file})`; }
    case "focus": { const { focus } = await import("./records.js"); const f = focus.start({ minutes: step.minutes || 25, label: step.label || "Focus" }); return `Focus session started (${f.planned_minutes} min)`; }
    case "computer": {
      const { runComputerAction } = await import("./computer.js");
      const r = await runComputerAction(step.action, step.args || {}, { requestedBy: "automation" });
      if (!r.ok) throw new Error(r.error || "Computer action failed");
      return `Computer: ${step.action} done`;
    }
    case "smarthome": {
      const sh = await import("./smarthome.js");
      const r = await sh.control(step.entity_id, step.service, step.args || {}, { deviceId: "automation" });
      return `${r.device}: now ${r.state}`;
    }
    default: throw new Error(`Unknown step ${step.type}`);
  }
}

const running = new Set();
export async function runRoutine(id, { trigger = "manual" } = {}) {
  const r = routines.get(id);
  if (!r) throw Object.assign(new Error("No such routine"), { status: 404, expose: true });
  if (running.has(r.id)) return { status: "already_running" };
  running.add(r.id);
  const run = db.prepare("INSERT INTO routine_runs (routine_id, trigger) VALUES (?, ?)").run(r.id, trigger);
  const runId = Number(run.lastInsertRowid);
  changed("routines");
  const out = []; let errors = 0;
  try {
    for (const step of r.actions) {
      try { out.push(`✓ ${await runStep(step, { routine: r, trigger })}`); }
      catch (e) { errors++; out.push(`✗ ${step.type}: ${e.message}`); }
    }
  } finally {
    running.delete(r.id);
    const status = errors === r.actions.length ? "error" : errors ? "partial" : "ok";
    db.prepare("UPDATE routine_runs SET finished_at = ?, status = ?, output = ?, error = ? WHERE id = ?")
      .run(new Date().toISOString(), status, out.join("\n"), errors ? `${errors} step(s) failed` : null, runId);
    db.prepare("UPDATE routines SET last_run_at = ? WHERE id = ?").run(new Date().toISOString(), r.id);
    logActivity("automation", `Routine "${r.name}" ran (${trigger}): ${errors ? `${errors} problem(s)` : "all steps OK"}`, { id: r.id, runId });
    if (errors) await notify({ kind: "automation", title: `Routine "${r.name}" had a problem`, body: out.filter((l) => l.startsWith("✗")).join(" · "), url: "/?tab=automations" }).catch(() => {});
    changed("routines");
  }
  return { status: errors ? "partial" : "ok", runId, output: out };
}

/** Scheduler tick: run routines whose time has come; record (not run) ones missed by more than two hours. */
export async function tickRoutines(now = new Date()) {
  let ran = 0;
  for (const r of db.prepare("SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now.toISOString())) {
    const late = now - new Date(r.next_run_at);
    db.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").run(computeNext({ ...r, enabled: true }, new Date(Math.max(now.getTime(), Date.parse(r.next_run_at)) + 1000)), r.id);
    if (late > CATCH_UP_MS) {
      db.prepare("INSERT INTO routine_runs (routine_id, trigger, finished_at, status, output) VALUES (?, 'schedule', ?, 'skipped', ?)")
        .run(r.id, now.toISOString(), `Missed: JARVIS wasn't running at ${describeLocal(r.next_run_at)}`);
      changed("routines");
      continue;
    }
    ran++;
    runRoutine(r.id, { trigger: "schedule" }).catch(() => {});
  }
  return { ran };
}
export function recomputeRoutines() {
  for (const r of db.prepare("SELECT * FROM routines").all()) {
    if (r.next_run_at && r.next_run_at <= new Date().toISOString()) continue;
    db.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").run(computeNext({ ...r, enabled: !!r.enabled }), r.id);
  }
}
