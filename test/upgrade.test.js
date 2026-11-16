// End-to-end tests for the Ultimate Upgrade: the real backend process against the stand-in upstream services.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { startMock, speechLikeWav } from "./mock-upstream.js";
import { startServer, Device, waitFor } from "./helpers.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let mock, srv, laptop;

before(async () => {
  mock = await startMock();
  srv = await startServer(mock);
  laptop = new Device(srv.base, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JARVIS-Desktop/4.0 Electron/33");
  const r = await laptop.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "correct horse battery" } });
  assert.equal(r.status, 201);
});
after(async () => { await srv?.stop(); mock?.server.close(); });

/** POST to the streaming chat endpoint and collect the Server-Sent Events. */
async function stream(text, extra = {}) {
  const res = await fetch(srv.base + "/api/chat/stream", { method: "POST", headers: { "content-type": "application/json", cookie: laptop.cookie, "x-jarvis": "1" }, body: JSON.stringify({ text, ...extra }) });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const events = [];
  const body = await res.text();
  for (const chunk of body.split("\n\n")) { const line = chunk.split("\n").find((l) => l.startsWith("data: ")); if (line) events.push(JSON.parse(line.slice(6))); }
  return events;
}

test("migration: an existing database is backed up first, upgraded in place, and keeps its data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-old-"));
  const db = new DatabaseSync(path.join(dir, "jarvis.db"));
  db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  for (const f of fs.readdirSync(path.join(ROOT, "server/migrations")).filter((f) => /^00[1-6]_/.test(f)).sort()) {
    db.exec(fs.readFileSync(path.join(ROOT, "server/migrations", f), "utf8"));
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(f.split("_")[0]);
  }
  db.exec("INSERT INTO tasks (title) VALUES ('Task from before the upgrade')");
  db.close();
  const old = await startServer(mock, { JARVIS_DATA_DIR: dir });
  try {
    const backups = fs.readdirSync(path.join(dir, "backups"));
    assert.ok(backups.some((f) => /^pre-migration-007-.*\.db$/.test(f)), `pre-migration backup written (${backups})`);
    const d = new Device(old.base);
    await d.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "correct horse battery" } });
    assert.ok((await d.call("/api/tasks")).data.some((t) => t.title === "Task from before the upgrade" && t.category === "general"));
    assert.equal((await d.call("/api/alarms")).status, 200);
  } finally { await old.stop(); }
});

test("streaming conversation: words arrive as they're generated, tools run, the alarm really exists", async () => {
  const ev = await stream("Set an alarm for seven every weekday", { voice: true });
  const tools = ev.filter((e) => e.type === "tool").map((e) => `${e.name}:${e.phase}`);
  assert.deepEqual(tools, ["set_alarm:start", "set_alarm:done"]);
  const done = ev.find((e) => e.type === "done");
  assert.match(done.reply, /^Alarm set, Sir — .*07:00/);
  assert.ok(ev.filter((e) => e.type === "delta").length >= 3, "reply streamed in pieces");
  const al = (await laptop.call("/api/alarms")).data.alarms.find((a) => a.label === "Wake up");
  assert.equal(al.time, "07:00");
  assert.equal(al.repeat, "weekdays");
  const story = await stream("Tell me a long story");
  const deltas = story.filter((e) => e.type === "delta").map((e) => e.text);
  assert.ok(deltas.length > 10);
  assert.equal(deltas.join(""), story.find((e) => e.type === "done").reply);
});

test("money: 'I just spent £12.50 on food' is recorded by hand, never as a payment", async () => {
  const ev = await stream("I just spent £12.50 on food");
  assert.match(ev.find((e) => e.type === "done").reply, /twelve pounds fifty/);
  const manual = (await laptop.call("/api/finance/manual")).data;
  assert.equal(manual[0].amount, -1250);
  assert.equal(manual[0].category, "food");
  const del = await laptop.call(`/api/finance/manual/${manual[0].id}`, { method: "DELETE" });
  assert.equal(del.data.ok, true);
});

test("world time uses real place lookups", async () => {
  const ev = await stream("What time is it in Tokyo?");
  const done = ev.find((e) => e.type === "done");
  assert.doesNotMatch(done.reply, /unknown/);
});

test("command centre: one call returns real weather, alarms, tasks and the greeting title", async () => {
  const h = (await laptop.call("/api/home")).data;
  assert.equal(h.title, "Sir");
  assert.equal(h.timezone, "Europe/Nicosia");
  assert.equal(h.location.place, "Dhekelia, Cyprus");
  assert.equal(h.weather.current.temp, 21);
  assert.ok(h.weather.today.sunrise && h.weather.today.uv != null, "UV and sunrise for the weather panel");
  assert.equal(h.alarms.next.label, "Wake up");
  assert.equal(h.money.connected, false);
  assert.ok(Array.isArray(h.activity) && h.activity.some((a) => /Alarm set/.test(a.summary)));
});

