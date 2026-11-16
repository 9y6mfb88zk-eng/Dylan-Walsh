// Record types for the upgrade sections, built on the validated crud() layer, plus the logic that goes beyond CRUD
// (invoice numbering/totals, pipeline summaries, habit streaks, focus timers, goal progress).
import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import { config } from "../config.js";
import { crud } from "./crud.js";
import { changed } from "../realtime.js";
import { localDate, addDays, weekdayOf, userTz } from "./time.js";
import { logActivity, notify } from "./notify.js";

// ---------------------------------------------------------------- Notes
export const notes = crud("notes", {
  entity: "notes", order: "pinned DESC, updated_at DESC", touch: true,
  fields: { title: { type: "text", max: 200 }, body: { type: "text", max: 20000 }, tags: { type: "text", max: 200 }, pinned: { type: "bool" } },
});

// ---------------------------------------------------------------- Research extras
export const savedSources = crud("saved_sources", {
  entity: "research", order: "id DESC",
  fields: { url: { type: "text", required: true, max: 2000 }, title: { type: "text", max: 300 }, note: { type: "text", max: 2000 }, folder: { type: "text", max: 80, default: "General" }, research_id: { type: "int" } },
});

// ---------------------------------------------------------------- Documents (uploads for analysis)
const TEXT_MIME = /^(text\/|application\/(json|xml|csv|x-yaml|javascript))/;
export const documents = {
  list(folder) {
    return db.prepare(`SELECT id, name, mime, size, folder, summary, created_at, length(text) AS text_length FROM documents ${folder ? "WHERE folder = ?" : ""} ORDER BY id DESC`).all(...(folder ? [folder] : []));
  },
  get(id) { return db.prepare("SELECT * FROM documents WHERE id = ?").get(Number(id)); },
  find(q) { return db.prepare("SELECT * FROM documents WHERE name LIKE ? ORDER BY id DESC LIMIT 1").get(`%${String(q).slice(0, 100)}%`); },
  add(buffer, { name, mime, folder = "General" }) {
    if (!buffer?.length) throw Object.assign(new Error("Empty file"), { status: 400, expose: true });
    if (buffer.length > 20 * 1024 * 1024) throw Object.assign(new Error("Documents must be under 20 MB"), { status: 400, expose: true });
    const isPdf = mime === "application/pdf" || /\.pdf$/i.test(name || "");
    const isText = TEXT_MIME.test(mime || "") || /\.(txt|md|csv|json|html?|xml|ya?ml|log)$/i.test(name || "");
    if (!isPdf && !isText) throw Object.assign(new Error("Upload a PDF or a text-based file (txt, md, csv, json, html)."), { status: 415, expose: true });
    const dir = path.join(config.dataDir, "documents");
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || "document").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const file = `${Date.now()}-${safe}`;
    fs.writeFileSync(path.join(dir, file), buffer);
    let text = "";
    if (isText) { text = buffer.toString("utf8"); if (/html?$/i.test(safe) || /html/.test(mime)) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "); }
    const r = db.prepare("INSERT INTO documents (name, mime, size, file, text, folder) VALUES (?, ?, ?, ?, ?, ?)")
      .run(safe, isPdf ? "application/pdf" : mime || "text/plain", buffer.length, file, text.slice(0, 500_000), String(folder).slice(0, 80));
    changed("documents");
    logActivity("document", `Document added: ${safe}`);
    return documents.get(r.lastInsertRowid);
  },
  bytes(doc) { return fs.readFileSync(path.join(config.dataDir, "documents", doc.file)); },
  setSummary(id, summary) { db.prepare("UPDATE documents SET summary = ? WHERE id = ?").run(summary, Number(id)); changed("documents"); },
  remove(id) {
    const d = documents.get(id);
    if (!d) return false;
    try { fs.rmSync(path.join(config.dataDir, "documents", d.file)); } catch {}
    db.prepare("DELETE FROM documents WHERE id = ?").run(d.id);
    changed("documents");
    return true;
  },
};

