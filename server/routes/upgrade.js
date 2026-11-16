// Routes for the upgrade sections: alarms, notifications, activity, notes, documents, research extras, money extras,
// business, world, automations, focus, goals, habits, smart home, diagnostics, briefings, home dashboard, search,
// and the streaming conversation endpoint.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { db, getSettings, kvGet } from "../db.js";
import { config } from "../config.js";
import { mountCrud } from "../services/crud.js";
import { alarms } from "../services/alarms.js";
import { notifications, recentActivity, logActivity } from "../services/notify.js";
import * as R from "../services/records.js";
import * as money from "../services/money.js";
import { routines, runRoutine, ACTION_TYPES, applyBriefingSetting } from "../services/automations.js";
import * as diagnostics from "../services/diagnostics.js";
import * as smarthome from "../services/smarthome.js";
import { deliverBriefing, briefingHistory, getBriefing } from "../services/briefings.js";
import { tasks, reminders, projects } from "../services/work.js";
import * as calendar from "../services/calendar.js";
import { memory } from "../services/memory.js";
import { chat, client, friendlyAiError, startResearch, brainReady } from "../brain.js";
import { getWeather, geocode } from "../integrations/weather.js";
import { rateLimit } from "../security/ratelimit.js";
import { auditFromReq } from "../security/audit.js";
import { changed, broadcast, sendToDevice } from "../realtime.js";
import { localDate, describeLocal, partOfDay } from "../services/time.js";
import * as finance from "../finance/service.js";
import * as pending from "../services/pending.js";

export const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const raw = (limit) => express.raw({ type: () => true, limit });
const dev = (req) => ({ deviceId: req.auth.deviceId });
const notFound = (res) => res.status(404).json({ error: "Not found" });

// ---------------------------------------------------------------- Streaming conversation (Server-Sent Events)
router.post("/api/chat/stream", rateLimit({ name: "chat", limit: 30, windowMs: 60_000 }), wrap(async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: `Say something, ${getSettings().profile?.title || "Sir"}.` });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const ping = setInterval(() => send({ type: "ping" }), 15_000);
  try {
    const out = await chat({ text, conversationId: req.body?.conversationId, clientId: req.body?.clientId || null, deviceId: req.auth.deviceId, deviceKind: req.auth.kind, loc: req.body?.loc, voice: !!req.body?.voice, onEvent: send });
    send({ type: "done", ...out });
  } catch (e) {
    const err = friendlyAiError(e);
    diagnostics.logError("chat", err.message);
    send({ type: "error", error: err.expose || err.status < 500 ? err.message : "Something unexpected went wrong in JARVIS." });
  } finally { clearInterval(ping); res.end(); }
}));

// ---------------------------------------------------------------- Home (command centre) — one call, real data only
router.get("/api/home", wrap(async (req, res) => {
  const s = getSettings(); const tz = s.timezone; const now = new Date();
  let weather = null, weatherError = null;
  try { weather = await getWeather({ ...s.home, units: s.units }); } catch (e) { weatherError = e.message; }
  const today = localDate(now, tz);
  const dayEnd = new Date(Date.now() + 36 * 3600_000).toISOString();
  const events = calendar.list(new Date(Date.now() - 3600_000).toISOString(), dayEnd);
  const sched = alarms.schedule(48);
  const fin = finance.financeFacts("position");
  res.json({
    now: now.toISOString(), timezone: tz, partOfDay: partOfDay(now, tz), title: s.profile?.title || "Sir", name: s.profile?.name || "",
    location: { place: s.home.place, lat: s.home.lat, lon: s.home.lon },
    ai: { configured: brainReady(), model: config.model },
    weather: weather && { place: weather.place, current: weather.current, today: weather.today, tomorrow: weather.tomorrow, daily: weather.daily, unitTemp: weather.unitTemp, unitWind: weather.unitWind, fetchedAt: weather.fetchedAt, source: weather.source },
    weatherError,
    events: events.slice(0, 12), nextEvent: calendar.nextEvent(now),
    alarms: { next: sched.upcoming.find((a) => !a.snoozed) || null, upcoming: sched.upcoming.slice(0, 5), ringing: sched.ringing },
    tasks: { open: tasks.list().slice(0, 12), overdue: tasks.overdue(), dueToday: tasks.dueToday(), total: tasks.list().length },
    reminders: reminders.upcoming().slice(0, 8),
    projects: projects.list({ includeDone: false }).slice(0, 6).map((p) => ({ id: p.id, title: p.title, kind: p.kind, status: p.status, progress: p.progress, deadline: p.deadline })),
    notifications: { unread: notifications.unreadCount(), latest: notifications.list({ limit: 8 }) },
    activity: recentActivity(10),
    focus: { active: R.focus.active(), stats: R.focus.stats() },
    habits: R.habits.list({ active: true }).map((h) => ({ id: h.id, name: h.name, doneToday: h.doneToday, streak: h.streak, frequency: h.frequency, today: h.today, target: h.target })),
    pending: pending.list(),
    money: fin.connected ? (() => { const p = finance.position(); return { connected: true, testData: fin.testData, available: p.balances.available, projected: p.projectedDisposable, perDay: p.perDay, lastSync: fin.lastSync }; })() : { connected: false, manualEntriesOnly: !!fin.manualEntriesOnly },
    briefing: kvGet("briefing.latest"),
    business: (() => { const b = R.businessSummary(); return { followUps: b.followUps.filter((c) => c.next_follow_up <= today).length, overdueInvoices: b.overdue.length }; })(),
  });
}));

