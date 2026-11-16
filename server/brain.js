// JARVIS's mind: persona, context assembly, tool execution, research, briefings and ideas.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { config, modelOptions } from "./config.js";
import { db, getSettings } from "./db.js";
import { tasks, reminders, projects } from "./services/work.js";
import { conversations } from "./services/conversations.js";
import { memory, CATEGORIES as MEM_CATS } from "./services/memory.js";
import * as calendar from "./services/calendar.js";
import * as finance from "./finance/service.js";
import { getWeather, weatherSentence } from "./integrations/weather.js";
import * as pending from "./services/pending.js";
import { connections } from "./services/oauth.js";
import { runComputerAction } from "./services/computer.js";
import { APPS, FOLDERS } from "./shared/computer-actions.js";
import { onlineDesktop, changed } from "./realtime.js";

export const client = config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null;
export const brainReady = () => !!client;

/** Turn Anthropic API errors into messages a person can act on. */
export function friendlyAiError(e) {
  if (!(e instanceof Anthropic.APIError)) return e;
  const m = String(e.message || "");
  const msg = e instanceof Anthropic.AuthenticationError ? "Your Anthropic API key was rejected. Check it in the tray icon → API keys."
    : /credit balance|billing|purchase credits/i.test(m) ? "Your Anthropic account is out of credit. Add some at console.anthropic.com → Settings → Billing."
    : e instanceof Anthropic.PermissionDeniedError ? "Your Anthropic key isn't allowed to use this model. Try another model in API keys & AI model."
    : e instanceof Anthropic.NotFoundError ? `The AI model "${config.model}" isn't available on your account. Choose another in API keys & AI model.`
    : e instanceof Anthropic.RateLimitError ? "Anthropic is rate-limiting requests right now. Try again in a moment."
    : e.status === 529 || e.status >= 500 ? "Anthropic's service is busy or having problems. Try again shortly."
    : e instanceof Anthropic.APIConnectionError ? "Couldn't reach Anthropic. Check the internet connection."
    : `The AI request failed: ${m.slice(0, 200)}`;
  return Object.assign(new Error(msg), { status: 502, expose: true, code: "ai_error" });
}
const { fallback: FALLBACK, webSearch: WEB_SEARCH } = modelOptions(config.model);
const research = modelOptions(config.researchModel);

const PERSONA = `You are JARVIS, the user's personal AI assistant, in the spirit of the assistant from Iron Man.
Personality: calm, intelligent, professional, direct, quietly witty, British in phrasing. Address the user as "sir" naturally, not in every sentence.
Your replies are usually SPOKEN ALOUD by a British voice and shown as text. Keep them to 1–3 natural sentences unless the user asks for detail, a list or a report. No markdown headings in spoken replies; say numbers and times the way a person would.
Truthfulness rules, which override everything else:
- Only state facts that come from your tools or the context below. Never invent balances, transactions, weather, events, search results or sources.
- If a service is not connected or a tool fails, say so plainly and say what would fix it.
- For money: separate the actual balance from projections; say when a figure is an estimate; never treat credit or overdraft limits as money the user has. If the data is labelled TEST DATA, say so.
- Do not claim an action succeeded unless the tool result says it did.
Actions:
- Use tools to act: tasks, reminders, calendar, projects, memory, finance questions, weather, the user's laptop, and web search.
- Calendar changes to existing events, deleting events, and bookings that clash need the user's confirmation: the tool returns a pending action; ask "Shall I go ahead?" and only call confirm_pending after a clear yes.
- For reminders, convert relative times ("at six", "in 20 minutes") into an absolute ISO 8601 timestamp with the correct UTC offset for the user's time zone given below. "At six" means the next 18:00 unless context says morning.
- Memory: save lasting, useful facts (preferences, goals, important dates, decisions) with remember. Do not save trivia or one-off chatter. Mark health, religion, politics, sexuality, exact address, ID numbers and detailed finances as sensitive — they are only stored after the user agrees. Never store passwords, PINs or card numbers.
- Research: use web search for anything current or factual you are not certain of, compare sources, and cite them. Use start_research for a longer written report.
- When the user wants to start something substantial ("I want to start a business"), create a project with milestones and first tasks, then summarise the plan briefly.`;

