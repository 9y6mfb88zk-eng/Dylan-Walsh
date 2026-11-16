import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { config } from "./config.js";
import { tasks, reminders, ideas, memories, history } from "./db.js";
import { getWeather, weatherSentence } from "./weather.js";

export const client = config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null;
export const brainReady = () => !!client;

// Server-side refusal fallback: on a policy decline the API re-runs on a fallback model.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const PERSONA = `You are JARVIS, a personal assistant with the manner of a dry, composed British butler.
- Always address the user as "sir". Warm, natural, quietly witty; never obsequious, never robotic.
- Your replies are SPOKEN ALOUD by a text-to-speech voice and shown as a one-line caption. Keep them to 1–3 short sentences unless sir explicitly asks for detail.
- No markdown, no bullet points, no emoji, no URLs, no lists read out mechanically. Write numbers and times the way a person would say them ("half past three", "twenty-two degrees").
- Use your tools to actually do things (tasks, reminders, weather, memory). Confirm briefly after acting. Never claim to have done something you did not do.
- For reminders, convert relative times ("in 20 minutes", "tomorrow at nine") into an absolute ISO 8601 timestamp WITH the user's UTC offset, using the current local time provided below.
- If something is ambiguous, make the sensible assumption and say so in passing rather than interrogating sir.
- When sir tells you a lasting preference or personal fact, save it with the remember tool.`;

function nowContext(loc) {
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "longOffset",
  }).format(now);
  return `Current local time: ${local} (${config.timezone}). UTC now: ${now.toISOString()}.
Sir's location: ${loc?.place || config.defaultPlace} (lat ${loc?.lat ?? config.defaultLat}, lon ${loc?.lon ?? config.defaultLon}).`;
}

function stateContext() {
  const open = tasks.list();
  const up = reminders.upcoming();
  const mem = memories.list();
  const fmt = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: config.timezone, dateStyle: "medium", timeStyle: "short" });
  return [
    `Open tasks (${open.length}): ${open.length ? open.map((t) => `#${t.id} ${t.title}${t.due ? ` (due ${t.due})` : ""}`).join("; ") : "none"}.`,
    `Upcoming reminders (${up.length}): ${up.length ? up.map((r) => `#${r.id} "${r.text}" at ${fmt(r.due_at)}`).join("; ") : "none"}.`,
    `Things you remember about sir: ${mem.length ? mem.map((m) => m.fact).join(" | ") : "nothing yet"}.`,
  ].join("\n");
}

// ---------------- Tools
const TOOLS = [
  { name: "add_task", description: "Add a task to sir's task list.", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["title"],
      properties: { title: { type: "string" }, due: { type: "string", description: "Optional due date YYYY-MM-DD" } } } },
  { name: "complete_task", description: "Mark a task done, by id (see open tasks in context).", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "integer" } } } },
  { name: "delete_task", description: "Delete a task by id.", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "integer" } } } },
  { name: "add_reminder", description: "Schedule a push-notification reminder. Fires server-side even if the app is closed.", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["text", "due_at"],
      properties: { text: { type: "string", description: "What to remind sir about" },
        due_at: { type: "string", description: "Absolute ISO 8601 timestamp with UTC offset, e.g. 2026-11-16T15:30:00+02:00" } } } },
  { name: "cancel_reminder", description: "Cancel an upcoming reminder by id.", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "integer" } } } },
  { name: "get_weather", description: "Get current weather and forecast for sir's current location.", strict: true,
    input_schema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "remember", description: "Save a lasting fact or preference about sir to long-term memory.", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["fact"], properties: { fact: { type: "string" } } } },
  { name: "latest_ideas", description: "Read the most recent background business ideas JARVIS has generated.", strict: true,
    input_schema: { type: "object", additionalProperties: false, properties: { count: { type: "integer" } } } },
];

async function runTool(name, input, ctx) {
  switch (name) {
    case "add_task": { const t = tasks.add({ title: input.title, due: input.due || null }); ctx.changed.add("tasks"); return { ok: true, task: t }; }
    case "complete_task": { const t = tasks.setDone(input.id, true); ctx.changed.add("tasks"); return t ? { ok: true, task: t } : { ok: false, error: "No such task" }; }
    case "delete_task": { ctx.changed.add("tasks"); return { ok: tasks.remove(input.id) }; }
    case "add_reminder": {
      const d = new Date(input.due_at);
      if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid due_at; use ISO 8601 with offset" };
      if (d.getTime() < Date.now() - 60_000) return { ok: false, error: "That time is in the past" };
      const r = reminders.add({ text: input.text, due_at: d.toISOString() }); ctx.changed.add("reminders");
      return { ok: true, reminder: { ...r, local: d.toLocaleString("en-GB", { timeZone: config.timezone }) } };
    }
    case "cancel_reminder": { ctx.changed.add("reminders"); return { ok: reminders.remove(input.id) }; }
    case "get_weather": {
      try { const w = await getWeather(ctx.loc?.lat, ctx.loc?.lon, ctx.loc?.place); return { ok: true, summary: weatherSentence(w) }; }
      catch (e) { return { ok: false, error: `Weather unavailable: ${e.message}` }; }
    }
    case "remember": { memories.add(input.fact); return { ok: true }; }
    case "latest_ideas": {
      return { ok: true, ideas: ideas.list(Math.min(Math.max(input.count || 3, 1), 10)).map((i) => ({ id: i.id, title: i.title, pitch: i.pitch, first_move: i.first_move })) };
    }
    default: return { ok: false, error: `Unknown tool ${name}` };
  }
}

function textOf(msg) {
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").replace(/\s+/g, " ").trim();
}

const REFUSAL_LINE = "I'm afraid that's one I must decline, sir.";

