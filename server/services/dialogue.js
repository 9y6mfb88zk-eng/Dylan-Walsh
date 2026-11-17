// Conversational continuity and delivery helpers (JARVIS 6.8). Pure functions over the conversation's own records:
// they shape how JARVIS speaks and what it remembers *within* a conversation. Nothing here writes long-term memory.

/** How often JARVIS may address the user by title. Values: never | rarely | occasionally | often. */
export const SIR_EVERY = { never: Infinity, rarely: 5, occasionally: 3, often: 1 };

/**
 * A deterministic hint so "Sir" stays occasional: counts the user's title in JARVIS's recent replies.
 * Returns "" when using it this turn is fine.
 */
export function titleHint(recentReplies, title = "Sir", frequency = "occasionally") {
  const every = SIR_EVERY[frequency] ?? SIR_EVERY.occasionally;
  if (every === Infinity) return `Don't address the user as "${title}" at all.`;
  if (every <= 1) return "";
  const re = new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const window = recentReplies.slice(-(every - 1));
  const used = window.filter((r) => re.test(r)).length;
  return used ? `You called the user "${title}" ${used === 1 ? "once" : `${used} times`} in your last ${window.length === 1 ? "reply" : `${window.length} replies`}: don't use it in this one.` : "";
}

/** The first few words of JARVIS's recent replies, so it doesn't open every answer the same way. */
export function recentOpenings(recentReplies, n = 3) {
  return [...new Set(recentReplies.slice(-n).map((r) => String(r).trim().split(/\s+/).slice(0, 3).join(" ").replace(/[,.!?;:]+$/, "")).filter((x) => x.length > 2))];
}

/** A short, readable summary of tool arguments ("place=Larnaca, days=3"), for follow-up context. */
export function summariseArgs(input = {}) {
  return Object.entries(input).filter(([, v]) => v != null && v !== "" && (Array.isArray(v) ? v.length > 0 && v.every((x) => typeof x !== "object") : typeof v !== "object"))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.slice(0, 4).join("/") : String(v).slice(0, 60)}`).slice(0, 5).join(", ");
}

/**
 * What JARVIS looked up in this conversation's recent replies ("2 replies ago: get_weather(place=Larnaca)"), newest first,
 * so "What about the weekend?" is understood as still being about the weather in that place.
 */
export function toolTrace(assistantMetas, limit = 6) {
  const out = [];
  assistantMetas.forEach((m, i) => {
    const ago = assistantMetas.length - i;   // 1 = the latest reply
    for (const t of m?.tools || []) out.push({ ago, line: `${t.name}${t.args ? `(${t.args})` : ""}` });
  });
  return out.reverse().slice(0, limit).map((x) => `${x.ago === 1 ? "last reply" : `${x.ago} replies ago`}: ${x.line}`);
}
