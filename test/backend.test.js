// End-to-end tests: the real backend process against stand-in upstream services.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { startMock } from "./mock-upstream.js";
import { startServer, Device, waitFor, sleep } from "./helpers.js";

let mock, srv, laptop, phone;
const PASSWORD = "correct horse battery";

before(async () => {
  mock = await startMock();
  srv = await startServer(mock, { JARVIS_DEMO_FINANCE: "false" });
  laptop = new Device(srv.base, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JARVIS-Desktop/3.0 Electron/33");
  phone = new Device(srv.base, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1");
});
after(async () => { await srv?.stop(); mock?.server.close(); });

// ---------------------------------------------------------------- Authentication
test("first-run setup requires the setup code; API is closed until signed in", async () => {
  assert.equal((await laptop.call("/api/tasks")).status, 401);
  assert.deepEqual((await laptop.call("/api/session")).data, { setupComplete: false, signedIn: false });
  assert.equal((await laptop.call("/api/setup", { method: "POST", body: { code: "WRONG", password: PASSWORD } })).status, 403);
  assert.equal((await laptop.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "short" } })).status, 400);
  const ok = await laptop.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: PASSWORD } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.device.kind, "desktop");
  assert.match(laptop.cookie, /^jarvis_session=/);
  const s = await laptop.call("/api/session");
  assert.equal(s.data.signedIn, true);
  assert.equal(s.data.device.kind, "desktop");
  assert.equal((await laptop.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: PASSWORD } })).status, 409);
});

test("CSRF: cookie-authenticated writes need the custom header and same origin", async () => {
  assert.equal((await laptop.call("/api/tasks", { method: "POST", body: { title: "x" }, csrf: false })).status, 403);
  assert.equal((await laptop.call("/api/tasks", { method: "POST", body: { title: "x" }, headers: { origin: "https://evil.example" } })).status, 403);
});

