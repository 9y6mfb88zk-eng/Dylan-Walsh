// Small, validated CRUD layer used by the simpler record types (clients, notes, goals, habits, debts…).
// Every write is validated against a field spec and broadcast to connected devices.
import { db } from "../db.js";
import { changed } from "../realtime.js";

const bad = (msg) => Object.assign(new Error(msg), { status: 400, expose: true });

function coerce(name, spec, v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") {
    if (spec.required) throw bad(`${spec.label || name} is required`);
    return spec.type === "text" ? "" : spec.type === "bool" ? 0 : spec.type === "json" ? (spec.default ?? "[]") : null;
  }
  switch (spec.type) {
    case "text": { const s = String(v).trim(); if (spec.required && !s) throw bad(`${spec.label || name} is required`); return s.slice(0, spec.max || 2000); }
    case "int": { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw bad(`${name} must be a number`); return spec.min != null ? Math.max(spec.min, spec.max != null ? Math.min(spec.max, n) : n) : n; }
    case "num": { const n = Number(v); if (!Number.isFinite(n)) throw bad(`${name} must be a number`); return n; }
    case "bool": return v === true || v === 1 || v === "1" || v === "true" ? 1 : 0;
    case "date": { const s = String(v).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${name} must be a date (YYYY-MM-DD)`); return s; }
    case "time": { const s = String(v); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw bad(`${name} must be a time (HH:MM)`); return s; }
    case "datetime": { const d = new Date(v); if (Number.isNaN(d.getTime())) throw bad(`${name} must be a date and time`); return d.toISOString(); }
    case "enum": { const s = String(v); if (!spec.values.includes(s)) throw bad(`${name} must be one of ${spec.values.join(", ")}`); return s; }
    case "json": return JSON.stringify(v);
    default: return v;
  }
}

/**
 * crud("clients", { fields: {name: {type:"text", required:true}, …}, entity: "business", order: "name" })
 * → { list(filters), get(id), create(data), update(id, data), remove(id) }
 */
export function crud(table, { fields, entity = table, order = "id DESC", hydrate = (r) => r, touch = false }) {
  const names = Object.keys(fields);
  const jsonFields = names.filter((n) => fields[n].type === "json");
  const boolFields = names.filter((n) => fields[n].type === "bool");
  const out = (r) => {
    if (!r) return null;
    const o = { ...r };
    for (const f of jsonFields) { try { o[f] = JSON.parse(o[f] ?? "null"); } catch {} }
    for (const f of boolFields) o[f] = !!o[f];
    return hydrate(o);
  };
  const api = {
    table,
    list(filters = {}) {
      const where = [], args = [];
      for (const [k, v] of Object.entries(filters)) {
        if (v === undefined || v === null || v === "" || !(names.includes(k) || k === "id")) continue;
        where.push(`${k} = ?`); args.push(fields[k]?.type === "bool" ? (v === true || v === "true" || v === "1" ? 1 : 0) : v);
      }
      return db.prepare(`SELECT * FROM ${table} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order}`).all(...args).map(out);
    },
    get(id) { return out(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id))); },
    create(data = {}) {
      const row = {};
      for (const n of names) {
        const v = coerce(n, fields[n], data[n] ?? fields[n].default);
        if (v !== undefined) row[n] = v;
        else if (fields[n].required) throw bad(`${fields[n].label || n} is required`);
      }
      const cols = Object.keys(row);
      const r = db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
      changed(entity);
      return api.get(r.lastInsertRowid);
    },
    update(id, data = {}) {
      const cur = api.get(id);
      if (!cur) return null;
      const sets = [], args = [];
      for (const n of names) {
        if (!(n in data)) continue;
        sets.push(`${n} = ?`); args.push(coerce(n, { ...fields[n], required: false }, data[n]));
      }
      if (touch) sets.push("updated_at = datetime('now')");
      if (sets.length) db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...args, Number(id));
      changed(entity);
      return api.get(id);
    },
    remove(id) { const ok = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(Number(id)).changes > 0; changed(entity); return ok; },
  };
  return api;
}

/** Mount list/create/update/delete routes for a crud service. */
export function mountCrud(router, base, service, { listFilters = [] } = {}) {
  router.get(base, (req, res) => res.json(service.list(Object.fromEntries(listFilters.map((f) => [f, req.query[f]])))));
  router.get(`${base}/:id`, (req, res) => { const r = service.get(req.params.id); r ? res.json(r) : res.status(404).json({ error: "Not found" }); });
  router.post(base, (req, res) => res.status(201).json(service.create(req.body || {})));
  router.patch(`${base}/:id`, (req, res) => { const r = service.update(req.params.id, req.body || {}); r ? res.json(r) : res.status(404).json({ error: "Not found" }); });
  router.delete(`${base}/:id`, (req, res) => res.json({ ok: service.remove(req.params.id) }));
}
