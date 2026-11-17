// Start-up checks for the boot screen. Each check does real work (reads the database, writes a test file, calls the
// AI provider, fetches the weather…) and reports one of a fixed set of statuses. Nothing here is a canned success.
//   operational · connected · degraded · not_configured · permission_required · offline · failed · initialising
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { db, getSettings, kvGet } from "../db.js";
import { config, ttsProvider } from "../config.js";
import { testCheck } from "./diagnostics.js";
import { healthReport } from "./health.js";
import { localAsrStatus, localAsrReadiness } from "../local-asr.js";

let PKG_VERSION = "";
try { PKG_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version; } catch {}
export const appVersion = () => process.env.JARVIS_VERSION || PKG_VERSION || process.env.npm_package_version || "";
const mb = (n) => `${(n / 1e9).toFixed(1)} GB`;
const netDown = (msg) => /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|timeout|aborted/i.test(msg || "");
async function cpuPercent(ms = 200) {
  const snap = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { idle: 0, total: 0 });
  const a = snap(); await new Promise((r) => setTimeout(r, ms)); const b = snap();
  return b.total > a.total ? Math.round(100 * (1 - (b.idle - a.idle) / (b.total - a.total))) : null;
}
function osName() {
  if (process.platform === "win32") {
    const build = Number(os.release().split(".")[2] || 0);
    const v = os.version?.() || "Windows";
    return `${build >= 22000 ? v.replace(/Windows 10/, "Windows 11") : v} (build ${build || os.release()})`;
  }
  return process.platform === "darwin" ? `macOS ${os.release()}` : `${os.type()} ${os.release()}`;
}

