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
  add({ conversationId, role, content, deviceId = null, clientId = null, sources = null, meta = null }) {
    if (clientId) { const ex = conversations.findByClientId(clientId); if (ex) return { message: ex, duplicate: true }; }
    const r = db.prepare("INSERT INTO messages (conversation_id, role, content, device_id, client_id, sources, meta) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(conversationId, role, String(content).slice(0, 20000), deviceId, clientId, sources ? JSON.stringify(sources) : null, meta ? JSON.stringify(meta) : null);
    const isFirstUser = role === "user" && db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(conversationId).n === 1;
    db.prepare(`UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')${isFirstUser ? ", title = ?" : ""} WHERE id = ?`)
      .run(...(isFirstUser ? [String(content).slice(0, 60), conversationId] : [conversationId]));
    const message = hydrate(db.prepare("SELECT m.*, d.name AS device_name FROM messages m LEFT JOIN devices d ON d.id = m.device_id WHERE m.id = ?").get(r.lastInsertRowid));
    broadcast({ type: "message", message });
    return { message, duplicate: false };
  },
  /**
   * Recent turns in model format, preceded by the running summary of older turns. A reply the user interrupted is
   * given as what they actually heard (followed by "…"), so "explain that again" refers to the right thing.
   * Also returns JARVIS's recent replies and their metadata (what it looked up), for follow-up context.
   */
  context(id, n = 20) {
    const c = conversations.get(id);
    const rows = db.prepare("SELECT role, content, meta FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?").all(id, n).reverse();
    const assistant = [];
    // The API requires alternating turns starting with the user: merge/trim accordingly.
    const out = [];
    for (const r of rows) {
      const meta = r.meta ? JSON.parse(r.meta) : null;
      let content = r.content;
      if (r.role === "assistant") { assistant.push({ text: r.content, meta }); if (meta?.interrupted) content = meta.heard ? `${meta.heard.trim()}…` : "…"; }
      if (out.length && out.at(-1).role === r.role) out.at(-1).content += `\n${content}`;
      else out.push({ role: r.role, content });
    }
    while (out.length && out[0].role !== "user") out.shift();
    const last = assistant.at(-1);
    return { summary: c?.summary || "", turns: out, replies: assistant.map((a) => a.text), metas: assistant.map((a) => a.meta), interrupted: last?.meta?.interrupted ? { heard: last.meta.heard || "", full: last.text } : null };
  },
  /**
   * The user cut JARVIS off: record how much of the reply to their message `clientId` they actually heard.
   * The reply may still be being saved (the interrupted request stops a moment later), so this waits briefly for it.
   */
  async markInterrupted(clientId, heard = "", { waitMs = 2500 } = {}) {
    const user = clientId ? db.prepare("SELECT id, conversation_id FROM messages WHERE client_id = ?").get(clientId) : null;
    if (!user) return false;
    const find = () => db.prepare("SELECT id, meta FROM messages WHERE conversation_id = ? AND id > ? AND role = 'assistant' ORDER BY id LIMIT 1").get(user.conversation_id, user.id);
    let m = find();
    for (let t = 0; !m && t < waitMs; t += 100) { await new Promise((r) => setTimeout(r, 100)); m = find(); }
    if (!m) return false;
    const meta = { ...(m.meta ? JSON.parse(m.meta) : {}), interrupted: true, heard: String(heard || "").slice(0, 4000) };
    db.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(JSON.stringify(meta), m.id);
    return true;
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
