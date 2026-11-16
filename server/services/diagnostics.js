// Live diagnostics. Every status comes from a real check made just now (or a recorded real event such as the
// last AI call); anything that has never been checked shows as "unknown", never as healthy.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { db, dbPath, kvGet } from "../db.js";
import { config, ttsProvider } from "../config.js";
import { healthReport } from "./health.js";
import { connections } from "./oauth.js";
import { desktopAgents, connectedDevices } from "../realtime.js";
import { localAsrStatus } from "../local-asr.js";

// ---------------------------------------------------------------- Recording
export function recordApiCall({ provider, model = "", purpose = "", latencyMs, ok, error = null }) {
  try {
    db.prepare("INSERT INTO api_calls (provider, model, purpose, latency_ms, ok, error) VALUES (?, ?, ?, ?, ?, ?)")
      .run(provider, model, purpose, Math.round(latencyMs), ok ? 1 : 0, error ? String(error).slice(0, 300) : null);
  } catch {}
}
/** Time an upstream call and record it. */
export async function timed(provider, { model, purpose } = {}, fn) {
  const t0 = performance.now();
  try {
    const r = await fn();
    recordApiCall({ provider, model, purpose, latencyMs: performance.now() - t0, ok: true });
    return r;
  } catch (e) {
    recordApiCall({ provider, model, purpose, latencyMs: performance.now() - t0, ok: false, error: e.message });
    throw e;
  }
}
export function logError(source, message, detail = {}) {
  try { db.prepare("INSERT INTO error_log (source, message, detail) VALUES (?, ?, ?)").run(String(source).slice(0, 60), String(message).slice(0, 500), JSON.stringify(detail).slice(0, 2000)); } catch {}
}
export function prune() {
  db.prepare("DELETE FROM diag_history WHERE at < ?").run(new Date(Date.now() - 14 * 86400_000).toISOString());
  db.prepare("DELETE FROM api_calls WHERE at < ?").run(new Date(Date.now() - 30 * 86400_000).toISOString());
  db.prepare("DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT 2000)").run();
}

// ---------------------------------------------------------------- Helpers
const check = (name, label, group, status, detail, extra = {}) => ({ name, label, group, status, detail, checkedAt: new Date().toISOString(), ...extra });
const ago = (iso) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 1000) : null);
const fmtAgo = (s) => (s == null ? "never" : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`);
const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

async function cpuUsage(sampleMs = 250) {
  const snap = () => os.cpus().map((c) => c.times);
  const a = snap();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = snap();
  let idle = 0, total = 0;
  b.forEach((t, i) => {
    const p = a[i]; if (!p) return;
    const d = Object.keys(t).reduce((s, k) => s + (t[k] - p[k]), 0);
    total += d; idle += t.idle - p.idle;
  });
  return total > 0 ? Math.round(((total - idle) / total) * 100) : null;
}

export function aiMetrics(hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db.prepare("SELECT * FROM api_calls WHERE provider = 'anthropic' AND at >= ? ORDER BY id DESC").all(since);
  const ok = rows.filter((r) => r.ok);
  const lat = ok.map((r) => r.latency_ms).sort((x, y) => x - y);
  return {
    calls: rows.length, errors: rows.length - ok.length,
    errorRate: rows.length ? Math.round(((rows.length - ok.length) / rows.length) * 100) : 0,
    medianMs: lat.length ? lat[Math.floor(lat.length / 2)] : null, p95Ms: lat.length ? lat[Math.floor(lat.length * 0.95)] : null,
    last: rows[0] || null, lastError: rows.find((r) => !r.ok) || null,
  };
}

// ---------------------------------------------------------------- Checks
async function hardware() {
  const cpu = await cpuUsage();
  const total = os.totalmem(), free = os.freemem();
  const ramPct = Math.round(((total - free) / total) * 100);
  let disk = null;
  try { const s = fs.statfsSync(config.dataDir); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
  const diskPct = disk ? Math.round(((disk.total - disk.free) / disk.total) * 100) : null;
  const ifaces = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).filter((i) => !i.internal && i.family === "IPv4").map((i) => ({ name, address: i.address })));
  const tailscale = ifaces.find((i) => /tailscale/i.test(i.name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address));
  let internet = null;
  const t0 = performance.now();
  try { await Promise.race([dns.lookup("api.anthropic.com"), new Promise((_, r) => setTimeout(() => r(new Error("DNS timeout")), 3000))]); internet = { ok: true, ms: Math.round(performance.now() - t0) }; }
  catch (e) { internet = { ok: false, error: e.message }; }
  const proc = process.memoryUsage();
  return [
    check("cpu", "Processor", "hardware", cpu == null ? "unknown" : cpu > 90 ? "warn" : "ok", cpu == null ? "Could not read CPU usage" : `${cpu}% in use · ${os.cpus().length} cores · ${os.cpus()[0]?.model?.trim() || ""}`, { value: cpu }),
    check("ram", "Memory (RAM)", "hardware", ramPct > 92 ? "warn" : "ok", `${ramPct}% in use · ${bytes(total - free)} of ${bytes(total)} · JARVIS server ${bytes(proc.rss)}`, { value: ramPct }),
    check("storage", "Storage", "hardware", diskPct == null ? "unknown" : disk.free < 1e9 ? "error" : disk.free < 5e9 ? "warn" : "ok", disk ? `${bytes(disk.free)} free of ${bytes(disk.total)} (${diskPct}% used)` : "Could not read disk space", { value: diskPct }),
    check("network", "Network", "hardware", internet.ok ? "ok" : ifaces.length ? "warn" : "error",
      internet.ok ? `Online · DNS ${internet.ms} ms · ${ifaces.length} interface(s)${tailscale ? " · Tailscale up" : ""}` : `${ifaces.length ? "Connected to a network but" : "No network and"} the internet can't be reached (${internet.error})`, { tailscale: !!tailscale }),
    check("uptime", "System uptime", "hardware", "ok", `Computer up ${Math.round(os.uptime() / 3600)} h · JARVIS server up ${Math.round(process.uptime() / 60)} min · ${os.platform()} ${os.release()}`),
  ];
}

