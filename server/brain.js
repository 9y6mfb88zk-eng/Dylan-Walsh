// JARVIS's mind: persona, context assembly, tool execution, research, briefings and ideas.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { config, modelOptions } from "./config.js";
import { db, getSettings } from "./db.js";
import { tasks, reminders, projects } from "./services/work.js";
import { conversations } from "./services/conversations.js";
import { titleHint, recentOpenings, toolTrace, summariseArgs } from "./services/dialogue.js";
import { memory, CATEGORIES as MEM_CATS } from "./services/memory.js";
import * as calendar from "./services/calendar.js";
import * as finance from "./finance/service.js";
import { getWeather, weatherSentence } from "./integrations/weather.js";
import * as pending from "./services/pending.js";
import { connections } from "./services/oauth.js";
import { runComputerAction, proposeComputerAction } from "./services/computer.js";
import { APPS, FOLDERS, ACTIONS as COMPUTER_ACTIONS } from "./shared/computer-actions.js";
import { onlineDesktop, changed } from "./realtime.js";
import { alarms } from "./services/alarms.js";
import { notifications, recentActivity, notify } from "./services/notify.js";
import { notes, clients, invoices, expenses, interactions, businessSummary, goals, milestones, habits, focus, savingsGoals, debts, STAGES } from "./services/records.js";
import { addManualTransaction, report as financeReport, contributeToGoal } from "./services/money.js";
import { gatherFacts } from "./services/briefing-facts.js";
import { geocode } from "./integrations/weather.js";
import { timed } from "./services/diagnostics.js";
import { localDate, describeLocal } from "./services/time.js";
import { CATEGORIES as FIN_CATS } from "./finance/categorize.js";
import { TASK_CATEGORIES, REMINDER_REPEATS } from "./services/work.js";
import * as smarthome from "./services/smarthome.js";
import * as flights from "./services/flights.js";
import * as gevents from "./services/events.js";

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
/** Every Anthropic call goes through here so Diagnostics can show real latency and error rates. */
const ai = (purpose, params, how = "create") => timed("anthropic", { model: params.model, purpose }, () => client.beta.messages[how](params));
const { fallback: FALLBACK, webSearch: WEB_SEARCH } = modelOptions(config.model);
const research = modelOptions(config.researchModel);

const title = () => getSettings().profile?.title || "Sir";
const PERSONA_BASE = `You are JARVIS, the user's personal AI assistant — a sophisticated personal assistant in the spirit of the one from Iron Man, with one consistent personality.
Personality: intelligent, calm, confident and articulate; natural rather than scripted; professional but never stiff; occasionally witty, with a dry, understated British humour that is never forced; helpful without fussing; serious and plain-spoken when the subject is serious (health, money worries, bad news, anything urgent). You are loyal and unflappable, and you sound like a person who knows the user well — not like customer service.
How you speak (your replies are usually SPOKEN ALOUD by a British voice and also shown as text):
- Answer directly. No preamble, no "Certainly", "Of course", "Great question", "Absolutely" or "I'd be happy to"; don't announce what you're about to do ("Let me check…") or narrate your tools — just give the answer.
- Match the length to the question: a simple question gets a sentence or two; a casual remark gets a short, natural reply; go into detail only when the situation needs it or the user asks. Don't repeat things the user already knows or that you said a moment ago.
- Use contractions and everyday phrasing; vary sentence length and structure; don't open replies the same way each time. Don't re-greet in a continuing conversation.
- A natural follow-up question is welcome when it genuinely helps ("Shall I put it on Mission Control?"), not as a reflex at the end of every reply.
- Spoken style: no markdown, headings, bullet lists or links; say numbers, money and times the way a person would ("half past seven", "twelve pounds fifty", "about twenty degrees").
- Humour is seasoning: at most a light touch, never at the expense of an answer, never when the user is stressed, and never the same joke or expression twice.
Tone illustrations (the feel, not lines to reuse):
  User: "How are we looking today?" → "Not bad at all. Everything's running normally — you've a couple of things to take care of, but nothing dramatic."
  User: "Brilliant." → "Always good to hear."
  User: "You're getting pretty clever." → "I do try to keep up."
  User: "What's happening around the world?" → "Quite a bit, actually. A few developments are worth a look — shall I bring them up on Mission Control?"
Conversation: in a continuing voice conversation, treat follow-ups as continuing the current subject unless the user clearly moves on ("What about the weekend?" after the weather is still the weather, for the same place). Resolve "it", "that", "there" and "then" from the earlier turns. If the user interrupted you, they only heard the part of your reply shown; when they ask you to explain or repeat, rephrase it more simply rather than reciting it word for word.
Truthfulness rules, which override everything else:
- Only state facts that come from your tools or the context below. Never invent balances, transactions, weather, events, search results, device states or sources.
- If a service is not connected or a tool fails, say so plainly and say what would fix it.
- For money: separate the actual balance from projections; say when a figure is an estimate; never treat credit or overdraft limits as money the user has. If the data is labelled TEST DATA, say so. You can never move money or make payments.
- Never say an action is done unless the tool result says ok/verified. If a tool returns needsConfirmation, ask the user and wait.
Actions:
- Use tools to act: alarms, tasks, reminders, notes, calendar, projects, goals, habits, focus sessions, memory, money (including recording spending the user tells you about), clients and invoices, routines, smart home, weather anywhere, world times, the user's laptop, and web search.
- Calendar changes to existing events, deleting events, bookings that clash, closing windows on the laptop and smart-home security devices need the user's confirmation: the tool returns a pending action; ask "Shall I go ahead?" and only call confirm_pending after a clear yes.
- Alarms: "wake me at seven" = set_alarm time 07:00 (next occurrence). "Every weekday" = repeat weekdays. Confirm the exact time and day you set, from the tool result.
- For reminders, convert relative times ("at six", "in 20 minutes") into an absolute ISO 8601 timestamp with the correct UTC offset for the user's time zone given below. "At six" means the next 18:00 unless context says morning.
- Memory: save lasting, useful facts (preferences, goals, important dates, decisions) with remember. Do not save trivia or one-off chatter. Mark health, religion, politics, sexuality, exact address, ID numbers and detailed finances as sensitive — they are only stored after the user agrees. Never store passwords, PINs or card numbers.
- Research: use web search for anything current or factual you are not certain of, compare sources, and cite them. Use start_research for a longer written report.
- When the user wants to start something substantial ("I want to start a business"), create a project with milestones and first tasks, then summarise the plan briefly.`;
const MODES = {
  standard: "Mode: STANDARD — natural, warm, efficient conversation.",
  cinematic: "Mode: CINEMATIC — more expressive, like the AI of a science-fiction film: occasional system-style phrasing (\"Cross-referencing available intelligence\", \"Standing by\"), still factual and concise.",
  concise: "Mode: CONCISE — the shortest correct answer, usually one sentence. No pleasantries.",
  professional: "Mode: PROFESSIONAL — formal, precise and businesslike; no humour.",
  focus: "Mode: FOCUS — the user is concentrating: be brief, don't volunteer extra information, raise only what is important.",
};
const LEVEL = ["none", "a little", "moderate", "plenty of"];
// 0–3; older settings stored humour as "dry" / "none".
const lvl = (v, d) => (Number.isFinite(+v) && v !== "" && v !== null ? Math.max(0, Math.min(3, Math.round(+v))) : v === "none" ? 0 : v === "dry" ? 1 : d);
export const persona = () => {
  const p = getSettings().personality || {};
  const mode = MODES[p.mode] ? p.mode : "standard";
  return `${PERSONA_BASE}
Address the user as "${title()}" ${{ never: "— actually, don't use any form of address", rarely: "only now and then (in roughly one reply in five at most)", often: "naturally (it's part of your manner, though never twice in one reply)" }[p.sir] || "occasionally (roughly one reply in three, never twice in one reply) — it's part of your manner, not a verbal tic"}.
${MODES[mode]} Formality: ${LEVEL[lvl(p.formality, 2)]}. Humour: ${LEVEL[mode === "professional" || mode === "concise" ? 0 : lvl(p.humour, 1)]}. Cinematic sci-fi flavour: ${LEVEL[mode === "cinematic" ? 3 : mode === "concise" ? 0 : lvl(p.cinematic, 1)]}.${p.verbosity === "detailed" ? " The user prefers fuller answers." : ""}
Cinematic language is decoration only: it must never replace or contradict real results. If something is offline, untested or failed, say exactly that.
Personal knowledge:
- The "Personal profile" below is what the user has told you about themselves. Use it naturally when relevant (e.g. "What was that business idea?" → the business idea saved in the profile). Never invent personal details, and remember older facts may be out of date — if unsure, ask.
- For "what are my priorities/goals/projects", use the real saved goals, projects and tasks (tools) — never make them up.
- When the user shares something lasting about themselves (a new job, a preference, a decision, an idea to keep), ask "Would you like me to remember that for future conversations, ${title()}?" unless they already asked you to remember it. Only call remember with user_confirmed=true after a clear yes or an explicit request.
- When they correct or retract something ("I'm no longer interested in that career"), update or delete that memory with correct_memory (ids are shown as #id), then confirm briefly.
- Never store passwords, PINs, bank details or other credentials.
- Diagnostics and status: use run_diagnostics for "run a diagnostic / status report / are all systems operational / how are you performing" and system_status for resource questions. Speak its narration lines in order (you may lightly vary wording), then give the real summary.`;
};
const PERSONA = PERSONA_BASE;

