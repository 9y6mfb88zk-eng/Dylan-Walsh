// Structured long-term memory with search. Sensitive facts wait for explicit permission.
import { db } from "../db.js";
import { config } from "../config.js";
import { changed } from "../realtime.js";

// Personal memory categories. Older categories (goal, project, idea, fact) are still accepted and shown alongside.
export const CATEGORIES = ["profile", "career", "ambition", "interest", "hobby", "business", "creative", "date", "preference", "routine", "task", "decision", "topic",
  "goal", "project", "idea", "fact", "summary"];
export const CATEGORY_LABELS = { profile: "Personal profile", career: "Career", ambition: "Ambitions", interest: "Interests", hobby: "Hobbies", business: "Businesses",
  creative: "Creative projects", date: "Important dates", preference: "Preferences", routine: "Routines", task: "Ongoing tasks", decision: "Previous decisions",
  topic: "Frequently discussed", goal: "Ambitions", project: "Projects", idea: "Ideas", fact: "General", summary: "Conversation summaries" };
// Words that mean the same thing in a question and in a memory ("career" ↔ "fire service", "story" ↔ "series").
const RELATED = {
  business: ["agency", "company", "startup", "entrepreneur", "website", "clients", "idea"], idea: ["business", "plan", "concept"],
  career: ["job", "army", "soldier", "fire", "service", "work", "transition", "rescue"], job: ["career", "army", "fire", "work"],
  story: ["creative", "series", "novel", "book", "writing", "kill", "house", "fiction"], writing: ["creative", "story", "series", "fiction"],
  game: ["gaming", "football", "manager"], football: ["football manager", "gaming"], hobby: ["interest", "gaming", "football", "writing"],
  live: ["stationed", "location", "cyprus", "dhekelia", "from"], from: ["united kingdom", "uk"], priorities: ["goal", "ambition", "project", "task"],
};

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

function hydrate(r) { const { embedding, ...rest } = r; return { ...rest, sensitive: !!r.sensitive, pinned: !!r.pinned, semantic: !!embedding }; }

export const memory = {
  list({ status } = {}) {
    return db.prepare(`SELECT * FROM memories ${status ? "WHERE status = ?" : ""} ORDER BY id DESC`).all(...(status ? [status] : [])).map(hydrate);
  },
  get(id) { const r = db.prepare("SELECT * FROM memories WHERE id = ?").get(id); return r && hydrate(r); },
  /**
   * Save a fact. Sensitive facts are stored as "pending" until the user approves them;
   * credentials are refused outright.
   */
  async save({ fact, category = "fact", sensitive = false, source = "user", approved = false, pinned = false, topic = "" }) {
    fact = String(fact || "").trim().slice(0, 1000);
    if (!fact) throw Object.assign(new Error("Nothing to remember"), { status: 400 });
    const cls = classify(fact);
    if (cls === "forbidden") return { saved: false, refused: true, reason: "I don't store passwords, PINs or card numbers." };
    const isSensitive = sensitive || cls === "sensitive";
    const status = isSensitive && !approved ? "pending" : "saved";
    const dup = db.prepare("SELECT id FROM memories WHERE lower(fact) = lower(?)").get(fact);
    if (dup) return { saved: true, duplicate: true, id: dup.id, status: "saved" };
    const emb = await embed(fact);
    const r = db.prepare("INSERT INTO memories (fact, category, sensitive, status, source, embedding, pinned, topic, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))")
      .run(fact, CATEGORIES.includes(category) ? category : "fact", isSensitive ? 1 : 0, status, source, emb ? JSON.stringify(emb) : null, pinned ? 1 : 0, String(topic || "").slice(0, 80));
    changed("memories");
    return { saved: status === "saved", pending: status === "pending", id: Number(r.lastInsertRowid), status };
  },
  approve(id) { const ok = db.prepare("UPDATE memories SET status = 'saved', updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ? AND status = 'pending'").run(id).changes > 0; changed("memories"); return ok; },
  async update(id, { fact, category, pinned, topic }) {
    const m = memory.get(id); if (!m) return null;
    const f = fact !== undefined ? String(fact).trim().slice(0, 1000) : m.fact;
    if (classify(f) === "forbidden") throw Object.assign(new Error("I don't store passwords, PINs or card numbers."), { status: 400, expose: true });
    const emb = f !== m.fact ? await embed(f) : undefined;
    db.prepare(`UPDATE memories SET fact = ?, category = ?, pinned = ?, topic = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now')${emb !== undefined ? ", embedding = ?" : ""} WHERE id = ?`)
      .run(...[f, CATEGORIES.includes(category) ? category : m.category, pinned !== undefined ? (pinned ? 1 : 0) : m.pinned ? 1 : 0, topic !== undefined ? String(topic).slice(0, 80) : m.topic || "", ...(emb !== undefined ? [emb ? JSON.stringify(emb) : null] : []), id]);
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
    const base = tokenize(query);
    const q = [...new Set([...base, ...base.flatMap((w) => (RELATED[w] || []).flatMap(tokenize))])];
    const catHint = new Set(base.map((w) => ({ business: "business", career: "career", job: "career", story: "creative", writing: "creative", hobby: "hobby", interest: "interest", date: "date", birthday: "date", prefer: "preference", routine: "routine", decided: "decision", decision: "decision" })[w]).filter(Boolean));
    const N = rows.length;
    const df = new Map();
    const docs = rows.map((r) => { const t = tokenize(r.fact + " " + r.category); new Set(t).forEach((w) => df.set(w, (df.get(w) || 0) + 1)); return t; });
    const qEmb = rows.some((r) => r.embedding) ? await embed(query) : null;
    const scored = rows.map((r, i) => {
      let lex = 0;
      for (const w of q) { const tf = docs[i].filter((x) => x === w || x.startsWith(w) || w.startsWith(x)).length; if (tf) lex += (tf / (tf + 1.2)) * Math.log(1 + N / (df.get(w) || 1)); }
      const sem = qEmb && r.embedding ? cosine(qEmb, JSON.parse(r.embedding)) : 0;
      return { r, score: lex + sem * 3 + (lex && catHint.has(r.category) ? 0.8 : 0) + (lex && r.pinned ? 0.1 : 0) };
    });
    return scored.filter((s) => s.score > 0.05).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => ({ ...hydrate(s.r), score: +s.score.toFixed(3) }));
  },
  /** A short always-on profile: preferences and goals, newest first. */
  profile(limit = 15) {
    return db.prepare("SELECT id, fact, category FROM memories WHERE status = 'saved' AND category != 'summary' ORDER BY pinned DESC, id DESC LIMIT ?").all(limit);
  },
  /** The personal profile JARVIS always has in mind: pinned facts plus the core categories, grouped, with ids for corrections. */
  profileBlock(maxChars = 5000) {
    const rows = db.prepare(`SELECT id, fact, category, topic FROM memories WHERE status = 'saved' AND (pinned = 1 OR category IN ('profile','career','ambition','interest','hobby','business','creative','date','preference','routine','decision','goal'))
      ORDER BY pinned DESC, COALESCE(updated_at, created_at) DESC LIMIT 120`).all();
    const groups = {};
    for (const r of rows) (groups[CATEGORY_LABELS[r.category] || r.category] ||= []).push(`#${r.id} ${r.fact}`);
    let out = Object.entries(groups).map(([k, v]) => `${k}: ${v.join(" | ")}`).join("\n");
    if (out.length > maxChars) out = out.slice(0, maxChars) + " …";
    return out;
  },
  recent(limit = 20) { return db.prepare("SELECT * FROM memories ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?").all(limit).map(hydrate); },
  byCategory() {
    const out = {};
    for (const m of db.prepare("SELECT * FROM memories WHERE status = 'saved' ORDER BY pinned DESC, id").all().map(hydrate)) (out[m.category] ||= []).push(m);
    return out;
  },
};

