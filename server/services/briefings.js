// Delivering briefings: compose from real facts, keep a history, notify every device and speak on the laptop.
import { db, kvSet } from "../db.js";
import { changed } from "../realtime.js";
import { briefing } from "../brain.js";
import { notify, logActivity } from "./notify.js";
import { KINDS } from "./briefing-facts.js";

const TITLES = { morning: "Morning briefing", afternoon: "Afternoon update", evening: "Evening review", weekly: "Weekly review" };

export async function deliverBriefing(kind = "morning", { loc, trigger = "manual", speak = true } = {}) {
  if (!KINDS.includes(kind)) throw Object.assign(new Error("Unknown briefing"), { status: 400, expose: true });
  const b = await briefing({ kind, loc });
  const r = db.prepare("INSERT INTO briefings (kind, text, facts, sources) VALUES (?, ?, ?, ?)").run(kind, b.text, JSON.stringify(b.facts || []), JSON.stringify(b.sources || []));
  db.prepare("DELETE FROM briefings WHERE id NOT IN (SELECT id FROM briefings ORDER BY id DESC LIMIT 200)").run();
  const row = { id: Number(r.lastInsertRowid), kind, text: b.text, sources: b.sources || [], at: new Date().toISOString() };
  kvSet("briefing.latest", row);
  changed("briefing");
  logActivity("briefing", `${TITLES[kind]} delivered (${trigger})`, { id: row.id });
  await notify({ kind: "briefing", title: TITLES[kind], body: b.text.split(/(?<=[.!?])\s/)[0], url: `/?briefing=${row.id}`, speak: speak ? b.text : undefined, data: { briefingId: row.id, kind } });
  return { ...row, facts: b.facts, weather: b.weather };
}
export function briefingHistory(limit = 30) {
  return db.prepare("SELECT * FROM briefings ORDER BY id DESC LIMIT ?").all(limit).map((b) => ({ ...b, facts: JSON.parse(b.facts), sources: JSON.parse(b.sources) }));
}
export function getBriefing(id) {
  const b = db.prepare("SELECT * FROM briefings WHERE id = ?").get(Number(id));
  return b && { ...b, facts: JSON.parse(b.facts), sources: JSON.parse(b.sources) };
}
export { TITLES as BRIEFING_TITLES };
