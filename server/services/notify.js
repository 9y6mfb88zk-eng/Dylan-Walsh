// Notification centre + activity log.
// notify() stores the notification, pushes it live to every open app (the Windows app shows a native notification
// and can speak it) and, unless switched off for that kind, sends a web push to phones.
import { db, getSettings } from "../db.js";
import { broadcast, changed } from "../realtime.js";
import { notifyAll } from "../push.js";

export const KINDS = ["alarm", "reminder", "event", "task", "automation", "project", "system", "research", "idea", "focus", "habit", "briefing", "finance"];

const row = (r) => r && { ...r, data: JSON.parse(r.data || "{}") };

export async function notify({ kind = "system", title, body = "", url = "/", speak, urgency, data = {}, push = true, tag } = {}) {
  const r = db.prepare("INSERT INTO notifications (kind, title, body, url, data) VALUES (?, ?, ?, ?, ?)")
    .run(kind, String(title).slice(0, 200), String(body || "").slice(0, 1000), url, JSON.stringify(data));
  const n = row(db.prepare("SELECT * FROM notifications WHERE id = ?").get(r.lastInsertRowid));
  changed("notifications");
  const payload = { id: n.id, kind, title: n.title, body: n.body, url, tag: tag || `${kind}-${n.id}`, urgency, speak };
  const prefs = getSettings().notifications || {};
  if (push && prefs[kind] !== false) {
    await notifyAll(payload).catch(() => {});        // also broadcasts {type:"notify"} to open apps
  } else {
    broadcast({ type: "notify", notification: payload });
  }
  return n;
}

export const notifications = {
  list({ limit = 100, unread = false } = {}) {
    return db.prepare(`SELECT * FROM notifications WHERE dismissed_at IS NULL ${unread ? "AND read_at IS NULL" : ""} ORDER BY id DESC LIMIT ?`).all(limit).map(row);
  },
  history(limit = 300) { return db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ?").all(limit).map(row); },
  unreadCount() { return db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL").get().n; },
  markRead(id) {
    if (id === "all") db.prepare("UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE read_at IS NULL").run();
    else db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?").run(Number(id));
    changed("notifications");
  },
  dismiss(id) {
    if (id === "all") db.prepare("UPDATE notifications SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dismissed_at IS NULL").run();
    else db.prepare("UPDATE notifications SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(Number(id));
    changed("notifications");
  },
  snooze(id, minutes = 10) {
    const until = new Date(Date.now() + Math.max(1, Math.min(1440, Number(minutes) || 10)) * 60_000).toISOString();
    db.prepare("UPDATE notifications SET snooze_until = ?, read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(until, Number(id));
    changed("notifications");
    return until;
  },
  /** Re-deliver snoozed notifications whose time has come (called by the scheduler). */
  async deliverSnoozed() {
    const due = db.prepare("SELECT * FROM notifications WHERE snooze_until IS NOT NULL AND snooze_until <= ? AND dismissed_at IS NULL").all(new Date().toISOString());
    for (const n of due) {
      db.prepare("UPDATE notifications SET snooze_until = NULL, read_at = NULL WHERE id = ?").run(n.id);
      await notifyAll({ id: n.id, kind: n.kind, title: n.title, body: n.body, url: n.url, tag: `${n.kind}-${n.id}` }).catch(() => {});
    }
    if (due.length) changed("notifications");
    return { delivered: due.length };
  },
};

// ---------------------------------------------------------------- Activity log (what JARVIS actually did)
export function logActivity(kind, summary, detail = {}, deviceId = null) {
  db.prepare("INSERT INTO activity (kind, summary, detail, device_id) VALUES (?, ?, ?, ?)").run(kind, String(summary).slice(0, 300), JSON.stringify(detail), deviceId);
  changed("activity");
}
export function recentActivity(limit = 20) {
  return db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?").all(limit).map((r) => ({ ...r, detail: JSON.parse(r.detail || "{}") }));
}