/** name → { label, critical, run(ctx) → { status, detail } } */
export const BOOT_CHECKS = {
  runtime: { label: "Application runtime", critical: true, async run() {
    return { status: "operational", detail: `JARVIS ${appVersion()} · Node ${process.version} · server up ${Math.round(process.uptime())} s` };
  } },
  os: { label: "Operating system", async run() {
    return { status: "operational", detail: `${osName()} · ${os.arch()}` };
  } },
  hardware: { label: "Hardware", async run() {
    const cpus = os.cpus(), total = os.totalmem(), free = os.freemem(), used = Math.round(((total - free) / total) * 100);
    const cpu = await cpuPercent();
    const busy = (cpu != null && cpu > 90) || used > 92;
    return { status: busy ? "degraded" : "operational", detail: `${cpus.length} cores · ${(cpus[0]?.model || "CPU").replace(/\s+/g, " ").trim()} · CPU ${cpu ?? "?"}% · memory ${used}% of ${mb(total)}${busy ? " — under heavy load" : ""}` };
  } },
  database: { label: "Database", critical: true, async run() {
    const t0 = performance.now();
    db.prepare("SELECT 1").get();
    const schema = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v || "?";
    const tasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE done = 0").get().n;
    let size = 0; try { size = fs.statSync(path.join(config.dataDir, "jarvis.db")).size; } catch {}
    return { status: "operational", detail: `online · schema ${schema} · ${(size / 1e6).toFixed(1)} MB · ${tasks} open tasks · query ${(performance.now() - t0).toFixed(1)} ms` };
  } },
  storage: { label: "Local storage", critical: true, async run() {
    const probe = path.join(config.dataDir, `.boot-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "ok"); const back = fs.readFileSync(probe, "utf8"); fs.rmSync(probe, { force: true });
    if (back !== "ok") return { status: "failed", detail: "the data folder didn't read back what was written" };
    let free = null; try { const s = fs.statfsSync(config.dataDir); free = s.bavail * s.bsize; } catch {}
    const backup = kvGet("backup.last", null);
    return { status: free != null && free < 2e9 ? "degraded" : "operational", detail: `data folder writable${free != null ? ` · ${mb(free)} free` : ""}${backup?.at ? ` · last backup ${new Date(backup.at).toLocaleDateString("en-GB")}` : ""}${free != null && free < 2e9 ? " — disk nearly full" : ""}` };
  } },
  ai: { label: "AI provider", async run({ client }) {
    if (!config.anthropicKey || !client) return { status: "not_configured", detail: "no Anthropic key — add one in the tray menu → API keys & AI model" };
    const r = await testCheck("ai", { client });
    if (r.ok) return { status: "connected", detail: `Anthropic responded in ${r.latencyMs} ms · ${config.model}` };
    return { status: netDown(r.detail) ? "offline" : "failed", detail: r.detail };
  } },
  stt: { label: "Voice input (speech recognition)", async run() {
    const state = localAsrReadiness();
    if (state === "loading" || state === "idle") return { status: "initialising", detail: `loading the on-device speech model (${localAsrStatus().model || "local"})…` };
    if (state === "ready") {
      const r = await testCheck("stt");
      return r.ok ? { status: "operational", detail: `${localAsrStatus().model} · test decode ${r.latencyMs} ms` } : { status: "failed", detail: r.detail };
    }
    if (config.openaiKey) return { status: "degraded", detail: `on-device model ${state === "error" ? `failed to load (${localAsrStatus().error})` : "not installed"} · using OpenAI Whisper (cloud)` };
    return { status: "failed", detail: state === "error" ? `the on-device model failed to load: ${localAsrStatus().error}` : "no speech recognition installed" };
  } },
  tts: { label: "Speech synthesis (cloud voice)", async run() {
    const p = ttsProvider();
    if (!p) return { status: "not_configured", detail: "no cloud voice set — the built-in system voice is used" };
    const r = await testCheck("tts");
    return r.ok ? { status: "connected", detail: `${p === "elevenlabs" ? "ElevenLabs" : "OpenAI"} voice reachable · ${r.latencyMs} ms (account check, no speech generated)` } : { status: netDown(r.detail) ? "offline" : "failed", detail: r.detail };
  } },
  scheduler: { label: "Background scheduler", async run() {
    const rep = healthReport().filter((s) => s.state !== "not_configured" && s.state !== "disabled");
    const bad = rep.filter((s) => s.state === "error"), late = rep.filter((s) => s.state === "stale");
    const ok = rep.filter((s) => s.state === "ok" || s.state === "waiting").length;
    if (bad.length) return { status: "degraded", detail: `${ok} of ${rep.length} services running · problem: ${bad.map((s) => `${s.label} (${s.lastError})`).join("; ")}` };
    if (late.length) return { status: "degraded", detail: `${late.map((s) => s.label).join(", ")} running late` };
    return { status: "operational", detail: `${rep.length} services scheduled · alarms every 5 s` };
  } },
  notifications: { label: "Notification service", async run() {
    const subs = db.prepare("SELECT COUNT(*) AS n FROM push_subs").get().n;
    const push = healthReport().find((s) => s.name === "push");
    if (push?.state === "error") return { status: "degraded", detail: `phone notifications failing: ${push.lastError}` };
    return { status: "operational", detail: `in-app and Windows notifications ready · ${subs ? `${subs} phone${subs === 1 ? "" : "s"} subscribed` : "no phone subscribed yet"}` };
  } },
  weather: { label: "Weather integration", async run() {
    const r = await testCheck("weather");
    if (r.ok) return { status: "connected", detail: `Open-Meteo · ${r.detail}` };
    return { status: netDown(r.detail) ? "offline" : "failed", detail: r.detail };
  } },
  calendar: { label: "Calendar integration", async run() {
    const local = db.prepare("SELECT COUNT(*) AS n FROM events WHERE start >= ?").get(new Date().toISOString()).n;
    const google = db.prepare("SELECT 1 FROM connections WHERE provider = 'google'").get();
    if (!google) return { status: "operational", detail: `JARVIS calendar · ${local} upcoming event${local === 1 ? "" : "s"} · Google not connected (optional)` };
    const r = await testCheck("google");
    return r.ok ? { status: "connected", detail: `Google Calendar synced · ${r.detail}` } : { status: netDown(r.detail) ? "offline" : "degraded", detail: `JARVIS calendar works; Google sync failed: ${r.detail}` };
  } },
};
export const BOOT_ORDER = Object.keys(BOOT_CHECKS);

export async function runBootCheck(name, ctx) {
  const c = BOOT_CHECKS[name];
  if (!c) return null;
  const t0 = performance.now();
  let out;
  try { out = await c.run(ctx); }
  catch (e) { out = { status: netDown(e.message) ? "offline" : "failed", detail: e.message }; }
  return { name, label: c.label, critical: !!c.critical, ...out, ms: Math.round(performance.now() - t0) };
}
void getSettings;