// ---------------------------------------------------------------- Search (Ctrl+K)
router.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q.slice(0, 80)}%`;
  const rows = (sql, map) => db.prepare(sql).all(like, like).map(map);
  res.json([
    ...rows("SELECT id, title, due FROM tasks WHERE (title LIKE ? OR notes LIKE ?) ORDER BY done, id DESC LIMIT 6", (t) => ({ type: "task", id: t.id, title: t.title, sub: t.due ? `Due ${t.due}` : "Task", tab: "tasks" })),
    ...rows("SELECT id, title FROM notes WHERE (title LIKE ? OR body LIKE ?) ORDER BY id DESC LIMIT 6", (n) => ({ type: "note", id: n.id, title: n.title || "Note", sub: "Note", tab: "memory" })),
    ...rows("SELECT id, title FROM projects WHERE (title LIKE ? OR goal LIKE ?) LIMIT 5", (p) => ({ type: "project", id: p.id, title: p.title, sub: "Project", tab: "projects" })),
    ...rows("SELECT id, name, company FROM clients WHERE (name LIKE ? OR company LIKE ?) LIMIT 5", (c) => ({ type: "client", id: c.id, title: c.name, sub: c.company || "Client", tab: "business" })),
    ...calendar.search(q, 5).map((e) => ({ type: "event", id: e.id, title: e.title, sub: e.all_day ? e.start : describeLocal(e.start), tab: "calendar" })),
    ...rows("SELECT id, fact FROM memories WHERE status != 'pending' AND (fact LIKE ? OR category LIKE ?) LIMIT 5", (m) => ({ type: "memory", id: m.id, title: m.fact.slice(0, 90), sub: "Memory", tab: "memory" })),
    ...rows("SELECT id, query FROM research WHERE (query LIKE ? OR report LIKE ?) ORDER BY id DESC LIMIT 4", (r) => ({ type: "research", id: r.id, title: r.query, sub: "Research", tab: "intelligence" })),
    ...rows("SELECT id, label, time FROM alarms WHERE (label LIKE ? OR message LIKE ?) LIMIT 4", (a) => ({ type: "alarm", id: a.id, title: `${a.label} ${a.time}`, sub: "Alarm", tab: "alarms" })),
  ]);
});

// ---------------------------------------------------------------- Alarms
router.get("/api/alarms", (req, res) => res.json({ alarms: alarms.list(), sounds: alarms.sounds(), ringing: alarms.ringing(), defaults: getSettings().alarms }));
router.get("/api/alarms/schedule", (req, res) => res.json(alarms.schedule(Math.min(Number(req.query.hours || 48), 168))));
router.get("/api/alarms/history", (req, res) => res.json(alarms.history(Math.min(Number(req.query.limit || 100), 500))));
router.get("/api/alarms/sounds", (req, res) => res.json(alarms.sounds()));
router.post("/api/alarms/sounds", raw("9mb"), (req, res) => {
  const s = alarms.addSound(req.body, { name: String(req.query.name || "Custom sound"), mime: String(req.headers["content-type"] || "").split(";")[0] });
  auditFromReq(req, "alarm.sound_added", { id: s.id });
  res.status(201).json(s);
});
router.get("/api/alarms/sounds/:id/file", (req, res) => {
  const f = alarms.soundFile(req.params.id);
  if (!f || !fs.existsSync(f.path)) return notFound(res);
  res.setHeader("content-type", f.mime); res.setHeader("cache-control", "private, max-age=86400");
  fs.createReadStream(f.path).pipe(res);
});
router.delete("/api/alarms/sounds/:id", (req, res) => res.json({ ok: alarms.removeSound(req.params.id) }));
router.post("/api/alarms", (req, res) => res.status(201).json(alarms.create(req.body || {}, dev(req))));
router.patch("/api/alarms/:id", (req, res) => { const a = alarms.update(req.params.id, req.body || {}, dev(req)); a ? res.json(a) : notFound(res); });
router.delete("/api/alarms/:id", (req, res) => res.json({ ok: alarms.remove(req.params.id, dev(req)) }));
router.post("/api/alarms/:id/snooze", (req, res) => { const r = alarms.snooze(req.params.id, req.body?.minutes, dev(req)); r ? res.json(r) : notFound(res); });
router.post("/api/alarms/:id/dismiss", (req, res) => { const r = alarms.dismiss(req.params.id, dev(req)); r ? res.json(r) : notFound(res); });
// The Windows agent reports what really happened: it rang, and whether audio was verified playing.
router.post("/api/alarms/:id/rang", (req, res) => { const r = alarms.rang(req.params.id, req.body?.scheduledFor, { deviceId: req.auth.deviceId, detail: req.body?.detail }); r ? res.json(r) : notFound(res); });
router.post("/api/alarms/:id/event", (req, res) => {
  const ev = String(req.body?.event || "");
  if (!["audio_verified", "audio_failed", "test", "spoken"].includes(ev)) return res.status(400).json({ error: "Unknown event" });
  alarms.event(req.params.id === "test" ? 0 : req.params.id, ev, req.body?.detail, dev(req));
  res.json({ ok: true });
});
// "Test alarm": rings on connected Windows apps right now (and records it), without touching your real alarms.
router.post("/api/alarms/test", (req, res) => {
  const d = getSettings().alarms;
  const test = { alarmId: 0, label: "Test alarm", sound: req.body?.sound || d.defaultSound, volume: Number(req.body?.volume ?? d.defaultVolume), gradual: !!(req.body?.gradual ?? false), message: "This is a test of the JARVIS alarm system.", snoozeMinutes: 1, at: new Date().toISOString(), test: true };
  // Rings on the device you pressed it on (the Windows app's agent shares the app's session), or everywhere if asked.
  const msg = { type: "alarm.test", alarm: test, speech: alarms.speech({ label: "Test alarm", message: test.message }) };
  const sent = req.body?.everywhere ? (broadcast(msg), true) : sendToDevice(req.auth.deviceId, msg);
  alarms.event(0, "test", `sound ${test.sound}${req.body?.everywhere ? " (all devices)" : ""}`, dev(req));
  res.json({ ok: true, sent });
});

// ---------------------------------------------------------------- Notifications & activity
router.get("/api/notifications", (req, res) => res.json({ items: notifications.list({ limit: Math.min(Number(req.query.limit || 100), 300), unread: req.query.unread === "1" }), unread: notifications.unreadCount() }));
router.get("/api/notifications/history", (req, res) => res.json(notifications.history(Math.min(Number(req.query.limit || 300), 1000))));
router.post("/api/notifications/read-all", (req, res) => { notifications.markRead("all"); res.json({ ok: true }); });
router.post("/api/notifications/dismiss-all", (req, res) => { notifications.dismiss("all"); res.json({ ok: true }); });
router.post("/api/notifications/:id/read", (req, res) => { notifications.markRead(req.params.id); res.json({ ok: true }); });
router.post("/api/notifications/:id/dismiss", (req, res) => { notifications.dismiss(req.params.id); res.json({ ok: true }); });
router.post("/api/notifications/:id/snooze", (req, res) => res.json({ until: notifications.snooze(req.params.id, req.body?.minutes) }));
router.get("/api/activity", (req, res) => res.json(recentActivity(Math.min(Number(req.query.limit || 50), 300))));

// ---------------------------------------------------------------- Tasks & reminders additions
router.get("/api/tasks/categories", (req, res) => res.json(db.prepare("SELECT category, COUNT(*) AS open FROM tasks WHERE done = 0 GROUP BY category").all()));
router.patch("/api/reminders/:id", (req, res) => { const r = reminders.update(Number(req.params.id), req.body || {}); r ? res.json(r) : notFound(res); });
router.post("/api/reminders/:id/snooze", (req, res) => { const r = reminders.snooze(Number(req.params.id), req.body?.minutes); r ? res.json(r) : notFound(res); });
router.get("/api/calendar/search", (req, res) => res.json(calendar.search(String(req.query.q || ""))));

// ---------------------------------------------------------------- Notes, documents, sources
router.get("/api/notes/search", (req, res) => { const q = `%${String(req.query.q || "").slice(0, 80)}%`; res.json(db.prepare("SELECT * FROM notes WHERE title LIKE ? OR body LIKE ? OR tags LIKE ? ORDER BY pinned DESC, updated_at DESC LIMIT 50").all(q, q, q).map((n) => ({ ...n, pinned: !!n.pinned }))); });
mountCrud(router, "/api/notes", R.notes);
mountCrud(router, "/api/sources", R.savedSources, { listFilters: ["folder"] });
router.get("/api/documents", (req, res) => res.json(R.documents.list(req.query.folder)));
router.post("/api/documents", raw("21mb"), (req, res) => {
  const d = R.documents.add(req.body, { name: String(req.query.name || "document"), mime: String(req.headers["content-type"] || "").split(";")[0], folder: String(req.query.folder || "General") });
  auditFromReq(req, "document.added", { id: d.id });
  res.status(201).json(d);
});
router.get("/api/documents/:id", (req, res) => { const d = R.documents.get(req.params.id); d ? res.json({ ...d, text: d.text.slice(0, 200_000) }) : notFound(res); });
router.get("/api/documents/:id/file", (req, res) => { const d = R.documents.get(req.params.id); if (!d) return notFound(res); res.setHeader("content-type", d.mime); res.setHeader("content-disposition", `inline; filename="${d.name.replace(/"/g, "")}"`); res.send(R.documents.bytes(d)); });
router.delete("/api/documents/:id", (req, res) => { auditFromReq(req, "document.deleted", { id: Number(req.params.id) }); res.json({ ok: R.documents.remove(req.params.id) }); });
// Analysis sends the document to Anthropic: only when the user presses Analyse (explicit authorisation).
router.post("/api/documents/:id/analyze", rateLimit({ name: "docs", limit: 10, windowMs: 10 * 60_000 }), wrap(async (req, res) => {
  const d = R.documents.get(req.params.id);
  if (!d) return notFound(res);
  if (!client) return res.status(503).json({ error: "Document analysis needs an Anthropic API key." });
  const question = String(req.body?.question || "").slice(0, 1000);
  const content = d.mime === "application/pdf"
    ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: R.documents.bytes(d).toString("base64") }, title: d.name }]
    : [{ type: "document", source: { type: "text", media_type: "text/plain", data: d.text.slice(0, 180_000) }, title: d.name }];
  content.push({ type: "text", text: question || "Summarise this document for me: what it is, the key points, any figures, dates, obligations or risks, and anything I need to act on. Be concise and accurate; don't invent anything that isn't in the document." });
  try {
    const msg = await diagnostics.timed("anthropic", { model: config.model, purpose: "document" }, () => client.beta.messages.create({ model: config.model, max_tokens: 4000, messages: [{ role: "user", content }], output_config: { effort: "low" } }));
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (!question) R.documents.setSummary(d.id, text);
    auditFromReq(req, "document.analyzed", { id: d.id });
    logActivity("document", `Document analysed: ${d.name}`, { id: d.id }, req.auth.deviceId);
    res.json({ text, saved: !question });
  } catch (e) { throw friendlyAiError(e); }
}));
router.patch("/api/research/:id", (req, res) => {
  const folder = String(req.body?.folder || "General").slice(0, 80);
  const ok = db.prepare("UPDATE research SET folder = ? WHERE id = ?").run(folder, Number(req.params.id)).changes > 0;
  changed("research"); res.json({ ok });
});
router.post("/api/research/compare", rateLimit({ name: "research", limit: 5, windowMs: 10 * 60_000 }), (req, res) => {
  const items = (Array.isArray(req.body?.items) ? req.body.items : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 5);
  if (items.length < 2) return res.status(400).json({ error: "Give at least two things to compare." });
  const r = startResearch(`Compare ${items.join(" vs ")}${req.body?.criteria ? ` on ${String(req.body.criteria).slice(0, 300)}` : ""}. Give a comparison table in prose, strengths and weaknesses of each, and a clear recommendation with reasons.`);
  db.prepare("UPDATE research SET kind = 'compare', folder = ? WHERE id = ?").run(String(req.body?.folder || "Comparisons").slice(0, 80), r.id);
  res.status(202).json(r);
});

