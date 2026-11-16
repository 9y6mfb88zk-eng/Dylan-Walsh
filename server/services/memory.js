// Structured long-term memory with search. Sensitive facts wait for explicit permission.
import { db } from "../db.js";
import { config } from "../config.js";
import { changed } from "../realtime.js";

export const CATEGORIES = ["preference", "goal", "project", "date", "idea", "decision", "fact", "summary"];

const SENSITIVE = [
  /\b(health|medical|diagnos|illness|disease|medication|pregnan|therapy|mental|depress|anxiety)\w*/i,
  /\b(religio|church|mosque|faith|sexual|gay|lesbian|bisexual|political|vote[sd]?|party member)\w*/i,
  /\b(address|post ?code|passport|national insurance|\bNI number|driving licen[cs]e|date of birth|DOB)\b/i,
  /\b(salary|debt|loan|overdraft|income|bank account|sort code)\b/i,
  /\b\d{2}-\d{2}-\d{2}\b/, /\b\d{8,}\b/,
];
const FORBIDDEN = [/\b(password|passcode|pin\b|pin number|cvv|security code|one[- ]time code|card number)\b/i, /\b(?:\d[ -]?){13,19}\b/];

export function classify(fact) {
  if (FORBIDDEN.some((r) => r.test(fact))) return "forbidden";
  return SENSITIVE.some((r) => r.test(fact)) ? "sensitive" : "normal";
}

async function embed(text) {
  if (!config.openaiKey) return null;
  try {
    const r = await fetch(`${config.openaiBaseUrl}/v1/embeddings`, {
      method: "POST", headers: { authorization: `Bearer ${config.openaiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.openaiEmbedModel, input: text.slice(0, 4000) }), signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    return (await r.json()).data?.[0]?.embedding || null;
  } catch { return null; }
}

const tokenize = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set("the and for with that this from have has are was were you your his her him she they them our ours its not but all any can will just into about what when where which who how why than then there their also been being some more most very much such only over under".split(" "));
function cosine(a, b) { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); }

function hydrate(r) { const { embedding, ...rest } = r; return { ...rest, sensitive: !!r.sensitive, semantic: !!embedding }; }

export const memory = {
  list({ status } = {}) {
    return db.prepare(`SELECT * FROM memories ${status ? "WHERE status = ?" : ""} ORDER BY id DESC`).all(...(status ? [status] : [])).map(hydrate);
  },
  get(id) { const r = db.prepare("SELECT * FROM memories WHERE id = ?").get(id); return r && hydrate(r); },
  /**
   * Save a fact. Sensitive facts are stored as "pending" until the user approves them;
   * credentials are refused outright.
   */
  async save({ fact, category = "fact", sensitive = false, source = "user", approved = false }) {
    fact = String(fact || "").trim().slice(0, 1000);
    if (!fact) throw Object.assign(new Error("Nothing to remember"), { status: 400 });
    const cls = classify(fact);
    if (cls === "forbidden") return { saved: false, refused: true, reason: "I don't store passwords, PINs or card numbers." };
    const isSensitive = sensitive || cls === "sensitive";
    const status = isSensitive && !approved ? "pending" : "saved";
    const dup = db.prepare("SELECT id FROM memories WHERE lower(fact) = lower(?)").get(fact);
    if (dup) return { saved: true, duplicate: true, id: dup.id, status: "saved" };
    const emb = await embed(fact);
    const r = db.prepare("INSERT INTO memories (fact, category, sensitive, status, source, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))")
      .run(fact, CATEGORIES.includes(category) ? category : "fact", isSensitive ? 1 : 0, status, source, emb ? JSON.stringify(emb) : null);
    changed("memories");
    return { saved: status === "saved", pending: status === "pending", id: Number(r.lastInsertRowid), status };
  },
  approve(id) { const ok = db.prepare("UPDATE memories SET status = 'saved', updated_at = datetime('now') WHERE id = ? AND status = 'pending'").run(id).changes > 0; changed("memories"); return ok; },
  async update(id, { fact, category }) {
    const m = memory.get(id); if (!m) return null;
    const f = fact !== undefined ? String(fact).trim().slice(0, 1000) : m.fact;
    const emb = f !== m.fact ? await embed(f) : undefined;
    db.prepare(`UPDATE memories SET fact = ?, category = ?, updated_at = datetime('now')${emb !== undefined ? ", embedding = ?" : ""} WHERE id = ?`)
      .run(...[f, CATEGORIES.includes(category) ? category : m.category, ...(emb !== undefined ? [emb ? JSON.stringify(emb) : null] : []), id]);
    changed("memories");
    return memory.get(id);
  },
  remove(id) { const ok = db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0; changed("memories"); return ok; },
  removeAll() { db.exec("DELETE FROM memories"); changed("memories"); },
  export() { return db.prepare("SELECT id, fact, category, sensitive, status, source, created_at, updated_at FROM memories ORDER BY id").all(); },
  /** Hybrid search: embeddings when available, keyword relevance always. Only approved memories. */
  async search(query, limit = 8) {
    const rows = db.prepare("SELECT * FROM memories WHERE status = 'saved'").all();
    if (!rows.length) return [];
    const q = tokenize(query);
    const N = rows.length;
    const df = new Map();
    const docs = rows.map((r) => { const t = tokenize(r.fact + " " + r.category); new Set(t).forEach((w) => df.set(w, (df.get(w) || 0) + 1)); return t; });
    const qEmb = rows.some((r) => r.embedding) ? await embed(query) : null;
    const scored = rows.map((r, i) => {
      let lex = 0;
      for (const w of q) { const tf = docs[i].filter((x) => x === w || x.startsWith(w) || w.startsWith(x)).length; if (tf) lex += (tf / (tf + 1.2)) * Math.log(1 + N / (df.get(w) || 1)); }
      const sem = qEmb && r.embedding ? cosine(qEmb, JSON.parse(r.embedding)) : 0;
      return { r, score: lex + sem * 3 };
    });
    return scored.filter((s) => s.score > 0.05).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => ({ ...hydrate(s.r), score: +s.score.toFixed(3) }));
  },
  /** A short always-on profile: preferences and goals, newest first. */
  profile(limit = 15) {
    return db.prepare("SELECT fact, category FROM memories WHERE status = 'saved' AND category IN ('preference','goal','date','decision','fact') ORDER BY id DESC LIMIT ?").all(limit);
  },
};
