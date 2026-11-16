import express from "express";
import { config } from "../config.js";
import { db, kvGet, getSettings, updateSettings, pushSubs } from "../db.js";
import { tasks, reminders, projects } from "../services/work.js";
import { conversations } from "../services/conversations.js";
import { memory } from "../services/memory.js";
import * as pending from "../services/pending.js";
import { healthReport } from "../services/health.js";
import { runComputerAction } from "../services/computer.js";
import { getWeather, geocode } from "../integrations/weather.js";
import { streamTTS, transcribe } from "../voice.js";
import { chat, briefing, startResearch, friendlyAiError } from "../brain.js";
import { notifyAll } from "../push.js";
import { runIdeaJob, runBriefingJob, fireDueReminders, backup } from "../scheduler.js";
import { tracked } from "../services/health.js";
import { desktopAgents, connectedDevices, changed } from "../realtime.js";
import { auditFromReq } from "../security/audit.js";
import { rateLimit } from "../security/ratelimit.js";
import { connections } from "../services/oauth.js";
import { ACTIONS, APPS, FOLDERS } from "../shared/computer-actions.js";
import { localAsrStatus } from "../local-asr.js";
import { onSettingsChanged } from "./upgrade.js";

export const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = (req) => Number(req.params.id);

// ---------------- Conversation
router.post("/api/chat", rateLimit({ name: "chat", limit: 30, windowMs: 60_000 }), wrap(async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: "Say something, sir." });
  try { res.json(await chat({ text, conversationId: req.body?.conversationId, clientId: req.body?.clientId || null, deviceId: req.auth.deviceId, deviceKind: req.auth.kind, loc: req.body?.loc })); }
  catch (e) { throw friendlyAiError(e); }
}));
router.get("/api/conversations", (req, res) => res.json({ current: conversations.currentId(), list: conversations.list() }));
router.get("/api/conversations/:cid/messages", (req, res) => res.json(conversations.messages(req.params.cid, { afterId: Number(req.query.after || 0), limit: Math.min(Number(req.query.limit || 100), 300) })));
router.post("/api/conversations", (req, res) => res.status(201).json(conversations.create()));
router.post("/api/conversations/:cid/current", (req, res) => res.json({ ok: conversations.setCurrent(req.params.cid) }));
router.delete("/api/conversations/:cid", (req, res) => { conversations.remove(req.params.cid); auditFromReq(req, "conversation.deleted"); res.json({ ok: true }); });

router.get("/api/briefing", wrap(async (req, res) => {
  try { res.json(await briefing({ loc: req.query.lat ? { lat: +req.query.lat, lon: +req.query.lon, place: req.query.place } : null })); } catch (e) { throw friendlyAiError(e); }
}));
router.get("/api/briefing/latest", (req, res) => res.json(kvGet("briefing.latest") || null));

// ---------------- Voice
router.post("/api/tts", rateLimit({ name: "tts", limit: 60, windowMs: 60_000 }), wrap(async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 2500);
  if (!text) return res.status(400).json({ error: "No text" });
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ac.abort(); });
  await streamTTS(text, res, ac.signal);
}));
const sttLimit = rateLimit({ name: "stt", limit: 40, windowMs: 60_000 }), partialLimit = rateLimit({ name: "stt-partial", limit: 90, windowMs: 60_000 });
router.post("/api/transcribe", (req, res, next) => (req.headers["x-partial"] === "1" ? partialLimit : sttLimit)(req, res, next), express.raw({ type: () => true, limit: "15mb" }), wrap(async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: "No audio" });
  const partial = req.headers["x-partial"] === "1";
  res.json({ text: await transcribe(req.body, req.headers["content-type"] || "audio/webm", { localOnly: partial }), partial });
}));

