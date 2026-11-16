// In-process tests for the upgrade services: time zones, alarms, reminders, recurrence, money, records,
// automations and diagnostics. Uses its own temporary database.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JARVIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-unit-"));
process.env.JARVIS_TZ = "Europe/Nicosia";
delete process.env.ANTHROPIC_API_KEY;
let T, A, W, C, M, R, AU, D, DB, F;
before(async () => {
  T = await import("../server/services/time.js");
  A = await import("../server/services/alarms.js");
  W = await import("../server/services/work.js");
  C = await import("../server/services/calendar.js");
  M = await import("../server/services/money.js");
  R = await import("../server/services/records.js");
  AU = await import("../server/services/automations.js");
  D = await import("../server/services/diagnostics.js");
  DB = await import("../server/db.js");
  F = await import("../server/finance/service.js");
});

test("time zones: wall-clock conversion is DST-safe in Europe/Nicosia", () => {
  const tz = "Europe/Nicosia";
  // Summer (UTC+3) and winter (UTC+2)
  assert.equal(T.fromLocal("2026-07-01", "07:00", tz).toISOString(), "2026-07-01T04:00:00.000Z");
  assert.equal(T.fromLocal("2026-12-01", "07:00", tz).toISOString(), "2026-12-01T05:00:00.000Z");
  // Day after the October change keeps 07:00 local
  assert.equal(T.fromLocal("2026-10-26", "07:00", tz).toISOString(), "2026-10-26T05:00:00.000Z");
  assert.equal(T.localHM(new Date("2026-12-01T05:00:00Z"), tz), "07:00");
  assert.equal(T.spokenTime(new Date("2026-12-01T05:00:00Z"), tz), "7 AM");
  assert.equal(T.spokenTime(new Date("2026-12-01T05:30:00Z"), tz), "half past 7 AM");
  // Next weekday at 07:00 after Friday 08:00 is Monday
  const fri = T.fromLocal("2026-11-20", "08:00", tz);
  assert.equal(T.localDate(T.nextAt("07:00", [1, 2, 3, 4, 5], fri, tz), tz), "2026-11-23");
});

test("alarms: parse times, schedule one-off and recurring, snooze, dismiss, history", () => {
  assert.equal(A.parseTime("7"), "07:00");
  assert.equal(A.parseTime("7.30pm"), "19:30");
  assert.equal(A.parseTime("12am"), "00:00");
  assert.throws(() => A.parseTime("25:00"), /real time/);
  const once = A.alarms.create({ time: "07:00", label: "Wake up" });
  assert.equal(once.repeat, "once");
  assert.ok(Date.parse(once.next_at) > Date.now() && Date.parse(once.next_at) <= Date.now() + 86400_000, "one-off without a date: next time 07:00 comes round");
  assert.equal(T.localHM(new Date(once.next_at)), "07:00");
  const wk = A.alarms.create({ time: "06:30", repeat: "weekdays", label: "Gym" });
  assert.ok([1, 2, 3, 4, 5].includes(T.localParts(new Date(wk.next_at)).weekday));
  assert.throws(() => A.alarms.create({ time: "08:00", repeat: "custom", days: [] }), /at least one day/);
  const custom = A.alarms.create({ time: "09:15", repeat: "custom", days: [6] });
  assert.equal(T.localParts(new Date(custom.next_at)).weekday, 6);
  const sch = A.alarms.schedule(24 * 8);
  assert.ok(sch.upcoming.some((x) => x.alarmId === wk.id) && sch.upcoming.filter((x) => x.alarmId === wk.id).length >= 2, "recurring alarm appears several times in the agent schedule");
  const sn = A.alarms.snooze(once.id, 9);
  assert.equal(sn.minutes, 9);
  assert.ok(A.alarms.get(once.id).effective_next === sn.until, "snooze takes precedence");
  A.alarms.dismiss(once.id);
  assert.equal(A.alarms.get(once.id).snoozed_until, null);
  const h = A.alarms.history().map((e) => e.event);
  assert.ok(h.includes("snoozed") && h.includes("dismissed"));
  assert.match(A.alarms.speech({ label: "Alarm", message: "" }, new Date("2026-12-01T05:00:00Z")), /^Good morning, Sir\. It is 7 AM\. Time to wake up\.$/);
});

