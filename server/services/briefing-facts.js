// Facts for morning / afternoon / evening / weekly briefings, gathered only from real data.
import { db, getSettings } from "../db.js";
import { tasks, reminders, projects } from "./work.js";
import * as calendar from "./calendar.js";
import * as finance from "../finance/service.js";
import { getWeather, weatherSentence } from "../integrations/weather.js";
import * as pending from "./pending.js";
import { alarms } from "./alarms.js";
import { habits, focus, goals, businessSummary } from "./records.js";
import { localDate, addDays, fromLocal, describeLocal } from "./time.js";
import { GBP } from "../finance/engine.js";

export const KINDS = ["morning", "afternoon", "evening", "weekly"];
const fmt = (iso, tz) => new Date(iso).toLocaleString("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" });
const hm = (iso) => (iso ? String(iso).slice(11, 16) : "?");

async function weatherFacts(s, loc, { sun = false } = {}) {
  try {
    const w = await getWeather({ ...(loc?.lat ? loc : s.home), units: s.units });
    return { w, line: `Weather: ${weatherSentence(w)}${sun ? ` Sunrise ${hm(w.today.sunrise)}, sunset ${hm(w.today.sunset)} (local time there).` : ""}` };
  } catch (e) { return { w: null, line: `Weather: unavailable (${e.message}).` }; }
}
function eventsLine(label, from, to, tz) {
  const ev = calendar.list(from.toISOString(), to.toISOString());
  return `${label}: ${ev.length ? ev.map((e) => `${e.title} ${e.all_day ? "(all day)" : fmt(e.start, tz)}${e.location ? ` at ${e.location}` : ""}`).join("; ") : "nothing scheduled"}.`;
}
function financeLine(s) {
  if (!s.finance.enabled) return null;
  const f = finance.financeFacts("position");
  if (!f.connected) return f.manualEntriesOnly ? "Finance: no bank connected (only hand-entered spending)." : "Finance: no bank connected.";
  return `Finance${f.testData ? " (TEST DATA)" : ""}: available ${f.balances.available}, commitments still due ${f.commitments.total}, projected disposable ${f.projectedDisposable}. ${f.notes.join(" ")}`;
}
function alarmLine(tomorrowOnly, tz) {
  const sch = alarms.schedule(36).upcoming.filter((a) => !a.snoozed);
  const next = tomorrowOnly ? sch.find((a) => localDate(new Date(a.at), tz) === addDays(localDate(new Date(), tz), 1)) : sch[0];
  return next ? `Alarm: ${next.label} at ${describeLocal(next.at, tz)}.` : tomorrowOnly ? "Alarm: none set for tomorrow morning." : "Alarm: none set.";
}
function habitsLine(onlyOpen) {
  const hs = habits.list({ active: true });
  if (!hs.length) return null;
  const shown = onlyOpen ? hs.filter((h) => h.frequency === "daily" && !h.doneToday) : hs;
  return `Habits: ${shown.length ? shown.map((h) => `${h.name}${h.streak ? ` (${h.streak}-${h.frequency === "daily" ? "day" : "week"} streak)` : ""}${onlyOpen ? " not done yet today" : ""}`).join("; ") : "all of today's habits are done"}.`;
}