// ---------------- Weather & settings
router.get("/api/weather", wrap(async (req, res) => {
  const s = getSettings();
  const loc = req.query.lat ? { lat: +req.query.lat, lon: +req.query.lon, place: req.query.place || "Current location" } : s.home;
  res.json(await getWeather({ ...loc, units: s.units }));
}));
router.get("/api/geocode", wrap(async (req, res) => res.json(await geocode(req.query.q || ""))));
router.get("/api/settings", (req, res) => res.json(getSettings()));
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
router.patch("/api/settings", (req, res) => {
  const allowed = ["home", "units", "briefing", "ideas", "finance", "memory", "computer", "timezone", "profile", "voice", "personality", "appearance", "alarms", "notifications", "focus"];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if (patch.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: patch.timezone }); } catch { return res.status(400).json({ error: "Unknown time zone" }); } }
  if (patch.home && !(Number.isFinite(+patch.home.lat) && Number.isFinite(+patch.home.lon))) return res.status(400).json({ error: "Home needs lat and lon" });
  if (patch.briefing?.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.briefing.time)) return res.status(400).json({ error: "Briefing time must be HH:MM" });
  if (patch.profile) patch.profile = Object.fromEntries(Object.entries(patch.profile).filter(([k]) => ["name", "title", "city", "country"].includes(k)).map(([k, v]) => [k, String(v ?? "").trim().slice(0, 60)]));
  if (patch.profile?.title === "") patch.profile.title = "Sir";
  if (patch.voice) {
    const v = patch.voice;
    if (v.timeoutSec !== undefined) v.timeoutSec = clamp(v.timeoutSec, 3, 60, 8);
    if (v.stayWithMeSec !== undefined) v.stayWithMeSec = clamp(v.stayWithMeSec, 30, 900, 120);
    if (v.rate !== undefined) v.rate = clamp(v.rate, 0.6, 1.6, 1);
    if (v.voiceName !== undefined) v.voiceName = String(v.voiceName).slice(0, 120);
  }
  if (patch.alarms) {
    const a = patch.alarms;
    if (a.defaultVolume !== undefined) a.defaultVolume = clamp(a.defaultVolume, 5, 100, 80);
    if (a.snoozeMinutes !== undefined) a.snoozeMinutes = clamp(Math.round(a.snoozeMinutes), 1, 60, 10);
  }
  if (patch.focus) for (const k of ["workMinutes", "breakMinutes"]) if (patch.focus[k] !== undefined) patch.focus[k] = clamp(Math.round(patch.focus[k]), 1, 240, k === "workMinutes" ? 25 : 5);
  if (patch.appearance?.animation && !["full", "reduced", "off"].includes(patch.appearance.animation)) return res.status(400).json({ error: "Animation must be full, reduced or off" });
  const s = updateSettings(patch);
  onSettingsChanged(patch);
  auditFromReq(req, "settings.changed", { keys: Object.keys(patch) });
  changed("settings");
  res.json(s);
});

// ---------------- Tasks, reminders, projects
router.get("/api/tasks", (req, res) => res.json(tasks.list({ includeDone: req.query.all === "1", projectId: req.query.project ? Number(req.query.project) : undefined, category: req.query.category || undefined })));
router.post("/api/tasks", (req, res) => res.status(201).json(tasks.add({ ...req.body, projectId: req.body?.projectId, clientId: req.body?.clientId })));
router.patch("/api/tasks/:id", (req, res) => { const t = tasks.update(id(req), req.body || {}); t ? res.json(t) : res.status(404).json({ error: "Not found" }); });
router.delete("/api/tasks/:id", (req, res) => res.json({ ok: tasks.remove(id(req)) }));

router.get("/api/reminders", (req, res) => res.json({ upcoming: reminders.upcoming(), recent: reminders.recent() }));
router.post("/api/reminders", (req, res) => res.status(201).json(reminders.add({ text: req.body?.text, due_at: req.body?.due_at, clientId: req.body?.clientId, repeat: req.body?.repeat || "none" })));
router.delete("/api/reminders/:id", (req, res) => res.json({ ok: reminders.remove(id(req)) }));

router.get("/api/projects", (req, res) => res.json(projects.list()));
router.get("/api/projects/:id", (req, res) => { const p = projects.get(id(req)); p ? res.json(p) : res.status(404).json({ error: "Not found" }); });
router.get("/api/projects/:id/report", (req, res) => res.json(projects.report(id(req))));
router.post("/api/projects", (req, res) => res.status(201).json(projects.create(req.body || {})));
router.patch("/api/projects/:id", (req, res) => res.json(projects.update(id(req), req.body || {})));
router.delete("/api/projects/:id", (req, res) => res.json({ ok: projects.remove(id(req)) }));
router.post("/api/projects/:id/milestones", (req, res) => res.status(201).json(projects.addMilestone(id(req), req.body || {})));
router.patch("/api/milestones/:id", (req, res) => res.json(projects.setMilestoneDone(id(req), !!req.body?.done)));

