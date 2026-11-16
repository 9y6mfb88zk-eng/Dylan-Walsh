// Conversations shared by every device: start on the laptop, carry on from the iPhone.
import { db, kvGet, kvSet } from "../db.js";
import { randomId } from "../security/crypto.js";
import { broadcast, changed } from "../realtime.js";

function hydrate(m) { return m && { ...m, sources: m.sources ? JSON.parse(m.sources) : [] }; }

export const conversations = {
  currentId() {
    let id = kvGet("currentConversation");
    if (!id || !db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id)) id = conversations.create().id;
    return id;
  },
  create(title = "Conversation") {
    const id = randomId();
    db.prepare("INSERT INTO conversations (id, title) VALUES (?, ?)").run(id, title);
    kvSet("currentConversation", id);
    changed("conversations");
    return { id, title };
  },
  setCurrent(id) {
    if (!db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id)) return false;
    kvSet("currentConversation", id); changed("conversations"); return true;
  },
  list(limit = 30) {
    return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS count
      FROM conversations c ORDER BY updated_at DESC LIMIT ?`).all(limit);
  },
  get(id) { return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id); },
  messages(id, { limit = 100, afterId = 0 } = {}) {
    return db.prepare(`SELECT m.*, d.name AS device_name FROM messages m LEFT JOIN devices d ON d.id = m.device_id
      WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT ?`).all(id, afterId, limit).reverse().map(hydrate);
  },
  findByClientId(clientId) { return clientId ? hydrate(db.prepare("SELECT * FROM messages WHERE client_id = ?").get(clientId)) : null; },
  /** Idempotent on clientId so an offline retry never duplicates a message. */
  add({ conversationId, role, content, deviceId = null, clientId = null, sources = null }) {
    if (clientId) { const ex = conversations.findByClientId(clientId); if (ex) return { message: ex, duplicate: true }; }
    const r = db.prepare("INSERT INTO messages (conversation_id, role, content, device_id, client_id, sources) VALUES (?, ?, ?, ?, ?, ?)")
      .run(conversationId, role, String(content).slice(0, 20000), deviceId, clientId, sources ? JSON.stringify(sources) : null);
    const isFirstUser = role === "user" && db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(conversationId).n === 1;
    db.prepare(`UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')${isFirstUser ? ", title = ?" : ""} WHERE id = ?`)
      .run(...(isFirstUser ? [String(content).slice(0, 60), conversationId] : [conversationId]));
    const message = hydrate(db.prepare("SELECT m.*, d.name AS device_name FROM messages m LEFT JOIN devices d ON d.id = m.device_id WHERE m.id = ?").get(r.lastInsertRowid));
    broadcast({ type: "message", message });
    return { message, duplicate: false };
  },
  /** Recent turns in model format, preceded by the running summary of older turns. */
  context(id, n = 20) {
    const c = conversations.get(id);
    const rows = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?").all(id, n).reverse();
    // The API requires alternating turns starting with the user: merge/trim accordingly.
    const out = [];
    for (const r of rows) {
      if (out.length && out.at(-1).role === r.role) out.at(-1).content += `\n${r.content}`;
      else out.push({ role: r.role, content: r.content });
    }
    while (out.length && out[0].role !== "user") out.shift();
    return { summary: c?.summary || "", turns: out };
  },
  unsummarized(id) {
    const c = conversations.get(id);
    return db.prepare("SELECT id, role, content FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id").all(id, c?.summarized_until || 0);
  },
  setSummary(id, summary, untilId) {
    db.prepare("UPDATE conversations SET summary = ?, summarized_until = ? WHERE id = ?").run(summary, untilId, id);
  },
  clearAll() {
    db.exec("DELETE FROM messages; DELETE FROM conversations;");
    kvSet("currentConversation", null);
    changed("conversations");
  },
  remove(id) {
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    if (kvGet("currentConversation") === id) kvSet("currentConversation", null);
    changed("conversations");
  },
};