function database() {
  const out = [];
  let status = "ok", detail;
  try {
    const qc = db.prepare("PRAGMA quick_check").get();
    const ok = Object.values(qc)[0] === "ok";
    const size = fs.statSync(dbPath).size + (fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0);
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
    status = ok ? "ok" : "error";
    detail = `${ok ? "Integrity check passed" : "INTEGRITY PROBLEM: " + Object.values(qc)[0]} · ${bytes(size)} · schema ${version}`;
  } catch (e) { status = "error"; detail = e.message; }
  out.push(check("database", "Database", "data", status, detail));
  const b = kvGet("backup.last");
  const age = ago(b?.at);
  out.push(check("backup", "Backups", "data", !b ? "warn" : age > 2 * 86400 ? "warn" : "ok", b ? `Last backup ${fmtAgo(age)} (${b.file})` : "No backup has been made yet"));
  const mem = db.prepare("SELECT COUNT(*) AS n, SUM(status = 'pending') AS p FROM memories").get();
  out.push(check("memory", "Memory system", "data", "ok", `${mem.n} memories${mem.p ? ` · ${mem.p} waiting for your approval` : ""} · search: ${config.openaiKey ? "semantic (OpenAI embeddings)" : "keyword"}`));
  return out;
}

function ai() {
  const m = aiMetrics();
  const lastTest = kvGet("diag.aiTest");
  if (!config.anthropicKey) return [check("ai", "AI (Anthropic)", "ai", "off", "No Anthropic API key — add one in the tray menu → API keys & AI model.")];
  let status = "unknown", detail;
  const lastOkAt = m.last?.ok ? m.last.at : lastTest?.ok ? lastTest.at : null;
  if (m.last && !m.last.ok && (!lastTest || lastTest.at < m.last.at)) { status = "error"; detail = `Last request failed ${fmtAgo(ago(m.last.at))}: ${m.last.error}`; }
  else if (lastTest && !lastTest.ok && (!m.last || lastTest.at > m.last.at)) { status = "error"; detail = `Connection test failed ${fmtAgo(ago(lastTest.at))}: ${lastTest.error}`; }
  else if (lastOkAt) { status = m.errorRate > 20 ? "warn" : "ok"; detail = `${config.model} · last success ${fmtAgo(ago(lastOkAt))}`; }
  else detail = `${config.model} · not used yet — press Test to check the connection`;
  return [check("ai", "AI (Anthropic)", "ai", status, detail, { metrics: m, model: config.model, lastTest })];
}

