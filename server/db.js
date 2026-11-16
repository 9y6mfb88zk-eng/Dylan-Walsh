import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(config.dataDir, { recursive: true });
export const dbPath = path.join(config.dataDir, "jarvis.db");
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

// ---------------- Migrations: numbered .sql files applied once, in order, each in a transaction.
export function migrate() {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const done = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  const files = fs.readdirSync(path.join(here, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied = [];
  for (const f of files) {
    const version = f.split("_")[0];
    if (done.has(version)) continue;
    const sql = fs.readFileSync(path.join(here, "migrations", f), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
      db.exec("COMMIT");
      applied.push(f);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${f} failed: ${e.message}`);
    }
  }
  return applied;
}
migrate();

export function tx(fn) {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}
export const nowIso = () => new Date().toISOString();

export function kvGet(k, fallback = null) {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(k);
  return row ? JSON.parse(row.v) : fallback;
}
export function kvSet(k, v) {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
}

// ---------------- User settings (synced across devices)
export const DEFAULT_SETTINGS = {
  home: { lat: config.defaultLat, lon: config.defaultLon, place: config.defaultPlace },
  units: "metric",                 // metric | imperial
  briefing: { time: config.briefingTime, enabled: true, sections: { weather: true, calendar: true, tasks: true, finance: true, projects: true, news: false } },
  ideas: { enabled: config.ideasEnabled, everyMinutes: config.ideasEveryMinutes },
  finance: { enabled: true, buffer: 5000 },     // keep £50 aside in affordability checks
  memory: { autoSave: true },
  computer: { enabled: true },
  timezone: config.timezone,
};
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? deepMerge(a[k], v) : v;
  return out;
}
export function getSettings() { return deepMerge(DEFAULT_SETTINGS, kvGet("settings", {})); }
export function updateSettings(patch) { const s = deepMerge(getSettings(), patch); kvSet("settings", s); return s; }

// Compatibility with the prototype's push module
export const pushSubs = {
  all() { return db.prepare("SELECT sub FROM push_subs").all().map((r) => JSON.parse(r.sub)); },
  add(sub, deviceId = null) {
    db.prepare("INSERT INTO push_subs (endpoint, sub, device_id) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub, device_id = excluded.device_id")
      .run(sub.endpoint, JSON.stringify(sub), deviceId);
  },
  remove(endpoint) { db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint); },
  removeForDevice(deviceId) { db.prepare("DELETE FROM push_subs WHERE device_id = ?").run(deviceId); },
};
