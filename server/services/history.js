// Session history: one searchable timeline of what happened — conversations, voice commands, tasks completed,
// diagnostics, errors, automations and decisions — built from the records JARVIS already keeps (no extra tracking).
import { db } from "../db.js";

export const HISTORY_KINDS = ["conversation", "command", "task", "diagnostic", "error", "automation", "decision"];
const iso = (t) => (!t ? null : /T/.test(t) ? (/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`) : `${t.replace(" ", "T")}Z`);

export function sessionHistory({ q = "", kind = "", limit = 100, before = "" } = {}) {
  limit = Math.max(1, Math.min(300, Number(limit) || 100));
  const like = `%${String(q).slice(0, 100)}%`;
  const want = (k) => !kind || kind === k;
  const out = [];
  if (want("conversation")) out.push(...db.prepare(`SELECT m.id, m.role, m.content, m.created_at, m.conversation_id, c.title FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role IN ('user','assistant') AND m.content LIKE ? ORDER BY m.id DESC LIMIT ?`).all(like, limit)
    .map((r) => ({ kind: "conversation", at: iso(r.created_at), title: r.role === "user" ? `You: ${r.content.slice(0, 160)}` : `JARVIS: ${r.content.slice(0, 160)}`, detail: r.title || "", ref: { conversation: r.conversation_id } })));
  if (want("command")) out.push(...db.prepare("SELECT id, at, summary, detail FROM activity WHERE kind = 'command' AND summary LIKE ? ORDER BY id DESC LIMIT ?").all(like, limit)
    .map((r) => ({ kind: "command", at: iso(r.at), title: r.summary, detail: JSON.parse(r.detail || "{}").text || "" })));
  if (want("task")) out.push(...db.prepare("SELECT id, title, completed_at FROM tasks WHERE done = 1 AND completed_at IS NOT NULL AND title LIKE ? ORDER BY completed_at DESC LIMIT ?").all(like, limit)
    .map((r) => ({ kind: "task", at: iso(r.completed_at), title: `Completed: ${r.title}`, detail: "", ref: { task: r.id } })));
  if (want("diagnostic")) out.push(...db.prepare("SELECT id, at, level, overall, duration_ms, summary FROM diagnostic_runs WHERE level LIKE ? OR summary LIKE ? ORDER BY id DESC LIMIT ?").all(like, like, limit)
    .map((r) => { const s = JSON.parse(r.summary || "[]"); const bad = s.filter((x) => ["error", "warn"].includes(x.status)); return { kind: "diagnostic", at: iso(r.at), title: `${r.level[0].toUpperCase() + r.level.slice(1)} diagnostics: ${r.overall === "ok" ? "all operational" : `${bad.length} need attention`}`, detail: bad.map((x) => `${x.label}: ${x.detail}`).join(" · ").slice(0, 300), status: r.overall, ref: { run: r.id } }; }));
  if (want("error")) out.push(...db.prepare("SELECT id, at, source, message FROM error_log WHERE message LIKE ? OR source LIKE ? ORDER BY id DESC LIMIT ?").all(like, like, limit)
    .map((r) => ({ kind: "error", at: iso(r.at), title: `${r.source}: ${r.message.slice(0, 160)}`, detail: "", status: "error" })));
  if (want("automation")) out.push(...db.prepare("SELECT rr.id, rr.started_at, rr.status, rr.trigger, rr.output, r.name FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id WHERE r.name LIKE ? OR rr.output LIKE ? ORDER BY rr.id DESC LIMIT ?").all(like, like, limit)
    .map((r) => ({ kind: "automation", at: iso(r.started_at), title: `${r.name} (${r.trigger}): ${r.status}`, detail: String(r.output || "").replace(/\n/g, " · ").slice(0, 300), status: r.status === "ok" ? "ok" : r.status === "running" ? "unknown" : "warn" })));
  if (want("decision")) out.push(...db.prepare("SELECT id, fact, created_at, updated_at FROM memories WHERE category = 'decision' AND status = 'saved' AND fact LIKE ? ORDER BY id DESC LIMIT ?").all(like, limit)
    .map((r) => ({ kind: "decision", at: iso(r.updated_at || r.created_at), title: r.fact, detail: "", ref: { memory: r.id } })));
  return out.filter((x) => x.at && (!before || x.at < before)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Privacy: clear the logs behind a kind. Conversations, tasks and memories are deleted from their own pages. */
export function clearHistory(kind) {
  if (kind === "command") return db.prepare("DELETE FROM activity WHERE kind = 'command'").run().changes;
  if (kind === "diagnostic") return db.prepare("DELETE FROM diagnostic_runs").run().changes;
  if (kind === "error") return db.prepare("DELETE FROM error_log").run().changes;
  if (kind === "automation") return db.prepare("DELETE FROM routine_runs WHERE status != 'running'").run().changes;
  return null;
}
