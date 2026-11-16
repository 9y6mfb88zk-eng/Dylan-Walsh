// Tasks, reminders, projects and milestones. Every write notifies connected devices.
import { db, tx } from "../db.js";
import { changed } from "../realtime.js";

const clean = (s, max = 500) => String(s ?? "").trim().slice(0, max);
const isoDate = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
const today = () => new Date().toISOString().slice(0, 10);

// ---------------- Tasks
export const tasks = {
  list({ includeDone = false, projectId } = {}) {
    const where = [];
    const args = [];
    if (!includeDone) where.push("t.done = 0");
    if (projectId) { where.push("t.project_id = ?"); args.push(projectId); }
    return db.prepare(`SELECT t.*, p.title AS project_title FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY t.done, t.priority, COALESCE(t.due, '9999'), t.id DESC`).all(...args);
  },
  get(id) { return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id); },
  /** Idempotent when clientId is given: retries from an offline outbox never duplicate. */
  add({ title, notes = "", due = null, source = "user", projectId = null, milestoneId = null, priority = 2, clientId = null }) {
    title = clean(title, 300);
    if (!title) throw Object.assign(new Error("Task title required"), { status: 400 });
    if (clientId) { const ex = db.prepare("SELECT * FROM tasks WHERE client_id = ?").get(clientId); if (ex) return ex; }
    const r = db.prepare("INSERT INTO tasks (title, notes, due, source, project_id, milestone_id, priority, client_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))")
      .run(title, clean(notes, 2000), isoDate(due), source, projectId || null, milestoneId || null, [1, 2, 3].includes(priority) ? priority : 2, clientId);
    changed("tasks", "projects");
    return tasks.get(r.lastInsertRowid);
  },
  update(id, patch) {
    const t = tasks.get(id);
    if (!t) return null;
    const next = {
      title: patch.title !== undefined ? clean(patch.title, 300) || t.title : t.title,
      notes: patch.notes !== undefined ? clean(patch.notes, 2000) : t.notes,
      due: patch.due !== undefined ? isoDate(patch.due) : t.due,
      priority: [1, 2, 3].includes(patch.priority) ? patch.priority : t.priority,
      project_id: patch.projectId !== undefined ? patch.projectId || null : t.project_id,
      done: typeof patch.done === "boolean" ? (patch.done ? 1 : 0) : t.done,
    };
    db.prepare(`UPDATE tasks SET title = ?, notes = ?, due = ?, priority = ?, project_id = ?, done = ?,
      completed_at = CASE WHEN ? = 1 AND done = 0 THEN datetime('now') WHEN ? = 0 THEN NULL ELSE completed_at END,
      updated_at = datetime('now') WHERE id = ?`)
      .run(next.title, next.notes, next.due, next.priority, next.project_id, next.done, next.done, next.done, id);
    changed("tasks", "projects");
    return tasks.get(id);
  },
  remove(id) { const ok = db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0; changed("tasks", "projects"); return ok; },
  overdue() { return db.prepare("SELECT * FROM tasks WHERE done = 0 AND due IS NOT NULL AND due < ? ORDER BY due").all(today()); },
  dueToday() { return db.prepare("SELECT * FROM tasks WHERE done = 0 AND due = ?").all(today()); },
};

// ---------------- Reminders
export const reminders = {
  upcoming() { return db.prepare("SELECT * FROM reminders WHERE fired = 0 ORDER BY due_at").all(); },
  recent() { return db.prepare("SELECT * FROM reminders WHERE fired = 1 ORDER BY fired_at DESC LIMIT 15").all(); },
  get(id) { return db.prepare("SELECT * FROM reminders WHERE id = ?").get(id); },
  add({ text, due_at, clientId = null }) {
    text = clean(text, 300);
    const d = new Date(due_at);
    if (!text || Number.isNaN(d.getTime())) throw Object.assign(new Error("Reminder needs text and a valid time"), { status: 400 });
    if (clientId) { const ex = db.prepare("SELECT * FROM reminders WHERE client_id = ?").get(clientId); if (ex) return ex; }
    const r = db.prepare("INSERT INTO reminders (text, due_at, client_id) VALUES (?, ?, ?)").run(text, d.toISOString(), clientId);
    changed("reminders");
    return reminders.get(r.lastInsertRowid);
  },
  due(nowIso = new Date().toISOString()) { return db.prepare("SELECT * FROM reminders WHERE fired = 0 AND due_at <= ? ORDER BY due_at").all(nowIso); },
  /** Atomically claim a reminder so it can only ever fire once, even across restarts. */
  claim(id) { return db.prepare("UPDATE reminders SET fired = 1, fired_at = ? WHERE id = ? AND fired = 0").run(new Date().toISOString(), id).changes === 1; },
  remove(id) { const ok = db.prepare("DELETE FROM reminders WHERE id = ?").run(id).changes > 0; changed("reminders"); return ok; },
};