// ---------------- Memory
router.get("/api/memories", (req, res) => res.json(memory.list()));
router.get("/api/memories/search", wrap(async (req, res) => res.json(await memory.search(req.query.q || "", 20))));
router.post("/api/memories", wrap(async (req, res) => res.status(201).json(await memory.save({ ...req.body, source: "user", approved: true }))));
router.patch("/api/memories/:id", wrap(async (req, res) => res.json(await memory.update(id(req), req.body || {}))));
router.post("/api/memories/:id/approve", (req, res) => { auditFromReq(req, "memory.approved", { id: id(req) }); res.json({ ok: memory.approve(id(req)) }); });
router.delete("/api/memories/:id", (req, res) => { auditFromReq(req, "memory.deleted", { id: id(req) }); res.json({ ok: memory.remove(id(req)) }); });
router.delete("/api/memories", (req, res) => { memory.removeAll(); auditFromReq(req, "memory.deleted_all"); res.json({ ok: true }); });
router.get("/api/memories/export", (req, res) => {
  auditFromReq(req, "memory.exported");
  res.setHeader("content-disposition", `attachment; filename="jarvis-memories-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(memory.export());
});

// ---------------- Ideas & research
router.get("/api/ideas", (req, res) => res.json({ ideas: db.prepare("SELECT * FROM ideas ORDER BY id DESC LIMIT 60").all().map((i) => ({ ...i, mvp: JSON.parse(i.mvp), added_to_tasks: !!i.added_to_tasks })), lastRun: kvGet("ideas.lastRun", 0), settings: getSettings().ideas }));
router.post("/api/ideas/generate", wrap(async (req, res) => {
  const idea = await runIdeaJob({ force: true });
  idea ? res.status(201).json(idea) : res.status(409).json({ error: "No new idea right now (busy, too similar, or no AI key)." });
}));
router.post("/api/ideas/:id/task", (req, res) => {
  const i = db.prepare("SELECT * FROM ideas WHERE id = ?").get(id(req));
  if (!i) return res.status(404).json({ error: "Not found" });
  const t = tasks.add({ title: i.first_move, notes: `From idea: ${i.title}`, source: `idea:${i.id}` });
  db.prepare("UPDATE ideas SET added_to_tasks = 1 WHERE id = ?").run(i.id);
  changed("ideas");
  res.status(201).json(t);
});
router.delete("/api/ideas/:id", (req, res) => { db.prepare("DELETE FROM ideas WHERE id = ?").run(id(req)); changed("ideas"); res.json({ ok: true }); });
router.get("/api/research", (req, res) => res.json(db.prepare("SELECT * FROM research ORDER BY id DESC LIMIT 50").all().map((r) => ({ ...r, sources: JSON.parse(r.sources) }))));
router.post("/api/research", rateLimit({ name: "research", limit: 5, windowMs: 10 * 60_000 }), (req, res) => {
  const q = String(req.body?.query || "").trim();
  if (!q) return res.status(400).json({ error: "What should I research?" });
  res.status(202).json(startResearch(q));
});
router.delete("/api/research/:id", (req, res) => { db.prepare("DELETE FROM research WHERE id = ?").run(id(req)); changed("research"); res.json({ ok: true }); });

// ---------------- Confirmations
router.get("/api/pending", (req, res) => res.json(pending.list()));
router.post("/api/pending/:pid", wrap(async (req, res) => res.json(await pending.decide(req.params.pid, req.body?.decision === "confirm" ? "confirm" : "reject", { deviceId: req.auth.deviceId }))));

// ---------------- Computer (manual trigger from the UI uses the same allowlist)
router.get("/api/computer", (req, res) => res.json({ actions: ACTIONS, apps: Object.fromEntries(Object.entries(APPS).map(([k, v]) => [k, v.label])), folders: FOLDERS, desktops: desktopAgents() }));
router.post("/api/computer", rateLimit({ name: "computer", limit: 20, windowMs: 60_000 }), wrap(async (req, res) => res.json(await runComputerAction(req.body?.action, req.body?.args || {}, { requestedBy: req.auth.deviceId }))));

// ---------------- Push
router.post("/api/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !/^https:\/\//.test(sub.endpoint)) return res.status(400).json({ error: "Invalid subscription" });
  pushSubs.add(sub, req.auth.deviceId);
  res.json({ ok: true });
});
router.post("/api/push/unsubscribe", (req, res) => { if (req.body?.endpoint) pushSubs.remove(req.body.endpoint); res.json({ ok: true }); });
router.post("/api/push/test", wrap(async (req, res) => res.json({ sent: await notifyAll({ title: "JARVIS", body: `Notifications are working, ${getSettings().profile?.title || "Sir"}.`, tag: "test", url: "/" }) })));

// ---------------- Health
router.get("/api/health", (req, res) => {
  const conns = connections.all().map(connections.view);
  res.json({
    server: { ok: true, uptime: Math.round(process.uptime()), version: process.env.JARVIS_VERSION || process.env.npm_package_version || "4.0.0", env: config.env, node: process.version, hosting: config.hosting },
    services: healthReport(),
    desktops: desktopAgents(),
    connectedDevices: connectedDevices().length,
    integrations: {
      ai: { configured: !!config.anthropicKey, model: config.model },
      voice: { tts: config.elevenKey ? "elevenlabs" : config.openaiKey ? "openai" : null, stt: !!config.openaiKey || localAsrStatus().available, sttLocal: localAsrStatus() },
      monzo: { configured: !!(config.monzoClientId && config.monzoClientSecret), connection: conns.find((c) => c.provider === "monzo") || null },
      google: { configured: !!(config.googleClientId && config.googleClientSecret), connection: conns.find((c) => c.provider === "google") || null },
      webSearch: config.webSearch,
    },
    backup: kvGet("backup.last"),
  });
});
router.post("/api/jobs/:job", wrap(async (req, res) => {
  const jobs = { backup: () => tracked("backup", backup), reminders: fireDueReminders, briefing: () => runBriefingJob({ kind: req.body?.kind || "morning" }), ideas: () => runIdeaJob({ force: true }) };
  if (!jobs[req.params.job]) return res.status(404).json({ error: "Unknown job" });
  res.json((await jobs[req.params.job]()) ?? null);
}));
