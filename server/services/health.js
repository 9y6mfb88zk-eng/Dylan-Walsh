// Background service registry: records every run so the health panel shows genuine status.
import { db } from "../db.js";

const registry = new Map();

/** register("weather", { label, everyMs, configured: () => bool, enabled: () => bool, note }) */
export function register(name, meta) { registry.set(name, meta); }

export async function tracked(name, fn) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO service_status (name, last_run) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run").run(name, now);
  try {
    const result = await fn();
    db.prepare("UPDATE service_status SET last_ok = ?, detail = ? WHERE name = ?").run(new Date().toISOString(), JSON.stringify(summarize(result)), name);
    return result;
  } catch (e) {
    db.prepare("UPDATE service_status SET last_error = ?, last_error_at = ? WHERE name = ?").run(String(e.message || e).slice(0, 300), new Date().toISOString(), name);
    throw e;
  }
}
function summarize(r) {
  if (r == null || typeof r !== "object") return { result: r ?? null };
  const o = {};
  for (const [k, v] of Object.entries(r)) if (["string", "number", "boolean"].includes(typeof v)) o[k] = v;
  return o;
}

export function healthReport() {
  const rows = Object.fromEntries(db.prepare("SELECT * FROM service_status").all().map((r) => [r.name, r]));
  const now = Date.now();
  return [...registry.entries()].map(([name, m]) => {
    const r = rows[name] || {};
    const configured = m.configured ? !!m.configured() : true;
    const enabled = m.enabled ? !!m.enabled() : true;
    const lastOk = r.last_ok ? Date.parse(r.last_ok) : 0;
    const lastErr = r.last_error_at ? Date.parse(r.last_error_at) : 0;
    let state = "ok";
    if (!configured) state = "not_configured";
    else if (!enabled) state = "disabled";
    else if (!r.last_run) state = "waiting";
    else if (lastErr > lastOk) state = "error";
    else if (m.everyMs && now - lastOk > m.everyMs * 3 + 60_000) state = "stale";
    return {
      name, label: m.label, note: m.note || "", state, every: m.everyMs || null,
      lastRun: r.last_run || null, lastOk: r.last_ok || null,
      lastError: lastErr > lastOk ? r.last_error : null, lastErrorAt: r.last_error_at || null,
      detail: r.detail ? JSON.parse(r.detail) : {},
    };
  });
}