function localNow(tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "longOffset" }).format(new Date());
}
const fmtLocal = (iso, tz) => new Date(iso).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function contextBlock({ userText, deviceKind, loc, voiceTurn = false }) {
  const s = getSettings();
  const tz = s.timezone;
  const open = tasks.list().slice(0, 12);
  const up = reminders.upcoming().slice(0, 8);
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const events = calendar.list(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 2 * 86400_000).toISOString()).slice(0, 10);
  const projs = projects.list({ includeDone: false }).slice(0, 8);
  const memOn = (s.memory?.mode || "ask") !== "off";
  // Saved memories are looked up only for messages with something to match (not "Brilliant." or "Thanks").
  const relevant = memOn && userText && userText.trim().split(/\s+/).length >= 3 ? await memory.search(userText, 6) : [];
  const pend = pending.list();
  const fin = { connections: connections.all().filter((c) => ["monzo", "demo"].includes(c.provider)).map(connections.view) };
  fin.testData = fin.connections.some((c) => c.provider === "demo");
  const desk = onlineDesktop();
  const home = loc?.lat ? loc : s.home;
  return [
    `Now: ${localNow(tz)} (time zone ${tz}). UTC: ${new Date().toISOString()}.`,
    `User: ${s.profile?.name || "(name not set)"}, addressed as "${title()}". Talking from: ${deviceKind || "unknown device"}${voiceTurn ? " by voice" : ""}. Home location: ${s.home.place}. Current location: ${home.place || "home"}. Units: ${s.units}.`,
    `Laptop (computer control): ${desk ? "online" : "offline"}. Allowed apps: ${Object.keys(APPS).join(", ")}. Folders: ${FOLDERS.join(", ")}.`,
    `Bank: ${fin.connections.length ? fin.connections.map((c) => `${c.provider} (${c.status}${c.last_sync_at ? `, synced ${c.last_sync_at}` : ""})`).join("; ") + (fin.testData ? " — TEST DATA" : "") : "not connected"}. Calendar: ${calendar.googleStatus().connection ? "Google connected" : "JARVIS calendar only (Google not connected)"}.`,
    `Open tasks: ${open.length ? open.map((t) => `#${t.id} ${t.title}${t.due ? ` (due ${t.due})` : ""}${t.project_title ? ` [${t.project_title}]` : ""}`).join("; ") : "none"}.`,
    `Upcoming reminders: ${up.length ? up.map((r) => `#${r.id} "${r.text}" ${fmtLocal(r.due_at, tz)}`).join("; ") : "none"}.`,
    `Calendar next 48h: ${events.length ? events.map((e) => `#${e.id} ${e.title} ${e.all_day ? e.start + " (all day)" : fmtLocal(e.start, tz)}`).join("; ") : "nothing"}.`,
    `Active projects: ${projs.length ? projs.map((p) => `#${p.id} ${p.title} ${p.progress.percent}%`).join("; ") : "none"}.`,
    `Pending confirmations: ${pend.length ? pend.map((p) => `${p.id}: ${p.summary}`).join("; ") : "none"}.`,
    `Alarms: ${(() => { const al = alarms.list().filter((a) => a.enabled || a.snoozed_until); return al.length ? al.slice(0, 8).map((a) => `#${a.id} ${a.label} ${a.time} ${a.repeat}${a.effective_next ? ` (next ${describeLocal(a.effective_next, tz)})` : ""}${a.enabled ? "" : " OFF"}`).join("; ") : "none set"; })()}.`,
    (() => { const f = focus.active(); return f ? `Focus session running: ${f.label}, ${Math.ceil(f.remainingSeconds / 60)} min left.` : ""; })(),
    (() => { const hs = habits.list({ active: true }); return hs.length ? `Habits today: ${hs.map((h) => `${h.name} ${h.doneToday ? "done" : "not done"}${h.streak ? ` (streak ${h.streak})` : ""}`).join("; ")}.` : ""; })(),
    `Unread notifications: ${notifications.unreadCount()}. Recently: ${recentActivity(5).map((a) => a.summary).join("; ") || "nothing"}.`,
    memOn ? "" : "Memory is switched OFF by the user: don't use or save personal memories.",
    relevant.length ? `Memories relevant to this message: ${relevant.map((m) => `#${m.id} [${m.category}] ${m.fact}`).join(" | ")}` : "",
    (() => { const n = s.awareness?.headsUp !== false && calendar.nextEvent(); return n && Date.parse(n.start) - Date.now() < 90 * 60_000 ? `Heads-up (mention only if relevant): "${n.title}" starts ${fmtLocal(n.start, tz)}.` : ""; })(),
    `Interface mode: ${s.personality?.mode || "standard"}.`,
  ].filter(Boolean).join("\n");
}