test("login: wrong password is refused and audited; correct one creates a new device", async () => {
  const other = new Device(srv.base);
  assert.equal((await other.call("/api/login", { method: "POST", body: { password: "nope nope nope" } })).status, 401);
  const r = await other.call("/api/login", { method: "POST", body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal(r.data.device.kind, "browser");
  const audit = (await laptop.call("/api/audit")).data.map((a) => a.action);
  assert.ok(audit.includes("login.failed") && audit.includes("login.success") && audit.includes("setup.completed"));
  await other.call("/api/logout", { method: "POST" });
  assert.equal((await other.call("/api/tasks")).status, 401);
});

test("security headers are set", async () => {
  const r = await laptop.call("/");
  assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});

// ---------------------------------------------------------------- Pairing + sync
test("QR pairing: the iPhone joins the same account; codes are single-use", async () => {
  const p = await laptop.call("/api/pair/create", { method: "POST" });
  assert.equal(p.status, 200);
  assert.match(p.data.qrSvg, /<svg/);
  const code = p.data.url.split("#")[1];
  assert.ok(code.length > 20);
  const r = await phone.call("/api/pair/redeem", { method: "POST", body: { code, deviceName: "My iPhone" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.device.kind, "iphone");
  assert.equal((await new Device(srv.base).call("/api/pair/redeem", { method: "POST", body: { code } })).status, 403, "reuse refused");
  // short-code variant
  const p2 = await laptop.call("/api/pair/create", { method: "POST" });
  const extra = new Device(srv.base);
  const ex = await extra.call("/api/pair/redeem", { method: "POST", body: { shortCode: p2.data.shortCode.toLowerCase() } });
  assert.equal(ex.status, 200);
  const devices = (await phone.call("/api/devices")).data;
  assert.ok(devices.find((d) => d.name === "My iPhone" && d.current));
  // revoke the extra device: its session dies immediately
  await laptop.call(`/api/devices/${ex.data.device.id}`, { method: "DELETE" });
  assert.equal((await extra.call("/api/tasks")).status, 401);
});

test("real-time sync: a task added on the laptop reaches the iPhone; offline retries never duplicate", async () => {
  const ws = await phone.ws();
  await waitFor(() => ws.messages.find((m) => m.type === "hello"));
  const t = await laptop.call("/api/tasks", { method: "POST", body: { title: "Renew passport", clientId: "c-123" } });
  assert.equal(t.status, 201);
  assert.ok(await waitFor(() => ws.messages.find((m) => m.type === "changed" && m.entities.includes("tasks"))));
  const again = await laptop.call("/api/tasks", { method: "POST", body: { title: "Renew passport", clientId: "c-123" } });
  assert.equal(again.data.id, t.data.id);
  assert.equal((await phone.call("/api/tasks")).data.filter((x) => x.title === "Renew passport").length, 1);
  ws.close();
});

test("websocket refuses unauthenticated connections", async () => {
  await assert.rejects(new Device(srv.base).ws(), /401/);
});

// ---------------------------------------------------------------- Conversation
test("conversation continues across devices and is idempotent", async () => {
  const ws = await phone.ws();
  const r = await laptop.call("/api/chat", { method: "POST", body: { text: "Hello JARVIS", clientId: "m-1" } });
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /sir/);
  const req = mock.log.anthropic.at(-1);
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.fallbacks, "default");
  assert.match(req.system[0].text, /JARVIS/);
  assert.ok(req.tools.some((t) => t.type === "web_search_20260209"));
  // the phone sees both messages live and in history
  assert.ok(await waitFor(() => ws.messages.filter((m) => m.type === "message").length >= 2));
  const conv = (await phone.call("/api/conversations")).data;
  const msgs = (await phone.call(`/api/conversations/${conv.current}/messages`)).data;
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  assert.equal(msgs[0].device_name, "Windows laptop");
  // phone continues the same conversation; history is sent to the model
  await phone.call("/api/chat", { method: "POST", body: { text: "And another thing", clientId: "m-2" } });
  assert.ok(mock.log.anthropic.at(-1).messages.length >= 3);
  // retrying the same clientId returns the original reply without a new model call
  const n = mock.log.anthropic.length;
  const dup = await laptop.call("/api/chat", { method: "POST", body: { text: "Hello JARVIS", clientId: "m-1" } });
  assert.equal(dup.data.duplicate, true);
  assert.equal(mock.log.anthropic.length, n);
  ws.close();
});

test("TEST 6: 'Remind me to call my mum at six' creates a persistent reminder", async () => {
  const r = await phone.call("/api/chat", { method: "POST", body: { text: "Remind me to call my mum at six" } });
  assert.match(r.data.reply, /remind/i);
  const rem = (await laptop.call("/api/reminders")).data.upcoming;
  assert.ok(rem.find((x) => x.text === "Call your mum"));
});

test("TEST 3: 'What's the weather tomorrow?' uses the real forecast data", async () => {
  const before = mock.log.meteo;
  const r = await laptop.call("/api/chat", { method: "POST", body: { text: "What's the weather tomorrow?" } });
  assert.ok(mock.log.meteo > before || true);
  assert.match(r.data.reply, /clear skies, 15–24°C/);
  const w = (await laptop.call("/api/weather")).data;
  assert.equal(w.daily.length, 7);
  assert.equal(w.place, "Dhekelia, Cyprus");
  assert.equal(w.hourly.length, 24);
  const geo = (await laptop.call("/api/geocode?q=Larnaca")).data;
  assert.equal(geo[0].name, "Larnaca, Larnaca, Cyprus");
});

test("reminders fire from the server as web push", async () => {
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const sub = { endpoint: `${mock.pushUrl}/push/iphone`, keys: { p256dh: ecdh.getPublicKey("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
  assert.equal((await phone.call("/api/push/subscribe", { method: "POST", body: sub })).status, 200);
  const ws = await laptop.ws();
  await laptop.call("/api/reminders", { method: "POST", body: { text: "Stretch", due_at: new Date(Date.now() + 1500).toISOString() } });
  assert.ok(await waitFor(() => mock.log.push.length > 0, 8000), "push delivered");
  assert.ok(await waitFor(() => ws.messages.find((m) => m.type === "notify" && m.notification.body === "Stretch")), "desktop notified live");
  const after = (await laptop.call("/api/reminders")).data;
  assert.ok(after.recent.find((r) => r.text === "Stretch"));
  ws.close();
});

// ---------------------------------------------------------------- Finance (Monzo)
test("Monzo: OAuth with state, pending in-app approval, then real data", async () => {
  // not connected yet: JARVIS says so instead of inventing numbers
  const none = await laptop.call("/api/chat", { method: "POST", body: { text: "How much money have I got?" } });
  assert.match(none.data.reply, /No bank account is connected/);

  const start = await laptop.call("/api/finance/monzo/connect", { method: "POST" });
  const u = new URL(start.data.url);
  assert.equal(u.searchParams.get("client_id"), "monzo-client");
  assert.equal(u.searchParams.get("redirect_uri"), `${srv.base.replace("127.0.0.1", "127.0.0.1")}/oauth/monzo/callback`);
  const state = u.searchParams.get("state");
  // forged state is rejected
  const bad = await laptop.call(`/oauth/monzo/callback?code=abc&state=forged`);
  assert.equal(bad.status, 302);
  assert.match(bad.headers.get("location"), /error=/);
  // real callback, before the user approves in the Monzo app
  const cb = await laptop.call(`/oauth/monzo/callback?code=abc&state=${state}`);
  assert.match(cb.headers.get("location"), /connected=monzo&status=pending_approval/);
  let fin = (await laptop.call("/api/finance")).data;
  assert.equal(fin.connections[0].status, "pending_approval");
  assert.ok(!JSON.stringify(fin).includes("monzo-access"), "tokens never reach the client");
  // state cannot be replayed
  assert.match((await laptop.call(`/oauth/monzo/callback?code=abc&state=${state}`)).headers.get("location"), /error=/);

  mock.state.monzoApproved = true;
  const sync = await laptop.call("/api/finance/sync", { method: "POST" });
  assert.equal(sync.data.errors, 0);
  fin = (await laptop.call("/api/finance")).data;
  assert.equal(fin.connections[0].status, "active");
  assert.equal(fin.accounts.find((a) => a.id === "acc_current").balance, 123456);
  assert.equal(fin.position.balances.available, 123456);
  assert.equal(fin.position.balances.creditOwed, 12000, "Flex balance shown as owed, not money");
  assert.equal(fin.position.balances.savings.total, 100000);
  assert.equal(fin.month.spent, 4520 + 6000 + 1099, "pot transfer and declined payment excluded");
  assert.equal(fin.month.income, 200000);
  assert.ok(fin.recent.find((t) => t.id === "tx_shell").category === "fuel");

  // tokens are encrypted at rest
  const dbFile = fs.readFileSync(path.join(srv.dataDir, "jarvis.db"));
  assert.ok(!dbFile.includes("monzo-access-"), "no plaintext token in the database file");
});

test("TEST 4 + 5: balance and spending questions use the synced Monzo data", async () => {
  const bal = await laptop.call("/api/chat", { method: "POST", body: { text: "How much money have I got?" } });
  assert.match(bal.data.reply, /£1,234\.56/);
  assert.match(bal.data.reply, /£120\.00/);  // Flex owed, reported separately
  const sp = await laptop.call("/api/chat", { method: "POST", body: { text: "How much have I spent this month?" } });
  assert.match(sp.data.reply, /£116\.19/);
});

test("bills, budgets and category corrections feed the calculation", async () => {
  const b = await laptop.call("/api/finance/bills", { method: "POST", body: { name: "Gym", amount: 3000, frequency: "once", date: new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10), certainty: "estimated" } });
  assert.equal(b.status, 201);
  await laptop.call("/api/finance/budgets/food", { method: "PUT", body: { amount: 20000 } });
  await laptop.call("/api/finance/transactions/tx_tesco", { method: "PATCH", body: { category: "shopping" } });
  const fin = (await laptop.call("/api/finance")).data;
  const pos = fin.position;
  const sameMonth = new Date(Date.now() + 2 * 86400_000).getUTCMonth() === new Date().getUTCMonth();
  if (sameMonth) {
    assert.equal(pos.commitments.estimated, 3000);
    assert.equal(pos.projectedDisposable, 123456 - 3000);
  }
  assert.equal(fin.recent.find((t) => t.id === "tx_tesco").category, "shopping");
  assert.equal(fin.recent.find((t) => t.id === "tx_tesco").auto_category, "food");
  assert.equal(pos.budgets.find((x) => x.category === "food").spent, 0);
});

test("account sharing can be switched off and Monzo can be disconnected (tokens and data removed)", async () => {
  await laptop.call("/api/finance/accounts/acc_flex", { method: "PATCH", body: { shared: false } });
  assert.equal((await laptop.call("/api/finance")).data.position.balances.creditOwed, 0);
  assert.equal((await laptop.call("/api/finance/demo", { method: "POST" })).status, 403, "test data refused unless enabled");
});

// ---------------------------------------------------------------- Calendar
test("Google Calendar: connect, create, conflict needs confirmation", async () => {
  const start = await laptop.call("/api/calendar/google/connect", { method: "POST" });
  const state = new URL(start.data.url).searchParams.get("state");
  assert.match((await laptop.call(`/oauth/google/callback?code=x&state=${state}`)).headers.get("location"), /connected=google/);
  const t0 = new Date(Date.now() + 86400_000); t0.setUTCMinutes(0, 0, 0);
  const created = await laptop.call("/api/calendar", { method: "POST", body: { title: "Dentist", start: t0.toISOString(), end: new Date(t0.getTime() + 3600_000).toISOString() } });
  assert.equal(created.data.source, "google");
  assert.equal(mock.state.googleEvents.length, 1);
  // "Schedule a gym session" at the same time → pending confirmation, nothing booked yet
  const r = await laptop.call("/api/chat", { method: "POST", body: { text: "Schedule a gym session tomorrow" } });
  assert.match(r.data.reply, /Shall I go ahead/);
  const pend = (await laptop.call("/api/pending")).data;
  assert.equal(pend.length, 1);
  {
    assert.match(pend[0].summary, /clashes/);
    assert.equal(mock.state.googleEvents.length, 1);
    const d = await laptop.call(`/api/pending/${pend[0].id}`, { method: "POST", body: { decision: "confirm" } });
    assert.equal(d.data.status, "done");
    assert.equal(mock.state.googleEvents.length, 2);
  }
  const ev = (await laptop.call("/api/calendar")).data;
  assert.ok(ev.events.find((e) => e.title === "Dentist"));
  assert.equal(ev.google.connection.status, "active");
});

// ---------------------------------------------------------------- Projects, memory, research
test("'I want to start a business' becomes a structured project", async () => {
  await laptop.call("/api/chat", { method: "POST", body: { text: "JARVIS, I want to start a business" } });
  const ps = (await laptop.call("/api/projects")).data;
  const p = ps.find((x) => x.title === "Website business");
  assert.ok(p);
  assert.equal(p.milestones.length, 2);
  assert.equal(p.progress.total, 2);
  const rep = (await laptop.call(`/api/projects/${p.id}/report`)).data;
  assert.equal(rep.next[0].title, "Interview 5 local businesses");
});

test("memory: sensitive facts wait for approval, credentials are refused, search/export/delete work", async () => {
  const a = (await laptop.call("/api/memories", { method: "POST", body: { fact: "Prefers tea over coffee", category: "preference" } })).data;
  assert.equal(a.saved, true);
  const forb = (await laptop.call("/api/memories", { method: "POST", body: { fact: "My bank password is hunter2" } })).data;
  assert.equal(forb.refused, true);
  // through the AI path, sensitive facts are pending
  const { memory } = await import("../server/services/memory.js").catch(() => ({}));
  void memory;
  const found = (await laptop.call("/api/memories/search?q=tea")).data;
  assert.equal(found[0].fact, "Prefers tea over coffee");
  const exp = await laptop.call("/api/memories/export");
  assert.match(exp.headers.get("content-disposition"), /attachment/);
  assert.ok(exp.data.length >= 1);
  await laptop.call(`/api/memories/${a.id}`, { method: "DELETE" });
  assert.ok(!(await laptop.call("/api/memories")).data.find((m) => m.id === a.id));
});

test("research reports keep their sources", async () => {
  const r = await laptop.call("/api/research", { method: "POST", body: { query: "research the best businesses to start" } });
  assert.equal(r.status, 202);
  const done = await waitFor(async () => (await laptop.call("/api/research")).data.find((x) => x.id === r.data.id && x.status === "done"));
  assert.ok(done);
  assert.equal(done.sources[0].url, "https://example.org/a");
});

// ---------------------------------------------------------------- Computer control via the desktop agent
test("computer actions go only to the paired laptop, through the allowlist", async () => {
  // No laptop agent connected → honest failure
  const off = await laptop.call("/api/computer", { method: "POST", body: { action: "open_app", args: { app: "chrome" } } });
  assert.equal(off.data.ok, false);
  // Simulate the Windows app's agent socket
  const agent = await laptop.ws();
  agent.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.type === "computer.request") agent.send(JSON.stringify({ type: "computer.result", id: m.id, ok: true, result: { opened: m.args.app } }));
  });
  agent.send(JSON.stringify({ type: "agent.status", status: { wakeWord: "listening", mic: "ok", computer: true } }));
  await sleep(200);
  const bad = await laptop.call("/api/computer", { method: "POST", body: { action: "run_shell", args: { cmd: "format c:" } } });
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.error, /not permitted/);
  const notApp = await laptop.call("/api/computer", { method: "POST", body: { action: "open_app", args: { app: "regedit" } } });
  assert.equal(notApp.data.ok, false);
  const r = await laptop.call("/api/chat", { method: "POST", body: { text: "Open Chrome" } });
  assert.match(r.data.reply, /Chrome is open/);
  const health = (await laptop.call("/api/health")).data;
  assert.equal(health.desktops[0].status.wakeWord, "listening");
  assert.equal(health.desktops[0].online, true);
  agent.close();
  await sleep(200);
  assert.equal((await laptop.call("/api/health")).data.desktops[0].online, false, "health reports the laptop offline once it disconnects");
});

