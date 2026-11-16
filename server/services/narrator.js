// Cinematic diagnostics and system awareness. Every line JARVIS says is generated from a real check made just now;
// the phrasing varies, the facts never do. Failures are reported with the real error. Untested things are never "passed".
import os from "node:os";
import { db, getSettings } from "../db.js";
import { config } from "../config.js";
import { runDiagnostics, testCheck, aiMetrics, logError } from "./diagnostics.js";
import { healthReport } from "./health.js";
import { desktopAgents, onlineDesktop, requestDesktop } from "../realtime.js";
import { alarms } from "./alarms.js";
import { memory } from "./memory.js";

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const title = () => getSettings().profile?.title || "Sir";

export const LEVELS = {
  quick: { label: "Quick diagnostics", checks: ["ai", "stt", "mic", "database", "network", "services"], tests: [] },
  full: { label: "Full system diagnostics", checks: ["ai", "stt", "tts", "mic", "memory", "database", "backup", "alarms", "services", "network", "cpu", "ram", "storage", "monzo", "google", "weather", "smarthome", "push"], tests: ["ai", "database", "network", "stt", "weather"] },
  voice: { label: "Voice diagnostics", checks: ["stt", "tts", "mic"], tests: ["stt", "tts"] },
  ai: { label: "AI diagnostics", checks: ["ai"], tests: ["ai"] },
  network: { label: "Network diagnostics", checks: ["network"], tests: ["network", "weather"] },
  security: { label: "Security diagnostics", checks: ["security"], tests: [] },
  performance: { label: "Performance diagnostics", checks: ["performance", "cpu", "ram"], tests: [] },
  hardware: { label: "Hardware diagnostics", checks: ["cpu", "ram", "storage", "uptime"], tests: [] },
  integrations: { label: "Integration diagnostics", checks: ["monzo", "google", "weather", "smarthome", "push"], tests: ["weather"] },
};
const NAMES = {
  ai: "Artificial intelligence core", stt: "Voice recognition", tts: "Speech output", mic: "Microphone and wake word", memory: "Memory architecture",
  database: "Primary database", backup: "Backup systems", alarms: "Alarm engine", services: "Background services", network: "Network connectivity",
  cpu: "Processor", ram: "System memory", storage: "Storage", uptime: "System uptime", monzo: "Monzo link", google: "Google Calendar link", weather: "Weather feed",
  smarthome: "Home Assistant link", push: "Phone notifications", security: "Security posture", performance: "Performance",
};
const OPEN = {
  quick: ["Running a quick systems check, {t}.", "Quick diagnostics initiated, {t}."],
  full: ["Certainly, {t}. Initiating full system diagnostics.", "Running a comprehensive systems analysis, {t}.", "Beginning full diagnostics, {t}. Scanning primary systems."],
  voice: ["Calibrating audio systems, {t}. Running voice diagnostics.", "Checking the voice interface, {t}."],
  ai: ["Testing the artificial intelligence core, {t}.", "Establishing a test link to the AI core, {t}."],
  network: ["Checking communications, {t}.", "Testing network connectivity, {t}."],
  security: ["Reviewing security posture, {t}.", "Running security diagnostics, {t}."],
  performance: ["Measuring performance, {t}.", "Profiling active systems, {t}."],
  hardware: ["Scanning hardware, {t}.", "Running hardware diagnostics, {t}."],
  integrations: ["Checking external links, {t}.", "Synchronising with connected services, {t}."],
};
const LINE = {
  ok: ["{n} is operational.", "{n}: online and responding.", "{n} checks out.", "{n} is responding normally."],
  warn: ["{n} needs attention: {d}.", "Caution — {n}: {d}."],
  error: ["{n} has a fault: {d}.", "I've detected a problem with {n}: {d}."],
  off: ["{n} isn't set up.", "{n}: not configured."],
  unknown: ["{n} couldn't be verified yet: {d}.", "{n}: no evidence either way yet — {d}."],
};
const CLOSE = {
  ok: ["All checked systems have completed their checks. Your system is operational, {t}. Standing by.", "Diagnostics complete. Everything I checked is in order, {t}.", "System integrity confirmed, {t}. Standing by."],
  warn: ["Diagnostics complete, {t}. {k} item{s} need{v} attention; everything else is operational.", "Checks complete. Primary systems are operational, but {k} item{s} need{v} attention, {t}."],
  error: ["Diagnostics complete, {t}. I found {k} fault{s}. Would you like me to investigate?", "Sir, {k} system{s} reported a fault. Details are on screen. Shall I investigate?".replace("Sir", "{t}")],
};
const fill = (s, v) => s.replace(/\{(\w)\}/g, (_, k) => v[k] ?? "");