test("alarms API: sounds, custom upload, test ring over the live connection, snooze/dismiss/history", async () => {
  const ws = await laptop.ws();
  const up = await laptop.call("/api/alarms/sounds?name=My%20tune", { method: "POST", raw: speechLikeWav(0.5), headers: { "content-type": "audio/wav" } });
  assert.equal(up.status, 201);
  const list = (await laptop.call("/api/alarms/sounds")).data;
  assert.ok(list.some((s) => s.builtin && s.id === "chime") && list.some((s) => s.name === "My tune"));
  const file = await laptop.call(`/api/alarms/sounds/${up.data.id.slice(7)}/file`);
  assert.equal(file.headers.get("content-type"), "audio/wav");
  const a = (await laptop.call("/api/alarms", { method: "POST", body: { time: "06:45", label: "Run", sound: up.data.id } })).data;
  assert.equal(a.sound_name, "My tune");
  assert.equal((await laptop.call("/api/alarms", { method: "POST", body: { time: "nonsense" } })).status, 400);
  await laptop.call("/api/alarms/test", { method: "POST", body: {} });
  const t = await waitFor(() => ws.messages.find((m) => m.type === "alarm.test"));
  assert.match(t.speech, /^Good (morning|afternoon|evening), Sir\./);
  const sn = await laptop.call(`/api/alarms/${a.id}/snooze`, { method: "POST", body: { minutes: 5 } });
  assert.equal(sn.data.minutes, 5);
  assert.ok(await waitFor(() => ws.messages.find((m) => m.type === "alarm.snoozed" && m.id === a.id)));
  await laptop.call(`/api/alarms/${a.id}/dismiss`, { method: "POST" });
  await laptop.call(`/api/alarms/${a.id}/rang`, { method: "POST", body: { scheduledFor: a.next_at, detail: "rang on laptop" } });
  await laptop.call(`/api/alarms/${a.id}/event`, { method: "POST", body: { event: "audio_verified", detail: "RMS 0.21" } });
  const hist = (await laptop.call("/api/alarms/history")).data.filter((e) => e.alarm_id === a.id).map((e) => e.event);
  assert.deepEqual(hist.sort(), ["audio_verified", "dismissed", "rang", "snoozed"]);
  const sched = (await laptop.call("/api/alarms/schedule")).data;
  assert.equal(sched.timezone, "Europe/Nicosia");
  ws.close();
});

test("notification centre: a repeating reminder notifies, stays scheduled, and can be snoozed, read and dismissed", async () => {
  const r = (await laptop.call("/api/reminders", { method: "POST", body: { text: "Stretch", due_at: new Date(Date.now() + 1500).toISOString(), repeat: "daily" } })).data;
  const n = await waitFor(async () => (await laptop.call("/api/notifications")).data.items.find((x) => x.kind === "reminder" && x.body === "Stretch"), 8000);
  assert.ok(n, "reminder notification stored");
  const again = (await laptop.call("/api/reminders")).data.upcoming.find((x) => x.id === r.id);
  assert.ok(again && Date.parse(again.due_at) > Date.now() + 20 * 3600_000, "rescheduled for tomorrow");
  const sn = await laptop.call(`/api/notifications/${n.id}/snooze`, { method: "POST", body: { minutes: 30 } });
  assert.ok(Date.parse(sn.data.until) > Date.now());
  await laptop.call("/api/notifications/read-all", { method: "POST" });
  assert.equal((await laptop.call("/api/notifications")).data.unread, 0);
  await laptop.call(`/api/notifications/${n.id}/dismiss`, { method: "POST" });
  assert.ok(!(await laptop.call("/api/notifications")).data.items.some((x) => x.id === n.id));
  assert.ok((await laptop.call("/api/notifications/history")).data.some((x) => x.id === n.id), "kept in history");
});

test("automations: built-ins exist; the evening review runs on demand and is kept in briefing history", async () => {
  const r = (await laptop.call("/api/routines")).data;
  const evening = r.routines.find((x) => x.builtin === "evening");
  assert.ok(r.routines.find((x) => x.builtin === "morning").enabled);
  const run = (await laptop.call(`/api/routines/${evening.id}/run`, { method: "POST" })).data;
  assert.equal(run.status, "ok");
  const b = (await laptop.call("/api/briefings")).data[0];
  assert.equal(b.kind, "evening");
  const prompt = mock.log.anthropic.at(-1).messages[0].content;
  assert.match(prompt, /evening review/i);
  assert.match(prompt, /Alarm: (Wake up|Run|none)/);
  // Settings ↔ morning routine stay in step.
  await laptop.call("/api/settings", { method: "PATCH", body: { briefing: { time: "06:30" } } });
  const m = (await laptop.call("/api/routines")).data.routines.find((x) => x.builtin === "morning");
  assert.equal(m.schedule.time, "06:30");
  assert.equal((await laptop.call("/api/settings", { method: "PATCH", body: { briefing: { time: "6.30am" } } })).status, 400);
});

