// Start-up checks (JARVIS 6.4): every check does real work and reports an honest status.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-upstream.js";
import { startServer, Device } from "./helpers.js";

let mock, srv, d;
before(async () => {
  mock = await startMock(); srv = await startServer(mock);
  d = new Device(srv.base, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JARVIS-Desktop/6.4 Electron/33");
  assert.equal((await d.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "correct horse battery" } })).status, 201);
});
after(async () => { await srv?.stop(); mock?.server.close(); });

const STATUSES = ["operational", "connected", "degraded", "not_configured", "permission_required", "offline", "failed", "initialising"];

test("the start-up list names every server-side check and the real version", async () => {
  const r = (await d.call("/api/boot")).data;
  assert.equal(r.version, "6.5.0");
  assert.deepEqual(r.checks.map((c) => c.name), ["runtime", "os", "hardware", "database", "storage", "ai", "stt", "tts", "scheduler", "notifications", "weather", "calendar"]);
  assert.deepEqual(r.checks.filter((c) => c.critical).map((c) => c.name), ["runtime", "database", "storage"]);
});

test("each check returns a real result with an allowed status", async () => {
  const names = (await d.call("/api/boot")).data.checks.map((c) => c.name);
  const res = {};
  for (const n of names) { const r = (await d.call(`/api/boot/check/${n}`)).data; assert.ok(STATUSES.includes(r.status), `${n}: ${r.status}`); assert.ok(r.detail, `${n} explains itself`); assert.ok(r.ms >= 0); res[n] = r; }
  assert.equal(res.database.status, "operational"); assert.match(res.database.detail, /schema 00\d/);
  assert.equal(res.storage.status, "operational"); assert.match(res.storage.detail, /writable/);
  assert.equal(res.ai.status, "connected"); assert.match(res.ai.detail, /responded in \d+ ms/);
  assert.equal(res.weather.status, "connected", "the weather service really answered");
  assert.equal(res.calendar.status, "operational"); assert.match(res.calendar.detail, /Google not connected/);
  assert.match(res.hardware.detail, /cores · .* · CPU \d+% · memory \d+%/);
  assert.notEqual(res.tts.status, "connected", "the stand-in voice service rejects the key, so it must not say connected");
  assert.equal((await d.call("/api/boot/check/nonsense")).status, 404);
});

test("an AI that fails is reported as failed or offline, never connected", async () => {
  const saved = mock.state.anthropicDown; mock.state.anthropicDown = true;
  try {
    const r = (await d.call("/api/boot/check/ai")).data;
    assert.ok(["failed", "offline"].includes(r.status), `${r.status}: ${r.detail}`);
  } finally { mock.state.anthropicDown = saved; }
});

test("startup and performance settings are validated and saved", async () => {
  assert.equal((await d.call("/api/settings", { method: "PATCH", body: { startup: { screen: "fireworks" } } })).status, 400);
  assert.equal((await d.call("/api/settings", { method: "PATCH", body: { appearance: { quality: "ultra" } } })).status, 400);
  await d.call("/api/settings", { method: "PATCH", body: { startup: { screen: "minimal", volume: 7, sound: 0, evil: 1 }, appearance: { quality: "medium", particles: 9, bloom: -1, updates: "reduced", mapQuality: "low" } } });
  const s = (await d.call("/api/settings")).data;
  assert.equal(s.startup.screen, "minimal"); assert.equal(s.startup.volume, 1, "volume clamped"); assert.equal(s.startup.sound, false); assert.equal(s.startup.evil, undefined);
  assert.equal(s.startup.fullDiagnostics, true, "unchanged defaults kept");
  assert.equal(s.appearance.quality, "medium"); assert.equal(s.appearance.particles, 1.5); assert.equal(s.appearance.bloom, 0); assert.equal(s.appearance.updates, "reduced"); assert.equal(s.appearance.mapQuality, "low");
});