// ---------------------------------------------------------------- Money additions
router.get("/api/finance/report", (req, res) => res.json(money.report({ months: Math.min(Math.max(Number(req.query.months || 6), 2), 24) })));
router.get("/api/finance/manual", (req, res) => res.json(money.manualTransactions()));
router.post("/api/finance/manual", (req, res) => res.status(201).json(money.addManualTransaction(req.body || {}, dev(req))));
router.delete("/api/finance/manual/:id", (req, res) => res.json({ ok: money.removeManualTransaction(req.params.id) }));
router.post("/api/finance/reconcile", (req, res) => res.json(money.reconcileManual()));
router.post("/api/savings-goals/:id/contribute", (req, res) => { const g = money.contributeToGoal(req.params.id, req.body?.amount); g ? res.json(g) : notFound(res); });
mountCrud(router, "/api/savings-goals", R.savingsGoals);
mountCrud(router, "/api/debts", R.debts);

// ---------------------------------------------------------------- Business
router.get("/api/business/summary", (req, res) => res.json(R.businessSummary()));
router.get("/api/clients/:id/interactions", (req, res) => res.json(R.interactions.list({ client_id: req.params.id })));
mountCrud(router, "/api/businesses", R.businesses);
mountCrud(router, "/api/clients", R.clients, { listFilters: ["stage", "business_id"] });
mountCrud(router, "/api/proposals", R.proposals, { listFilters: ["client_id", "status"] });
mountCrud(router, "/api/invoices", R.invoices, { listFilters: ["client_id", "status"] });
mountCrud(router, "/api/expenses", R.expenses, { listFilters: ["business_id"] });
mountCrud(router, "/api/interactions", R.interactions, { listFilters: ["client_id"] });
router.post("/api/proposals/:id/draft", rateLimit({ name: "docs", limit: 10, windowMs: 10 * 60_000 }), wrap(async (req, res) => {
  const p = R.proposals.get(req.params.id);
  if (!p) return notFound(res);
  if (!client) return res.status(503).json({ error: "Drafting needs an Anthropic API key." });
  const c = p.client_id ? R.clients.get(p.client_id) : null;
  try {
    const msg = await diagnostics.timed("anthropic", { model: config.model, purpose: "proposal" }, () => client.beta.messages.create({ model: config.model, max_tokens: 3000, output_config: { effort: "low" },
      messages: [{ role: "user", content: `Draft a clear, professional business proposal titled "${p.title}"${c ? ` for ${c.name}${c.company ? ` of ${c.company}` : ""}` : ""}. Amount: £${(p.amount / 100).toFixed(2)}. Notes from me: ${p.body || "(none)"}${c?.notes ? `\nClient notes: ${c.notes}` : ""}\nSections: summary, scope, deliverables, timeline, price, next steps. Use plain text with short headings. Don't invent facts about the client; leave [placeholders] where details are needed.` }] }));
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    res.json(R.proposals.update(p.id, { body: text }));
  } catch (e) { throw friendlyAiError(e); }
}));