test("alarms: due alarms ring once and move on; very late ones are recorded as missed", async () => {
  const a = A.alarms.create({ time: "05:00", repeat: "daily", label: "Daily" });
  const due = new Date(a.next_at);
  const r1 = await A.alarms.processDue(new Date(due.getTime() + 2000));
  assert.equal(r1.fired, 1);
  const after = A.alarms.get(a.id);
  assert.ok(Date.parse(after.next_at) > due.getTime() + 3600_000, "advanced to the next day");
  assert.equal((await A.alarms.processDue(new Date(due.getTime() + 4000))).fired, 0, "never rings twice");
  assert.ok(A.alarms.ringing().some((x) => x.alarm_id === a.id));
  // A one-off that is 20 minutes overdue (laptop was off) is missed, not rung.
  const o = A.alarms.create({ time: "05:00", label: "Late" });
  const lateBy = new Date(Date.parse(o.next_at) + 20 * 60_000);
  assert.equal((await A.alarms.processDue(lateBy)).fired, 0);
  const missed = A.alarms.history().find((e) => e.alarm_id === o.id && e.event === "missed");
  assert.ok(missed, "recorded as missed");
  assert.equal(A.alarms.get(o.id).enabled, false, "finished one-off is switched off");
});

test("reminders: repeating reminders reschedule at the same local time; snooze", () => {
  const due = T.fromLocal(T.addDays(T.localDate(), -1), "18:00");
  const r = W.reminders.add({ text: "Water plants", due_at: due.toISOString(), repeat: "daily" });
  assert.ok(W.reminders.claim(r.id));
  const n = W.reminders.reschedule(r.id);
  assert.equal(n.fired, 0);
  assert.ok(Date.parse(n.due_at) > Date.now());
  assert.equal(T.localHM(new Date(n.due_at)), "18:00");
  assert.equal(n.times_fired, 1);
  const m = W.reminders.add({ text: "Pay rent", due_at: T.fromLocal("2026-01-31", "09:00").toISOString(), repeat: "monthly" });
  const mn = W.reminders.reschedule(m.id);
  assert.match(T.localDate(new Date(mn.due_at)), /-(28|29|30|31)$|-\d\d$/);
  const one = W.reminders.add({ text: "Call", due_at: new Date(Date.now() - 1000).toISOString() });
  W.reminders.claim(one.id);
  const sn = W.reminders.snooze(one.id, 10);
  assert.equal(sn.fired, 0);
  assert.ok(Date.parse(sn.due_at) > Date.now() + 9 * 60_000);
});

test("calendar: weekly recurring events expand into occurrences; search finds them", async () => {
  const start = T.fromLocal(T.localDate(), "19:00");
  await C.create({ title: "Football training", start: start.toISOString(), recurrence: { freq: "weekly", interval: 1, count: 3 }, target: "local" });
  const list = C.list(new Date(start.getTime() - 3600_000).toISOString(), new Date(start.getTime() + 30 * 86400_000).toISOString()).filter((e) => e.title === "Football training");
  assert.equal(list.length, 3);
  assert.ok(list.every((e) => T.localHM(new Date(e.start)) === "19:00"), "same local time each week");
  assert.equal(C.search("football")[0].title, "Football training");
});

test("money: manual spending counts once, and is matched to the bank transaction when it arrives", () => {
  const t = M.addManualTransaction({ amount: 1250, description: "Lunch", category: "food" });
  assert.equal(t.amount, -1250);
  assert.throws(() => M.addManualTransaction({ amount: 0 }), /more than zero/);
  const spentFood = () => F.loadData().transactions.filter((x) => x.category === "food" && x.amount === -1250).length;
  assert.equal(spentFood(), 1);
  // No bank connected: the AI is told balances are unknown, but spending questions work.
  assert.equal(F.financeFacts("position").connected, false);
  assert.equal(F.financeFacts("spending").manualEntriesOnly, true);
  // A bank transaction for the same amount arrives the next morning.
  const db = DB.db;
  const c = db.prepare("INSERT INTO connections (provider, status) VALUES ('monzo', 'active')").run();
  db.prepare("INSERT INTO fin_accounts (id, connection_id, name, type, balance, shared) VALUES ('acc_1', ?, 'Current', 'current', 50000, 1)").run(c.lastInsertRowid);
  db.prepare("INSERT INTO fin_transactions (id, account_id, created, amount, description, merchant, category) VALUES ('tx_1', 'acc_1', ?, -1250, 'PRET', 'Pret', 'food')").run(new Date(Date.now() + 3600_000).toISOString());
  assert.equal(spentFood(), 2, "before reconciling both are visible");
  assert.equal(M.reconcileManual().matched, 1);
  assert.equal(spentFood(), 1, "after reconciling the spend counts once");
  assert.equal(M.payoffMonths(100000, 0, 10000), 10);
  assert.equal(M.payoffMonths(100000, 24, 1000), null, "payment below interest never clears");
  const rep = M.report({ months: 3 });
  assert.equal(rep.history.length, 3);
  assert.ok(rep.projection.estimate);
});