/** Extra real checks that aren't in the standard diagnostics list. */
async function securityCheck() {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const failed = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.failed' AND at >= ?").get(since).n;
  const devices = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL").get().n;
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?").get(new Date().toISOString()).n;
  const local = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  const issues = [];
  if (failed >= 3) issues.push(`${failed} failed sign-ins in 24 h`);
  if (!config.encryptionKey) issues.push("no encryption key for stored tokens");
  if (!local && config.hosting === "laptop") issues.push("server is listening beyond this laptop");
  return { name: "security", status: issues.length ? "warn" : "ok", detail: `${devices} signed-in device(s), ${sessions} active session(s), ${failed} failed sign-in(s) in 24 h, server ${local ? "private to this laptop" : `on ${config.host}`}, tokens ${config.encryptionKey ? "encrypted" : "NOT encrypted"}${issues.length ? ` — ${issues.join("; ")}` : ""}` };
}
async function performanceCheck() {
  const lag = await new Promise((r) => { const t = performance.now(); setTimeout(() => r(performance.now() - t - 20), 20); });
  const t0 = performance.now(); db.prepare("SELECT COUNT(*) FROM messages").get(); db.prepare("SELECT * FROM tasks WHERE done = 0 ORDER BY due LIMIT 20").all(); const dbMs = performance.now() - t0;
  const m = aiMetrics(24);
  const stt = db.prepare("SELECT latency_ms FROM api_calls WHERE provider LIKE 'stt-%' AND ok = 1 AND at >= ? ORDER BY latency_ms").all(new Date(Date.now() - 86400_000).toISOString()).map((r) => r.latency_ms);
  const sttMed = stt.length ? stt[Math.floor(stt.length / 2)] : null;
  const rss = process.memoryUsage().rss / 1e6;
  const slow = lag > 100 || dbMs > 50 || (m.medianMs && m.medianMs > 8000);
  return { name: "performance", status: slow ? "warn" : "ok", detail: `event loop lag ${Math.max(0, lag).toFixed(0)} ms, database ${dbMs.toFixed(1)} ms, AI median ${m.medianMs ?? "—"} ms (${m.calls} calls/24 h), speech recognition median ${sttMed ?? "—"} ms, server memory ${rss.toFixed(0)} MB`, metrics: { lagMs: Math.max(0, +lag.toFixed(1)), dbMs: +dbMs.toFixed(2), aiMedianMs: m.medianMs, aiP95Ms: m.p95Ms, sttMedianMs: sttMed, rssMb: +rss.toFixed(0) } };
}
function alarmCheck() {
  const sch = alarms.schedule(48), agent = desktopAgents().find((a) => a.online);
  const st = agent?.status?.alarms;
  return { name: "alarms", status: "ok", detail: `${sch.upcoming.length} ring(s) scheduled in the next 48 h${sch.upcoming[0] ? `, next ${sch.upcoming[0].label} at ${new Date(sch.upcoming[0].at).toLocaleString("en-GB", { timeZone: getSettings().timezone, weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}${agent ? "; laptop agent connected" : "; laptop agent not connected"}${st?.wakeTask ? `, wake task ${st.wakeTask}` : ""}` };
}
function servicesCheck(report) {
  const bad = report.filter((s) => s.state === "error"), stale = report.filter((s) => s.state === "stale");
  return { name: "services", status: bad.length ? "error" : stale.length ? "warn" : "ok", detail: bad.length ? bad.map((s) => `${s.label}: ${s.lastError}`).join("; ") : stale.length ? `${stale.map((s) => s.label).join(", ")} running late` : `${report.filter((s) => s.state === "ok").length} services responding` };
}
function memoryCheck() {
  const n = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'saved'").get().n;
  const t0 = performance.now(); memory.profileBlock(); const ms = performance.now() - t0;
  const mode = getSettings().memory?.mode || "ask";
  return { name: "memory", status: mode === "off" ? "off" : "ok", detail: mode === "off" ? "switched off by you" : `${n} memories accessible, profile assembled in ${ms.toFixed(1)} ms` };
}

/** Run a diagnostic level: real checks (+ real tests where the level calls for them), narrated. */
export async function runLevel(level = "quick", { client, record = true } = {}) {
  const L = LEVELS[level] || LEVELS.quick;
  const t0 = performance.now();
  const testResults = {};
  await Promise.all(L.tests.map(async (n) => { testResults[n] = await testCheck(n, { client }); }));
  const snap = await runDiagnostics();
  const byName = Object.fromEntries(snap.checks.map((c) => [c.name, c]));
  const results = [];
  for (const n of L.checks) {
    let r;
    if (n === "security") r = await securityCheck();
    else if (n === "performance") r = await performanceCheck();
    else if (n === "alarms") r = alarmCheck();
    else if (n === "services") r = servicesCheck(healthReport());
    else if (n === "memory") r = memoryCheck();
    else if (byName[n]) r = { name: n, status: byName[n].status, detail: byName[n].detail };
    else continue;
    const t = testResults[n];
    if (t && r.status !== "off") r = { ...r, status: t.ok ? (r.status === "warn" ? "warn" : "ok") : "error", detail: t.ok ? `${t.detail} (${t.latencyMs} ms)` : `test failed — ${t.detail}`, tested: true, latencyMs: t.latencyMs };
    results.push({ ...r, label: NAMES[n] || n });
  }
  const problems = results.filter((r) => r.status === "error" || r.status === "warn");
  const overall = results.some((r) => r.status === "error") ? "error" : problems.length ? "warn" : "ok";
  const v = { t: title() };
  const narration = [fill(pick(OPEN[level] || OPEN.quick), v)];
  for (const r of results) narration.push(fill(pick(LINE[r.status] || LINE.unknown), { n: r.label, d: String(r.detail).replace(/\.$/, "") }));
  const k = problems.length;
  narration.push(fill(pick(CLOSE[overall]), { ...v, k: String(k), s: k === 1 ? "" : "s", v: k === 1 ? "s" : "" }));
  const durationMs = Math.round(performance.now() - t0);
  if (record) {
    try { db.prepare("INSERT INTO diagnostic_runs (level, overall, duration_ms, summary, narration) VALUES (?, ?, ?, ?, ?)").run(level, overall, durationMs, JSON.stringify(results), JSON.stringify(narration)); }
    catch (e) { logError("diagnostics", e.message); }
  }
  return { level, label: L.label, overall, results, problems, narration, durationMs, at: new Date().toISOString() };
}
// Whole-machine CPU use since the previous call (no sampling delay; the first call has no baseline).
let prevCpu = null;
function cpuSince() {
  const c = os.cpus().reduce((a, x) => { const t = x.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { idle: 0, total: 0 });
  const p = prevCpu; prevCpu = c;
  return p && c.total > p.total ? Math.round(100 * (1 - (c.idle - p.idle) / (c.total - p.total))) : null;
}
export async function performanceMetrics() {
  const p = await performanceCheck();
  const cpuPct = cpuSince(), ramPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  const since = new Date(Date.now() - 86400_000).toISOString();
  const lat = (prov) => { const l = db.prepare("SELECT latency_ms FROM api_calls WHERE provider LIKE ? AND ok = 1 AND at >= ? ORDER BY latency_ms").all(prov, since).map((r) => r.latency_ms); return { n: l.length, medianMs: l.length ? l[Math.floor(l.length / 2)] : null, p95Ms: l.length ? l[Math.floor(l.length * 0.95)] : null }; };
  return { at: new Date().toISOString(), cpuPct, ramPct, ...p.metrics, ai: lat("anthropic"), sttLocal: lat("stt-local"), sttCloud: lat("stt-openai"), uptimeSec: Math.round(process.uptime()), loadAvg: os.loadavg(), cores: os.cpus().length };
}
export function diagnosticHistory(limit = 30) {
  return db.prepare("SELECT * FROM diagnostic_runs ORDER BY id DESC LIMIT ?").all(limit).map((r) => ({ ...r, summary: JSON.parse(r.summary), narration: JSON.parse(r.narration) }));
}

/** "How are you performing?", "What's using the most resources?", "Have you detected any errors?" — live facts. */
export async function systemAwareness() {
  const snap = await runDiagnostics();
  const perf = await performanceCheck();
  const errors = db.prepare("SELECT at, source, message FROM error_log WHERE at >= ? ORDER BY id DESC LIMIT 8").all(new Date(Date.now() - 86400_000).toISOString());
  let topProcesses = null;
  const desk = onlineDesktop();
  if (desk) { const r = await requestDesktop(desk.deviceId, { action: "system_status", args: {} }, 8000); if (r.ok) topProcesses = r.result; }
  const g = (n) => snap.checks.find((c) => c.name === n);
  return {
    overall: snap.overall, problems: snap.checks.filter((c) => ["error", "warn"].includes(c.status)).map((c) => `${c.label}: ${c.detail}`),
    resources: { cpu: g("cpu")?.detail, ram: g("ram")?.detail, storage: g("storage")?.detail, jarvisServerMemoryMb: perf.metrics.rssMb, cores: os.cpus().length },
    laptop: topProcesses || "The Windows app isn't connected, so I can't see other programs' resource use.",
    performance: perf.metrics, errorsLast24h: errors,
  };
}