// ---------------------------------------------------------------- World
mountCrud(router, "/api/locations", R.savedLocations);
router.get("/api/world", wrap(async (req, res) => {
  const s = getSettings();
  const places = [{ id: 0, name: s.home.place, lat: s.home.lat, lon: s.home.lon, timezone: s.timezone, home: true }, ...R.savedLocations.list()];
  const out = await Promise.all(places.map(async (p) => {
    let weather = null, error = null;
    if (req.query.weather !== "0") { try { const w = await getWeather({ lat: p.lat, lon: p.lon, place: p.name, units: s.units }); weather = { temp: w.current.temp, summary: w.current.summary, code: w.current.code, isDay: w.current.isDay, high: w.today.high, low: w.today.low, unit: w.unitTemp }; } catch (e) { error = e.message; } }
    return { ...p, localTime: new Date().toLocaleString("en-GB", { timeZone: p.timezone, hour: "2-digit", minute: "2-digit", weekday: "short" }), offset: new Intl.DateTimeFormat("en-GB", { timeZone: p.timezone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((x) => x.type === "timeZoneName")?.value, weather, error };
  }));
  res.json(out);
}));
router.post("/api/locations/lookup", wrap(async (req, res) => res.json(await geocode(String(req.body?.q || "")))));

// ---------------------------------------------------------------- Automations & briefings
router.get("/api/routines", (req, res) => res.json({ routines: routines.list(), actionTypes: ACTION_TYPES, runs: routines.allRuns(30) }));
router.get("/api/routines/:id/runs", (req, res) => res.json(routines.runs(req.params.id)));
router.post("/api/routines/:id/run", wrap(async (req, res) => { auditFromReq(req, "routine.run", { id: Number(req.params.id) }); res.json(await runRoutine(Number(req.params.id), { trigger: req.body?.voice ? "voice" : "manual", deviceId: req.auth.deviceId, confirmed: !!req.body?.confirmed })); }));
// Command macros: "start my working session" → the macro with that trigger phrase (null if none matches).
router.post("/api/macros/match", (req, res) => { const r = routines.matchPhrase(String(req.body?.text || "").slice(0, 200)); res.json(r ? { id: r.id, name: r.name, actions: r.actions } : null); });
// Session history: one timeline across conversations, commands, tasks, diagnostics, errors, automations and decisions.
router.get("/api/history", wrap(async (req, res) => { const h = await import("../services/history.js"); res.json({ kinds: h.HISTORY_KINDS, items: h.sessionHistory({ q: req.query.q || "", kind: req.query.kind || "", limit: req.query.limit, before: req.query.before || "" }) }); }));
router.delete("/api/history/:kind", wrap(async (req, res) => {
  const n = (await import("../services/history.js")).clearHistory(req.params.kind);
  if (n == null) return res.status(400).json({ error: "Conversations, tasks and memories are deleted from their own pages." });
  auditFromReq(req, "history.cleared", { kind: req.params.kind, n }); res.json({ ok: true, deleted: n });
}));
// Local voice commands handled on the device (Mission Control, voice modes) are logged so they appear in session history.
router.post("/api/activity/command", (req, res) => { logActivity("command", String(req.body?.summary || "").slice(0, 200), { text: String(req.body?.text || "").slice(0, 200) }, req.auth.deviceId); res.json({ ok: true }); });
router.post("/api/routines", (req, res) => res.status(201).json(routines.create(req.body || {})));
router.patch("/api/routines/:id", (req, res) => { const r = routines.update(req.params.id, req.body || {}); r ? res.json(r) : notFound(res); });
router.delete("/api/routines/:id", (req, res) => res.json({ ok: routines.remove(req.params.id) }));
router.get("/api/briefings", (req, res) => res.json(briefingHistory(Math.min(Number(req.query.limit || 30), 200))));
router.get("/api/briefings/:id", (req, res) => { const b = getBriefing(req.params.id); b ? res.json(b) : notFound(res); });
router.post("/api/briefings/:kind", rateLimit({ name: "briefing", limit: 6, windowMs: 10 * 60_000 }), wrap(async (req, res) => {
  try { res.json(await deliverBriefing(req.params.kind, { trigger: "manual", loc: req.body?.loc, speak: req.body?.speak !== false })); } catch (e) { throw friendlyAiError(e); }
}));

// ---------------------------------------------------------------- Focus, goals, habits
router.get("/api/focus", (req, res) => res.json({ active: R.focus.active(), stats: R.focus.stats(), history: R.focus.history(30), defaults: getSettings().focus }));
router.post("/api/focus/start", (req, res) => res.status(201).json(R.focus.start(req.body || {})));
router.post("/api/focus/stop", (req, res) => res.json({ stopped: R.focus.stop({ completed: !!req.body?.completed }) }));
mountCrud(router, "/api/goals", R.goals, { listFilters: ["status", "kind"] });
mountCrud(router, "/api/goal-milestones", R.milestones, { listFilters: ["goal_id"] });
router.post("/api/habits/:id/check", (req, res) => { const h = R.habits.check(req.params.id, req.body || {}); h ? res.json(h) : notFound(res); });
mountCrud(router, "/api/habits", R.habits, { listFilters: ["active"] });

// ---------------------------------------------------------------- Smart home
router.get("/api/smarthome", (req, res) => res.json({ configured: smarthome.configured(), status: kvGet("smarthome.status"), devices: smarthome.list() }));
router.post("/api/smarthome/discover", wrap(async (req, res) => res.json(await smarthome.discover())));
router.patch("/api/smarthome/:entity", (req, res) => res.json({ ok: smarthome.setAllowed(req.params.entity, !!req.body?.allowed, dev(req)) }));
router.post("/api/smarthome/:entity/control", wrap(async (req, res) => {
  // Pressing a button in the app is an explicit action; security devices still need `confirmed: true` from a dialog.
  res.json(await smarthome.control(req.params.entity, String(req.body?.service || ""), req.body?.data || {}, { ...dev(req), confirmed: !!req.body?.confirmed }));
}));

// ---------------------------------------------------------------- Diagnostics
router.get("/api/diagnostics", wrap(async (req, res) => res.json(await diagnostics.runDiagnostics())));
router.get("/api/diagnostics/history", (req, res) => res.json(diagnostics.history({ check: req.query.check, hours: Math.min(Number(req.query.hours || 24), 336) })));
router.get("/api/diagnostics/logs", (req, res) => res.json(diagnostics.logs(Math.min(Number(req.query.limit || 200), 1000))));
router.get("/api/diagnostics/ai", (req, res) => res.json(diagnostics.aiMetrics(Math.min(Number(req.query.hours || 24), 720))));
router.post("/api/diagnostics/test/:check", rateLimit({ name: "diagtest", limit: 20, windowMs: 60_000 }), wrap(async (req, res) => {
  if (!diagnostics.TESTABLE.includes(req.params.check)) return res.status(404).json({ error: "No test for that" });
  res.json(await diagnostics.testCheck(req.params.check, { client }));
}));
// Narrated diagnostic levels (quick, full, voice, ai, network, security, performance, hardware, integrations) and their history.
router.post("/api/diagnostics/run", rateLimit({ name: "diagrun", limit: 10, windowMs: 60_000 }), wrap(async (req, res) => {
  const { runLevel, LEVELS } = await import("../services/narrator.js");
  const level = String(req.body?.level || req.query.level || "quick");
  if (!LEVELS[level]) return res.status(400).json({ error: `Unknown level. Choose: ${Object.keys(LEVELS).join(", ")}` });
  res.json(await runLevel(level, { client }));
}));
router.get("/api/diagnostics/runs", wrap(async (req, res) => res.json((await import("../services/narrator.js")).diagnosticHistory(Math.min(Number(req.query.limit || 30), 200)))));
router.get("/api/performance", wrap(async (req, res) => res.json(await (await import("../services/narrator.js")).performanceMetrics())));
router.get("/api/awareness", wrap(async (req, res) => res.json(await (await import("../services/narrator.js")).systemAwareness())));
// Desktop-side checks (microphone level, speaker test, wake word, alarm audio) are posted here so they appear in history.
router.post("/api/diagnostics/report", (req, res) => {
  const name = String(req.body?.check || "").slice(0, 40), status = ["ok", "warn", "error", "off", "unknown"].includes(req.body?.status) ? req.body.status : "unknown";
  if (!name) return res.status(400).json({ error: "check required" });
  db.prepare("INSERT INTO diag_history (check_name, status, latency_ms, detail) VALUES (?, ?, ?, ?)").run(`desktop:${name}`, status, Number.isFinite(+req.body?.latencyMs) ? Math.round(+req.body.latencyMs) : null, String(req.body?.detail || "").slice(0, 300));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Settings: briefing time ↔ morning routine
export function onSettingsChanged(patch) {
  if (patch.briefing && (patch.briefing.time || patch.briefing.enabled !== undefined)) applyBriefingSetting(patch.briefing);
  if (patch.timezone) Promise.all([import("../services/alarms.js"), import("../services/automations.js")]).then(([a, b]) => { a.recomputeAll(); b.recomputeRoutines(); changed("alarms", "routines"); });
}
void memory;

// ---------------------------------------------------------------- Your data: export everything / delete by category (backup first)
const EXPORT_TABLES = ["tasks", "reminders", "projects", "milestones", "events", "memories", "notes", "documents", "saved_sources", "research", "ideas", "alarms", "alarm_events",
  "savings_goals", "debts", "bills", "budgets", "businesses", "clients", "proposals", "invoices", "business_expenses", "interactions", "saved_locations", "routines", "routine_runs",
  "focus_sessions", "goals", "goal_milestones", "habits", "habit_checks", "briefings", "notifications", "activity", "conversations", "messages"];
router.get("/api/export", (req, res) => {
  const out = { exportedAt: new Date().toISOString(), app: "JARVIS", settings: getSettings(), tables: {} };
  for (const t of EXPORT_TABLES) { try { out.tables[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch {} }
  // Hand-entered money only (bank data stays with the bank); never tokens or passwords.
  try { out.tables.manual_transactions = db.prepare("SELECT * FROM fin_transactions WHERE account_id = 'manual-entries'").all(); } catch {}
  auditFromReq(req, "data.exported");
  res.setHeader("content-disposition", `attachment; filename="jarvis-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(out);
});
const WIPE = {
  conversations: ["messages", "conversations"], memories: ["memories"], notes: ["notes"], documents: ["documents"], research: ["saved_sources", "research", "ideas"],
  tasks: ["tasks", "reminders"], alarms: ["alarm_events", "alarms", "alarm_sounds"], money: ["savings_goals", "debts"], business: ["interactions", "invoices", "proposals", "business_expenses", "clients", "businesses"],
  productivity: ["habit_checks", "habits", "goal_milestones", "goals", "focus_sessions"], activity: ["notifications", "activity", "briefings"],
};
router.post("/api/data/wipe", (req, res) => {
  const scope = String(req.body?.scope || "");
  if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: "Confirmation missing" });
  const scopes = scope === "everything" ? Object.keys(WIPE) : WIPE[scope] ? [scope] : null;
  if (!scopes) return res.status(400).json({ error: "Unknown category" });
  const dir = path.join(config.dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const backup = `pre-delete-${scope}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
  db.exec(`VACUUM INTO '${path.join(dir, backup).replace(/'/g, "''")}'`);
  let rows = 0;
  db.exec("BEGIN");
  try {
    for (const s of scopes) for (const t of WIPE[s]) rows += db.prepare(`DELETE FROM ${t}`).run().changes;
    if (scopes.includes("money")) rows += db.prepare("DELETE FROM fin_transactions WHERE account_id = 'manual-entries'").run().changes;
    if (scopes.includes("conversations")) db.prepare("DELETE FROM kv WHERE k = 'currentConversation'").run();
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  if (scopes.includes("documents")) { try { for (const f of fs.readdirSync(path.join(config.dataDir, "documents"))) fs.unlinkSync(path.join(config.dataDir, "documents", f)); } catch {} }
  if (scopes.includes("alarms")) { try { for (const f of fs.readdirSync(path.join(config.dataDir, "sounds"))) fs.unlinkSync(path.join(config.dataDir, "sounds", f)); } catch {} }
  auditFromReq(req, "data.deleted", { scope, rows });
  changed("tasks", "reminders", "notes", "memories", "alarms", "business", "finance", "habits", "goals", "focus", "notifications", "activity", "research", "documents", "conversations", "briefing");
  res.json({ ok: true, rows, backup });
});
