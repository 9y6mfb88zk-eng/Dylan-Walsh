// Personal intelligence, narrated diagnostics and system awareness — the real backend against the stand-in upstream services.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-upstream.js";
import { startServer, Device, waitFor } from "./helpers.js";

let mock, srv, laptop;
before(async () => {
  mock = await startMock();
  srv = await startServer(mock);
  laptop = new Device(srv.base, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JARVIS-Desktop/4.0 Electron/33");
  assert.equal((await laptop.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "correct horse battery" } })).status, 201);
});
after(async () => { await srv?.stop(); mock?.server.close(); });

async function stream(text) {
  const res = await fetch(srv.base + "/api/chat/stream", { method: "POST", headers: { "content-type": "application/json", cookie: laptop.cookie, "x-jarvis": "1" }, body: JSON.stringify({ text }) });
  const out = [];
  for (const chunk of (await res.text()).split("\n\n")) { const l = chunk.split("\n").find((x) => x.startsWith("data: ")); if (l) out.push(JSON.parse(l.slice(6))); }
  return out.find((e) => e.type === "done")?.reply || out.find((e) => e.type === "error")?.error;
}

test("the starting profile is seeded once, editable, and pinned — and KILL HOUSE exists as a creative project", async () => {
  const prof = await waitFor(async () => { const r = (await laptop.call("/api/memories/profile")).data; return r.preference?.length === 3 ? r : null; }, 8000);
  assert.match(prof.business[0].fact, /website design agency/);
  assert.ok(prof.career[0].fact.includes("may have changed"), "career is marked as possibly out of date");
  assert.ok(prof.ambition.some((m) => /Lancashire Fire and Rescue/.test(m.fact)));
  assert.ok(Object.values(prof).flat().every((m) => m.pinned), "starting facts are pinned");
  const kh = await waitFor(async () => (await laptop.call("/api/projects")).data.find((p) => p.title === "KILL HOUSE"), 5000);
  assert.equal(kh?.kind, "creative", "KILL HOUSE workspace created");
  // Edit and remove work, and are not re-seeded on the next start.
  const id = prof.hobby[0].id;
  assert.equal((await laptop.call(`/api/memories/${id}`, { method: "PATCH", body: { fact: "Gaming, mostly Football Manager 2026." } })).data.fact, "Gaming, mostly Football Manager 2026.");
  assert.equal((await laptop.call(`/api/memories/${prof.hobby[1].id}`, { method: "DELETE" })).data.ok, true);
  const recent = (await laptop.call("/api/memories/recent?limit=5")).data;
  assert.equal(recent[0].id, id, "the edit is the most recent update");
});