test("records: invoices number and total themselves; habits keep streaks; focus finishes on time", async () => {
  const cl = R.clients.create({ name: "Acme Villas", stage: "proposal", value: 250000, next_follow_up: T.localDate() });
  const inv = R.invoices.create({ client_id: cl.id, items: [{ description: "Website", quantity: 1, unit: 120000 }, { description: "Hosting", quantity: 12, unit: 1000 }] });
  assert.match(inv.number, /^INV-\d{4}-0001$/);
  assert.equal(inv.total, 132000);
  assert.equal(inv.client_name, "Acme Villas");
  const paid = R.invoices.update(inv.id, { status: "paid" });
  assert.ok(paid.paid_at);
  const sum = R.businessSummary();
  assert.equal(sum.revenueMonth, 132000);
  assert.ok(sum.followUps.some((f) => f.id === cl.id));
  assert.throws(() => R.clients.create({ name: "" }), /required/);
  const h = R.habits.create({ name: "Read 20 pages" });
  for (let i = 3; i >= 1; i--) R.habits.check(h.id, { date: T.addDays(T.localDate(), -i) });
  assert.equal(R.habits.get(h.id).streak, 3, "today not done yet still keeps yesterday's streak");
  R.habits.check(h.id);
  assert.equal(R.habits.get(h.id).streak, 4);
  assert.equal(R.habits.get(h.id).doneToday, true);
  const f = R.focus.start({ minutes: 1, label: "Deep work" });
  assert.ok(R.focus.active());
  const r = await R.focus.tick(new Date(Date.parse(f.ends_at) + 1000));
  assert.equal(r.finished, 1);
  assert.equal(R.focus.active(), null);
  const g = R.goals.create({ title: "Run a 10k" });
  R.milestones.create({ goal_id: g.id, title: "5k" });
  const m2 = R.milestones.create({ goal_id: g.id, title: "8k" });
  R.milestones.update(m2.id, { done: true });
  assert.equal(R.goals.get(g.id).progress, 50);
});

test("automations: built-in routines are seeded once; due routines run and are recorded; long-missed ones are skipped", async () => {
  AU.seedRoutines();
  const all = AU.routines.list();
  const by = Object.fromEntries(all.map((r) => [r.builtin, r]));
  assert.equal(by.morning.schedule.time, "07:00");
  assert.equal(by.evening.schedule.time, "21:00");
  assert.deepEqual(by.weekly.schedule.days, [0]);
  assert.equal(DB.getSettings().briefing.time, "07:00", "the spec's default morning briefing time");
  AU.seedRoutines();
  assert.equal(AU.routines.list().length, all.length, "not duplicated");
  assert.throws(() => AU.routines.remove(by.morning.id), /can't be deleted|cannot|not deleted/i);
  const mine = AU.routines.create({ name: "Back up at noon", schedule: { type: "daily", time: "12:00" }, actions: [{ type: "backup" }] });
  DB.db.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), mine.id);
  assert.equal((await AU.tickRoutines()).ran, 1);
  for (let i = 0; i < 50 && !AU.routines.runs(mine.id)[0]?.finished_at; i++) await new Promise((r) => setTimeout(r, 50));
  const run = AU.routines.runs(mine.id)[0];
  assert.equal(run.status, "ok");
  assert.match(run.output, /Backup saved/);
  DB.db.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * 3600_000).toISOString(), mine.id);
  await AU.tickRoutines();
  assert.equal(AU.routines.runs(mine.id)[0].status, "skipped");
  assert.ok(Date.parse(AU.routines.get(mine.id).next_run_at) > Date.now());
  assert.throws(() => AU.routines.create({ name: "x", schedule: { type: "daily", time: "7am" }, actions: [{ type: "backup" }] }), /HH:MM/);
  assert.throws(() => AU.routines.create({ name: "x", schedule: { type: "daily", time: "07:00" }, actions: [{ type: "shell" }] }), /Unknown step/);
});

test("diagnostics: real checks only — nothing reports healthy without evidence", async () => {
  const d = await D.runDiagnostics();
  const by = Object.fromEntries(d.checks.map((c) => [c.name, c]));
  assert.equal(by.ai.status, "off", "no API key → off, not green");
  assert.equal(by.database.status, "ok");
  assert.match(by.database.detail, /Integrity check passed/);
  assert.ok(["ok", "warn", "error"].includes(by.storage.status));
  assert.notEqual(by.mic.status, "ok", "no Windows app connected → microphone not reported as working");
  D.recordApiCall({ provider: "anthropic", model: "m", purpose: "chat", latencyMs: 800, ok: false, error: "boom" });
  const d2 = await D.runDiagnostics();
  assert.equal(d2.checks.find((c) => c.name === "ai").status, "off");
  const t = await D.testCheck("database");
  assert.equal(t.ok, true);
  assert.equal((await D.testCheck("nonsense")).ok, false);
});
