import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, ttsProvider } from "./config.js";
import { tasks, reminders, ideas, memories, history, pushSubs, kvGet, kvSet } from "./db.js";
import { vapidPublicKey, notifyAll } from "./push.js";
import { getWeather } from "./weather.js";
import { streamTTS, transcribe } from "./voice.js";
import { chat, briefing, brainReady } from "./brain.js";
import { startScheduler, runIdeaJob, runBriefingJob, fireDueReminders } from "./scheduler.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "100kb" }));

// ---------------- Auth (optional single passcode)
const secret = kvGet("cookieSecret") || (() => { const s = crypto.randomBytes(32).toString("hex"); kvSet("cookieSecret", s); return s; })();
const token = crypto.createHmac("sha256", secret).update(`jarvis:${config.passcode}`).digest("hex");
const cookieOf = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const authed = (req) => !config.passcode || cookieOf(req).jarvis === token;

app.post("/api/login", (req, res) => {
  const given = String(req.body?.passcode || "");
  const ok = config.passcode && given.length === config.passcode.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(config.passcode));
  if (!ok) return res.status(401).json({ error: "Incorrect passcode" });
  res.setHeader("set-cookie", `jarvis=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true });
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (req, res) => res.json({
  authRequired: !!config.passcode, authed: authed(req),
  brain: brainReady(), tts: ttsProvider(), stt: !!config.openaiKey,
  vapidPublicKey, userName: config.userName, timezone: config.timezone,
  defaultLocation: { lat: config.defaultLat, lon: config.defaultLon, place: config.defaultPlace },
  ideasEveryMinutes: config.ideasEveryMinutes, briefingTime: config.briefingTime,
}));
app.use("/api", (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: "Passcode required" })));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const idParam = (req) => Number(req.params.id);
function locFrom(src) {
  const lat = Number(src?.lat), lon = Number(src?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, place: src.place || "your location" };
  return kvGet("lastLocation") || { lat: config.defaultLat, lon: config.defaultLon, place: config.defaultPlace };
}

// ---------------- Conversation
app.post("/api/chat", wrap(async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: "Say something, sir." });
  res.json(await chat(text, locFrom(req.body?.loc)));
}));
app.post("/api/history/clear", (_req, res) => { history.clear(); res.json({ ok: true }); });

app.get("/api/briefing", wrap(async (req, res) => {
  const b = await briefing(locFrom(req.query));
  kvSet("briefing.latest", { text: b.text, at: new Date().toISOString() });
  res.json(b);
}));
app.get("/api/briefing/latest", (_req, res) => res.json(kvGet("briefing.latest") || null));

// ---------------- Voice
app.post("/api/tts", wrap(async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 2500);
  if (!text) return res.status(400).json({ error: "No text" });
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ac.abort(); });
  await streamTTS(text, res, ac.signal);
}));
app.post("/api/transcribe", express.raw({ type: () => true, limit: "15mb" }), wrap(async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: "No audio" });
  res.json({ text: await transcribe(req.body, req.headers["content-type"] || "audio/webm") });
}));

// ---------------- Location & weather
app.post("/api/location", (req, res) => {
  const loc = locFrom(req.body);
  kvSet("lastLocation", loc);
  res.json(loc);
});
app.get("/api/weather", wrap(async (req, res) => {
  const loc = locFrom(req.query);
  res.json(await getWeather(loc.lat, loc.lon, loc.place));
}));

// ---------------- Tasks
app.get("/api/tasks", (req, res) => res.json(tasks.list({ includeDone: req.query.all === "1" })));
app.post("/api/tasks", (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "Title required" });
  res.status(201).json(tasks.add({ title, notes: req.body.notes || "", due: req.body.due || null }));
});
app.patch("/api/tasks/:id", (req, res) => {
  const t = tasks.get(idParam(req));
  if (!t) return res.status(404).json({ error: "Not found" });
  res.json(typeof req.body?.done === "boolean" ? tasks.setDone(t.id, req.body.done) : t);
});
app.delete("/api/tasks/:id", (req, res) => res.json({ ok: tasks.remove(idParam(req)) }));

// ---------------- Reminders
app.get("/api/reminders", (_req, res) => res.json({ upcoming: reminders.upcoming(), recent: reminders.recent() }));
app.post("/api/reminders", (req, res) => {
  const text = String(req.body?.text || "").trim();
  const d = new Date(req.body?.due_at);
  if (!text || Number.isNaN(d.getTime())) return res.status(400).json({ error: "text and valid due_at required" });
  res.status(201).json(reminders.add({ text, due_at: d.toISOString() }));
});
app.delete("/api/reminders/:id", (req, res) => res.json({ ok: reminders.remove(idParam(req)) }));

// ---------------- Ideas
app.get("/api/ideas", (_req, res) => res.json({ ideas: ideas.list(), lastRun: kvGet("ideas.lastRun", 0), everyMinutes: config.ideasEveryMinutes }));
app.post("/api/ideas/generate", wrap(async (_req, res) => {
  if (!brainReady()) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
  const idea = await runIdeaJob({ force: true });
  idea ? res.status(201).json(idea) : res.status(409).json({ error: "No new idea (busy or too similar) — try again shortly" });
}));
app.post("/api/ideas/:id/task", (req, res) => {
  const i = ideas.get(idParam(req));
  if (!i) return res.status(404).json({ error: "Not found" });
  const t = tasks.add({ title: i.first_move, notes: `From idea: ${i.title}`, source: `idea:${i.id}` });
  ideas.markAdded(i.id);
  res.status(201).json(t);
});
app.delete("/api/ideas/:id", (req, res) => res.json({ ok: ideas.remove(idParam(req)) }));

// ---------------- Memory
app.get("/api/memories", (_req, res) => res.json(memories.list()));
app.delete("/api/memories/:id", (req, res) => res.json({ ok: memories.remove(idParam(req)) }));

// ---------------- Push
app.post("/api/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh) return res.status(400).json({ error: "Invalid subscription" });
  pushSubs.add(sub);
  res.json({ ok: true });
});
app.post("/api/push/unsubscribe", (req, res) => { if (req.body?.endpoint) pushSubs.remove(req.body.endpoint); res.json({ ok: true }); });
app.post("/api/push/test", wrap(async (_req, res) => {
  const sent = await notifyAll({ title: "JARVIS", body: "Notifications are working, sir.", tag: "test", url: "/" });
  res.json({ sent });
}));

// Dev/test hooks to run jobs on demand
app.post("/api/jobs/reminders", wrap(async (_req, res) => res.json({ fired: await fireDueReminders() })));
app.post("/api/jobs/briefing", wrap(async (_req, res) => res.json(await runBriefingJob({ force: true }))));

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error("[error]", err.status || "", err.message);
  res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message || "Internal error" });
});

// ---------------- Static PWA
app.use(express.static(path.join(here, "..", "public"), {
  setHeaders(res, file) {
    if (file.endsWith("sw.js")) { res.setHeader("cache-control", "no-cache"); res.setHeader("service-worker-allowed", "/"); }
    if (file.endsWith(".webmanifest")) res.setHeader("content-type", "application/manifest+json");
  },
}));
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(here, "..", "public", "index.html")));

const server = app.listen(config.port, () => {
  console.log(`JARVIS listening on http://localhost:${config.port}`);
  console.log(`  brain: ${brainReady() ? config.model : "OFF (set ANTHROPIC_API_KEY)"} | tts: ${ttsProvider() || "browser voices"} | stt fallback: ${config.openaiKey ? "Whisper" : "OFF (set OPENAI_API_KEY)"} | passcode: ${config.passcode ? "on" : "OFF"}`);
});
const stop = startScheduler();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop(); server.close(() => process.exit(0)); });