// ---------------- Tools
const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const S = { type: "string" }, I = { type: "integer" }, N = { type: "number" }, B = { type: "boolean" };
const TOOLS = [
  { name: "get_weather", description: "Real forecast (current, 7 days, UV, sunrise/sunset) for the user's home or current location, or any named place.", input_schema: obj({ place: S }) },
  { name: "world_time", description: "Current local time (and optionally weather) in named cities or countries.", input_schema: obj({ places: { type: "array", items: S }, weather: B }, ["places"]) },
  { name: "set_alarm", description: "Set an alarm. time is HH:MM 24h local. repeat: once (default; next time this clock time comes round, or on date YYYY-MM-DD), daily, weekdays, weekends, custom (days 0=Sun..6=Sat). message is spoken after the sound.",
    input_schema: obj({ time: S, label: S, repeat: { type: "string", enum: ["once", "daily", "weekdays", "weekends", "custom"] }, days: { type: "array", items: I }, date: S, message: S, sound: { type: "string", enum: ["chime", "classic", "radar", "gentle", "digital"] } }, ["time"]) },
  { name: "change_alarm", description: "Change, switch on/off, snooze, dismiss or delete an alarm by id.", input_schema: obj({ id: I, action: { type: "string", enum: ["update", "enable", "disable", "snooze", "dismiss", "delete"] }, time: S, label: S, repeat: { type: "string", enum: ["once", "daily", "weekdays", "weekends", "custom"] }, days: { type: "array", items: I }, minutes: I }, ["id", "action"]) },
  { name: "take_note", description: "Save a note (or search notes when query is given).", input_schema: obj({ title: S, body: S, tags: S, query: S }) },
  { name: "record_money", description: "Record money the user tells you they spent or received (e.g. 'I just spent £12.50 on food'). This is bookkeeping only — it never moves money. If a bank is connected the same spend is matched automatically when it arrives.",
    input_schema: obj({ amount_pounds: N, description: S, category: { type: "string", enum: FIN_CATS }, income: B, date: S }, ["amount_pounds"]) },
  { name: "money_plan", description: "Savings goals, debts and the finance report/projections. action: report | add_goal {name, target_pounds, deadline} | contribute {goal_id, amount_pounds} | add_debt {name, balance_pounds, apr, min_payment_pounds}.",
    input_schema: obj({ action: { type: "string", enum: ["report", "add_goal", "contribute", "add_debt"] }, name: S, target_pounds: N, deadline: S, goal_id: I, amount_pounds: N, balance_pounds: N, apr: N, min_payment_pounds: N }, ["action"]) },
  { name: "business", description: "Clients, leads and invoices. action: summary | list_clients | add_client {name, company, email, stage, value_pounds, next_follow_up} | update_client {client_id, stage, next_follow_up, notes} | log_interaction {client_id, kind, summary} | create_invoice {client_id, items:[{description, quantity, unit_pounds}], due} | invoice_status {invoice_id, status} | add_expense {description, amount_pounds, category, date}.",
    input_schema: obj({ action: { type: "string", enum: ["summary", "list_clients", "add_client", "update_client", "log_interaction", "create_invoice", "invoice_status", "add_expense"] }, client_id: I, invoice_id: I, name: S, company: S, email: S, stage: { type: "string", enum: STAGES }, value_pounds: N, next_follow_up: S, notes: S, kind: { type: "string", enum: ["call", "email", "meeting", "note"] }, summary: S, items: { type: "array", items: obj({ description: S, quantity: N, unit_pounds: N }, ["description", "unit_pounds"]) }, due: S, status: { type: "string", enum: ["draft", "sent", "paid", "void"] }, description: S, amount_pounds: N, category: S, date: S }, ["action"]) },
  { name: "focus", description: "Start, stop or check a focus (Pomodoro) session.", input_schema: obj({ action: { type: "string", enum: ["start", "stop", "status", "break"] }, minutes: I, label: S }, ["action"]) },
  { name: "habits_goals", description: "Habits and goals. action: list | check_habit {name} | add_habit {name, frequency, target, reminder_time} | add_goal {title, kind, target_date} | goal_progress {goal_id, progress} | add_milestone {goal_id, title, due} | complete_milestone {milestone_id}.",
    input_schema: obj({ action: { type: "string", enum: ["list", "check_habit", "add_habit", "add_goal", "goal_progress", "add_milestone", "complete_milestone"] }, name: S, frequency: { type: "string", enum: ["daily", "weekly"] }, target: I, reminder_time: S, title: S, kind: { type: "string", enum: ["short", "long", "career", "financial", "learning", "personal"] }, target_date: S, goal_id: I, milestone_id: I, progress: I, due: S }, ["action"]) },
  { name: "routine", description: "Run an automation routine now (e.g. 'morning briefing', 'evening review', 'weekly review' or one of the user's routines), or deliver a briefing: kind morning|afternoon|evening|weekly.", input_schema: obj({ name: S, briefing: { type: "string", enum: ["morning", "afternoon", "evening", "weekly"] }, confirmed: B }) },
  { name: "smart_home", description: "Home Assistant devices the user has allowed. action: list | control {device (name or entity id), service (turn_on, turn_off, toggle, set_temperature, open_cover, close_cover, lock, unlock, media_play, media_pause), brightness_pct, temperature}. Locks and doors need confirmation.",
    input_schema: obj({ action: { type: "string", enum: ["list", "control"] }, device: S, service: S, brightness_pct: I, temperature: N }, ["action"]) },
  { name: "notifications", description: "Read or clear the notification centre.", input_schema: obj({ action: { type: "string", enum: ["list", "read_all", "dismiss_all"] } }, ["action"]) },
  { name: "finance", description: "Answer money questions from the user's connected bank data. question: position (how much do I have / left / after bills), spending (spent this month, optionally a category or monthsAgo), afford (needs amount in pounds), subscriptions, compare (this vs last month), saving, transactions.",
    input_schema: obj({ question: { type: "string", enum: ["position", "spending", "afford", "subscriptions", "compare", "saving", "transactions"] }, amount: N, category: { type: "string", enum: ["food", "shopping", "transport", "fuel", "bills", "subscriptions", "entertainment", "travel", "transfers", "other"] }, monthsAgo: I, limit: I }, ["question"]) },
  { name: "add_commitment", description: "Record an upcoming bill, planned saving or debt repayment the user tells you about (used in the money-left calculation). Mark certainty 'confirmed' only if the user says the amount is fixed.",
    input_schema: obj({ name: S, amount_pounds: N, kind: { type: "string", enum: ["bill", "saving", "debt"] }, frequency: { type: "string", enum: ["monthly", "weekly", "yearly", "once"] }, day_of_month: I, date: S, certainty: { type: "string", enum: ["estimated", "confirmed"] } }, ["name", "amount_pounds", "kind", "frequency"]) },
  { name: "calendar_list", description: "List calendar events between two ISO times.", input_schema: obj({ from: S, to: S }, ["from", "to"]) },
  { name: "calendar_create", description: "Create an event. start/end are ISO 8601 with offset, or YYYY-MM-DD with all_day. If it clashes with something, it returns a pending action to confirm.",
    input_schema: obj({ title: S, start: S, end: S, all_day: B, location: S, notes: S }, ["title", "start"]) },
  { name: "calendar_change", description: "Move/edit or delete an existing event (by id from context or calendar_list). Always returns a pending action the user must confirm.",
    input_schema: obj({ event_id: I, operation: { type: "string", enum: ["update", "delete"] }, title: S, start: S, end: S, location: S }, ["event_id", "operation"]) },
  { name: "add_task", description: "Add a task, optionally to a project.", input_schema: obj({ title: S, due: S, priority: { type: "integer", enum: [1, 2, 3] }, project_id: I, notes: S, category: { type: "string", enum: TASK_CATEGORIES } }, ["title"]) },
  { name: "update_task", description: "Complete, reschedule, reprioritise, set progress (0-100) or delete a task by id.", input_schema: obj({ id: I, done: B, due: S, priority: { type: "integer", enum: [1, 2, 3] }, title: S, progress: I, category: { type: "string", enum: TASK_CATEGORIES }, delete: B }, ["id"]) },
  { name: "add_reminder", description: "Create a persistent reminder delivered as a notification on all devices at due_at (absolute ISO 8601 with UTC offset). repeat: none (default), daily, weekdays, weekly, monthly.", input_schema: obj({ text: S, due_at: S, repeat: { type: "string", enum: REMINDER_REPEATS } }, ["text", "due_at"]) },
  { name: "cancel_reminder", description: "Cancel a reminder by id.", input_schema: obj({ id: I }, ["id"]) },
  { name: "create_project", description: "Create a structured project with milestones and starter tasks (dates YYYY-MM-DD, priority 1 high to 3 low).",
    input_schema: obj({ title: S, goal: S, milestones: { type: "array", items: obj({ title: S, due: S, tasks: { type: "array", items: obj({ title: S, due: S, priority: { type: "integer", enum: [1, 2, 3] } }, ["title"]) } }, ["title"]) } }, ["title", "goal", "milestones"]) },
  { name: "get_project", description: "Retrieve a project (by id or search text) with milestones, tasks, progress, overdue work and next actions.", input_schema: obj({ id: I, query: S }) },
  { name: "update_project", description: "Change a project's status or notes, add a milestone, or append to its workspace notes (append_note keeps the existing notes — use it for creative work like KILL HOUSE chapters, characters and plot decisions).", input_schema: obj({ id: I, status: { type: "string", enum: ["active", "paused", "done"] }, notes: S, append_note: S, add_milestone: S, milestone_due: S }, ["id"]) },
  { name: "remember", description: "Save a lasting fact about the user. user_confirmed must be true only if the user explicitly asked you to remember it or said yes when you asked. Categories: profile, career, ambition, interest, hobby, business, creative, date, preference, routine, task, decision, topic.",
    input_schema: obj({ fact: S, category: { type: "string", enum: MEM_CATS.filter((c) => c !== "summary") }, sensitive: B, user_confirmed: B, topic: S }, ["fact", "category", "user_confirmed"]) },
  { name: "correct_memory", description: "Update or delete a saved memory by id after the user corrects or retracts it.", input_schema: obj({ id: I, fact: S, category: { type: "string", enum: MEM_CATS }, delete: B }, ["id"]) },
  { name: "run_diagnostics", description: "Run real system checks. level: quick | full | voice | ai | network | security | performance | hardware | integrations. Returns narration lines and real results.", input_schema: obj({ level: { type: "string", enum: ["quick", "full", "voice", "ai", "network", "security", "performance", "hardware", "integrations"] } }, ["level"]) },
  { name: "system_status", description: "Live system awareness: service health, errors detected, resource use (CPU, memory, storage), what's using the most resources on the laptop, recent errors.", input_schema: obj({}) },
  { name: "interface", description: "Control the JARVIS interface on the user's current device: mission_control_on, mission_control_off, set_mode (standard|cinematic|concise|professional|focus), open_section (section id).", input_schema: obj({ action: { type: "string", enum: ["mission_control_on", "mission_control_off", "set_mode", "open_section"] }, mode: { type: "string", enum: ["standard", "cinematic", "concise", "professional", "focus"] }, section: S }, ["action"]) },
  { name: "global_operations", description: "Mission Control Global Operations on the user's screen: public civil flight tracking (ADS-B, incomplete coverage; military/private-flagged aircraft are never shown) and the Global Events tracker (published reports of conflicts, attacks, unrest, disasters, humanitarian crises, diplomacy, ceasefires — each with its source). action: flights_area {place or region, radius_nm} | flights_find {query: callsign, ICAO24 hex or registration} | flights_world | flights_show | flights_hide | nearest {place?} | events {category?, country?, days?} | layer {base: dark|satellite|today|terrain|relief|osm, layer: boundaries|labels|events|conflict|flights|trails|radar|3d, on}. Answer ONLY from the returned data; if something isn't found say it isn't visible in the available data.",
    input_schema: obj({ action: { type: "string", enum: ["flights_area", "flights_find", "flights_world", "flights_show", "flights_hide", "nearest", "events", "layer"] }, place: S, region: { type: "string", enum: ["world", "europe", "mediterranean", "cyprus", "uk", "middleeast", "northamerica", "southamerica", "africa", "southasia", "eastasia", "oceania"] }, radius_nm: I, query: S,
      category: { type: "string", enum: ["conflict", "attack", "unrest", "disaster", "humanitarian", "diplomacy", "ceasefire"] }, country: S, days: I, base: S, layer: S, on: B }, ["action"]) },
  { name: "mission_operations", description: "Mission Control operations on the user's screen. Answer only from returned data. Actions:\n- blackbox_research {subject, question?, category?}: start a sourced research dossier (public information only; public figures only in their public role; never private individuals). Categories: company, organisation, country, city, location, person, aircraft, airport, space, history, conflict, technology, science, aerospace, news, institution, general.\n- blackbox_list / blackbox_get {id}: saved dossiers.\n- wayfinder_plan {destination, days?, kind? (trip|hiking|roadtrip|camping|city|multicountry|photography|research), start? YYYY-MM-DD}: create and save a trip/expedition with real weather, FCDO advice and airports plus an AI-drafted itinerary.\n- wayfinder_destination {destination}: real facts (weather forecast, FCDO advice summary, airports, currency).\n- wayfinder_flights_to {destination}: airports serving it. There is NO free source of flight schedules or fares — say so.\n- wayfinder_trips: saved trips (they save automatically).\n- sentinel_watchlist {name, countries?, regions?, categories?, min_level? (any|multiple|corroborated|official)}: create a watchlist that alerts on new matching reports.\n- sentinel_webcams {query?}: show public operator-published webcams.\n- orbit_iss | orbit_track {query: satellite name or NORAD id} | orbit_spaceweather | orbit_launches.\n- situation_report: compile the Global Situation Report.",
    input_schema: obj({ action: { type: "string", enum: ["blackbox_research", "blackbox_list", "blackbox_get", "wayfinder_plan", "wayfinder_destination", "wayfinder_flights_to", "wayfinder_trips", "sentinel_watchlist", "sentinel_webcams", "orbit_iss", "orbit_track", "orbit_spaceweather", "orbit_launches", "situation_report"] },
      subject: S, question: S, category: S, id: I, destination: S, days: I, kind: S, start: S, name: S, countries: { type: "array", items: S }, regions: { type: "array", items: S }, categories: { type: "array", items: S }, min_level: S, query: S }, ["action"]) },
  { name: "recall", description: "Search long-term memory.", input_schema: obj({ query: S }, ["query"]) },
  { name: "forget", description: "Delete a memory by id.", input_schema: obj({ id: I }, ["id"]) },
  { name: "computer", description: "Do something on the user's Windows laptop through the allowlisted actions: open_app {app}, open_folder {folder}, open_bookmark {name}, open_url {url}, create_document {title, content, format}, search_files {query, folder}, open_file {path}, create_folder {name, parent}, screenshot, list_windows, focus_window {target}, minimize_window {target}, close_window {target} (needs confirmation), clipboard_read, clipboard_write {text}, lock_screen, system_status.",
    input_schema: obj({ action: { type: "string", enum: Object.keys(COMPUTER_ACTIONS) }, app: S, folder: S, name: S, url: S, title: S, content: S, format: { type: "string", enum: ["md", "txt"] }, query: S, path: S, parent: S, target: S, text: S }, ["action"]) },
  { name: "confirm_pending", description: "Carry out or cancel a pending action after the user clearly answers.", input_schema: obj({ id: S, decision: { type: "string", enum: ["confirm", "reject"] } }, ["id", "decision"]) },
  { name: "start_research", description: "Start a longer sourced research report in the background; the user is notified when it is ready.", input_schema: obj({ query: S }, ["query"]) },
  { name: "latest_ideas", description: "Read the latest background business ideas.", input_schema: obj({ count: I }) },
  { name: "new_conversation", description: "Start a fresh conversation thread when the user asks to change subject completely.", input_schema: obj({}) },
];