// ---------------------------------------------------------------- Finance extras
export const savingsGoals = crud("savings_goals", {
  entity: "finance", order: "COALESCE(deadline,'9999'), id",
  fields: { name: { type: "text", required: true, max: 80 }, target: { type: "int", required: true, min: 1 }, saved: { type: "int", min: 0, default: 0 }, deadline: { type: "date" } },
  hydrate: (g) => ({ ...g, percent: g.target ? Math.min(100, Math.round((g.saved / g.target) * 100)) : 0 }),
});
export const debts = crud("debts", {
  entity: "finance", order: "apr DESC, balance DESC", touch: true,
  fields: { name: { type: "text", required: true, max: 80 }, balance: { type: "int", required: true, min: 0 }, apr: { type: "num", default: 0 }, min_payment: { type: "int", min: 0, default: 0 }, due_day: { type: "int", min: 1, max: 31 } },
});

// ---------------------------------------------------------------- Business & clients
export const STAGES = ["lead", "contacted", "qualified", "proposal", "won", "lost", "active", "past"];
export const businesses = crud("businesses", { entity: "business", order: "name", fields: { name: { type: "text", required: true, max: 120 }, description: { type: "text", max: 2000 }, website: { type: "text", max: 300 } } });
export const clients = crud("clients", {
  entity: "business", order: "COALESCE(next_follow_up,'9999'), updated_at DESC", touch: true,
  fields: {
    business_id: { type: "int" }, name: { type: "text", required: true, max: 120 }, company: { type: "text", max: 120 }, email: { type: "text", max: 200 },
    phone: { type: "text", max: 60 }, stage: { type: "enum", values: STAGES, default: "lead" }, value: { type: "int", min: 0, default: 0 },
    next_follow_up: { type: "date" }, source: { type: "text", max: 120 }, notes: { type: "text", max: 10000 },
  },
});
export const proposals = crud("proposals", {
  entity: "business", order: "id DESC", touch: true,
  fields: { client_id: { type: "int" }, title: { type: "text", required: true, max: 200 }, body: { type: "text", max: 50000 }, amount: { type: "int", min: 0, default: 0 }, status: { type: "enum", values: ["draft", "sent", "accepted", "rejected"], default: "draft" } },
});
export const expenses = crud("business_expenses", {
  entity: "business", order: "date DESC, id DESC",
  fields: { business_id: { type: "int" }, description: { type: "text", required: true, max: 200 }, amount: { type: "int", required: true, min: 0 }, category: { type: "text", max: 60, default: "general" }, date: { type: "date", required: true } },
});
export const interactions = crud("interactions", {
  entity: "business", order: "at DESC",
  fields: { client_id: { type: "int", required: true }, kind: { type: "enum", values: ["call", "email", "meeting", "note"], default: "note" }, summary: { type: "text", required: true, max: 5000 }, at: { type: "datetime" } },
});
const invoiceBase = crud("invoices", {
  entity: "business", order: "id DESC",
  fields: {
    number: { type: "text", max: 40 }, business_id: { type: "int" }, client_id: { type: "int" }, items: { type: "json", default: "[]" }, total: { type: "int", min: 0 },
    currency: { type: "text", max: 3, default: "GBP" }, status: { type: "enum", values: ["draft", "sent", "paid", "void"], default: "draft" },
    issued: { type: "date" }, due: { type: "date" }, paid_at: { type: "date" }, notes: { type: "text", max: 5000 },
  },
  hydrate: (i) => ({ ...i, client_name: i.client_id ? db.prepare("SELECT name FROM clients WHERE id = ?").get(i.client_id)?.name : null }),
});
function cleanItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 50).map((it) => ({
    description: String(it.description || "").slice(0, 200), quantity: Math.max(0, Number(it.quantity) || 1), unit: Math.max(0, Math.round(Number(it.unit) || 0)),
  })).filter((it) => it.description);
}
export const invoices = {
  ...invoiceBase,
  create(data = {}) {
    const items = cleanItems(data.items);
    const year = new Date().getUTCFullYear();
    const n = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?").get(`INV-${year}-%`).n + 1;
    const today = localDate();
    return invoiceBase.create({ ...data, items, total: items.reduce((s, i) => s + Math.round(i.quantity * i.unit), 0), number: data.number || `INV-${year}-${String(n).padStart(4, "0")}`, issued: data.issued || today, due: data.due || addDays(today, 30) });
  },
  update(id, data = {}) {
    const patch = { ...data };
    if (data.items) { patch.items = cleanItems(data.items); patch.total = patch.items.reduce((s, i) => s + Math.round(i.quantity * i.unit), 0); }
    if (data.status === "paid" && !data.paid_at) patch.paid_at = localDate();
    return invoiceBase.update(id, patch);
  },
};
export function businessSummary() {
  const year = String(new Date().getUTCFullYear()), month = localDate().slice(0, 7), today = localDate();
  const pipeline = STAGES.map((s) => ({ stage: s, ...db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(value),0) AS value FROM clients WHERE stage = ?").get(s) }));
  const sum = (sql, ...a) => db.prepare(sql).get(...a).v || 0;
  return {
    pipeline,
    revenueMonth: sum("SELECT SUM(total) AS v FROM invoices WHERE status = 'paid' AND paid_at LIKE ?", `${month}%`),
    revenueYear: sum("SELECT SUM(total) AS v FROM invoices WHERE status = 'paid' AND paid_at LIKE ?", `${year}%`),
    outstanding: sum("SELECT SUM(total) AS v FROM invoices WHERE status = 'sent'"),
    overdue: db.prepare("SELECT id, number, total, due FROM invoices WHERE status = 'sent' AND due < ?").all(today),
    expensesMonth: sum("SELECT SUM(amount) AS v FROM business_expenses WHERE date LIKE ?", `${month}%`),
    followUps: db.prepare("SELECT id, name, company, stage, next_follow_up FROM clients WHERE next_follow_up IS NOT NULL AND next_follow_up <= ? AND stage NOT IN ('lost','past') ORDER BY next_follow_up").all(addDays(today, 7)),
    openProposals: db.prepare("SELECT id, title, amount, status FROM proposals WHERE status IN ('draft','sent') ORDER BY id DESC").all(),
  };
}

// ---------------------------------------------------------------- World
export const savedLocations = crud("saved_locations", {
  entity: "world", order: "id",
  fields: { name: { type: "text", required: true, max: 120 }, lat: { type: "num", required: true }, lon: { type: "num", required: true }, timezone: { type: "text", required: true, max: 60 }, country: { type: "text", max: 80 } },
});

// ---------------------------------------------------------------- Goals
export const goals = crud("goals", {
  entity: "goals", order: "status = 'done', COALESCE(target_date,'9999'), id", touch: true,
  fields: {
    title: { type: "text", required: true, max: 200 }, kind: { type: "enum", values: ["short", "long", "career", "financial", "learning", "personal"], default: "personal" },
    description: { type: "text", max: 5000 }, target_date: { type: "date" }, progress: { type: "int", min: 0, max: 100, default: 0 },
    status: { type: "enum", values: ["active", "paused", "done"], default: "active" },
  },
  hydrate: (g) => {
    const ms = db.prepare("SELECT * FROM goal_milestones WHERE goal_id = ? ORDER BY sort, id").all(g.id).map((m) => ({ ...m, done: !!m.done }));
    return { ...g, milestones: ms, progress: ms.length ? Math.round((ms.filter((m) => m.done).length / ms.length) * 100) : g.progress };
  },
});
export const milestones = crud("goal_milestones", {
  entity: "goals", order: "sort, id",
  fields: { goal_id: { type: "int", required: true }, title: { type: "text", required: true, max: 200 }, due: { type: "date" }, done: { type: "bool" }, sort: { type: "int", default: 0 } },
});

// ---------------------------------------------------------------- Habits
const habitBase = crud("habits", {
  entity: "habits", order: "active DESC, id",
  fields: { name: { type: "text", required: true, max: 120 }, frequency: { type: "enum", values: ["daily", "weekly"], default: "daily" }, target: { type: "int", min: 1, max: 50, default: 1 }, reminder_time: { type: "time" }, active: { type: "bool", default: true } },
  hydrate: (h) => habitStats(h),
});
function habitStats(h) {
  const today = localDate();
  const checks = Object.fromEntries(db.prepare("SELECT date, count FROM habit_checks WHERE habit_id = ? AND date >= ?").all(h.id, addDays(today, -400)).map((c) => [c.date, c.count]));
  const last14 = Array.from({ length: 14 }, (_, i) => { const d = addDays(today, i - 13); return { date: d, count: checks[d] || 0 }; });
  let streak = 0;
  if (h.frequency === "daily") {
    // A streak counts consecutive days that met the target; today only counts once it is done.
    for (let i = checks[today] >= h.target ? 0 : 1; i < 400; i++) { const d = addDays(today, -i); if ((checks[d] || 0) >= h.target) streak++; else break; }
  } else {
    // Weekly: consecutive Monday-start weeks meeting the target.
    const monday = (d) => addDays(d, -((weekdayOf(d) + 6) % 7));
    let wk = monday(today);
    const weekCount = (start) => Array.from({ length: 7 }, (_, i) => checks[addDays(start, i)] || 0).reduce((a, b) => a + b, 0);
    if (weekCount(wk) < h.target) wk = addDays(wk, -7);
    while (weekCount(wk) >= h.target && streak < 60) { streak++; wk = addDays(wk, -7); }
  }
  const weekStart = addDays(today, -((weekdayOf(today) + 6) % 7));
  const thisWeek = Array.from({ length: 7 }, (_, i) => checks[addDays(weekStart, i)] || 0).reduce((a, b) => a + b, 0);
  return { ...h, today: checks[today] || 0, doneToday: (checks[today] || 0) >= h.target, streak, thisWeek, last14 };
}
export const habits = {
  ...habitBase,
  check(id, { date, delta = 1 } = {}) {
    const h = db.prepare("SELECT * FROM habits WHERE id = ?").get(Number(id));
    if (!h) return null;
    const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate();
    const cur = db.prepare("SELECT count FROM habit_checks WHERE habit_id = ? AND date = ?").get(h.id, d)?.count || 0;
    const next = Math.max(0, Math.min(50, cur + Number(delta)));
    if (next === 0) db.prepare("DELETE FROM habit_checks WHERE habit_id = ? AND date = ?").run(h.id, d);
    else db.prepare("INSERT INTO habit_checks (habit_id, date, count) VALUES (?, ?, ?) ON CONFLICT(habit_id, date) DO UPDATE SET count = excluded.count").run(h.id, d, next);
    changed("habits");
    if (delta > 0) logActivity("habit", `Habit checked: ${h.name}`, { id: h.id });
    return habits.get(h.id);
  },
  find(q) { return db.prepare("SELECT * FROM habits WHERE name LIKE ? AND active = 1 LIMIT 1").get(`%${String(q).slice(0, 80)}%`); },
  /** Daily habit reminders at their reminder time, if not yet done today. */
  async remind(now = new Date()) {
    const hm = new Intl.DateTimeFormat("en-GB", { timeZone: userTz(), hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
    const today = localDate(now);
    let sent = 0;
    for (const h of db.prepare("SELECT * FROM habits WHERE active = 1 AND reminder_time IS NOT NULL AND reminder_time <= ?").all(hm)) {
      const key = `habit-reminded-${h.id}-${today}`;
      if (db.prepare("SELECT 1 FROM kv WHERE k = ?").get(key)) continue;
      db.prepare("INSERT INTO kv (k, v) VALUES (?, '1')").run(key);
      const st = habitStats(h);
      if (h.frequency === "daily" && st.doneToday) continue;
      sent++;
      await notify({ kind: "habit", title: `Habit: ${h.name}`, body: st.streak ? `Keep your ${st.streak}-day streak going.` : "A gentle reminder, Sir.", url: "/?tab=goals" });
    }
    return { sent };
  },
};

// ---------------------------------------------------------------- Focus (Pomodoro)
export const focus = {
  active() {
    const s = db.prepare("SELECT * FROM focus_sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get();
    return s ? { ...s, remainingSeconds: Math.max(0, Math.round((Date.parse(s.ends_at) - Date.now()) / 1000)) } : null;
  },
  start({ minutes = 25, label = "Focus", kind = "work" } = {}) {
    focus.stop({ completed: false, silent: true });
    const mins = Math.max(1, Math.min(240, Math.round(Number(minutes) || 25)));
    const now = new Date();
    const r = db.prepare("INSERT INTO focus_sessions (label, kind, planned_minutes, started_at, ends_at) VALUES (?, ?, ?, ?, ?)")
      .run(String(label).slice(0, 80) || "Focus", kind === "break" ? "break" : "work", mins, now.toISOString(), new Date(now.getTime() + mins * 60_000).toISOString());
    changed("focus");
    logActivity("focus", `${kind === "break" ? "Break" : "Focus session"} started: ${mins} min${label && label !== "Focus" ? ` — ${label}` : ""}`);
    return focus.active() || db.prepare("SELECT * FROM focus_sessions WHERE id = ?").get(r.lastInsertRowid);
  },
  stop({ completed = false, silent = false } = {}) {
    const s = db.prepare("SELECT * FROM focus_sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get();
    if (!s) return null;
    db.prepare("UPDATE focus_sessions SET ended_at = ?, completed = ? WHERE id = ?").run(new Date().toISOString(), completed ? 1 : 0, s.id);
    changed("focus");
    if (!silent) logActivity("focus", `${s.kind === "break" ? "Break" : "Focus session"} ${completed ? "completed" : "stopped"}`);
    return s;
  },
  history(limit = 50) { return db.prepare("SELECT * FROM focus_sessions ORDER BY id DESC LIMIT ?").all(limit); },
  stats() {
    const today = localDate();
    const rows = db.prepare("SELECT * FROM focus_sessions WHERE kind = 'work' AND started_at >= ?").all(new Date(Date.now() - 14 * 86400_000).toISOString());
    const minutesOf = (s) => Math.round(Math.max(0, Math.min(Date.parse(s.ended_at || new Date().toISOString()), Date.parse(s.ends_at)) - Date.parse(s.started_at)) / 60000);
    const byDay = {};
    for (const s of rows) { const d = localDate(new Date(s.started_at)); byDay[d] = (byDay[d] || 0) + minutesOf(s); }
    const last7 = Array.from({ length: 7 }, (_, i) => { const d = addDays(today, i - 6); return { date: d, minutes: byDay[d] || 0 }; });
    return { today: byDay[today] || 0, week: last7.reduce((a, b) => a + b.minutes, 0), completedToday: rows.filter((s) => s.completed && localDate(new Date(s.started_at)) === today).length, last7 };
  },
  /** Finish sessions whose time is up and announce it (scheduler). */
  async tick(now = new Date()) {
    const s = db.prepare("SELECT * FROM focus_sessions WHERE ended_at IS NULL AND notified = 0 AND ends_at <= ?").get(now.toISOString());
    if (!s) return { finished: 0 };
    db.prepare("UPDATE focus_sessions SET notified = 1, completed = 1, ended_at = ends_at WHERE id = ?").run(s.id);
    changed("focus");
    logActivity("focus", `${s.kind === "break" ? "Break" : "Focus session"} completed (${s.planned_minutes} min)`);
    await notify(s.kind === "break"
      ? { kind: "focus", title: "Break over", body: "Ready for the next session, Sir?", url: "/?tab=focus", speak: "Break's over, Sir. Ready for the next session?" }
      : { kind: "focus", title: "Focus session complete", body: `${s.planned_minutes} minutes done. Time for a short break.`, url: "/?tab=focus", speak: `Focus session complete, Sir. ${s.planned_minutes} minutes well spent. Time for a short break.` });
    return { finished: 1 };
  },
};
