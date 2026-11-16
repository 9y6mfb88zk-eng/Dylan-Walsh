import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startMock } from "./mock-upstream.js";

let mock, proc, base, cookie = "";
const PORT = 3999;
const PASS = "letmein";

async function call(p, { method = "GET", body, raw, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, headers: res.headers, data: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

before(async () => {
  mock = await startMock();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
    env: {
      PATH: process.env.PATH, PORT: String(PORT), JARVIS_DATA_DIR: dataDir, JARVIS_PASSCODE: PASS,
      ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: mock.url,
      ELEVENLABS_API_KEY: "test-eleven", ELEVENLABS_BASE_URL: mock.url,
      OPENAI_API_KEY: "test-openai", OPENAI_BASE_URL: mock.url,
      OPEN_METEO_URL: `${mock.url}/v1/forecast`, REMINDER_POLL_SECONDS: "1", IDEAS_ENABLED: "false", NODE_EXTRA_CA_CERTS: mock.caPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.env.DEBUG && process.stdout.write(d));
  proc.stderr.on("data", (d) => process.stderr.write(d));
  base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/api/health")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
});
after(() => { proc?.kill(); mock?.server.close(); });

test("passcode gate protects the API", async () => {
  assert.equal((await call("/api/tasks")).status, 401);
  assert.equal((await call("/api/login", { method: "POST", body: { passcode: "nope" } })).status, 401);
  const ok = await call("/api/login", { method: "POST", body: { passcode: PASS } });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get("set-cookie").split(";")[0];
  const cfg = await call("/api/config");
  assert.equal(cfg.data.authed, true);
  assert.equal(cfg.data.brain, true);
  assert.equal(cfg.data.tts, "elevenlabs");
  assert.equal(cfg.data.stt, true);
  assert.equal(cfg.data.defaultLocation.place, "Dhekelia, Cyprus");
  assert.ok(cfg.data.vapidPublicKey.length > 40);
});

test("PWA assets are served", async () => {
  for (const p of ["/", "/manifest.webmanifest", "/sw.js", "/app.js", "/styles.css", "/icons/icon-192.png", "/icons/apple-touch-icon.png"]) {
    assert.equal((await call(p)).status, 200, p);
  }
  const m = await call("/manifest.webmanifest");
  assert.match(m.headers.get("content-type"), /manifest\+json/);
});

test("weather defaults to Dhekelia and accepts geolocation", async () => {
  const w = await call("/api/weather");
  assert.equal(w.status, 200);
  assert.equal(w.data.place, "Dhekelia, Cyprus");
  assert.equal(w.data.current.temp, 21);
  assert.equal(w.data.current.summary, "mainly clear");
  assert.ok(w.data.hourly.length > 0);
  const w2 = await call("/api/weather?lat=35.17&lon=33.36&place=Nicosia");
  assert.equal(w2.data.place, "Nicosia");
});

test("chat replies in persona, with Opus 5.5, low effort, fallbacks and tools", async () => {
  const r = await call("/api/chat", { method: "POST", body: { text: "Hello JARVIS" } });
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /sir/);
  const req = mock.log.anthropic.at(-1);
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.output_config.effort, "low");
  assert.equal(req.fallbacks, "default");
  assert.match(req.system, /British butler/);
  assert.match(req.system, /Europe\/Nicosia/);
  assert.ok(req.tools.some((t) => t.name === "add_reminder"));
});

test("chat tool use adds a task", async () => {
  const r = await call("/api/chat", { method: "POST", body: { text: "Please add a task to buy halloumi" } });
  assert.deepEqual(r.data.changed, ["tasks"]);
  const tasks = await call("/api/tasks");
  assert.ok(tasks.data.some((t) => t.title === "Buy halloumi"));
  // the tool_result went back to Claude
  const last = mock.log.anthropic.at(-1);
  assert.equal(last.messages.at(-1).content[0].type, "tool_result");
  // and history now carries the turn as context
  const next = await call("/api/chat", { method: "POST", body: { text: "Thanks" } });
  assert.equal(next.status, 200);
  assert.ok(mock.log.anthropic.at(-1).messages.length >= 4);
});