test("settings: voice, appearance and personal details are validated", async () => {
  const s = (await laptop.call("/api/settings", { method: "PATCH", body: { voice: { timeoutSec: 999, rate: 5 }, profile: { name: "Dylan", title: "" }, appearance: { animation: "reduced" } } })).data;
  assert.equal(s.voice.timeoutSec, 60);
  assert.equal(s.voice.rate, 1.6);
  assert.equal(s.voice.continuous, true, "other voice settings kept");
  assert.equal(s.profile.title, "Sir");
  assert.equal(s.profile.name, "Dylan");
  assert.equal((await laptop.call("/api/settings", { method: "PATCH", body: { appearance: { animation: "wild" } } })).status, 400);
});

test("diagnostics: test buttons make real requests; AI status follows real results", async () => {
  const t = (await laptop.call("/api/diagnostics/test/ai", { method: "POST" })).data;
  assert.equal(t.ok, true);
  assert.match(t.detail, /available/);
  const d = (await laptop.call("/api/diagnostics")).data;
  const ai = d.checks.find((c) => c.name === "ai");
  assert.equal(ai.status, "ok");
  assert.ok(ai.metrics.calls >= 3, "real chat calls were measured");
  assert.ok(d.checks.find((c) => c.name === "cpu"));
  assert.equal((await laptop.call("/api/diagnostics/test/weather", { method: "POST" })).data.ok, true);
  assert.equal((await laptop.call("/api/diagnostics/test/rm-rf", { method: "POST" })).status, 404);
  const logs = (await laptop.call("/api/diagnostics/logs")).data;
  assert.ok(logs.apiCalls.length > 0);
});

test("search, notes, business, habits and focus work end to end", async () => {
  await laptop.call("/api/notes", { method: "POST", body: { title: "Villa ideas", body: "Pool cleaning rota" } });
  const hits = (await laptop.call("/api/search?q=villa")).data;
  assert.ok(hits.some((h) => h.type === "note"));
  const c = (await laptop.call("/api/clients", { method: "POST", body: { name: "Sea View Villas", stage: "lead", value: 50000 } })).data;
  const inv = (await laptop.call("/api/invoices", { method: "POST", body: { client_id: c.id, items: [{ description: "Design", quantity: 2, unit: 15000 }] } })).data;
  assert.equal(inv.total, 30000);
  assert.ok((await laptop.call("/api/business/summary")).data.pipeline.find((p) => p.stage === "lead").count >= 1);
  const h = (await laptop.call("/api/habits", { method: "POST", body: { name: "Meditate" } })).data;
  assert.equal((await laptop.call(`/api/habits/${h.id}/check`, { method: "POST" })).data.doneToday, true);
  const f = (await laptop.call("/api/focus/start", { method: "POST", body: { minutes: 25, label: "Proposal" } })).data;
  assert.equal(f.planned_minutes, 25);
  assert.ok((await laptop.call("/api/focus")).data.active);
  await laptop.call("/api/focus/stop", { method: "POST" });
  assert.equal((await laptop.call("/api/focus")).data.active, null);
});

test("documents: text uploads are stored, and only analysed when asked", async () => {
  const before = mock.log.anthropic.length;
  const d = (await laptop.call("/api/documents?name=contract.txt", { method: "POST", raw: Buffer.from("Term: 12 months. Fee: £500 per month."), headers: { "content-type": "text/plain" } })).data;
  assert.equal(mock.log.anthropic.length, before, "uploading sends nothing to the AI");
  const a = (await laptop.call(`/api/documents/${d.id}/analyze`, { method: "POST", body: {} })).data;
  assert.ok(a.text);
  const sent = mock.log.anthropic.at(-1).messages[0].content;
  assert.equal(sent[0].type, "document");
  assert.match(sent[0].source.data, /12 months/);
  assert.equal((await laptop.call("/api/documents?name=x.exe", { method: "POST", raw: Buffer.from("MZ"), headers: { "content-type": "application/octet-stream" } })).status, 415);
});

test("Monzo sign-in finished in the laptop's normal browser shows a clear page, not the JARVIS login", async () => {
  const anon = new Device(srv.base);
  const r = await anon.call("/oauth/monzo/callback?error=access_denied&error_description=You%20cancelled");
  assert.equal(r.status, 400);
  assert.match(r.data.toString(), /Monzo wasn&#39;t connected/);
  assert.match(r.data.toString(), /You cancelled/);
  const g = await anon.call("/oauth/google/callback?state=forged&code=x");
  assert.match(g.data.toString(), /Google Calendar wasn&#39;t connected/);
  assert.match(g.data.toString(), /expired or was not started by JARVIS/);
});
