// The JARVIS background agent (runs in the Electron main process, no window needed).
// - Keeps its own live connection to the JARVIS server using this laptop's signed-in session.
// - Runs allowlisted computer actions the server asks for (the renderer no longer has to be open).
// - Rings alarms locally from a cached schedule: works with the window closed, rings on wake/startup if an alarm
//   came due in the last 15 minutes, and asks Windows Task Scheduler to wake the laptop for the next alarm.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import WebSocket from "ws";

const LATE_MS = 15 * 60_000;
const TASK_NAME = "JARVIS NextAlarm";

export function createAgent({ getBase, getCookie, userAgent, runAction, onRing, onStopRing, onStatus, onSettings, log, dataDir, exePath, platform = process.platform }) {
  fs.mkdirSync(path.join(dataDir, "alarm-sounds"), { recursive: true });
  const cacheFile = path.join(dataDir, "alarm-cache.json");
  let cache = { upcoming: [], timezone: null, syncedAt: null, rung: [] };
  try { cache = { ...cache, ...JSON.parse(fs.readFileSync(cacheFile, "utf8")) }; } catch {}
  const saveCache = () => { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch {} };
  let ws = null, retry = 0, retryTimer = null, stopped = false, serverSettings = {};
  const st = { connected: false, ready: false, scheduled: 0, lastSync: cache.syncedAt, wakeTask: null, wakeAt: null, wakeError: null, audioVerifiedAt: null, ringing: null };
  const status = (patch = {}) => { Object.assign(st, patch, { scheduled: cache.upcoming.length }); onStatus?.({ ...st }); };
  const pendingPosts = [];

  // ---------------------------------------------------------------- HTTP to the server with this laptop's session
  async function http(pathname, { method = "GET", body } = {}) {
    const base = getBase(); const cookie = await getCookie();
    if (!base || !cookie) throw new Error("not signed in");
    const r = await fetch(new URL(pathname, base), {
      method, signal: AbortSignal.timeout(10_000),
      headers: { cookie: `jarvis_session=${cookie}`, "x-jarvis": "1", "user-agent": userAgent, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return r.headers.get("content-type")?.includes("json") ? r.json() : r;
  }
  /** Fire-and-remember: alarm events are queued if the server is down and sent when it's back. */
  function report(pathname, body) {
    http(pathname, { method: "POST", body }).catch(() => { pendingPosts.push([pathname, body]); if (pendingPosts.length > 50) pendingPosts.shift(); });
  }
  async function flush() { while (pendingPosts.length) { const [p, b] = pendingPosts[0]; try { await http(p, { method: "POST", body: b }); pendingPosts.shift(); } catch { return; } } }

  // ---------------------------------------------------------------- Live connection
  async function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    const base = getBase(), cookie = await getCookie().catch(() => null);
    if (!base || !cookie) { retryTimer = setTimeout(connect, 5000); return; }
    try { ws?.terminate(); } catch {}
    ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", { headers: { cookie: `jarvis_session=${cookie}`, "user-agent": userAgent } });
    ws.on("open", () => { retry = 0; status({ connected: true }); log("agent connected"); sync().catch(() => {}); loadSettings(); flush(); });
    ws.on("message", (buf) => { let m; try { m = JSON.parse(buf); } catch { return; } handle(m).catch((e) => log("agent message error", e.message)); });
    ws.on("close", () => { status({ connected: false }); if (!stopped) retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++)); });
    ws.on("error", (e) => log("agent socket error", e.message));
  }
  const send = (msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
  async function loadSettings() { try { serverSettings = await http("/api/settings"); onSettings?.(serverSettings); } catch {} }

  async function handle(m) {
    if (m.type === "computer.request") {
      try { const result = await runAction(m.action, m.args || {}); send({ type: "computer.result", id: m.id, ok: true, result }); }
      catch (e) { send({ type: "computer.result", id: m.id, ok: false, error: e.message }); }
    }
    if (m.type === "changed" && m.entities?.includes("alarms")) sync().catch(() => {});
    if (m.type === "changed" && m.entities?.includes("settings")) loadSettings();
    if (m.type === "alarm.ringing" && m.alarm) {
      const a = m.alarm;
      ring({ alarmId: a.id, label: a.label, sound: a.sound, volume: a.volume, gradual: a.gradual, message: a.message, snoozeMinutes: a.snooze_minutes, at: m.scheduledFor }, { speech: m.speech, fromServer: true });
    }
    if (m.type === "alarm.test") ring({ ...m.alarm, alarmId: 0, at: new Date().toISOString(), test: true }, { speech: m.speech, fromServer: true });
    if ((m.type === "alarm.snoozed" || m.type === "alarm.dismissed") && st.ringing && st.ringing.alarmId === m.id) { st.ringing = null; onStopRing(); status(); }
  }

  // ---------------------------------------------------------------- Schedule
  async function sync() {
    const s = await http("/api/alarms/schedule?hours=48");
    cache.upcoming = s.upcoming; cache.timezone = s.timezone; cache.syncedAt = new Date().toISOString();
    cache.rung = cache.rung.filter((k) => Date.parse(k.split("@")[1]) > Date.now() - 86400_000);
    saveCache();
    status({ ready: true, lastSync: cache.syncedAt });
    // Custom sounds are downloaded ahead of time so they ring even if the server isn't up yet after a wake.
    for (const a of s.upcoming) if (String(a.sound).startsWith("custom:")) await ensureSound(a.sound.slice(7)).catch(() => {});
    await scheduleWake();
    // An alarm the server says is ringing right now (e.g. this app was just started).
    for (const r of s.ringing || []) if (Date.now() - Date.parse(r.at) < LATE_MS) ring({ alarmId: r.alarm_id, label: r.label, sound: r.sound, volume: r.volume, gradual: !!r.gradual, message: r.message, snoozeMinutes: r.snooze_minutes, at: r.scheduled_for }, { fromServer: true });
    return s;
  }
  async function ensureSound(id) {
    const file = path.join(dataDir, "alarm-sounds", id);
    if (fs.existsSync(file)) return file;
    const r = await http(`/api/alarms/sounds/${id}/file`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return file;
  }
  function soundFor(a) {
    if (String(a.sound).startsWith("custom:")) { const f = path.join(dataDir, "alarm-sounds", a.sound.slice(7)); if (fs.existsSync(f)) return { file: f }; }
    return { builtin: /^[a-z]+$/.test(a.sound) ? a.sound : "chime" };
  }

  // ---------------------------------------------------------------- Ringing
  const key = (a) => `${a.alarmId}@${new Date(a.at).toISOString()}`;
  function ring(a, { speech, fromServer = false } = {}) {
    if (!a.test && cache.rung.includes(key(a))) { if (!fromServer) return; if (st.ringing && key(st.ringing) === key(a)) return; }
    if (st.ringing && key(st.ringing) === key(a)) return;
    if (!a.test) { cache.rung.push(key(a)); saveCache(); }
    st.ringing = a; status();
    log("alarm ringing", a.label, a.at, a.test ? "(test)" : "");
    const title = serverSettings.profile?.title || "Sir";
    onRing({ ...a, ...soundFor(a), speech: speech || defaultSpeech(a, title), speak: serverSettings.alarms?.speak !== false });
    if (!a.test && !fromServer) report(`/api/alarms/${a.alarmId}/rang`, { scheduledFor: new Date(a.at).toISOString(), detail: "rang on the laptop" });
  }
  function defaultSpeech(a, title) {
    const tz = cache.timezone || undefined;
    const d = new Date(a.at);
    const h = Number(d.toLocaleString("en-GB", { timeZone: tz, hour: "2-digit", hour12: false })), mi = Number(d.toLocaleString("en-GB", { timeZone: tz, minute: "2-digit" }));
    const h12 = h % 12 || 12, ampm = h < 12 ? "AM" : "PM";
    const t = mi === 0 ? `${h12} ${ampm}` : mi === 30 ? `half past ${h12} ${ampm}` : `${h12}:${String(mi).padStart(2, "0")} ${ampm}`;
    const pod = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    return `Good ${pod}, ${title}. It is ${t}. ${a.message || (a.label && a.label !== "Alarm" ? `This is your ${a.label} alarm.` : pod === "morning" ? "Time to wake up." : "This is your alarm.")}`;
  }
  /** Called every second: ring anything due (and not more than 15 minutes late). */
  function check(now = Date.now()) {
    for (const a of cache.upcoming) {
      const t = Date.parse(a.at);
      if (t <= now && now - t < LATE_MS && !cache.rung.includes(key(a))) { ring(a); break; }
    }
  }
  function snooze(minutes) {
    const a = st.ringing; if (!a) return;
    st.ringing = null; onStopRing();
    const mins = Math.max(1, Math.min(60, Number(minutes) || a.snoozeMinutes || 10));
    if (a.test) return status();
    // Ring again locally even if the server can't be reached; the server is told too (and confirms).
    cache.upcoming.push({ ...a, at: new Date(Date.now() + mins * 60_000).toISOString(), snoozed: true });
    cache.upcoming.sort((x, y) => x.at.localeCompare(y.at)); saveCache();
    report(`/api/alarms/${a.alarmId}/snooze`, { minutes: mins });
    status(); scheduleWake();
  }
  function dismiss() {
    const a = st.ringing; if (!a) return;
    st.ringing = null; onStopRing(); status();
    if (!a.test) report(`/api/alarms/${a.alarmId}/dismiss`, {});
  }
  function audioResult(ok, detail) {
    const a = st.ringing;
    if (ok) status({ audioVerifiedAt: new Date().toISOString() });
    report(`/api/alarms/${a && !a.test ? a.alarmId : "test"}/event`, { event: ok ? "audio_verified" : "audio_failed", detail });
    report("/api/diagnostics/report", { check: "alarm_audio", status: ok ? "ok" : "error", detail });
  }

  // ---------------------------------------------------------------- Windows Task Scheduler: wake the laptop for the next alarm
  function xmlEscape(s) { return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c])); }
  function localIso(d) { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
  function taskXml(when) {
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Wakes the laptop and starts JARVIS for your next alarm.</Description></RegistrationInfo>
  <Triggers><TimeTrigger><StartBoundary>${localIso(when)}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled>
    <Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>true</WakeToRun><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Priority>5</Priority></Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(exePath)}</Command><Arguments>--hidden --alarm-check</Arguments></Exec></Actions>
</Task>`;
  }
  const schtasks = (args) => new Promise((resolve) => execFile("schtasks.exe", args, { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || err?.message || "") })));
  let lastWakePlanned = null;
  async function scheduleWake() {
    if (platform !== "win32") return status({ wakeTask: "unsupported" });
    const enabled = serverSettings.alarms?.wakeComputer !== false;
    const next = cache.upcoming.map((a) => Date.parse(a.at)).filter((t) => t > Date.now() + 60_000).sort((a, b) => a - b)[0];
    if (!enabled || !next) {
      if (lastWakePlanned !== "none") { await schtasks(["/Delete", "/TN", TASK_NAME, "/F"]); lastWakePlanned = "none"; }
      return status({ wakeTask: enabled ? "none" : "off", wakeAt: null, wakeError: null });
    }
    const when = new Date(next - 90_000);              // start a minute and a half early so JARVIS is up in time
    if (lastWakePlanned === when.toISOString()) return;
    const file = path.join(os.tmpdir(), `jarvis-wake-${process.pid}.xml`);
    // schtasks expects UTF-16 for an XML that declares it
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(when), "utf16le")]));
    const r = await schtasks(["/Create", "/TN", TASK_NAME, "/XML", file, "/F"]);
    try { fs.unlinkSync(file); } catch {}
    if (r.ok) { lastWakePlanned = when.toISOString(); status({ wakeTask: "ok", wakeAt: new Date(next).toISOString(), wakeError: null }); log("wake task set for", localIso(when)); }
    else { status({ wakeTask: "error", wakeError: r.err.trim().slice(0, 200) }); log("wake task failed", r.err); }
  }

  const tick = setInterval(() => check(), 1000);
  const resync = setInterval(() => sync().catch(() => {}), 10 * 60_000);
  status({ ready: cache.upcoming.length > 0 || !!cache.syncedAt });
  check();                                               // startup / --alarm-check: ring anything just due from the cache
  return {
    start: connect, sync, check, snooze, dismiss, audioResult, taskXml,
    get status() { return { ...st, scheduled: cache.upcoming.length }; },
    reconnect() { retry = 0; connect(); },
    stop() { stopped = true; clearInterval(tick); clearInterval(resync); clearTimeout(retryTimer); try { ws?.close(); } catch {} },
  };
}