/** Collect the facts for a briefing. Returns { facts: string[], weather }. */
export async function gatherFacts(kind = "morning", { loc } = {}) {
  const s = getSettings(); const tz = s.timezone; const sec = s.briefing.sections || {};
  const now = new Date(); const today = localDate(now, tz);
  const facts = []; let weather = null;
  const push = (x) => x && facts.push(x);

  if (kind === "morning") {
    if (sec.weather !== false) { const r = await weatherFacts(s, loc, { sun: true }); weather = r.w; push(r.line); }
    if (sec.calendar !== false) push(eventsLine("Today's schedule", now, fromLocal(addDays(today, 1), "00:00", tz), tz));
    if (sec.tasks !== false) {
      const od = tasks.overdue(), due = tasks.dueToday(), open = tasks.list();
      push(`Tasks: ${open.length} open; overdue: ${od.map((t) => t.title).join(", ") || "none"}; due today: ${due.map((t) => t.title).join(", ") || "none"}; top priority: ${open.filter((t) => t.priority === 1).slice(0, 3).map((t) => t.title).join(", ") || "none"}.`);
      const rem = reminders.upcoming().filter((r) => Date.parse(r.due_at) < Date.now() + 24 * 3600_000);
      push(`Reminders today: ${rem.map((r) => `${r.text} at ${fmt(r.due_at, tz)}`).join("; ") || "none"}.`);
    }
    if (sec.finance !== false) push(financeLine(s));
    if (sec.projects !== false) {
      const ps = projects.list({ includeDone: false }).slice(0, 4);
      push(`Projects: ${ps.map((p) => `${p.title} ${p.progress.percent}%${p.progress.overdue ? ` (${p.progress.overdue} overdue)` : ""}`).join("; ") || "none"}.`);
    }
    push(habitsLine(false));
    const biz = businessSummary();
    if (biz.followUps.some((c) => c.next_follow_up <= today)) push(`Client follow-ups due: ${biz.followUps.filter((c) => c.next_follow_up <= today).map((c) => c.name).join(", ")}.`);
    if (biz.overdue.length) push(`Overdue invoices: ${biz.overdue.map((i) => `${i.number} ${GBP(i.total)}`).join(", ")}.`);
  } else if (kind === "afternoon") {
    push(eventsLine("Rest of today", now, fromLocal(addDays(today, 1), "00:00", tz), tz));
    const done = db.prepare("SELECT title FROM tasks WHERE done = 1 AND completed_at >= ?").all(fromLocal(today, "00:00", tz).toISOString().replace("T", " ").slice(0, 19));
    push(`Tasks completed today: ${done.map((t) => t.title).join(", ") || "none yet"}; still due today: ${tasks.dueToday().map((t) => t.title).join(", ") || "none"}.`);
    const f = focus.stats(); push(`Focus so far today: ${f.today} minutes.`);
    if (sec.weather !== false) { const r = await weatherFacts(s, loc); weather = r.w; push(r.line); }
    push(habitsLine(true));
  } else if (kind === "evening") {
    const done = db.prepare("SELECT title FROM tasks WHERE done = 1 AND completed_at >= ?").all(fromLocal(today, "00:00", tz).toISOString().replace("T", " ").slice(0, 19));
    push(`Done today: ${done.map((t) => t.title).join(", ") || "no tasks marked done"}. Focus today: ${focus.stats().today} minutes.`);
    push(habitsLine(true));
    const tomorrow = addDays(today, 1);
    push(eventsLine("Tomorrow", fromLocal(tomorrow, "00:00", tz), fromLocal(addDays(tomorrow, 1), "00:00", tz), tz));
    const dueTomorrow = db.prepare("SELECT title FROM tasks WHERE done = 0 AND due = ?").all(tomorrow);
    push(`Tasks due tomorrow: ${dueTomorrow.map((t) => t.title).join(", ") || "none"}. Overdue: ${tasks.overdue().map((t) => t.title).join(", ") || "none"}.`);
    push(alarmLine(true, tz));
    if (sec.weather !== false) {
      try { const w = await getWeather({ ...(loc?.lat ? loc : s.home), units: s.units }); weather = w; const t = w.tomorrow; push(`Tomorrow's weather: ${t.summary}, ${t.low}–${t.high}${w.unitTemp}, rain chance ${t.rain ?? "?"}%, UV ${t.uv ?? "?"}.`); }
      catch (e) { push(`Weather: unavailable (${e.message}).`); }
    }
  } else if (kind === "weekly") {
    const weekAgo = new Date(Date.now() - 7 * 86400_000);
    const done = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE done = 1 AND completed_at >= ?").get(weekAgo.toISOString().replace("T", " ").slice(0, 19)).n;
    push(`This week: ${done} task(s) completed; ${tasks.list().length} open; ${tasks.overdue().length} overdue. Focus: ${focus.stats().week} minutes over 7 days.`);
    push(habitsLine(false));
    const gs = goals.list({ status: "active" });
    if (gs.length) push(`Goals: ${gs.map((g) => `${g.title} ${g.progress}%${g.target_date ? ` (target ${g.target_date})` : ""}`).join("; ")}.`);
    const ps = projects.list({ includeDone: false }).slice(0, 5);
    if (ps.length) push(`Projects: ${ps.map((p) => `${p.title} ${p.progress.percent}%`).join("; ")}.`);
    if (s.finance.enabled) {
      const c = finance.financeFacts("compare");
      if (c.connected) push(`Spending${c.testData ? " (TEST DATA)" : ""}: this month so far ${c.thisMonthSoFar} vs ${c.lastMonthSamePoint} at the same point last month.`);
    }
    const biz = businessSummary();
    if (biz.revenueMonth || biz.outstanding || biz.followUps.length) push(`Business: revenue this month ${GBP(biz.revenueMonth)}, outstanding invoices ${GBP(biz.outstanding)}, follow-ups in the next week: ${biz.followUps.map((c) => c.name).join(", ") || "none"}.`);
    push(eventsLine("Next 7 days", now, new Date(Date.now() + 7 * 86400_000), tz));
  }
  const pend = pending.list();
  if (pend.length) push(`Waiting for your confirmation: ${pend.map((p) => p.summary).join("; ")}.`);
  return { facts, weather };
}