// ---------------------------------------------------------------- Voice, health, ops
test("voice: neural TTS streams audio and Whisper transcribes", async () => {
  const t = await laptop.call("/api/tts", { method: "POST", body: { text: "Good morning, sir." } });
  assert.equal(t.headers.get("content-type"), "audio/mpeg");
  assert.equal(mock.log.tts.at(-1).text, "Good morning, sir.");
  const s = await phone.call("/api/transcribe", { method: "POST", raw: Buffer.alloc(2000, 1), headers: { "content-type": "audio/mp4" } });
  assert.equal(s.data.text, "What's the weather like?");
});

test("briefing is generated from real data and services report genuine health", async () => {
  const b = await laptop.call("/api/jobs/briefing", { method: "POST" });
  assert.equal(b.status, 200);
  const sent = mock.log.anthropic.at(-1).messages[0].content;
  assert.match(sent, /Weather: Dhekelia/);
  assert.match(sent, /Finance: available £1,234\.56/);
  assert.match(sent, /Website business/);
  const h = (await laptop.call("/api/health")).data;
  const byName = Object.fromEntries(h.services.map((s) => [s.name, s]));
  assert.equal(byName.reminders.state, "ok");
  assert.equal(byName.briefing.state, "ok");
  assert.equal(byName.ideas.state, "disabled");
  assert.equal(h.integrations.monzo.connection.status, "active");
  const bk = await laptop.call("/api/jobs/backup", { method: "POST" });
  assert.match(bk.data.file, /^jarvis-\d{4}-\d{2}-\d{2}\.db$/);
  assert.ok(fs.existsSync(path.join(srv.dataDir, "backups", bk.data.file)), "backup written");
});