// ---------------------------------------------------------------- The starting profile (only what the user has told JARVIS)
// Seeded once into an editable profile. Nothing here is inferred, and the user can change or remove any of it.
export const STARTING_PROFILE = [
  ["profile", "Is from the United Kingdom."],
  ["career", "Serving in the British Army as an infantry soldier (as last shared; may have changed)."],
  ["profile", "Stationed in Cyprus; default location Dhekelia, Cyprus."],
  ["profile", "Uses a Windows 11 laptop as the main JARVIS device."],
  ["ambition", "Interested in moving from the Army into the fire service; has expressed interest in Lancashire Fire and Rescue."],
  ["ambition", "Interested in entrepreneurship and building businesses."],
  ["business", "Has been developing an idea for a website design agency that builds professional websites for small businesses."],
  ["interest", "Technology and artificial intelligence."],
  ["interest", "Building own software and AI systems (including JARVIS)."],
  ["interest", "Business development and entrepreneurship."],
  ["hobby", "Gaming, especially Football Manager."],
  ["hobby", "Football and football management."],
  ["hobby", "Creative writing and building fictional worlds."],
  ["creative", "KILL HOUSE — an ongoing fictional series: a gritty British dystopian survival thriller set during a fictional civil war.", "KILL HOUSE"],
  ["preference", "Prefers natural conversation over robotic exchanges, and speaking continuously without repeating the wake word."],
  ["preference", "Likes a confident, intelligent, occasionally witty assistant with the futuristic JARVIS personality and occasional cinematic sci-fi language."],
  ["preference", "Wants useful, direct answers without unnecessary explanation."],
];
export async function seedProfile({ kvGet, kvSet }) {
  if (kvGet("profile.seeded")) return 0;
  let n = 0;
  for (const [category, fact, topic] of STARTING_PROFILE) {
    const r = await memory.save({ fact, category, source: "profile", approved: true, pinned: true, topic: topic || "" });
    if (r.saved && !r.duplicate) n++;
  }
  kvSet("profile.seeded", new Date().toISOString());
  return n;
}