/** One conversational turn. Returns { reply, changed: string[] }. */
export async function chat(userText, loc) {
  if (!client) return { reply: "My apologies, sir — my higher faculties are offline. An Anthropic API key is required.", changed: [] };
  const ctx = { loc, changed: new Set() };
  const system = `${PERSONA}\n\n${nowContext(loc)}\n${stateContext()}`;
  const messages = [...history.recent(16).map((m) => ({ role: m.role, content: m.content })), { role: "user", content: userText }];

  let reply = "";
  for (let step = 0; step < 6; step++) {
    const msg = await client.beta.messages.create({
      model: config.model, max_tokens: 4000, system, tools: TOOLS, messages,
      output_config: { effort: "low" }, ...FALLBACK,
    });
    if (msg.stop_reason === "refusal") { reply = REFUSAL_LINE; break; }
    const uses = msg.content.filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || uses.length === 0) { reply = textOf(msg); break; }
    messages.push({ role: "assistant", content: msg.content });
    const results = await Promise.all(uses.map(async (u) => {
      try {
        const out = await runTool(u.name, u.input || {}, ctx);
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out), is_error: out.ok === false };
      } catch (e) {
        return { type: "tool_result", tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  reply ||= "Done, sir.";
  history.add("user", userText);
  history.add("assistant", reply);
  return { reply, changed: [...ctx.changed] };
}

/** Spoken morning briefing using real weather, tasks, reminders and the latest idea. */
export async function briefing(loc) {
  let w = null;
  try { w = await getWeather(loc?.lat, loc?.lon, loc?.place); } catch (e) { console.warn("[briefing] weather:", e.message); }
  const latest = ideas.list(1)[0];
  const facts = `${nowContext(loc)}\nWeather: ${w ? weatherSentence(w) : "unavailable"}\n${stateContext()}\n` +
    `Latest business idea: ${latest ? `${latest.title} — first move: ${latest.first_move}` : "none yet"}.`;
  if (!client) {
    const open = tasks.list();
    return { text: `Good ${partOfDay()}, sir. ${w ? `It's ${w.current.temp} degrees and ${w.current.summary} in ${w.place}, with a high of ${w.today.high}.` : ""} You have ${open.length} open task${open.length === 1 ? "" : "s"}.`, weather: w };
  }
  const msg = await client.beta.messages.create({
    model: config.model, max_tokens: 3000, output_config: { effort: "low" }, ...FALLBACK,
    system: `${PERSONA}\n\nDeliver sir's briefing: greeting appropriate to the time of day, the weather in plain words (temperature, sky, anything notable like rain, wind or UV), what's on today (tasks and reminders — highlight the most important), and one line on the latest idea if there is one. 4–6 spoken sentences. No lists.`,
    messages: [{ role: "user", content: `Facts for the briefing:\n${facts}\n\nBrief me.` }],
  });
  const text = msg.stop_reason === "refusal" ? `Good ${partOfDay()}, sir.` : textOf(msg);
  return { text, weather: w };
}

export function partOfDay() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, hour: "2-digit", hour12: false }).format(new Date()));
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

// ---------------- Background ideas
const IdeaSchema = z.object({
  title: z.string().describe("Short product name + what it is, max ~8 words"),
  pitch: z.string().describe("Two sentences: the problem, who pays, and why it works"),
  why_now: z.string().describe("One sentence on why this fits a solo founder in Cyprus right now"),
  budget: z.string().describe("Rough cost to MVP in EUR, e.g. 'under €300'"),
  mvp: z.array(z.string()).describe("Exactly three concrete MVP steps, in order"),
  first_move: z.string().describe("One concrete action sir can do this week, under 20 words, phrased as a task"),
});

function normalise(s) { return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3); }
function tooSimilar(title, existing) {
  const a = new Set(normalise(title));
  if (!a.size) return false;
  return existing.some((t) => {
    const b = new Set(normalise(t));
    const inter = [...a].filter((x) => b.has(x)).length;
    return t.trim().toLowerCase() === title.trim().toLowerCase() || inter / Math.min(a.size, b.size || 1) >= 0.7;
  });
}

/** Generate one new, non-repeating idea and save it. Returns the saved idea, or null. */
export async function generateIdea() {
  if (!client) return null;
  const previous = ideas.titles();
  for (let attempt = 0; attempt < 3; attempt++) {
    const avoid = previous.slice(0, 200);
    const msg = await client.beta.messages.parse({
      model: config.model, max_tokens: 6000, output_config: { effort: "medium", format: betaZodOutputFormat(IdeaSchema) }, ...FALLBACK,
      system: "You are a sharp, practical startup advisor. You propose ideas a single person can actually ship and sell.",
      messages: [{ role: "user", content:
        `Give me the single best NEW AI app or SaaS idea for a solo founder based in Cyprus (Larnaca district) on a small budget (a few hundred euros, no team, no funding).
Favour: real paying customers reachable from Cyprus or online, fast to MVP with no-code or light code plus AI APIs, recurring revenue, low regulatory risk. Local angles (tourism, property, shipping, expat services, Cyprus SMEs, Greek/English/Russian-language markets) are welcome but not required.
Include a 3-step MVP and one first move for this week.
It must be clearly different from every one of these previous ideas — different customer AND different problem:
${avoid.length ? avoid.map((t) => `- ${t}`).join("\n") : "(none yet)"}` +
        (attempt > 0 ? "\n\nYour previous suggestion was too close to an existing idea. Pick a genuinely different space." : "") }],
    });
    if (msg.stop_reason === "refusal") return null;
    const idea = msg.parsed_output;
    if (!idea) continue;
    idea.mvp = idea.mvp.slice(0, 3);
    if (tooSimilar(idea.title, previous)) { previous.unshift(idea.title); continue; }
    return ideas.add(idea);
  }
  return null;
}