function localNow(tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "longOffset" }).format(new Date());
}
const fmtLocal = (iso, tz) => new Date(iso).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function contextBlock({ userText, deviceKind, loc }) {
  const s = getSettings();
  const tz = s.timezone;
  const open = tasks.list().slice(0, 12);
  const up = reminders.upcoming().slice(0, 8);
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const events = calendar.list(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 2 * 86400_000).toISOString()).slice(0, 10);
  const projs = projects.list({ includeDone: false }).slice(0, 8);
  const relevant = userText ? await memory.search(userText, 6) : [];
  const profile = memory.profile(10);
  const pend = pending.list();
  const fin = { connections: connections.all().filter((c) => ["monzo", "demo"].includes(c.provider)).map(connections.view) };
  fin.testData = fin.connections.some((c) => c.provider === "demo");
  const desk = onlineDesktop();
  const home = loc?.lat ? loc : s.home;
  return [
    `Now: ${localNow(tz)} (time zone ${tz}). UTC: ${new Date().toISOString()}.`,
    `User is talking from: ${deviceKind || "unknown device"}. Home location: ${s.home.place}. Current location: ${home.place || "home"}. Units: ${s.units}.`,
    `Laptop (computer control): ${desk ? "online" : "offline"}. Allowed apps: ${Object.keys(APPS).join(", ")}. Folders: ${FOLDERS.join(", ")}.`,
    `Bank: ${fin.connections.length ? fin.connections.map((c) => `${c.provider} (${c.status}${c.last_sync_at ? `, synced ${c.last_sync_at}` : ""})`).join("; ") + (fin.testData ? " — TEST DATA" : "") : "not connected"}. Calendar: ${calendar.googleStatus().connection ? "Google connected" : "JARVIS calendar only (Google not connected)"}.`,
    `Open tasks: ${open.length ? open.map((t) => `#${t.id} ${t.title}${t.due ? ` (due ${t.due})` : ""}${t.project_title ? ` [${t.project_title}]` : ""}`).join("; ") : "none"}.`,
    `Upcoming reminders: ${up.length ? up.map((r) => `#${r.id} "${r.text}" ${fmtLocal(r.due_at, tz)}`).join("; ") : "none"}.`,
    `Calendar next 48h: ${events.length ? events.map((e) => `#${e.id} ${e.title} ${e.all_day ? e.start + " (all day)" : fmtLocal(e.start, tz)}`).join("; ") : "nothing"}.`,
    `Active projects: ${projs.length ? projs.map((p) => `#${p.id} ${p.title} ${p.progress.percent}%`).join("; ") : "none"}.`,
    `Pending confirmations: ${pend.length ? pend.map((p) => `${p.id}: ${p.summary}`).join("; ") : "none"}.`,
    `About the user: ${profile.length ? profile.map((m) => m.fact).join(" | ") : "nothing saved yet"}.`,
    relevant.length ? `Relevant memories: ${relevant.map((m) => `[${m.category}] ${m.fact}`).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
}

// ---------------- Tools
const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const S = { type: "string" }, I = { type: "integer" }, N = { type: "number" }, B = { type: "boolean" };
const TOOLS = [
  { name: "get_weather", description: "Real forecast (current, hourly, 7 days) for the user's home or current location.", input_schema: obj({}) },
  { name: "finance", description: "Answer money questions from the user's connected bank data. question: position (how much do I have / left / after bills), spending (spent this month, optionally a category or monthsAgo), afford (needs amount in pounds), subscriptions, compare (this vs last month), saving, transactions.",
    input_schema: obj({ question: { type: "string", enum: ["position", "spending", "afford", "subscriptions", "compare", "saving", "transactions"] }, amount: N, category: { type: "string", enum: ["food", "shopping", "transport", "fuel", "bills", "subscriptions", "entertainment", "travel", "transfers", "other"] }, monthsAgo: I, limit: I }, ["question"]) },
  { name: "add_commitment", description: "Record an upcoming bill, planned saving or debt repayment the user tells you about (used in the money-left calculation). Mark certainty 'confirmed' only if the user says the amount is fixed.",
    input_schema: obj({ name: S, amount_pounds: N, kind: { type: "string", enum: ["bill", "saving", "debt"] }, frequency: { type: "string", enum: ["monthly", "weekly", "yearly", "once"] }, day_of_month: I, date: S, certainty: { type: "string", enum: ["estimated", "confirmed"] } }, ["name", "amount_pounds", "kind", "frequency"]) },
  { name: "calendar_list", description: "List calendar events between two ISO times.", input_schema: obj({ from: S, to: S }, ["from", "to"]) },
  { name: "calendar_create", description: "Create an event. start/end are ISO 8601 with offset, or YYYY-MM-DD with all_day. If it clashes with something, it returns a pending action to confirm.",
    input_schema: obj({ title: S, start: S, end: S, all_day: B, location: S, notes: S }, ["title", "start"]) },
  { name: "calendar_change", description: "Move/edit or delete an existing event (by id from context or calendar_list). Always returns a pending action the user must confirm.",
    input_schema: obj({ event_id: I, operation: { type: "string", enum: ["update", "delete"] }, title: S, start: S, end: S, location: S }, ["event_id", "operation"]) },
  { name: "add_task", description: "Add a task, optionally to a project.", input_schema: obj({ title: S, due: S, priority: { type: "integer", enum: [1, 2, 3] }, project_id: I, notes: S }, ["title"]) },
  { name: "update_task", description: "Complete, reschedule, reprioritise or delete a task by id.", input_schema: obj({ id: I, done: B, due: S, priority: { type: "integer", enum: [1, 2, 3] }, title: S, delete: B }, ["id"]) },
  { name: "add_reminder", description: "Create a persistent reminder delivered as a notification on all devices at due_at (absolute ISO 8601 with UTC offset).", input_schema: obj({ text: S, due_at: S }, ["text", "due_at"]) },
  { name: "cancel_reminder", description: "Cancel a reminder by id.", input_schema: obj({ id: I }, ["id"]) },
  { name: "create_project", description: "Create a structured project with milestones and starter tasks (dates YYYY-MM-DD, priority 1 high to 3 low).",
    input_schema: obj({ title: S, goal: S, milestones: { type: "array", items: obj({ title: S, due: S, tasks: { type: "array", items: obj({ title: S, due: S, priority: { type: "integer", enum: [1, 2, 3] } }, ["title"]) } }, ["title"]) } }, ["title", "goal", "milestones"]) },
  { name: "get_project", description: "Retrieve a project (by id or search text) with milestones, tasks, progress, overdue work and next actions.", input_schema: obj({ id: I, query: S }) },
  { name: "update_project", description: "Change a project's status or notes, or add a milestone.", input_schema: obj({ id: I, status: { type: "string", enum: ["active", "paused", "done"] }, notes: S, add_milestone: S, milestone_due: S }, ["id"]) },
  { name: "remember", description: "Save a lasting fact about the user.", input_schema: obj({ fact: S, category: { type: "string", enum: MEM_CATS }, sensitive: B }, ["fact", "category"]) },
  { name: "recall", description: "Search long-term memory.", input_schema: obj({ query: S }, ["query"]) },
  { name: "forget", description: "Delete a memory by id.", input_schema: obj({ id: I }, ["id"]) },
  { name: "computer", description: "Do something on the user's Windows laptop through the allowlisted actions: open_app {app}, open_folder {folder}, open_bookmark {name}, open_url {url}, create_document {title, content, format}, search_files {query, folder}, open_file {path}.",
    input_schema: obj({ action: { type: "string", enum: ["open_app", "open_folder", "open_bookmark", "open_url", "create_document", "search_files", "open_file"] }, app: S, folder: S, name: S, url: S, title: S, content: S, format: { type: "string", enum: ["md", "txt"] }, query: S, path: S }, ["action"]) },
  { name: "confirm_pending", description: "Carry out or cancel a pending action after the user clearly answers.", input_schema: obj({ id: S, decision: { type: "string", enum: ["confirm", "reject"] } }, ["id", "decision"]) },
  { name: "start_research", description: "Start a longer sourced research report in the background; the user is notified when it is ready.", input_schema: obj({ query: S }, ["query"]) },
  { name: "latest_ideas", description: "Read the latest background business ideas.", input_schema: obj({ count: I }) },
  { name: "new_conversation", description: "Start a fresh conversation thread when the user asks to change subject completely.", input_schema: obj({}) },
];

async function runTool(name, input, ctx) {
  const s = getSettings();
  switch (name) {
    case "get_weather": {
      const loc = ctx.loc?.lat ? ctx.loc : s.home;
      try { return { ok: true, forecast: weatherSentence(await getWeather({ ...loc, units: s.units })) }; } catch (e) { return { ok: false, error: `Weather service unavailable: ${e.message}` }; }
    }
    case "finance": return finance.financeFacts(input.question, input);
    case "add_commitment": {
      const b = finance.saveBill({ name: input.name, amount: Math.round(Number(input.amount_pounds) * 100), kind: input.kind, frequency: input.frequency, day_of_month: input.day_of_month, date: input.date, certainty: input.certainty || "estimated", category: input.kind === "bill" ? "bills" : "transfers" });
      return { ok: true, saved: { id: b.id, name: b.name, certainty: b.certainty } };
    }
    case "calendar_list": return { ok: true, events: calendar.list(new Date(input.from).toISOString(), new Date(input.to).toISOString()).map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, all_day: e.all_day, source: e.source, location: e.location })) };
    case "calendar_create": {
      const ev = { title: input.title, start: input.start, end: input.end, all_day: !!input.all_day, location: input.location, notes: input.notes };
      if (!ev.all_day) {
        const start = new Date(ev.start).toISOString(), end = ev.end ? new Date(ev.end).toISOString() : new Date(Date.parse(ev.start) + 3600_000).toISOString();
        const clash = calendar.conflicts(start, end);
        if (clash.length) return pending.propose("calendar.create", ev, `Book "${ev.title}" at ${fmtLocal(start, s.timezone)} even though it clashes with ${clash.map((c) => `"${c.title}"`).join(", ")}`);
      }
      const created = await calendar.create(ev);
      return { ok: true, event: { id: created.id, title: created.title, start: created.start, source: created.source } };
    }
    case "calendar_change": {
      const cur = calendar.get(input.event_id);
      if (!cur) return { ok: false, error: "No such event" };
      if (input.operation === "delete") return pending.propose("calendar.delete", { id: cur.id }, `Delete "${cur.title}" on ${cur.all_day ? cur.start : fmtLocal(cur.start, s.timezone)}`);
      const patch = Object.fromEntries(Object.entries({ title: input.title, start: input.start, end: input.end, location: input.location }).filter(([, v]) => v));
      if (patch.start && !patch.end && !cur.all_day) patch.end = new Date(Date.parse(patch.start) + (Date.parse(cur.end) - Date.parse(cur.start))).toISOString();
      const clash = patch.start ? calendar.conflicts(new Date(patch.start).toISOString(), new Date(patch.end).toISOString(), cur.id) : [];
      return pending.propose("calendar.update", { id: cur.id, patch }, `Change "${cur.title}"${patch.start ? ` to ${fmtLocal(patch.start, s.timezone)}` : ""}${patch.title ? `, renamed "${patch.title}"` : ""}${clash.length ? ` (clashes with ${clash.map((c) => c.title).join(", ")})` : ""}`);
    }
    case "add_task": return { ok: true, task: tasks.add({ title: input.title, due: input.due, priority: input.priority, projectId: input.project_id, notes: input.notes, source: "jarvis" }) };
    case "update_task": {
      if (input.delete) return { ok: tasks.remove(input.id) };
      const t = tasks.update(input.id, { done: input.done, due: input.due, priority: input.priority, title: input.title });
      return t ? { ok: true, task: t } : { ok: false, error: "No such task" };
    }
    case "add_reminder": {
      const d = new Date(input.due_at);
      if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid time; use ISO 8601 with offset" };
      if (d.getTime() < Date.now() - 60_000) return { ok: false, error: "That time has already passed" };
      const r = reminders.add({ text: input.text, due_at: d.toISOString() });
      return { ok: true, reminder: { id: r.id, text: r.text, local: fmtLocal(r.due_at, s.timezone) } };
    }
    case "cancel_reminder": return { ok: reminders.remove(input.id) };
    case "create_project": { const p = projects.create(input); return { ok: true, project: { id: p.id, title: p.title, milestones: p.milestones.map((m) => m.title), tasks: p.progress.total } }; }
    case "get_project": {
      const p = input.id ? projects.get(input.id) : input.query ? projects.find(input.query) : null;
      return p ? { ok: true, report: projects.report(p.id), notes: p.notes } : { ok: false, error: "No matching project", projects: projects.list().map((x) => ({ id: x.id, title: x.title })) };
    }
    case "update_project": {
      if (input.add_milestone) projects.addMilestone(input.id, { title: input.add_milestone, due: input.milestone_due });
      const p = projects.update(input.id, { status: input.status, notes: input.notes });
      return p ? { ok: true, project: projects.report(p.id) } : { ok: false, error: "No such project" };
    }
    case "remember": {
      if (!s.memory.autoSave && !ctx.explicitMemory) return { ok: false, error: "Automatic memory is switched off; ask the user to save it from the Memory page." };
      const r = await memory.save({ fact: input.fact, category: input.category, sensitive: input.sensitive, source: "conversation" });
      return r.pending ? { ok: true, pending: true, id: r.id, note: "Sensitive: stored only after the user approves. Ask them if you may keep it; if yes call confirm_pending with id 'memory:" + r.id + "'." } : r;
    }
    case "recall": return { ok: true, memories: (await memory.search(input.query, 8)).map((m) => ({ id: m.id, fact: m.fact, category: m.category })) };
    case "forget": return { ok: memory.remove(input.id) };
    case "computer": {
      const { action, ...rest } = input;
      return runComputerAction(action, rest, { requestedBy: ctx.deviceId });
    }
    case "confirm_pending": {
      if (String(input.id).startsWith("memory:")) {
        const id = Number(String(input.id).slice(7));
        if (input.decision === "confirm") return { ok: memory.approve(id) };
        return { ok: memory.remove(id), removed: true };
      }
      try { return { ok: true, ...(await pending.decide(input.id, input.decision, { deviceId: ctx.deviceId })) }; } catch (e) { return { ok: false, error: e.message }; }
    }
    case "start_research": { const r = startResearch(input.query); return { ok: true, researchId: r.id, note: "Running in the background; the user will be notified." }; }
    case "latest_ideas": return { ok: true, ideas: db.prepare("SELECT id, title, pitch, first_move FROM ideas ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(input.count || 3, 1), 10)) };
    case "new_conversation": { const c = conversations.create(); ctx.newConversationId = c.id; return { ok: true }; }
    default: return { ok: false, error: `Unknown tool ${name}` };
  }
}

// Confirmation handlers
pending.registerHandler("calendar.create", (ev) => calendar.create(ev).then((e) => ({ id: e.id, title: e.title })));
pending.registerHandler("calendar.update", ({ id, patch }) => calendar.update(id, patch).then((e) => ({ id: e.id, start: e.start })));
pending.registerHandler("calendar.delete", ({ id }) => calendar.remove(id).then((ok) => ({ deleted: ok })));

// ---------------- Conversation turn
function textAndSources(content) {
  const sources = [];
  const parts = [];
  for (const b of content) {
    if (b.type !== "text") continue;
    parts.push(b.text);
    for (const c of b.citations || []) if (c.url && !sources.some((s) => s.url === c.url)) sources.push({ url: c.url, title: c.title || c.url });
  }
  return { text: parts.join("").replace(/\s+\n/g, "\n").trim(), sources };
}

/**
 * Handle one user message: store it, think with tools, store and broadcast the reply.
 * Idempotent per clientId: a retried message returns the original reply.
 */
export async function chat({ text, conversationId, deviceId, deviceKind, clientId, loc }) {
  conversationId ||= conversations.currentId();
  const prior = clientId ? conversations.findByClientId(clientId) : null;
  if (prior) {
    const reply = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND role = 'assistant' ORDER BY id LIMIT 1").get(prior.conversation_id, prior.id);
    if (reply) return { reply: reply.content, sources: reply.sources ? JSON.parse(reply.sources) : [], conversationId: prior.conversation_id, duplicate: true, changed: [] };
  }
  const { summary, turns } = conversations.context(conversationId, 20);
  conversations.add({ conversationId, role: "user", content: text, deviceId, clientId });
  if (!client) {
    const reply = "My apologies, sir — my reasoning systems are offline. An Anthropic API key needs to be added to the server.";
    conversations.add({ conversationId, role: "assistant", content: reply });
    return { reply, sources: [], conversationId, changed: [] };
  }
  const ctx = { loc, deviceId, changed: new Set() };
  const system = [
    { type: "text", text: PERSONA, cache_control: { type: "ephemeral" } },
    { type: "text", text: `${summary ? `Earlier in this conversation (summary): ${summary}\n` : ""}${await contextBlock({ userText: text, deviceKind, loc })}` },
  ];
  const messages = [...turns, { role: "user", content: text }];
  const tools = [...TOOLS, ...(config.webSearch ? [WEB_SEARCH(5)] : [])];
  let final = null;
  for (let step = 0; step < 8; step++) {
    const msg = await client.beta.messages.create({ model: config.model, max_tokens: 6000, system, tools, messages, output_config: { effort: process.env.JARVIS_EFFORT || "low" }, ...FALLBACK });
    if (msg.stop_reason === "refusal") { final = { text: "I'm afraid that's one I must decline, sir.", sources: [] }; break; }
    messages.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason === "pause_turn") continue;  // server tool (web search) still working
    const uses = msg.content.filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !uses.length) { final = textAndSources(msg.content); break; }
    const results = await Promise.all(uses.map(async (u) => {
      try {
        const out = await runTool(u.name, u.input || {}, ctx);
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out).slice(0, 30000), is_error: out?.ok === false };
      } catch (e) {
        return { type: "tool_result", tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  final ||= { text: "I've done what I can on that, sir.", sources: [] };
  final.text ||= "Done, sir.";
  const targetConv = ctx.newConversationId || conversationId;
  conversations.add({ conversationId: targetConv, role: "assistant", content: final.text, sources: final.sources });
  maybeSummarize(conversationId).catch(() => {});
  return { reply: final.text, sources: final.sources, conversationId: targetConv };
}

/** Keep long conversations manageable: fold older turns into a running summary, and keep notable ones as memory. */
async function maybeSummarize(conversationId) {
  const rows = conversations.unsummarized(conversationId);
  if (rows.length < 40 || !client) return;
  const fold = rows.slice(0, rows.length - 12);
  const prev = conversations.get(conversationId)?.summary || "";
  const msg = await client.beta.messages.create({
    model: config.model, max_tokens: 2000, output_config: { effort: "low" }, ...FALLBACK,
    messages: [{ role: "user", content: `Update this running summary of a conversation between a user and their assistant JARVIS. Keep decisions, commitments, facts about the user and open threads; drop small talk. Max 200 words.\n\nPrevious summary:\n${prev || "(none)"}\n\nNew turns:\n${fold.map((m) => `${m.role}: ${m.content}`).join("\n")}` }],
  });
  const text = textAndSources(msg.content).text;
  if (text) {
    conversations.setSummary(conversationId, text, fold.at(-1).id);
    await memory.save({ fact: `Conversation summary (${new Date().toISOString().slice(0, 10)}): ${text.slice(0, 900)}`, category: "summary", source: "conversation" });
  }
}

// ---------------- Research (sourced, background)
export function startResearch(query) {
  const r = db.prepare("INSERT INTO research (query, status) VALUES (?, 'running')").run(String(query).slice(0, 500));
  const id = Number(r.lastInsertRowid);
  changed("research");
  runResearch(id, query).catch(() => {});
  return { id };
}
async function runResearch(id, query) {
  const { notifyAll } = await import("./push.js");
  try {
    if (!client) throw new Error("Anthropic API key missing");
    if (!config.webSearch) throw new Error("Web search is disabled (JARVIS_WEB_SEARCH=false)");
    const messages = [{ role: "user", content: `Research this thoroughly using web search and write a concise, well-structured report for the user (who lives in ${getSettings().home.place}). Compare several sources, note disagreements and uncertainty, and cite sources for every factual claim. Do not invent anything. Topic: ${query}` }];
    let out = { text: "", sources: [] };
    for (let i = 0; i < 6; i++) {
      const msg = await client.beta.messages.create({ model: config.researchModel, max_tokens: 16000, tools: [research.webSearch(10)], messages, output_config: { effort: "medium" }, ...research.fallback });
      messages.push({ role: "assistant", content: msg.content });
      const part = textAndSources(msg.content);
      out = { text: (out.text + "\n" + part.text).trim(), sources: [...out.sources, ...part.sources.filter((s) => !out.sources.some((o) => o.url === s.url))] };
      if (msg.stop_reason !== "pause_turn") break;
    }
    db.prepare("UPDATE research SET report = ?, sources = ?, status = 'done' WHERE id = ?").run(out.text, JSON.stringify(out.sources), id);
    changed("research");
    notifyAll({ title: "Research ready", body: String(query).slice(0, 100), url: `/?tab=research&id=${id}`, tag: `research-${id}` }).catch(() => {});
  } catch (e) {
    db.prepare("UPDATE research SET status = 'failed', error = ? WHERE id = ?").run(e.message, id);
    changed("research");
  }
}

// ---------------- Daily briefing (real data only)
export async function briefing({ loc } = {}) {
  const s = getSettings();
  const sec = s.briefing.sections;
  const facts = [];
  let weather = null;
  if (sec.weather) {
    try { weather = await getWeather({ ...(loc?.lat ? loc : s.home), units: s.units }); facts.push(`Weather: ${weatherSentence(weather)}`); }
    catch (e) { facts.push(`Weather: unavailable (${e.message}).`); }
  }
  if (sec.calendar) {
    const ev = calendar.list(new Date().toISOString(), new Date(Date.now() + 24 * 3600_000).toISOString());
    facts.push(`Calendar (next 24h): ${ev.length ? ev.map((e) => `${e.title} ${e.all_day ? "(all day)" : fmtLocal(e.start, s.timezone)}`).join("; ") : "nothing scheduled"}.`);
  }
  if (sec.tasks) {
    const od = tasks.overdue(), today = tasks.dueToday(), open = tasks.list();
    facts.push(`Tasks: ${open.length} open; overdue: ${od.map((t) => t.title).join(", ") || "none"}; due today: ${today.map((t) => t.title).join(", ") || "none"}; top priority: ${open.filter((t) => t.priority === 1).slice(0, 3).map((t) => t.title).join(", ") || "none"}.`);
    const rem = reminders.upcoming().filter((r) => Date.parse(r.due_at) < Date.now() + 24 * 3600_000);
    facts.push(`Reminders today: ${rem.map((r) => `${r.text} at ${fmtLocal(r.due_at, s.timezone)}`).join("; ") || "none"}.`);
  }
  if (sec.finance && s.finance.enabled) {
    const f = finance.financeFacts("position");
    facts.push(f.connected ? `Finance${f.testData ? " (TEST DATA)" : ""}: available ${f.balances.available}, commitments still due ${f.commitments.total}, projected disposable ${f.projectedDisposable}. ${f.notes.join(" ")}` : "Finance: no bank connected.");
  }
  if (sec.projects) {
    const ps = projects.list({ includeDone: false }).slice(0, 4);
    facts.push(`Projects: ${ps.map((p) => `${p.title} ${p.progress.percent}% (${p.progress.overdue} overdue)`).join("; ") || "none"}.`);
  }
  const pend = pending.list();
  if (pend.length) facts.push(`Waiting for your confirmation: ${pend.map((p) => p.summary).join("; ")}.`);

  if (!client) return { text: `Good ${partOfDay()}, sir. ${facts.join(" ")}`, weather, facts };
  const tools = sec.news && config.webSearch ? [WEB_SEARCH(2)] : [];
  const messages = [{ role: "user", content: `Facts for the briefing (use only these${tools.length ? " plus one or two genuinely relevant news headlines you find with web search, with sources" : ""}):\n${facts.join("\n")}\n\nNow: ${localNow(s.timezone)}.\nDeliver the briefing: greeting suited to the time of day, then weather, schedule, priorities, money if present, projects, ${tools.length ? "news, " : ""}in 5–8 spoken sentences. No lists.` }];
  let text = "", sources = [];
  for (let i = 0; i < 3; i++) {
    const msg = await client.beta.messages.create({ model: config.model, max_tokens: 4000, system: PERSONA, tools, messages, output_config: { effort: "low" }, ...FALLBACK });
    messages.push({ role: "assistant", content: msg.content });
    const p = textAndSources(msg.content); text += p.text; sources.push(...p.sources);
    if (msg.stop_reason !== "pause_turn") break;
  }
  return { text: text.trim() || `Good ${partOfDay()}, sir.`, weather, facts, sources };
}

export function partOfDay() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: getSettings().timezone, hour: "2-digit", hour12: false }).format(new Date()));
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

// ---------------- Background ideas (kept from the prototype)
const IdeaSchema = z.object({
  title: z.string(), pitch: z.string(), why_now: z.string(), budget: z.string(),
  mvp: z.array(z.string()), first_move: z.string(),
});
function tooSimilar(title, existing) {
  const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const a = words(title);
  return existing.some((t) => { const b = words(t); const inter = [...a].filter((x) => b.has(x)).length; return t.toLowerCase() === title.toLowerCase() || (a.size && inter / Math.min(a.size, b.size || 1) >= 0.7); });
}
export async function generateIdea() {
  if (!client) return null;
  const previous = db.prepare("SELECT title FROM ideas ORDER BY id DESC").all().map((r) => r.title);
  const place = getSettings().home.place;
  for (let attempt = 0; attempt < 3; attempt++) {
    const msg = await client.beta.messages.parse({
      model: config.model, max_tokens: 6000, output_config: { effort: "medium", format: betaZodOutputFormat(IdeaSchema) }, ...FALLBACK,
      messages: [{ role: "user", content: `Give the single best NEW AI app or SaaS idea for a solo founder based in ${place} on a small budget (a few hundred pounds, no team). Favour real paying customers, a fast MVP with light code plus AI APIs, recurring revenue and low regulatory risk. Give: title, a two-sentence pitch, why now, rough budget, exactly three MVP steps, and one concrete first move for this week (under 20 words).
It must differ from all of these (different customer AND problem):\n${previous.slice(0, 200).map((t) => `- ${t}`).join("\n") || "(none)"}` }],
    });
    if (msg.stop_reason === "refusal") return null;
    const idea = msg.parsed_output;
    if (!idea || tooSimilar(idea.title, previous)) { if (idea) previous.unshift(idea.title); continue; }
    const r = db.prepare("INSERT INTO ideas (title, pitch, why_now, mvp, first_move, budget) VALUES (?, ?, ?, ?, ?, ?)")
      .run(idea.title, idea.pitch, idea.why_now, JSON.stringify(idea.mvp.slice(0, 3)), idea.first_move, idea.budget);
    changed("ideas");
    const row = db.prepare("SELECT * FROM ideas WHERE id = ?").get(r.lastInsertRowid);
    return { ...row, mvp: JSON.parse(row.mvp) };
  }
  return null;
}