// ---------------- Projects
function hydrate(p) {
  if (!p) return null;
  const ms = db.prepare("SELECT * FROM milestones WHERE project_id = ? ORDER BY sort, id").all(p.id);
  const ts = db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY done, priority, COALESCE(due,'9999'), id").all(p.id);
  const done = ts.filter((t) => t.done).length;
  const overdue = ts.filter((t) => !t.done && t.due && t.due < today());
  return {
    ...p,
    milestones: ms.map((m) => ({ ...m, done: !!m.done, tasks: ts.filter((t) => t.milestone_id === m.id) })),
    tasks: ts,
    progress: { total: ts.length, done, percent: ts.length ? Math.round((done / ts.length) * 100) : 0, overdue: overdue.length,
      milestonesDone: ms.filter((m) => m.done).length, milestonesTotal: ms.length },
  };
}
export const projects = {
  list({ includeDone = true } = {}) {
    return db.prepare(`SELECT * FROM projects ${includeDone ? "" : "WHERE status != 'done'"} ORDER BY status = 'done', updated_at DESC`).all().map(hydrate);
  },
  get(id) { return hydrate(db.prepare("SELECT * FROM projects WHERE id = ?").get(id)); },
  find(q) {
    const p = db.prepare("SELECT * FROM projects WHERE title LIKE ? ORDER BY status = 'done', updated_at DESC LIMIT 1").get(`%${clean(q, 100)}%`);
    return hydrate(p);
  },
  /** Create a project with an optional plan: milestones[{title, due, tasks:[{title, due, priority}]}]. */
  create({ title, goal = "", milestones = [], tasks: loose = [] }) {
    title = clean(title, 200);
    if (!title) throw Object.assign(new Error("Project title required"), { status: 400 });
    const id = tx(() => {
      const pid = Number(db.prepare("INSERT INTO projects (title, goal) VALUES (?, ?)").run(title, clean(goal, 2000)).lastInsertRowid);
      milestones.slice(0, 12).forEach((m, i) => {
        const mid = Number(db.prepare("INSERT INTO milestones (project_id, title, due, sort) VALUES (?, ?, ?, ?)").run(pid, clean(m.title, 200), isoDate(m.due), i).lastInsertRowid);
        (m.tasks || []).slice(0, 15).forEach((t) => db.prepare("INSERT INTO tasks (title, due, priority, project_id, milestone_id, source, updated_at) VALUES (?, ?, ?, ?, ?, 'jarvis', datetime('now'))")
          .run(clean(t.title, 300), isoDate(t.due), [1, 2, 3].includes(t.priority) ? t.priority : 2, pid, mid));
      });
      loose.slice(0, 20).forEach((t) => db.prepare("INSERT INTO tasks (title, due, priority, project_id, source, updated_at) VALUES (?, ?, ?, ?, 'jarvis', datetime('now'))")
        .run(clean(t.title, 300), isoDate(t.due), [1, 2, 3].includes(t.priority) ? t.priority : 2, pid));
      return pid;
    });
    changed("projects", "tasks");
    return projects.get(id);
  },
  update(id, patch) {
    const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    if (!p) return null;
    db.prepare("UPDATE projects SET title = ?, goal = ?, status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(
      patch.title !== undefined ? clean(patch.title, 200) || p.title : p.title,
      patch.goal !== undefined ? clean(patch.goal, 2000) : p.goal,
      ["active", "paused", "done"].includes(patch.status) ? patch.status : p.status,
      patch.notes !== undefined ? clean(patch.notes, 5000) : p.notes, id);
    changed("projects");
    return projects.get(id);
  },
  remove(id) { const ok = tx(() => { db.prepare("DELETE FROM tasks WHERE project_id = ?").run(id); return db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0; }); changed("projects", "tasks"); return ok; },
  addMilestone(projectId, { title, due }) {
    const sort = db.prepare("SELECT COALESCE(MAX(sort),0)+1 AS s FROM milestones WHERE project_id = ?").get(projectId).s;
    db.prepare("INSERT INTO milestones (project_id, title, due, sort) VALUES (?, ?, ?, ?)").run(projectId, clean(title, 200), isoDate(due), sort);
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(projectId);
    changed("projects");
    return projects.get(projectId);
  },
  setMilestoneDone(id, done) {
    const m = db.prepare("SELECT * FROM milestones WHERE id = ?").get(id);
    if (!m) return null;
    db.prepare("UPDATE milestones SET done = ? WHERE id = ?").run(done ? 1 : 0, id);
    changed("projects");
    return projects.get(m.project_id);
  },
  /** Plain-English progress report (facts only; the AI adds judgement). */
  report(id) {
    const p = projects.get(id);
    if (!p) return null;
    const open = p.tasks.filter((t) => !t.done);
    const overdue = open.filter((t) => t.due && t.due < today());
    const next = open.slice(0, 5);
    return {
      project: p.title, status: p.status, goal: p.goal, progress: p.progress,
      milestones: p.milestones.map((m) => ({ title: m.title, due: m.due, done: m.done, open: m.tasks.filter((t) => !t.done).length })),
      overdue: overdue.map((t) => ({ id: t.id, title: t.title, due: t.due })),
      next: next.map((t) => ({ id: t.id, title: t.title, due: t.due, priority: t.priority })),
    };
  },
};
