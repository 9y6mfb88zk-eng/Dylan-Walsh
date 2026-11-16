// Home Assistant (optional). JARVIS only controls devices the user has explicitly allowed, every command is
// checked against an allowlist of safe services, security devices (locks, alarms, garage doors) need a separate
// confirmation, and the resulting state is read back from Home Assistant before success is reported.
import { db, kvSet } from "../db.js";
import { config } from "../config.js";
import { changed } from "../realtime.js";
import { audit } from "../security/audit.js";
import { logActivity } from "./notify.js";
import { timed } from "./diagnostics.js";

const DOMAINS = {
  light: ["turn_on", "turn_off", "toggle"],
  switch: ["turn_on", "turn_off", "toggle"],
  fan: ["turn_on", "turn_off", "toggle"],
  climate: ["set_temperature", "turn_on", "turn_off"],
  media_player: ["media_play", "media_pause", "volume_set", "turn_on", "turn_off"],
  scene: ["turn_on"],
  script: ["turn_on"],
  cover: ["open_cover", "close_cover", "stop_cover"],
  lock: ["lock", "unlock"],
};
// Anything that affects physical security needs the user's explicit yes every time.
const SENSITIVE = (domain, entity, service) => domain === "lock" || (domain === "cover" && /garage|gate|door/i.test(entity)) || (service === "unlock");
const bad = (m, status = 400) => Object.assign(new Error(m), { status, expose: true });
export const configured = () => !!(config.haUrl && config.haToken);

async function ha(pathname, { method = "GET", body } = {}) {
  if (!configured()) throw bad("Home Assistant isn't set up. Add its address and a long-lived access token in API keys.", 503);
  return timed("homeassistant", { purpose: pathname.split("/")[2] || "api" }, async () => {
    const r = await fetch(`${config.haUrl.replace(/\/$/, "")}${pathname}`, {
      method, headers: { authorization: `Bearer ${config.haToken}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401) throw bad("Home Assistant rejected the access token.", 502);
    if (!r.ok) throw bad(`Home Assistant error (HTTP ${r.status})`, 502);
    return r.json();
  });
}

export async function ping() {
  try {
    const j = await ha("/api/");
    const n = db.prepare("SELECT COUNT(*) AS n FROM smart_devices").get().n;
    kvSet("smarthome.status", { ok: true, at: new Date().toISOString(), devices: n, message: j.message });
    return { ok: true, message: j.message || "API running." };
  } catch (e) {
    kvSet("smarthome.status", { ok: false, at: new Date().toISOString(), error: e.message });
    return { ok: false, error: e.message };
  }
}

/** Read every entity from Home Assistant. New devices start as NOT allowed. */
export async function discover() {
  const states = await ha("/api/states");
  let added = 0;
  for (const s of states) {
    const domain = s.entity_id.split(".")[0];
    if (!DOMAINS[domain]) continue;
    const exists = db.prepare("SELECT 1 FROM smart_devices WHERE entity_id = ?").get(s.entity_id);
    db.prepare(`INSERT INTO smart_devices (entity_id, name, domain, state, allowed, updated_at) VALUES (?, ?, ?, ?, 0, datetime('now'))
      ON CONFLICT(entity_id) DO UPDATE SET name = excluded.name, state = excluded.state, updated_at = excluded.updated_at`)
      .run(s.entity_id, String(s.attributes?.friendly_name || s.entity_id).slice(0, 120), domain, String(s.state).slice(0, 60));
    if (!exists) added++;
  }
  kvSet("smarthome.status", { ok: true, at: new Date().toISOString(), devices: db.prepare("SELECT COUNT(*) AS n FROM smart_devices").get().n });
  changed("smarthome");
  return { devices: list().length, added };
}

export function list() { return db.prepare("SELECT * FROM smart_devices ORDER BY allowed DESC, domain, name").all().map((d) => ({ ...d, allowed: !!d.allowed, services: DOMAINS[d.domain] || [], sensitive: d.domain === "lock" })); }
export function find(q) {
  const s = String(q || "").toLowerCase();
  return list().find((d) => d.entity_id === s) || list().find((d) => d.name.toLowerCase() === s) || list().find((d) => d.name.toLowerCase().includes(s) || d.entity_id.includes(s.replace(/\s+/g, "_")));
}
export function setAllowed(entityId, allowed, { deviceId } = {}) {
  const ok = db.prepare("UPDATE smart_devices SET allowed = ? WHERE entity_id = ?").run(allowed ? 1 : 0, entityId).changes > 0;
  if (ok) { audit("smarthome.allowlist", { deviceId, entityId, allowed: !!allowed }); changed("smarthome"); }
  return ok;
}

/** Validate a command. Returns {device, service, data, sensitive}. */
export function validate(entityId, service, data = {}) {
  const d = db.prepare("SELECT * FROM smart_devices WHERE entity_id = ?").get(entityId);
  if (!d) throw bad(`I don't know a device called ${entityId}. Refresh the device list in Smart Home.`, 404);
  if (!d.allowed) throw bad(`${d.name} isn't on your allowed list. Allow it in Smart Home first.`, 403);
  if (!(DOMAINS[d.domain] || []).includes(service)) throw bad(`${service} isn't permitted for ${d.domain} devices.`, 403);
  const clean = {};
  if (data.brightness_pct != null) clean.brightness_pct = Math.max(1, Math.min(100, Math.round(Number(data.brightness_pct))));
  if (data.temperature != null) { const t = Number(data.temperature); if (!(t >= 5 && t <= 35)) throw bad("Temperature must be between 5 and 35 °C"); clean.temperature = t; }
  if (data.volume_level != null) clean.volume_level = Math.max(0, Math.min(1, Number(data.volume_level)));
  return { device: d, service, data: clean, sensitive: SENSITIVE(d.domain, d.entity_id, service) };
}

/** Run a validated command and read the state back. Callers must have obtained confirmation for sensitive ones. */
export async function control(entityId, service, data = {}, { deviceId, confirmed = false } = {}) {
  const v = validate(entityId, service, data);
  if (v.sensitive && !confirmed) throw bad(`${v.device.name} is a security device; this needs your confirmation.`, 409);
  await ha(`/api/services/${v.device.domain}/${service}`, { method: "POST", body: { entity_id: entityId, ...v.data } });
  await new Promise((r) => setTimeout(r, 700));
  const st = await ha(`/api/states/${encodeURIComponent(entityId)}`);
  db.prepare("UPDATE smart_devices SET state = ?, updated_at = datetime('now') WHERE entity_id = ?").run(String(st.state), entityId);
  audit("smarthome.control", { deviceId, entityId, service });
  logActivity("smarthome", `${v.device.name}: ${service.replace(/_/g, " ")} → now ${st.state}`, { entityId, service }, deviceId);
  changed("smarthome");
  return { ok: true, device: v.device.name, service, state: st.state, verified: true };
}