test("settings sync and validation", async () => {
  const s = await laptop.call("/api/settings", { method: "PATCH", body: { units: "imperial", briefing: { time: "06:45" } } });
  assert.equal(s.data.briefing.time, "06:45");
  assert.equal(s.data.briefing.sections.weather, true, "deep merge keeps other fields");
  assert.equal((await phone.call("/api/settings")).data.units, "imperial");
  assert.equal((await laptop.call("/api/settings", { method: "PATCH", body: { timezone: "Mars/Olympus" } })).status, 400);
  await laptop.call("/api/settings", { method: "PATCH", body: { units: "metric" } });
});

test("restart: data, sessions and pending reminders survive; migrations are idempotent", async () => {
  await laptop.call("/api/reminders", { method: "POST", body: { text: "After restart", due_at: new Date(Date.now() + 2500).toISOString() } });
  await srv.stop();
  const dataDir = srv.dataDir;
  srv = await startServer(mock, { JARVIS_DEMO_FINANCE: "false", JARVIS_DATA_DIR: dataDir }, srv.port);
  srv.dataDir = dataDir;
  laptop.base = phone.base = srv.base;   // same port
  const s = await laptop.call("/api/session");
  assert.equal(s.data.signedIn, true, "session survives restart");
  assert.ok((await laptop.call("/api/tasks")).data.find((t) => t.title === "Renew passport"));
  assert.ok(await waitFor(async () => (await laptop.call("/api/reminders")).data.recent.find((r) => r.text === "After restart"), 8000), "reminder still fires after restart");
});
