import { db } from "../db.js";

/** Append-only audit trail of security-relevant actions. Never put secrets in `detail`. */
export function audit(action, { deviceId = null, ip = null, ...detail } = {}) {
  db.prepare("INSERT INTO audit_log (device_id, action, detail, ip) VALUES (?, ?, ?, ?)").run(deviceId, action, JSON.stringify(detail), ip);
}
export function auditFromReq(req, action, detail = {}) {
  audit(action, { deviceId: req.auth?.deviceId || null, ip: req.ip, ...detail });
}
export function recentAudit(limit = 100) {
  return db.prepare("SELECT a.*, d.name AS device_name FROM audit_log a LEFT JOIN devices d ON d.id = a.device_id ORDER BY a.id DESC LIMIT ?")
    .all(limit).map((r) => ({ ...r, detail: JSON.parse(r.detail || "{}") }));
}