function voice() {
  const tts = ttsProvider();
  const asr = localAsrStatus();
  const agents = desktopAgents().filter((a) => a.online);
  const st = agents[0]?.status || {};
  const lastTts = db.prepare("SELECT * FROM api_calls WHERE provider IN ('elevenlabs','openai-tts') ORDER BY id DESC LIMIT 1").get();
  return [
    check("tts", "Voice output", "voice", tts ? (lastTts && !lastTts.ok ? "error" : lastTts ? "ok" : "unknown") : "ok",
      tts ? `${tts === "elevenlabs" ? "ElevenLabs" : "OpenAI"} voice${lastTts ? ` · last ${lastTts.ok ? `OK in ${lastTts.latency_ms} ms` : `failed: ${lastTts.error}`} ${fmtAgo(ago(lastTts.at))}` : " · not used yet"}` : "Built-in Windows voice (free, offline). Add an ElevenLabs key for the premium British voice."),
    check("stt", "Speech recognition", "voice", asr.available ? "ok" : config.openaiKey ? "ok" : "error",
      asr.available ? `${asr.model}${asr.error ? ` · ${asr.error}` : ""}` : config.openaiKey ? "OpenAI Whisper (cloud)" : `Unavailable${asr.error ? `: ${asr.error}` : " — the on-device model is missing"}`),
    check("mic", "Microphone & wake word", "voice", !agents.length ? "unknown" : st.error ? "error" : st.muted ? "warn" : st.mic === "ok" || st.listening ? "ok" : "warn",
      !agents.length ? "The Windows app isn't connected, so the microphone can't be checked." : st.error ? `Problem: ${st.error}` : st.muted ? "Muted — say nothing will wake JARVIS until you unmute." : `${st.micDevice || "Default microphone"} · wake word ${st.wakeWord || "off"}${st.lastWake ? ` · last wake ${fmtAgo(ago(st.lastWake))}` : ""}`),
  ];
}

function integrations() {
  const conns = connections.all();
  const out = [];
  const monzo = conns.find((c) => c.provider === "monzo");
  out.push(check("monzo", "Monzo (read-only)", "integrations",
    !(config.monzoClientId && config.monzoClientSecret) ? "off" : !monzo ? "off" : monzo.status === "active" ? (ago(monzo.last_sync_at) > 3600 ? "warn" : "ok") : monzo.status === "pending_approval" ? "warn" : "error",
    !(config.monzoClientId && config.monzoClientSecret) ? "Not set up — add the Monzo client ID and secret in API keys." : !monzo ? "Not connected." : monzo.status === "active" ? `Connected · synced ${fmtAgo(ago(monzo.last_sync_at))}` : monzo.status === "pending_approval" ? "Waiting for you to approve JARVIS in the Monzo app." : `${monzo.status}: ${monzo.last_error || "reconnect Monzo"}`));
  const g = conns.find((c) => c.provider === "google");
  out.push(check("google", "Google Calendar", "integrations",
    !(config.googleClientId && config.googleClientSecret) ? "off" : !g ? "off" : g.status === "active" ? "ok" : "error",
    !(config.googleClientId && config.googleClientSecret) ? "Not set up — JARVIS's own calendar is in use." : !g ? "Not connected — JARVIS's own calendar is in use." : g.status === "active" ? `Connected · synced ${fmtAgo(ago(g.last_sync_at))}` : `${g.status}: ${g.last_error || "reconnect Google"}`));
  const services = healthReport();
  const weather = services.find((x) => x.name === "weather");
  out.push(check("weather", "Weather (Open-Meteo)", "integrations", !weather || weather.state === "waiting" ? "unknown" : weather.state === "ok" ? "ok" : weather.state === "error" ? "error" : "warn",
    weather?.lastError ? `Error: ${weather.lastError}` : weather?.lastOk ? `Updated ${fmtAgo(ago(weather.lastOk))}` : "Not fetched yet"));
  const ha = kvGet("smarthome.status");
  out.push(check("smarthome", "Home Assistant", "integrations", !(config.haUrl && config.haToken) ? "off" : !ha ? "unknown" : ha.ok ? "ok" : "error",
    !(config.haUrl && config.haToken) ? "Not set up (optional)." : !ha ? "Not checked yet" : ha.ok ? `Connected · ${ha.devices ?? 0} devices · checked ${fmtAgo(ago(ha.at))}` : `Unreachable: ${ha.error}`));
  const subs = db.prepare("SELECT COUNT(*) AS n FROM push_subs").get().n;
  out.push(check("push", "Phone notifications", "integrations", subs ? "ok" : "off", subs ? `${subs} device(s) subscribed` : "No phone has turned on notifications yet."));
  return out;
}

