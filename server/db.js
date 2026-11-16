import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, "jarvis.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  due TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,          -- ISO 8601 UTC
  fired INTEGER NOT NULL DEFAULT 0,
  fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  pitch TEXT NOT NULL,
  why_now TEXT DEFAULT '',
  mvp TEXT NOT NULL,             -- JSON array of 3 steps
  first_move TEXT NOT NULL,
  budget TEXT DEFAULT '',
  added_to_tasks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);

export function kvGet(k, fallback = null) {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(k);
  return row ? JSON.parse(row.v) : fallback;
}
export function kvSet(k, v) {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
}

// ---- Tasks
export const tasks = {
  list({ includeDone = false } = {}) {
    return db.prepare(`SELECT * FROM tasks ${includeDone ? "" : "WHERE done = 0"} ORDER BY done, COALESCE(due, '9999'), id DESC`).all();
  },
  add({ title, notes = "", due = null, source = "user" }) {
    const r = db.prepare("INSERT INTO tasks (title, notes, due, source) VALUES (?, ?, ?, ?)").run(title, notes, due, source);
    return tasks.get(r.lastInsertRowid);
  },
  get(id) { return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id); },
  setDone(id, done = true) {
    db.prepare("UPDATE tasks SET done = ?, completed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?").run(done ? 1 : 0, done ? 1 : 0, id);
    return tasks.get(id);
  },
  remove(id) { return db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0; },
};

// ---- Reminders
export const reminders = {
  upcoming() { return db.prepare("SELECT * FROM reminders WHERE fired = 0 ORDER BY due_at").all(); },
  recent() { return db.prepare("SELECT * FROM reminders WHERE fired = 1 ORDER BY fired_at DESC LIMIT 10").all(); },
  add({ text, due_at }) {
    const r = db.prepare("INSERT INTO reminders (text, due_at) VALUES (?, ?)").run(text, new Date(due_at).toISOString());
    return db.prepare("SELECT * FROM reminders WHERE id = ?").get(r.lastInsertRowid);
  },
  due(nowIso = new Date().toISOString()) {
    return db.prepare("SELECT * FROM reminders WHERE fired = 0 AND due_at <= ? ORDER BY due_at").all(nowIso);
  },
  markFired(id) { db.prepare("UPDATE reminders SET fired = 1, fired_at = ? WHERE id = ?").run(new Date().toISOString(), id); },
  remove(id) { return db.prepare("DELETE FROM reminders WHERE id = ?").run(id).changes > 0; },
};

// ---- Ideas
function hydrateIdea(row) { return row && { ...row, mvp: JSON.parse(row.mvp), added_to_tasks: !!row.added_to_tasks }; }
export const ideas = {
  list(limit = 50) { return db.prepare("SELECT * FROM ideas ORDER BY id DESC LIMIT ?").all(limit).map(hydrateIdea); },
  titles() { return db.prepare("SELECT title FROM ideas ORDER BY id DESC").all().map((r) => r.title); },
  get(id) { return hydrateIdea(db.prepare("SELECT * FROM ideas WHERE id = ?").get(id)); },
  add(i) {
    const r = db.prepare("INSERT INTO ideas (title, pitch, why_now, mvp, first_move, budget) VALUES (?, ?, ?, ?, ?, ?)")
      .run(i.title, i.pitch, i.why_now || "", JSON.stringify(i.mvp), i.first_move, i.budget || "");
    return ideas.get(r.lastInsertRowid);
  },
  markAdded(id) { db.prepare("UPDATE ideas SET added_to_tasks = 1 WHERE id = ?").run(id); },
  remove(id) { return db.prepare("DELETE FROM ideas WHERE id = ?").run(id).changes > 0; },
};

// ---- Memories (long-term facts about the user)
export const memories = {
  list() { return db.prepare("SELECT * FROM memories ORDER BY id").all(); },
  add(fact) { db.prepare("INSERT INTO memories (fact) VALUES (?)").run(fact); },
  remove(id) { return db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0; },
};

// ---- Conversation turns (not shown in UI; used as context)
export const history = {
  recent(n = 16) {
    return db.prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?").all(n).reverse();
  },
  add(role, content) { db.prepare("INSERT INTO messages (role, content) VALUES (?, ?)").run(role, content); },
  clear() { db.exec("DELETE FROM messages"); },
};

// ---- Push subscriptions
export const pushSubs = {
  all() { return db.prepare("SELECT sub FROM push_subs").all().map((r) => JSON.parse(r.sub)); },
  add(sub) {
    db.prepare("INSERT INTO push_subs (endpoint, sub) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub")
      .run(sub.endpoint, JSON.stringify(sub));
  },
  remove(endpoint) { db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint); },
};