test("reminder set by voice fires a web push server-side", async () => {
  // Subscribe a fake device whose push endpoint is the mock push service.
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const sub = { endpoint: `${mock.pushUrl}/push/device1`, keys: { p256dh: ecdh.getPublicKey("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
  assert.equal((await call("/api/push/subscribe", { method: "POST", body: sub })).status, 200);

  const r = await call("/api/chat", { method: "POST", body: { text: "Remind me in two seconds to stretch" } });
  assert.deepEqual(r.data.changed, ["reminders"]);
  const rem = await call("/api/reminders");
  assert.equal(rem.data.upcoming.length, 1);

  const before = mock.log.push.length;
  for (let i = 0; i < 50 && mock.log.push.length === before; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(mock.log.push.length > before, "push delivered");
  const after = await call("/api/reminders");
  assert.equal(after.data.upcoming.length, 0);
  assert.equal(after.data.recent[0].text, "stretch your legs");
});

test("ideas: generate, no repeats in prompt, add first move to tasks", async () => {
  const a = await call("/api/ideas/generate", { method: "POST" });
  assert.equal(a.status, 201);
  assert.equal(a.data.mvp.length, 3);
  const b = await call("/api/ideas/generate", { method: "POST" });
  assert.equal(b.status, 201);
  const ideaReq = mock.log.anthropic.filter((x) => x.output_config?.format).at(-1);
  assert.match(ideaReq.messages[0].content, new RegExp(a.data.title));
  assert.match(ideaReq.messages[0].content, /Cyprus/);
  const list = await call("/api/ideas");
  assert.equal(list.data.ideas.length, 2);
  const t = await call(`/api/ideas/${a.data.id}/task`, { method: "POST" });
  assert.equal(t.status, 201);
  assert.equal(t.data.title, a.data.first_move);
  assert.equal((await call("/api/ideas")).data.ideas.find((i) => i.id === a.data.id).added_to_tasks, true);
});

test("briefing uses real weather data", async () => {
  const b = await call("/api/briefing");
  assert.equal(b.status, 200);
  assert.match(b.data.text, /sir/);
  assert.equal(b.data.weather.current.temp, 21);
  const req = mock.log.anthropic.at(-1);
  assert.match(req.messages[0].content, /21°C now/);
  assert.match(req.messages[0].content, /Buy halloumi/);
  const job = await call("/api/jobs/briefing", { method: "POST" });
  assert.equal(job.status, 200);
  assert.ok((await call("/api/briefing/latest")).data.text);
});

test("neural TTS streams audio/mpeg from ElevenLabs", async () => {
  const r = await call("/api/tts", { method: "POST", body: { text: "Very good, sir." } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.equal(r.headers.get("x-tts-provider"), "elevenlabs");
  assert.ok(r.data.length > 0);
  assert.equal(mock.log.tts.at(-1).text, "Very good, sir.");
});

test("server-side transcription (Whisper fallback for iPhone)", async () => {
  const r = await call("/api/transcribe", { method: "POST", raw: Buffer.alloc(2000, 1), headers: { "content-type": "audio/mp4" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.text, "What's the weather like?");
  assert.equal(mock.log.stt, 1);
});

test("task CRUD", async () => {
  const t = await call("/api/tasks", { method: "POST", body: { title: "File VAT return" } });
  assert.equal(t.status, 201);
  assert.equal((await call(`/api/tasks/${t.data.id}`, { method: "PATCH", body: { done: true } })).data.done, 1);
  assert.ok(!(await call("/api/tasks")).data.some((x) => x.id === t.data.id));
  assert.ok((await call("/api/tasks?all=1")).data.some((x) => x.id === t.data.id));
  assert.equal((await call(`/api/tasks/${t.data.id}`, { method: "DELETE" })).data.ok, true);
});