function background() {
  return healthReport().map((sv) => check(`svc:${sv.name}`, sv.label, "services",
    { ok: "ok", waiting: "unknown", not_configured: "off", disabled: "off", error: "error", stale: "warn" }[sv.state] || "unknown",
    sv.lastError ? `Error ${fmtAgo(ago(sv.lastErrorAt))}: ${sv.lastError}` : sv.lastOk ? `Last ran OK ${fmtAgo(ago(sv.lastOk))}${sv.note ? ` · ${sv.note}` : ""}` : sv.note || "Has not run yet"));
}

function devices() {
  const agents = desktopAgents();
  const out = agents.map((a) => check(`desktop:${a.deviceId}`, a.deviceName || "Windows app", "devices", a.online ? (a.status?.error ? "warn" : "ok") : "error",
    a.online ? `Connected · ${a.status?.version ? `v${a.status.version}` : ""}${a.status?.computer === false ? " · computer control off" : ""}` : `Disconnected ${fmtAgo(ago(a.offlineAt))}`));
  if (!agents.length) out.push(check("desktop", "Windows app", "devices", "unknown", "No Windows app has connected since the server started."));
  out.push(check("clients", "Open apps", "devices", "ok", `${connectedDevices().length} device(s) connected live`));
  return out;
}

/** Run every check now. */
export async function runDiagnostics({ record = false } = {}) {
  const checks = [...ai(), ...voice(), ...database(), ...integrations(), ...devices(), ...background(), ...(await hardware())];
  if (record) {
    const ins = db.prepare("INSERT INTO diag_history (check_name, status, latency_ms, detail) VALUES (?, ?, ?, ?)");
    for (const c of checks) ins.run(c.name, c.status, c.metrics?.medianMs ?? null, String(c.detail).slice(0, 300));
    prune();
  }
  const counts = checks.reduce((a, c) => ((a[c.status] = (a[c.status] || 0) + 1), a), {});
  return {
    at: new Date().toISOString(),
    overall: counts.error ? "error" : counts.warn ? "warn" : "ok",
    counts, checks,
    version: process.env.JARVIS_VERSION || process.env.npm_package_version || "",
  };
}

