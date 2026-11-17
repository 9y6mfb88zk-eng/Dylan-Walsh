// The shared record store for every Mission Control operation (one table, one model).
import { db } from "../../db.js";
import { changed } from "../../realtime.js";

export const OPS = { blackbox: ["dossier"], wayfinder: ["trip", "expedition"], sentinel: ["watchlist"], orbit: ["satellite"], report: ["situation_report"] };
const parse = (r) => r && { ...r, data: JSON.parse(r.data || "{}"), tags: JSON.parse(r.tags || "[]") };
const now = () => new Date().toISOString();
const clean = (v, n) => String(v ?? "").slice(0, n);

export const records = {
  list({ op, kind, q, tag, limit = 200 } = {}) {
    const where = [], args = [];
    if (op) { where.push("op = ?"); args.push(op); }
    if (kind) { where.push("kind = ?"); args.push(kind); }
    if (q) { where.push("(title LIKE ? OR notes LIKE ? OR data LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (tag) { where.push("tags LIKE ?"); args.push(`%"${String(tag).replace(/[%"]/g, "")}"%`); }
    return db.prepare(`SELECT * FROM op_records ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 200, 1000)).map(parse);
  },
  get(id) { return parse(db.prepare("SELECT * FROM op_records WHERE id = ?").get(Number(id))); },
  create({ op, kind, title = "", status = "ready", data = {}, tags = [], notes = "", lat = null, lon = null }) {
    if (!OPS[op]?.includes(kind)) throw Object.assign(new Error(`Unknown record type ${op}/${kind}`), { status: 400 });
    const r = db.prepare("INSERT INTO op_records (op, kind, title, status, data, tags, notes, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(op, kind, clean(title, 200), status, JSON.stringify(data), JSON.stringify(normTags(tags)), clean(notes, 20000), num(lat), num(lon));
    changed("ops");
    return this.get(r.lastInsertRowid);
  },
  update(id, patch = {}) {
    const cur = this.get(id); if (!cur) return null;
    const next = {
      title: patch.title !== undefined ? clean(patch.title, 200) : cur.title,
      status: patch.status ?? cur.status,
      data: patch.data !== undefined ? (patch.replaceData ? patch.data : { ...cur.data, ...patch.data }) : cur.data,
      tags: patch.tags !== undefined ? normTags(patch.tags) : cur.tags,
      notes: patch.notes !== undefined ? clean(patch.notes, 20000) : cur.notes,
      lat: patch.lat !== undefined ? num(patch.lat) : cur.lat, lon: patch.lon !== undefined ? num(patch.lon) : cur.lon,
    };
    db.prepare("UPDATE op_records SET title = ?, status = ?, data = ?, tags = ?, notes = ?, lat = ?, lon = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.status, JSON.stringify(next.data), JSON.stringify(next.tags), next.notes, next.lat, next.lon, now(), cur.id);
    changed("ops");
    return this.get(cur.id);
  },
  remove(id) { const ok = db.prepare("DELETE FROM op_records WHERE id = ?").run(Number(id)).changes > 0; if (ok) changed("ops"); return ok; },
};
function normTags(t) { return [...new Set((Array.isArray(t) ? t : String(t || "").split(",")).map((x) => String(x).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 30); }
function num(v) { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; }