async function runTool(name, input, ctx) {
  const s = getSettings();
  switch (name) {
    case "get_weather": {
      let loc = ctx.loc?.lat ? ctx.loc : s.home;
      if (input.place) { const g = (await geocode(input.place).catch(() => []))[0]; if (!g) return { ok: false, error: `I couldn't find a place called ${input.place}.` }; loc = { lat: g.lat, lon: g.lon, place: g.name }; }
      try { const w = await getWeather({ ...loc, units: s.units }); return { ok: true, forecast: weatherSentence(w), sunrise: w.today?.sunrise, sunset: w.today?.sunset, uvToday: w.today?.uv }; } catch (e) { return { ok: false, error: `Weather service unavailable: ${e.message}` }; }
    }
    case "world_time": {
      const out = [];
      for (const p of (input.places || []).slice(0, 6)) {
        const g = (await geocode(p).catch(() => []))[0];
        if (!g?.timezone) { out.push({ place: p, error: "not found" }); continue; }
        const row = { place: g.name, timezone: g.timezone, localTime: new Date().toLocaleString("en-GB", { timeZone: g.timezone, weekday: "long", hour: "2-digit", minute: "2-digit" }) };
        if (input.weather) { try { const w = await getWeather({ lat: g.lat, lon: g.lon, place: g.name, units: s.units }); row.weather = `${w.current.temp}${w.unitTemp}, ${w.current.summary}`; } catch (e) { row.weather = `unavailable (${e.message})`; } }
        out.push(row);
      }
      return { ok: true, home: { place: s.home.place, localTime: new Date().toLocaleString("en-GB", { timeZone: s.timezone, weekday: "long", hour: "2-digit", minute: "2-digit" }) }, places: out };
    }
    case "set_alarm": {
      const a = alarms.create({ time: input.time, label: input.label, repeat: input.repeat || "once", days: input.days, date: input.date, message: input.message, sound: input.sound }, { deviceId: ctx.deviceId });
      return { ok: true, alarm: { id: a.id, label: a.label, time: a.time, repeat: a.repeat, next: a.next_local, sound: a.sound_name } };
    }
    case "change_alarm": {
      const id = input.id;
      if (!alarms.get(id)) return { ok: false, error: "No such alarm" };
      if (input.action === "delete") return { ok: alarms.remove(id, { deviceId: ctx.deviceId }) };
      if (input.action === "snooze") return { ok: true, ...alarms.snooze(id, input.minutes, { deviceId: ctx.deviceId }) };
      if (input.action === "dismiss") return { ok: true, alarm: alarms.dismiss(id, { deviceId: ctx.deviceId }) };
      const patch = input.action === "enable" ? { enabled: true } : input.action === "disable" ? { enabled: false } : Object.fromEntries(Object.entries({ time: input.time, label: input.label, repeat: input.repeat, days: input.days }).filter(([, v]) => v !== undefined));
      const a = alarms.update(id, patch, { deviceId: ctx.deviceId });
      return { ok: true, alarm: { id: a.id, label: a.label, time: a.time, repeat: a.repeat, enabled: a.enabled, next: a.next_local } };
    }
    case "take_note": {
      if (input.query) { const q = input.query.toLowerCase(); return { ok: true, notes: notes.list().filter((n) => `${n.title} ${n.body} ${n.tags}`.toLowerCase().includes(q)).slice(0, 10).map((n) => ({ id: n.id, title: n.title, body: n.body.slice(0, 500) })) }; }
      const n = notes.create({ title: input.title || (input.body || "").slice(0, 60), body: input.body || "", tags: input.tags || "" });
      return { ok: true, note: { id: n.id, title: n.title } };
    }
    case "record_money": {
      const t = addManualTransaction({ amount: Math.round(Number(input.amount_pounds) * 100), description: input.description, category: input.category, income: !!input.income, date: input.date }, { deviceId: ctx.deviceId });
      return { ok: true, recorded: { id: t.id, amount: (Math.abs(t.amount) / 100).toFixed(2), category: t.category, income: t.amount > 0, date: t.created.slice(0, 10) }, note: "Bookkeeping only; no money was moved." };
    }
    case "money_plan": {
      const p = (x) => Math.round(Number(x) * 100);
      if (input.action === "report") { const r = financeReport(); return { ok: true, ...JSON.parse(JSON.stringify(r, (k, v) => (typeof v === "number" && /spent|income|net|target|saved|left|balance|monthly|in\dMonths|total|cash|savings|credit|debts|min_payment|monthlyNeeded/i.test(k) ? `£${(v / 100).toFixed(2)}` : v))) }; }
      if (input.action === "add_goal") { const g = savingsGoals.create({ name: input.name, target: p(input.target_pounds), deadline: input.deadline }); return { ok: true, goal: g }; }
      if (input.action === "contribute") { const g = contributeToGoal(input.goal_id, p(input.amount_pounds)); return g ? { ok: true, goal: g, note: "Tracked only; no money was moved." } : { ok: false, error: "No such goal" }; }
      if (input.action === "add_debt") { const d = debts.create({ name: input.name, balance: p(input.balance_pounds), apr: input.apr || 0, min_payment: p(input.min_payment_pounds || 0) }); return { ok: true, debt: d }; }
      return { ok: false, error: "Unknown action" };
    }
    case "business": {
      const p = (x) => (x == null ? undefined : Math.round(Number(x) * 100));
      switch (input.action) {
        case "summary": return { ok: true, ...businessSummary() };
        case "list_clients": return { ok: true, clients: clients.list().slice(0, 40).map((c) => ({ id: c.id, name: c.name, company: c.company, stage: c.stage, value: c.value, next_follow_up: c.next_follow_up })) };
        case "add_client": return { ok: true, client: clients.create({ name: input.name, company: input.company, email: input.email, stage: input.stage, value: p(input.value_pounds), next_follow_up: input.next_follow_up, notes: input.notes }) };
        case "update_client": { const c = clients.update(input.client_id, Object.fromEntries(Object.entries({ stage: input.stage, next_follow_up: input.next_follow_up, notes: input.notes, value: p(input.value_pounds) }).filter(([, v]) => v !== undefined))); return c ? { ok: true, client: c } : { ok: false, error: "No such client" }; }
        case "log_interaction": return { ok: true, interaction: interactions.create({ client_id: input.client_id, kind: input.kind, summary: input.summary }) };
        case "create_invoice": { const i = invoices.create({ client_id: input.client_id, items: (input.items || []).map((it) => ({ description: it.description, quantity: it.quantity || 1, unit: p(it.unit_pounds) })), due: input.due }); return { ok: true, invoice: { id: i.id, number: i.number, total: `£${(i.total / 100).toFixed(2)}`, status: i.status, due: i.due }, note: "Created as a draft; nothing has been sent." }; }
        case "invoice_status": { const i = invoices.update(input.invoice_id, { status: input.status }); return i ? { ok: true, invoice: { id: i.id, number: i.number, status: i.status } } : { ok: false, error: "No such invoice" }; }
        case "add_expense": return { ok: true, expense: expenses.create({ description: input.description, amount: p(input.amount_pounds), category: input.category, date: input.date || localDate() }) };
        default: return { ok: false, error: "Unknown action" };
      }
    }
    case "focus": {
      if (input.action === "status") return { ok: true, active: focus.active(), stats: focus.stats() };
      if (input.action === "stop") { const f = focus.stop({ completed: false }); return f ? { ok: true, stopped: f.label } : { ok: false, error: "No focus session is running" }; }
      const f = focus.start({ minutes: input.minutes || (input.action === "break" ? s.focus.breakMinutes : s.focus.workMinutes), label: input.label, kind: input.action === "break" ? "break" : "work" });
      return { ok: true, session: { label: f.label, minutes: f.planned_minutes, ends_at: f.ends_at } };
    }
    case "habits_goals": {
      switch (input.action) {
        case "list": return { ok: true, habits: habits.list({ active: true }).map((h) => ({ id: h.id, name: h.name, doneToday: h.doneToday, streak: h.streak, frequency: h.frequency })), goals: goals.list().map((g) => ({ id: g.id, title: g.title, progress: g.progress, status: g.status, target_date: g.target_date, milestones: g.milestones.map((m) => ({ id: m.id, title: m.title, done: m.done })) })) };
        case "check_habit": { const h = habits.find(input.name || input.title || ""); if (!h) return { ok: false, error: `No active habit matching "${input.name}"`, habits: habits.list({ active: true }).map((x) => x.name) }; const r = habits.check(h.id); return { ok: true, habit: { name: r.name, today: r.today, streak: r.streak } }; }
        case "add_habit": return { ok: true, habit: habits.create({ name: input.name, frequency: input.frequency, target: input.target, reminder_time: input.reminder_time }) };
        case "add_goal": return { ok: true, goal: goals.create({ title: input.title || input.name, kind: input.kind, target_date: input.target_date }) };
        case "goal_progress": { const g = goals.update(input.goal_id, { progress: input.progress, ...(input.progress >= 100 ? { status: "done" } : {}) }); return g ? { ok: true, goal: { id: g.id, title: g.title, progress: g.progress } } : { ok: false, error: "No such goal" }; }
        case "add_milestone": return { ok: true, milestone: milestones.create({ goal_id: input.goal_id, title: input.title || input.name, due: input.due }) };
        case "complete_milestone": { const m = milestones.update(input.milestone_id, { done: true }); return m ? { ok: true, milestone: m } : { ok: false, error: "No such milestone" }; }
        default: return { ok: false, error: "Unknown action" };
      }
    }
    case "routine": {
      const auto = await import("./services/automations.js");
      if (input.briefing) { const { deliverBriefing } = await import("./services/briefings.js"); const b = await deliverBriefing(input.briefing, { loc: ctx.loc, trigger: "voice", speak: false }); return { ok: true, briefing: b.text, note: "Read this briefing to the user as your reply." }; }
      const r = auto.routines.find(input.name || "");
      if (!r) return { ok: false, error: `No routine called "${input.name}"`, routines: auto.routines.list().map((x) => x.name) };
      const res = await auto.runRoutine(r.id, { trigger: "voice", deviceId: ctx.deviceId, confirmed: !!input.confirmed });
      if (res.status === "needs_confirmation") return { ok: false, needsConfirmation: true, ...res, note: `Tell the user these steps change things outside JARVIS (${res.steps.join("; ")}) and ask "Shall I proceed?". Only call routine again with confirmed=true after a clear yes.` };
      return { ok: res.status === "ok", ...res };
    }
    case "smart_home": {
      if (!smarthome.configured()) return { ok: false, error: "Home Assistant isn't set up. It can be added in API keys (address and a long-lived access token)." };
      if (input.action === "list") return { ok: true, devices: smarthome.list().filter((d) => d.allowed).map((d) => ({ entity_id: d.entity_id, name: d.name, state: d.state, services: d.services })), note: "Only devices the user allowed are listed." };
      const d = smarthome.find(input.device);
      if (!d) return { ok: false, error: `No device matching "${input.device}"` };
      const data = { brightness_pct: input.brightness_pct, temperature: input.temperature };
      const v = smarthome.validate(d.entity_id, input.service, data);
      if (v.sensitive) return pending.propose("smarthome.control", { entity: d.entity_id, service: input.service, data }, `${input.service.replace(/_/g, " ")} ${d.name}`);
      return smarthome.control(d.entity_id, input.service, data, { deviceId: ctx.deviceId });
    }
    case "notifications": {
      if (input.action === "read_all") { notifications.markRead("all"); return { ok: true }; }
      if (input.action === "dismiss_all") { notifications.dismiss("all"); return { ok: true }; }
      return { ok: true, unread: notifications.list({ unread: true, limit: 15 }).map((n) => ({ title: n.title, body: n.body, at: n.created_at })) };
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
    case "add_task": return { ok: true, task: tasks.add({ title: input.title, due: input.due, priority: input.priority, projectId: input.project_id, notes: input.notes, category: input.category, source: "jarvis" }) };
    case "update_task": {
      if (input.delete) return { ok: tasks.remove(input.id) };
      const t = tasks.update(input.id, { done: input.done, due: input.due, priority: input.priority, title: input.title, progress: input.progress, category: input.category });
      return t ? { ok: true, task: t } : { ok: false, error: "No such task" };
    }
    case "add_reminder": {
      const d = new Date(input.due_at);
      if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid time; use ISO 8601 with offset" };
      if (d.getTime() < Date.now() - 60_000) return { ok: false, error: "That time has already passed" };
      const r = reminders.add({ text: input.text, due_at: d.toISOString(), repeat: input.repeat || "none" });
      return { ok: true, reminder: { id: r.id, text: r.text, local: fmtLocal(r.due_at, s.timezone), repeat: r.repeat } };
    }
    case "cancel_reminder": return { ok: reminders.remove(input.id) };
    case "create_project": { const p = projects.create(input); return { ok: true, project: { id: p.id, title: p.title, milestones: p.milestones.map((m) => m.title), tasks: p.progress.total } }; }
    case "get_project": {
      const p = input.id ? projects.get(input.id) : input.query ? projects.find(input.query) : null;
      return p ? { ok: true, report: projects.report(p.id), notes: p.notes } : { ok: false, error: "No matching project", projects: projects.list().map((x) => ({ id: x.id, title: x.title })) };
    }
    case "update_project": {
      if (input.add_milestone) projects.addMilestone(input.id, { title: input.add_milestone, due: input.milestone_due });
      const cur = projects.get(input.id);
      const notes = input.append_note ? `${cur?.notes ? cur.notes + "\n\n" : ""}[${localDate()}] ${input.append_note}`.slice(-5000) : input.notes;
      const p = projects.update(input.id, { status: input.status, notes });
      return p ? { ok: true, project: projects.report(p.id) } : { ok: false, error: "No such project" };
    }
    case "remember": {
      const mode = s.memory?.mode || "ask";
      if (mode === "off") return { ok: false, error: "Memory is switched off by the user (Memory & Notes)." };
      if (mode === "ask" && !input.user_confirmed) return { ok: false, needsConfirmation: true, error: `Ask first: "Would you like me to remember that for future conversations, ${title()}?" Then call remember again with user_confirmed=true if they agree.` };
      const r = await memory.save({ fact: input.fact, category: input.category, sensitive: input.sensitive, source: "conversation", topic: input.topic });
      return r.pending ? { ok: true, pending: true, id: r.id, note: "Sensitive: stored only after the user approves. Ask them if you may keep it; if yes call confirm_pending with id 'memory:" + r.id + "'." } : { ok: !!r.saved, ...r };
    }
    case "recall": return (s.memory?.mode || "ask") === "off" ? { ok: false, error: "Memory is switched off by the user." } : { ok: true, memories: (await memory.search(input.query, 8)).map((m) => ({ id: m.id, fact: m.fact, category: m.category })) };
    case "correct_memory": {
      if (!memory.get(input.id)) return { ok: false, error: "No such memory" };
      if (input.delete) return { ok: memory.remove(input.id), deleted: true };
      const m = await memory.update(input.id, { fact: input.fact, category: input.category });
      return { ok: true, memory: { id: m.id, fact: m.fact, category: m.category } };
    }
    case "run_diagnostics": {
      const { runLevel } = await import("./services/narrator.js");
      const r = await runLevel(input.level || "quick", { client, deviceId: ctx.deviceId });
      ctx.diagnostics = r;
      return { ok: true, overall: r.overall, narration: r.narration, problems: r.problems, durationMs: r.durationMs };
    }
    case "system_status": {
      const { systemAwareness } = await import("./services/narrator.js");
      return { ok: true, ...(await systemAwareness()) };
    }
    case "interface": {
      const { sendToDevice } = await import("./realtime.js");
      if (input.action === "set_mode") { const { updateSettings } = await import("./db.js"); updateSettings({ personality: { mode: input.mode || "standard" } }); changed("settings"); return { ok: true, mode: input.mode }; }
      const sent = sendToDevice(ctx.deviceId, { type: "ui", action: input.action, section: input.section });
      return sent ? { ok: true } : { ok: false, error: "This device isn't connected live." };
    }
    case "global_operations": {
      const { sendToDevice } = await import("./realtime.js");
      const show = (cmd) => sendToDevice(ctx.deviceId, { type: "ui", action: "goc", cmd });
      const a = input.action;
      if (a === "flights_area" || a === "nearest") {
        let lat = null, lon = null, label = input.region || null;
        if (input.place) { const g = (await geocode(input.place))[0]; if (!g) return { ok: false, error: `I couldn't find a place called ${input.place}.` }; lat = g.lat; lon = g.lon; label = g.name; }
        else if (!input.region && a === "nearest") { const st = getSettings(); lat = st.home.lat; lon = st.home.lon; label = st.home.place; }
        if (lat != null) {
          const nm = Math.max(20, Math.min(250, input.radius_nm || 120));
          const r = await flights.near(lat, lon, nm);
          const shown = show(a === "nearest" && r.nearby?.[0] ? { action: "select", hex: r.nearby[0].hex, section: "flights" } : { action: "flights_area", lat, lon, nm });
          if (!r.ok) return { ok: false, error: r.error, onScreen: shown };
          return { ok: true, area: label, radius_nm: nm, aircraftVisible: r.count, nearest: r.nearby.slice(0, 8), source: r.attribution?.name, dataAgeSec: r.ageSec, coverageNote: "Only aircraft seen by volunteer ADS-B receivers appear; many are not visible.", onScreen: shown };
        }
        const shown = show({ action: "flights_area", region: input.region });
        return { ok: true, region: input.region, onScreen: shown, note: "The map is showing that region; the aircraft count appears on screen." };
      }
      if (a === "flights_find") {
        const r = await flights.search(input.query);
        if (r.ok && r.results.length) show({ action: "select", hex: r.results[0].hex, follow: true, section: "flights" });
        return r.ok && r.results.length ? { ok: true, found: r.results.slice(0, 3), source: r.from } : { ok: false, query: r.query, error: r.error || "not currently visible in the available data" };
      }
      if (a === "events") {
        const r = await gevents.list({ category: input.category, country: input.country, days: input.days || 3, limit: 12 });
        show({ action: "events", category: input.category || null, country: input.country || "" });
        return { ok: true, total: r.total, items: r.items.map((e) => ({ title: e.title, place: e.placeName || e.country, category: e.category, published: e.publishedAt || e.eventDate, verification: r.statusLabels[e.status], source: e.sources?.[0]?.name, url: e.sources?.[0]?.url })),
          sourcesUnavailable: Object.values(r.providers).filter((p) => p.configured && p.state !== "operational").map((p) => `${p.name}: ${p.state}`) };
      }
      return { ok: true, onScreen: show({ action: a, base: input.base, layer: input.layer, on: input.on }) };
    }
    case "mission_operations": {
      const { sendToDevice } = await import("./realtime.js");
      const show = (cmd) => sendToDevice(ctx.deviceId, { type: "ui", action: "goc", cmd });
      const { records } = await import("./services/ops/records.js");
      const a = input.action;
      if (a === "blackbox_research") {
        const bb = await import("./services/ops/blackbox.js");
        const { notify: n } = await import("./services/notify.js");
        const r = bb.createDossier({ subject: input.subject, question: input.question, category: input.category }, { notify: n });
        show({ op: "blackbox", action: "open", id: r.id });
        return { ok: true, id: r.id, status: "researching", note: "The dossier is being researched in the background and opens on screen; it is not finished yet, so don't state findings." };
      }
      if (a === "blackbox_list") return { dossiers: records.list({ op: "blackbox", kind: "dossier", limit: 20 }).map((d) => ({ id: d.id, title: d.title, status: d.status, category: d.data.category, updated: d.updated_at })) };
      if (a === "blackbox_get") { const d = records.get(input.id); if (!d || d.op !== "blackbox") return { ok: false, error: "No such dossier" }; show({ op: "blackbox", action: "open", id: d.id }); return { id: d.id, title: d.title, status: d.status, summary: d.data.executiveSummary, findings: (d.data.findings || []).slice(0, 8), sources: (d.data.sources || []).slice(0, 12).map((s) => ({ title: s.title, url: s.url })), limitations: d.data.limitations }; }
      if (a === "wayfinder_plan") {
        const wf = await import("./services/ops/wayfinder.js");
        const t = await wf.planTrip({ destination: input.destination, days: input.days, kind: input.kind, start: input.start });
        show({ op: "wayfinder", action: "open", id: t.id });
        return { ok: true, id: t.id, title: t.title, saved: true, destination: t.data.destination?.name, aiDraftedItinerary: t.data.aiDraft, weather: t.data.research?.weatherAtCreation?.daily?.slice(0, 7), advice: t.data.research?.advice?.summary?.slice(0, 400), airports: (t.data.research?.airports || []).slice(0, 3).map((x) => `${x.name} (${x.iata || x.icao}) ${x.km} km`) };
      }
      if (a === "wayfinder_destination" || a === "wayfinder_flights_to") {
        const wf = await import("./services/ops/wayfinder.js");
        const d = await wf.destination(input.destination);
        if (!d.ok) return d;
        if (a === "wayfinder_flights_to") return { destination: d.place.name, airports: d.airports.map((x) => ({ name: x.name, iata: x.iata, icao: x.icao, km: x.km })), note: "No free source provides airline schedules or fares; live status of a known flight number is available once it's flying." };
        return { place: d.place.name, localTime: d.localTime, country: d.country, weather: d.weather?.daily?.slice(0, 7) || d.weather, adviceSummary: d.advice?.summary?.slice(0, 500), adviceUrl: d.advice?.url, adviceUpdated: d.advice?.updatedAt, airports: d.airports.slice(0, 3) };
      }
      if (a === "wayfinder_trips") { show({ op: "wayfinder", action: "list" }); return { trips: records.list({ op: "wayfinder", limit: 20 }).map((t) => ({ id: t.id, title: t.title, destination: t.data.destination?.name, depart: t.data.depart, return: t.data.return })), note: "Trips are saved automatically as they change." }; }
      if (a === "sentinel_watchlist") {
        const sn = await import("./services/ops/sentinel.js");
        const w = records.create({ op: "sentinel", kind: "watchlist", title: input.name || (input.countries || []).join(", ") || "Watchlist", data: sn.normaliseWatchlist({ countries: input.countries, regions: input.regions, categories: input.categories, minLevel: input.min_level, enabled: true }) });
        show({ op: "sentinel", action: "watchlists" });
        return { ok: true, id: w.id, title: w.title, watching: w.data };
      }
      if (a === "sentinel_webcams") { show({ op: "sentinel", action: "webcams", q: input.query || "" }); const sn = await import("./services/ops/sentinel.js"); const r = await sn.webcams({ q: input.query }); return { count: r.cams.length, verifiedLive: r.cams.filter((c) => c.liveStatus === "live").length, cameras: r.cams.slice(0, 10).map((c) => ({ name: c.name, city: c.city, country: c.country, kind: c.kind, status: c.liveStatus })), note: r.note }; }
      if (a.startsWith("orbit_")) {
        const ob = await import("./services/ops/orbit.js");
        if (a === "orbit_iss") { show({ op: "orbit", action: "iss" }); return await ob.iss(); }
        if (a === "orbit_track") { const r = await ob.search(input.query); if (!r.elements.length) return { ok: false, error: "No catalogued object matches that." }; show({ op: "orbit", action: "search", query: input.query }); return { ok: true, ...ob.describe(r.elements[0]), matches: r.total, fetchedAt: r.fetchedAt }; }
        if (a === "orbit_spaceweather") { show({ op: "orbit", action: "spaceweather" }); const w = await ob.spaceWeather(); return { kp: w.kp && { latest: w.kp.latest, time: w.kp.time, storm: w.kp.storm }, flare: w.flare, alerts: (w.alerts || []).slice(0, 3), donki: (w.donki || []).slice(0, 3), errors: w.errors }; }
        if (a === "orbit_launches") { show({ op: "orbit", action: "launches" }); const l = await ob.launches(6); return { launches: l.items.map((x) => ({ name: x.name, net: x.net, precision: x.netPrecision, status: x.statusName, provider: x.provider, site: x.site })), fetchedAt: l.fetchedAt }; }
      }
      if (a === "situation_report") { show({ action: "sitrep" }); return { ok: true, note: "The report is compiling on screen; summarise it only after the user has read it or ask what they'd like to know." }; }
      return { ok: false, error: "Unknown action" };
    }
    case "forget": return { ok: memory.remove(input.id) };
    case "computer": {
      const { action, ...rest } = input;
      if (COMPUTER_ACTIONS[action]?.confirm) { try { return proposeComputerAction(action, rest); } catch (e) { return { ok: false, error: e.message }; } }
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
pending.registerHandler("smarthome.control", ({ entity, service, data }) => smarthome.control(entity, service, data, { confirmed: true }));

// What the user's Mission Control is showing, so "this aircraft", "this journey" or "this dossier" make sense.
function screenLine(sc) {
  if (!sc || typeof sc !== "object") return "";
  const j = JSON.stringify(sc, (k, v) => (typeof v === "string" ? v.slice(0, 160) : v)).slice(0, 1500);
  return `\nOn the user's screen now (Mission Control): ${j}. Use the mission_operations / global_operations tools for anything on it.`;
}

// ---------------- Conversation turn
/** Notes about the conversation itself: what was looked up recently, an interruption, delivery requests and the "Sir" rule. */
function conversationNotes({ replies = [], metas = [], cut = null, session = null }) {
  const p = getSettings().personality || {};
  const lines = [];
  const trace = toolTrace(metas);
  if (trace.length) lines.push(`What you looked up recently in this conversation (for follow-ups): ${trace.join("; ")}.`);
  if (cut) lines.push(`The user interrupted your last reply. They heard only: "${cut.heard.slice(-500) || "(nothing)"}". What you had been going to say: "${cut.full.slice(0, 700)}".`);
  if (session?.brief) lines.push("The user asked you to keep answers brief for now: one or two sentences unless they ask for more.");
  const hint = titleHint(replies.slice(-4), title(), p.sir || "occasionally");
  if (hint) lines.push(hint);
  const opens = recentOpenings(replies);
  if (opens.length) lines.push(`Your recent replies began "${opens.join("\", \"")}" — start this one differently.`);
  return lines.length ? `\nConversation notes:\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}

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
 * With onEvent the reply is streamed: {type:"delta", text} as words arrive, {type:"tool", name, phase} around tool use.
 */
export async function chat({ text, conversationId, deviceId, deviceKind, clientId, loc, voice = false, screen = null, onEvent, signal = null, session = null, interrupted = null } = {}) {
  conversationId ||= conversations.currentId();
  // The user cut the previous reply short: record what they actually heard before building the context.
  if (interrupted?.clientId) await conversations.markInterrupted(String(interrupted.clientId), interrupted.heard).catch(() => false);
  const prior = clientId ? conversations.findByClientId(clientId) : null;
  if (prior) {
    const reply = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND role = 'assistant' ORDER BY id LIMIT 1").get(prior.conversation_id, prior.id);
    if (reply) { onEvent?.({ type: "delta", text: reply.content }); return { reply: reply.content, sources: reply.sources ? JSON.parse(reply.sources) : [], conversationId: prior.conversation_id, duplicate: true, changed: [] }; }
  }
  const { summary, turns, replies, metas, interrupted: cut } = conversations.context(conversationId, 20);
  conversations.add({ conversationId, role: "user", content: text, deviceId, clientId });
  if (!client) {
    const reply = `My apologies, ${title()} — my reasoning systems are offline. An Anthropic API key needs to be added (tray icon → API keys & AI model).`;
    conversations.add({ conversationId, role: "assistant", content: reply });
    onEvent?.({ type: "delta", text: reply });
    return { reply, sources: [], conversationId, changed: [] };
  }
  const ctx = { loc, deviceId, changed: new Set() };
  const system = [
    { type: "text", text: persona(), cache_control: { type: "ephemeral" } },
    ...((getSettings().memory?.mode || "ask") !== "off" ? [{ type: "text", text: `Personal profile (from saved memory; ids for corrections):\n${memory.profileBlock() || "Nothing saved yet."}`, cache_control: { type: "ephemeral" } }] : []),
    { type: "text", text: `${summary ? `Earlier in this conversation (summary): ${summary}\n` : ""}${await contextBlock({ userText: text, deviceKind, loc, voiceTurn: voice })}${screenLine(screen)}${conversationNotes({ replies, metas, cut, session })}` },
  ];
  const messages = [...turns, { role: "user", content: text }];
  const tools = [...TOOLS, ...(config.webSearch ? [WEB_SEARCH(5)] : [])];
  const said = [], sources = [], toolsUsed = [];
  let finished = false, partial = "", aborted = false;
  for (let step = 0; step < 8; step++) {
    if (signal?.aborted) { aborted = true; break; }
    const params = { model: config.model, max_tokens: 6000, system, tools, messages, output_config: { effort: process.env.JARVIS_EFFORT || "low" }, ...FALLBACK };
    let msg;
    if (onEvent) {
      msg = await timed("anthropic", { model: config.model, purpose: "chat" }, async () => {
        const stream = client.beta.messages.stream(params, signal ? { signal } : undefined);
        let sep = said.length > 0;
        partial = "";
        stream.on("text", (delta) => { partial += delta; if (sep && delta.trim()) { onEvent({ type: "delta", text: " " }); sep = false; } onEvent({ type: "delta", text: delta }); });
        stream.on("streamEvent", (ev) => { if (ev.type === "content_block_start" && ev.content_block?.type === "server_tool_use") onEvent({ type: "tool", name: ev.content_block.name, phase: "start" }); });
        return stream.finalMessage();
      }).catch((e) => { if (signal?.aborted) return null; throw e; });
      if (!msg) { aborted = true; if (partial.trim()) said.push(partial.trim()); break; }
    } else msg = await ai("chat", params);
    if (msg.stop_reason === "refusal") { said.push(`I'm afraid that's one I must decline, ${title()}.`); onEvent?.({ type: "delta", text: said.at(-1) }); finished = true; break; }
    messages.push({ role: "assistant", content: msg.content });
    const part = textAndSources(msg.content);
    if (part.text) said.push(part.text);
    for (const src of part.sources) if (!sources.some((x) => x.url === src.url)) sources.push(src);
    if (msg.stop_reason === "pause_turn") continue;  // server tool (web search) still working
    for (const b of msg.content) if (b.type === "server_tool_use" && b.input?.query) toolsUsed.push({ name: b.name, args: `query=${String(b.input.query).slice(0, 60)}` });
    const uses = msg.content.filter((b) => b.type === "tool_use");
    for (const u of uses) toolsUsed.push({ name: u.name, args: summariseArgs(u.input || {}) });
    if (msg.stop_reason !== "tool_use" || !uses.length) { finished = true; break; }
    const results = await Promise.all(uses.map(async (u) => {
      onEvent?.({ type: "tool", name: u.name, phase: "start" });
      try {
        const out = await runTool(u.name, u.input || {}, ctx);
        onEvent?.({ type: "tool", name: u.name, phase: "done", ok: out?.ok !== false });
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out).slice(0, 30000), is_error: out?.ok === false };
      } catch (e) {
        onEvent?.({ type: "tool", name: u.name, phase: "done", ok: false });
        return { type: "tool_result", tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  let reply = said.join(" ").replace(/\s+\n/g, "\n").trim();
  const targetConv = ctx.newConversationId || conversationId;
  if (aborted) {
    // Interrupted: keep only what was actually produced (the client then records how much was heard).
    conversations.add({ conversationId: targetConv, role: "assistant", content: reply || "…", sources, meta: { tools: toolsUsed, interrupted: true, heard: "" } });
    return { reply, sources, conversationId: targetConv, interrupted: true };
  }
  if (!reply) { reply = finished ? "Done." : "I've done what I can on that."; onEvent?.({ type: "delta", text: reply }); }
  conversations.add({ conversationId: targetConv, role: "assistant", content: reply, sources, meta: toolsUsed.length ? { tools: toolsUsed } : null });
  maybeSummarize(conversationId).catch(() => {});
  return { reply, sources, conversationId: targetConv };
}

/** Keep long conversations manageable: fold older turns into a running summary, and keep notable ones as memory. */
async function maybeSummarize(conversationId) {
  const rows = conversations.unsummarized(conversationId);
  if (rows.length < 40 || !client) return;
  const fold = rows.slice(0, rows.length - 12);
  const prev = conversations.get(conversationId)?.summary || "";
  const msg = await ai("summary", {
    model: config.model, max_tokens: 2000, output_config: { effort: "low" }, ...FALLBACK,
    messages: [{ role: "user", content: `Update this running summary of a conversation between a user and their assistant JARVIS. Keep decisions, commitments, facts about the user and open threads; drop small talk. Max 200 words.\n\nPrevious summary:\n${prev || "(none)"}\n\nNew turns:\n${fold.map((m) => `${m.role}: ${m.content}`).join("\n")}` }],
  });
  const text = textAndSources(msg.content).text;
  if (text) {
    // The running summary stays with this conversation (active context). It is only copied into long-term memory
    // if the user turned that on (Settings → Memory); by default conversations are not saved as memories.
    conversations.setSummary(conversationId, text, fold.at(-1).id);
    if (getSettings().memory?.saveSummaries === true) await memory.save({ fact: `Conversation summary (${new Date().toISOString().slice(0, 10)}): ${text.slice(0, 900)}`, category: "summary", source: "conversation" });
  }
}

// ---------------- Research (sourced, background)
/** Web research for operations (Blackbox, Wayfinder): returns the report text and the real cited URLs. */
export async function webResearch(prompt, { maxUses = 8 } = {}) {
  if (!client) throw new Error("Anthropic API key missing");
  if (!config.webSearch) throw new Error("Web search is disabled (JARVIS_WEB_SEARCH=false)");
  const messages = [{ role: "user", content: prompt }];
  let out = { text: "", sources: [] };
  for (let i = 0; i < 4; i++) {
    const msg = await ai("ops-research", { model: config.researchModel, max_tokens: 12000, tools: [research.webSearch(maxUses)], messages, output_config: { effort: "medium" }, ...research.fallback });
    messages.push({ role: "assistant", content: msg.content });
    const part = textAndSources(msg.content);
    out = { text: (out.text + "\n" + part.text).trim(), sources: [...out.sources, ...part.sources.filter((s) => !out.sources.some((o) => o.url === s.url))] };
    if (msg.stop_reason !== "pause_turn") break;
  }
  return out;
}
/** Structured JSON from the AI (zod schema). Returns null on refusal. */
export async function structured(purpose, schema, prompt, { effort = "medium", maxTokens = 12000 } = {}) {
  if (!client) throw new Error("Anthropic API key missing");
  const msg = await ai(purpose, { model: config.model, max_tokens: maxTokens, output_config: { effort, format: betaZodOutputFormat(schema) }, ...FALLBACK, messages: [{ role: "user", content: prompt }] }, "parse");
  return msg.stop_reason === "refusal" ? null : msg.parsed_output;
}

export function startResearch(query) {
  const r = db.prepare("INSERT INTO research (query, status) VALUES (?, 'running')").run(String(query).slice(0, 500));
  const id = Number(r.lastInsertRowid);
  changed("research");
  runResearch(id, query).catch(() => {});
  return { id };
}
async function runResearch(id, query) {
  try {
    if (!client) throw new Error("Anthropic API key missing");
    if (!config.webSearch) throw new Error("Web search is disabled (JARVIS_WEB_SEARCH=false)");
    const messages = [{ role: "user", content: `Research this thoroughly using web search and write a concise, well-structured report for the user (who lives in ${getSettings().home.place}). Compare several sources, note disagreements and uncertainty, and cite sources for every factual claim. Do not invent anything. Topic: ${query}` }];
    let out = { text: "", sources: [] };
    for (let i = 0; i < 6; i++) {
      const msg = await ai("research", { model: config.researchModel, max_tokens: 16000, tools: [research.webSearch(10)], messages, output_config: { effort: "medium" }, ...research.fallback });
      messages.push({ role: "assistant", content: msg.content });
      const part = textAndSources(msg.content);
      out = { text: (out.text + "\n" + part.text).trim(), sources: [...out.sources, ...part.sources.filter((s) => !out.sources.some((o) => o.url === s.url))] };
      if (msg.stop_reason !== "pause_turn") break;
    }
    db.prepare("UPDATE research SET report = ?, sources = ?, status = 'done' WHERE id = ?").run(out.text, JSON.stringify(out.sources), id);
    changed("research");
    notify({ kind: "research", title: "Research ready", body: String(query).slice(0, 100), url: `/?tab=intelligence&id=${id}`, tag: `research-${id}` }).catch(() => {});
  } catch (e) {
    db.prepare("UPDATE research SET status = 'failed', error = ? WHERE id = ?").run(e.message, id);
    changed("research");
  }
}

// ---------------- Briefings (real data only)
const BRIEF_STYLE = {
  morning: (n) => `Deliver the morning briefing: a greeting suited to the time of day (e.g. "Good morning, ${title()}."), then weather (mention UV or sunset only if notable), today's schedule, priorities and reminders, money if present, projects and habits${n ? ", then one or two genuinely relevant news headlines" : ""} — in 5–8 spoken sentences.`,
  afternoon: () => "Give a brief afternoon update: the rest of today's schedule, progress so far and what still needs doing — 3–5 spoken sentences.",
  evening: () => `Give the evening review: what got done today, what's left, tomorrow's schedule and weather, and the alarm for tomorrow — 4–6 spoken sentences, ending with a calm sign-off for the night.`,
  weekly: () => "Give the weekly review: the week's results (tasks, focus, habits, goals), money and business if present, and the week ahead — 6–9 spoken sentences.",
};
export async function briefing({ loc, kind = "morning" } = {}) {
  const s = getSettings();
  const { facts, weather } = await gatherFacts(kind, { loc });
  if (!client) return { text: `Good ${partOfDay()}, ${title()}. ${facts.join(" ")}`, weather, facts };
  const news = kind === "morning" && s.briefing.sections?.news && config.webSearch;
  const tools = news ? [WEB_SEARCH(2)] : [];
  const messages = [{ role: "user", content: `Facts for the briefing (use only these${news ? " plus news you find with web search, with sources" : ""}; if something is unavailable, say so briefly):\n${facts.join("\n")}\n\nNow: ${localNow(s.timezone)}.\n${BRIEF_STYLE[kind](news)} No lists or headings.` }];
  let text = "", sources = [];
  for (let i = 0; i < 3; i++) {
    const msg = await ai(`briefing:${kind}`, { model: config.model, max_tokens: 4000, system: persona(), tools, messages, output_config: { effort: "low" }, ...FALLBACK });
    messages.push({ role: "assistant", content: msg.content });
    const p = textAndSources(msg.content); text += p.text; sources.push(...p.sources);
    if (msg.stop_reason !== "pause_turn") break;
  }
  return { text: text.trim() || `Good ${partOfDay()}, ${title()}.`, weather, facts, sources, kind };
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
    const msg = await ai("idea", {
      model: config.model, max_tokens: 6000, output_config: { effort: "medium", format: betaZodOutputFormat(IdeaSchema) }, ...FALLBACK,
      messages: [{ role: "user", content: `Give the single best NEW AI app or SaaS idea for a solo founder based in ${place} on a small budget (a few hundred pounds, no team). Favour real paying customers, a fast MVP with light code plus AI APIs, recurring revenue and low regulatory risk. Give: title, a two-sentence pitch, why now, rough budget, exactly three MVP steps, and one concrete first move for this week (under 20 words).
It must differ from all of these (different customer AND problem):\n${previous.slice(0, 200).map((t) => `- ${t}`).join("\n") || "(none)"}` }],
    }, "parse");
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