export function history({ check: name, hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  return name
    ? db.prepare("SELECT * FROM diag_history WHERE check_name = ? AND at >= ? ORDER BY id").all(name, since)
    : db.prepare("SELECT * FROM diag_history WHERE at >= ? ORDER BY id").all(since);
}
export function logs(limit = 200) {
  return {
    errors: db.prepare("SELECT * FROM error_log ORDER BY id DESC LIMIT ?").all(limit),
    apiCalls: db.prepare("SELECT * FROM api_calls ORDER BY id DESC LIMIT ?").all(Math.min(limit, 200)),
    audit: db.prepare("SELECT a.id, a.at, a.action, a.detail, d.name AS device FROM audit_log a LEFT JOIN devices d ON d.id = a.device_id ORDER BY a.id DESC LIMIT 100").all().map((r) => ({ ...r, detail: JSON.parse(r.detail || "{}") })),
  };
}

/** "Test connection" buttons: make a real, cheap request to the service and report exactly what happened. */
export async function testCheck(name, { client } = {}) {
  const t0 = performance.now();
  const done = (ok, detail) => ({ name, ok, detail, latencyMs: Math.round(performance.now() - t0), at: new Date().toISOString() });
  try {
    switch (name) {
      case "ai": {
        if (!client) return done(false, "No Anthropic API key is set.");
        const m = await client.models.retrieve(config.model);
        const r = done(true, `Reached Anthropic; model ${m.id} is available on your key.`);
        recordApiCall({ provider: "anthropic", model: config.model, purpose: "test", latencyMs: r.latencyMs, ok: true });
        (await import("../db.js")).kvSet("diag.aiTest", { ok: true, at: r.at, latencyMs: r.latencyMs });
        return r;
      }
      case "weather": {
        const { getWeather } = await import("../integrations/weather.js");
        const { getSettings } = await import("../db.js");
        const w = await getWeather({ ...getSettings().home, units: getSettings().units });
        return done(true, `${w.place}: ${w.current.temp}${w.unitTemp}, ${w.current.summary} (${w.cached ? "cached copy" : "fresh"} from ${w.source})`);
      }
      case "monzo": {
        const finance = await import("../finance/service.js");
        const r = await finance.syncAll();
        return done(!r.errors && r.connections > 0, r.connections ? `${r.connections} connection(s) synced${r.errors ? `, ${r.errors} failed` : ""}` : "Monzo isn't connected.");
      }
      case "google": {
        const cal = await import("./calendar.js");
        const r = await cal.syncGoogle();
        return done(!!r.synced, r.synced ? `Synced ${r.events} events` : "Google Calendar isn't connected.");
      }
      case "smarthome": {
        const sh = await import("./smarthome.js");
        const r = await sh.ping();
        return done(r.ok, r.ok ? `Home Assistant answered: ${r.message}` : r.error);
      }
      case "tts": {
        const p = ttsProvider();
        if (!p) return done(true, "Using the built-in Windows voice; nothing to test on the server.");
        const url = p === "elevenlabs" ? `${config.elevenBaseUrl}/v1/user` : `${config.openaiBaseUrl}/v1/models`;
        const res = await fetch(url, { headers: p === "elevenlabs" ? { "xi-api-key": config.elevenKey } : { authorization: `Bearer ${config.openaiKey}` }, signal: AbortSignal.timeout(8000) });
        recordApiCall({ provider: p === "elevenlabs" ? "elevenlabs" : "openai-tts", purpose: "test", latencyMs: performance.now() - t0, ok: res.ok, error: res.ok ? null : `HTTP ${res.status}` });
        return done(res.ok, res.ok ? `${p === "elevenlabs" ? "ElevenLabs" : "OpenAI"} accepted the key.` : `${p} rejected the request (HTTP ${res.status}).`);
      }
      case "stt": {
        const s = localAsrStatus();
        if (!s.available) return done(!!config.openaiKey, config.openaiKey ? "On-device model missing; OpenAI Whisper will be used." : `No speech recognition available${s.error ? `: ${s.error}` : ""}.`);
        const { transcribeLocal } = await import("../local-asr.js");
        const silence = Buffer.alloc(44 + 16000 * 2);
        silence.write("RIFF", 0); silence.writeUInt32LE(36 + 32000, 4); silence.write("WAVEfmt ", 8); silence.writeUInt32LE(16, 16); silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22);
        silence.writeUInt32LE(16000, 24); silence.writeUInt32LE(32000, 28); silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34); silence.write("data", 36); silence.writeUInt32LE(32000, 40);
        await transcribeLocal(silence);
        return done(true, "The on-device Whisper model loaded and ran.");
      }
      case "database": {
        const r = db.prepare("PRAGMA integrity_check").get();
        const v = Object.values(r)[0];
        return done(v === "ok", v === "ok" ? "Full integrity check passed." : `Integrity check: ${v}`);
      }
      case "network": {
        await dns.lookup("api.anthropic.com");
        return done(true, `Internet reachable (DNS ${Math.round(performance.now() - t0)} ms).`);
      }
      case "push": {
        const { notifyAll } = await import("../push.js");
        const n = await notifyAll({ title: "JARVIS", body: "Test notification — notifications are working, Sir.", tag: "diag-test", url: "/?tab=diagnostics" });
        return done(n > 0, n ? `Delivered to ${n} device(s).` : "No phone is subscribed to notifications.");
      }
      default: return done(false, `There is no test for "${name}".`);
    }
  } catch (e) {
    if (name === "ai") { (await import("../db.js")).kvSet("diag.aiTest", { ok: false, at: new Date().toISOString(), error: e.message }); recordApiCall({ provider: "anthropic", model: config.model, purpose: "test", latencyMs: performance.now() - t0, ok: false, error: e.message }); }
    logError(`test:${name}`, e.message);
    return done(false, e.message);
  }
}
export const TESTABLE = ["ai", "weather", "monzo", "google", "smarthome", "tts", "stt", "database", "network", "push"];
void path;
