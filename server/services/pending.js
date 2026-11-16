// Actions that need the user's explicit "yes" before they run (calendar changes, conflicting bookings, etc.).
import { db } from "../db.js";
import { randomId } from "../security/crypto.js";
import { changed, broadcast } from "../realtime.js";
import { audit } from "../security/audit.js";

const handlers = new Map();
export function registerHandler(kind, fn) { handlers.set(kind, fn); }

export function propose(kind, payload, summary, ttlMinutes = 15) {
  if (!handlers.has(kind)) throw new Error(`No handler for ${kind}`);
  const id = randomId().slice(0, 8);
  db.prepare("INSERT INTO pending_actions (id, kind, payload, summary, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, kind, JSON.stringify(payload), summary, new Date(Date.now() + ttlMinutes * 60_000).toISOString());
  changed("pending");
  broadcast({ type: "pending", action: { id, kind, summary } });
  return { id, summary, needsConfirmation: true };
}

export function list() {
  db.prepare("UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(new Date().toISOString());
  return db.prepare("SELECT id, kind, summary, created_at, expires_at FROM pending_actions WHERE status = 'pending' ORDER BY created_at").all();
}

export async function decide(id, decision, { deviceId } = {}) {
  const a = db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id);
  if (!a) throw Object.assign(new Error("No such pending action"), { status: 404 });
  if (a.status !== "pending") throw Object.assign(new Error(`That action is already ${a.status}.`), { status: 409 });
  if (Date.parse(a.expires_at) < Date.now()) {
    db.prepare("UPDATE pending_actions SET status = 'expired' WHERE id = ?").run(id);
    throw Object.assign(new Error("That request expired. Ask again if you still want it."), { status: 410 });
  }
  if (decision !== "confirm") {
    db.prepare("UPDATE pending_actions SET status = 'rejected' WHERE id = ?").run(id);
    changed("pending");
    return { status: "rejected" };
  }
  db.prepare("UPDATE pending_actions SET status = 'confirmed' WHERE id = ?").run(id);
  try {
    const result = await handlers.get(a.kind)(JSON.parse(a.payload));
    db.prepare("UPDATE pending_actions SET result = ? WHERE id = ?").run(JSON.stringify(result ?? null), id);
    audit("action.confirmed", { deviceId, kind: a.kind, summary: a.summary });
    changed("pending");
    return { status: "done", result };
  } catch (e) {
    db.prepare("UPDATE pending_actions SET status = 'failed', result = ? WHERE id = ?").run(JSON.stringify({ error: e.message }), id);
    changed("pending");
    throw e;
  }
}