test("“What was that business idea?” is answered from the personal profile", async () => {
  const reply = await stream("What was that business idea I had?");
  assert.match(reply, /website design agency for small businesses, Sir \(memory #\d+\)/);
});

test("JARVIS asks before remembering something new, and only saves after a yes", async () => {
  const before = (await laptop.call("/api/memories")).data.length;
  assert.match(await stream("I've started boxing on Tuesdays"), /Would you like me to remember that for future conversations, Sir\?/);
  assert.equal((await laptop.call("/api/memories")).data.length, before, "nothing saved without consent");
  assert.match(await stream("Yes, remember that I've started boxing"), /Noted for the future/);
  assert.ok((await laptop.call("/api/memories")).data.some((m) => m.fact === "Has started boxing training" && m.category === "hobby"));
});

test("memory can be switched off: nothing is saved and the profile isn't sent to the AI", async () => {
  await laptop.call("/api/settings", { method: "PATCH", body: { memory: { mode: "off" } } });
  const n = mock.log.anthropic.length;
  assert.match(await stream("What was that business idea I had?"), /don't have a business idea on file/);
  assert.ok(!JSON.stringify(mock.log.anthropic.slice(n).map((b) => b.system)).includes("website design agency"), "profile not sent while memory is off");
  assert.match(await stream("Yes, remember that I've started boxing"), /couldn't: .*switched off/);
  await laptop.call("/api/settings", { method: "PATCH", body: { memory: { mode: "ask" } } });
});

test("narrated diagnostics: every line comes from a real check, failures are reported, runs are stored", async () => {
  const r = (await laptop.call("/api/diagnostics/run", { method: "POST", body: { level: "full" } })).data;
  assert.equal(r.level, "full");
  assert.ok(r.results.length >= 15);
  assert.equal(r.narration.length, r.results.length + 2, "opening + one line per check + closing");
  for (const x of r.results) assert.ok(["ok", "warn", "error", "off", "unknown"].includes(x.status));
  const ai = r.results.find((x) => x.name === "ai");
  assert.equal(ai.tested, true, "the AI core was actually tested, not assumed");
  // Problems are named in the closing line with their real count.
  const k = r.problems.length;
  if (r.overall === "ok") assert.equal(k, 0);
  else assert.match(r.narration.at(-1), new RegExp(`\\b${k}\\b`));
  for (const p of r.problems) assert.ok(r.narration.some((l) => l.includes(p.label)), `${p.label} is mentioned`);
  const sec = (await laptop.call("/api/diagnostics/run", { method: "POST", body: { level: "security" } })).data;
  assert.match(sec.results[0].detail, /signed-in device\(s\).*failed sign-in/);
  assert.equal((await laptop.call("/api/diagnostics/run", { method: "POST", body: { level: "nonsense" } })).status, 400);
  const runs = (await laptop.call("/api/diagnostics/runs")).data;
  assert.deepEqual(runs.slice(0, 2).map((x) => x.level), ["security", "full"]);
});

test("“Run a full diagnostic” by voice speaks the real narration", async () => {
  const reply = await stream("Run a full diagnostic");
  assert.match(reply, /diagnostics|systems analysis/i);
  assert.match(reply, /Primary database|Artificial intelligence core/);
});

test("system awareness and performance metrics are live measurements", async () => {
  const a = (await laptop.call("/api/awareness")).data;
  assert.ok(a.resources.cores >= 1 && a.performance.dbMs >= 0);
  assert.ok(Array.isArray(a.errorsLast24h));
  const p = (await laptop.call("/api/performance")).data;
  assert.ok(p.rssMb > 0 && p.ai.n >= 1, "AI latency recorded from the calls above");
  assert.ok(typeof p.lagMs === "number");
});

test("command macros: the two examples exist, are matched by phrase, and run their real steps", async () => {
  const { routines } = (await laptop.call("/api/routines")).data;
  const work = routines.find((r) => r.name === "Start my working session");
  assert.ok(work && routines.some((r) => r.name === "Prepare my morning"));
  assert.equal(work.schedule.type, "manual");
  assert.equal(work.next_run_at, null, "macros never run on a schedule");
  assert.equal((await laptop.call("/api/macros/match", { method: "POST", body: { text: "JARVIS, start my working session please" } })).data.id, work.id);
  assert.equal((await laptop.call("/api/macros/match", { method: "POST", body: { text: "start my car" } })).data, null);
  const r = (await laptop.call(`/api/routines/${work.id}/run`, { method: "POST", body: { voice: true } })).data;
  assert.ok(r.output.some((l) => /^✓ Systems check/.test(l)), r.output.join("\n"));
  assert.ok(r.output.some((l) => /^✓ Voice mode: focus/.test(l)));
  assert.ok(r.output.some((l) => /^✓ Focus session started \(50 min\)/.test(l)));
  assert.equal((await laptop.call("/api/settings")).data.personality.mode, "focus");
  await laptop.call("/api/settings", { method: "PATCH", body: { personality: { mode: "standard" } } });
  await laptop.call("/api/focus/stop", { method: "POST" }).catch(() => {});
});

test("a macro with a consequential step asks for confirmation when started by voice", async () => {
  const m = (await laptop.call("/api/routines", { method: "POST", body: { name: "Lock up", trigger_phrase: "lock up for the night", schedule: { type: "manual" }, actions: [{ type: "computer", action: "lock_screen" }] } })).data;
  const r = (await laptop.call(`/api/routines/${m.id}/run`, { method: "POST", body: { voice: true } })).data;
  assert.equal(r.status, "needs_confirmation");
  assert.match(r.steps[0], /lock_screen/);
  const runs = (await laptop.call(`/api/routines/${m.id}/runs`)).data;
  assert.equal(runs.length, 0, "nothing ran without the yes");
  assert.equal((await laptop.call("/api/routines", { method: "POST", body: { name: "Bad", schedule: { type: "manual" }, actions: [{ type: "ui", action: "format_disk" }] } })).status, 400);
});

test("session history: one timeline across conversations, commands, diagnostics and automations, searchable and clearable", async () => {
  await laptop.call("/api/activity/command", { method: "POST", body: { summary: "Mission Control activated", text: "activate mission control" } });
  const all = (await laptop.call("/api/history?limit=200")).data.items;
  const kinds = new Set(all.map((x) => x.kind));
  for (const k of ["conversation", "command", "diagnostic", "automation"]) assert.ok(kinds.has(k), `has ${k}`);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].at >= all[i].at, "newest first");
  const q = (await laptop.call("/api/history?q=business%20idea")).data.items;
  assert.ok(q.length && q.every((x) => /business idea/i.test(x.title + x.detail)));
  const cmds = (await laptop.call("/api/history?kind=command")).data.items;
  assert.ok(cmds.every((x) => x.kind === "command") && cmds.some((x) => x.title === "Mission Control activated"));
  assert.ok((await laptop.call("/api/history/command", { method: "DELETE" })).data.deleted >= 1);
  assert.equal((await laptop.call("/api/history?kind=command")).data.items.length, 0);
  assert.equal((await laptop.call("/api/history/conversation", { method: "DELETE" })).status, 400, "conversations are deleted from their own page");
});

test("settings: voice modes, personality levels and memory mode are validated", async () => {
  assert.equal((await laptop.call("/api/settings", { method: "PATCH", body: { personality: { mode: "chaotic" } } })).status, 400);
  assert.equal((await laptop.call("/api/settings", { method: "PATCH", body: { memory: { mode: "sometimes" } } })).status, 400);
  await laptop.call("/api/settings", { method: "PATCH", body: { personality: { mode: "cinematic", humour: 9 } } });
  const p = (await laptop.call("/api/settings")).data.personality;
  assert.equal(p.mode, "cinematic"); assert.equal(p.humour, 3, "clamped to 0–3");
  const n = mock.log.anthropic.length;
  await stream("Tell me a long story");
  const sys = JSON.stringify(mock.log.anthropic.slice(n)[0].system);
  assert.match(sys, /Mode: CINEMATIC/);
  assert.match(sys, /Humour: plenty of/);
  await laptop.call("/api/settings", { method: "PATCH", body: { personality: { mode: "standard", humour: 1 } } });
});
