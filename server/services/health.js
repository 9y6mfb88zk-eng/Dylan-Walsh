// Background service registry: records every run so the health panel shows genuine status.
import { db, getSettings } from "../db.js";

const registry = new Map();

/** register("weather", { label, everyMs, configured: () => bool, enabled: () => bool, note }) */
export function register(name, meta) { registry.set(name, meta); }

export async function tracked(name, fn) {
  const now = new Date().toISOString();
  const prev = db.prepare("SELECT last_ok, last_error_at FROM service_status WHERE name = ?").get(name);
  const wasFailing = !!prev?.last_error_at && !(prev.last_ok && prev.last_ok > prev.last_error_at);
  db.prepare("INSERT INTO service_status (name, last_run) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run").run(name, now);
  try {
    const result = await fn();
    db.prepare("UPDATE service_status SET last_ok = ?, detail = ? WHERE name = ?").run(new Date().toISOString(), JSON.stringify(summarize(result)), name);
    if (wasFailing) alertChange(name, "recovered");
    return result;
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    db.prepare("UPDATE service_status SET last_error = ?, last_error_at = ? WHERE name = ?").run(msg, new Date().toISOString(), name);
    if (!wasFailing && prev?.last_ok) alertChange(name, "failed", msg);     // it was working, and now it isn't
    throw e;
  }
}
/** Proactive awareness: tell the user once when an integration stops working, and once when it recovers. */
function alertChange(name, change, msg = "") {
  const m = registry.get(name);
  if (!m || getSettings().awareness?.integrationAlerts === false) return;
  import("./notify.js").then(({ notify }) => notify(change === "failed"
    ? { kind: "system", title: `${m.label} has stopped working`, body: `${msg}. I'll keep retrying and let you know when it's back.`, url: "/?tab=diagnostics", speak: `${m.label} has stopped working, ${getSettings().profile?.title || "Sir"}.` }
    : { kind: "system", title: `${m.label} is working again`, body: "", url: "/?tab=diagnostics", push: false })).catch(() => {});
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
