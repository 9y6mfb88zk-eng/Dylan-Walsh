// JARVIS start-up: a dedicated initialisation screen that shows the real start-up of the application.
//   1 POWER ON · 2 SYSTEM CHECK · 3 AI INITIALISATION · 4 SYSTEM STATUS · 5 ENTER JARVIS
// Every line is the result of a real check (server checks via /api/boot, device checks here). Nothing is shown as
// working unless it was checked and passed. Its length is the length of the actual work: there is no artificial wait.
// The Command Centre is built underneath while this runs, so entering is a fade, not a reload.
import { api } from "./api.js";
import * as sync from "./sync.js";
import { sounds } from "./sounds.js";
import { esc } from "./util.js";

export const STARTUP_DEFAULTS = { screen: "cinematic", skipAnimation: false, sound: true, volume: 0.6, silent: false, reducedAudio: false, autoOpen: false, fullDiagnostics: true };
const GOOD = ["operational", "connected"], LIMITED = ["degraded", "permission_required", "initialising"], BAD = ["failed", "offline"];
const WORD = { operational: "OPERATIONAL", connected: "CONNECTED", degraded: "DEGRADED", not_configured: "NOT CONFIGURED", permission_required: "PERMISSION REQUIRED", offline: "OFFLINE", failed: "FAILED", initialising: "INITIALISING", pending: "CHECKING" };
const light = (s) => (GOOD.includes(s) ? "ok" : s === "not_configured" ? "off" : BAD.includes(s) ? "bad" : s === "pending" ? "pending" : "warn");
const tone = (s) => (GOOD.includes(s) ? "ok" : BAD.includes(s) ? "bad" : s === "not_configured" ? null : "warn");
const timeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${label} didn't respond within ${Math.round(ms / 1000)} s`), { code: "timeout" })), ms))]);

// ---------------------------------------------------------------- Device-side checks (this computer / browser)
async function checkMicrophone(ctx) {
  if (ctx.desktop) {
    const st = ctx.agent || (await timeout(ctx.desktop.getStatus(), 4000, "The Windows audio service").catch(() => null));
    if (!st) return { status: "degraded", detail: "the Windows audio service isn't reporting yet" };
    if (st.muted) return { status: "degraded", detail: "microphone available · muted by you" };
    if (st.wakeWord === "listening") return { status: "operational", detail: `available · permission granted · listening for “Hey JARVIS”${st.mic ? ` · ${st.mic}` : ""}` };
    if (/denied|permission/i.test(st.wakeWord || "")) return { status: "permission_required", detail: "Windows is blocking microphone access — Settings → Privacy → Microphone" };
    return { status: "initialising", detail: `wake word ${st.wakeWord || "starting"}` };
  }
  if (!navigator.mediaDevices?.enumerateDevices) return { status: "failed", detail: "this browser can't use a microphone" };
  let perm = "unknown";
  try { perm = (await navigator.permissions.query({ name: "microphone" })).state; } catch {}
  const inputs = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === "audioinput");
  if (!inputs.length && perm !== "granted") return { status: perm === "denied" ? "permission_required" : "offline", detail: perm === "denied" ? "microphone access is blocked for JARVIS in this browser" : "no microphone found" };
  if (perm === "granted") return { status: "operational", detail: `${inputs.length} microphone${inputs.length === 1 ? "" : "s"} available · permission granted` };
  if (perm === "denied") return { status: "permission_required", detail: `${inputs.length} microphone${inputs.length === 1 ? "" : "s"} found · access blocked in this browser's settings` };
  return { status: "permission_required", detail: `${inputs.length} microphone${inputs.length === 1 ? "" : "s"} found · permission will be asked the first time you talk` };
}
async function systemVoices() {
  if (!("speechSynthesis" in window)) return [];
  let v = speechSynthesis.getVoices();
  if (!v.length) await new Promise((r) => { speechSynthesis.addEventListener?.("voiceschanged", r, { once: true }); setTimeout(r, 1500); });
  return speechSynthesis.getVoices();
}
function checkWebGL() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return { status: "failed", detail: "no WebGL — the 2D core will be used" };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || "GPU";
    // "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 3060 Laptop GPU"
    const inner = String(gpu).replace(/^ANGLE \((.*)\)$/, "$1"), parts = inner.split(", ");
    const name = (parts.length >= 2 ? parts[1] : inner).replace(/\s*\(0x[0-9a-f]+\)\)?/ig, "").replace(/\s*(Direct3D\S*|vs_\S+|ps_\S+)/g, "").trim().slice(0, 70);
    const software = /SwiftShader|llvmpipe|Software|Basic Render/i.test(gpu);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { status: software ? "degraded" : "operational", detail: `${gl instanceof WebGL2RenderingContext ? "WebGL 2" : "WebGL"} · ${name}${software ? " — software rendering, animations will be slower" : ""}` };
  } catch (e) { return { status: "failed", detail: e.message }; }
}

// ---------------------------------------------------------------- The screen
function buildScreen(st) {
  const el = document.createElement("section");
  el.className = `boot2 ${st.screen === "minimal" ? "minimal" : ""} ${st.skipAnimation ? "still" : ""} ${st.fullDiagnostics ? "" : "brief"}`;
  el.setAttribute("aria-label", "JARVIS start-up");
  el.innerHTML = `<canvas class="b2-fx" aria-hidden="true"></canvas><div class="b2-scan" aria-hidden="true"></div><div class="b2-pulse" aria-hidden="true"></div>
    <div class="b2-inner">
      <header class="b2-brand"><div class="b2-title">J.A.R.V.I.S.</div><div class="b2-sub" id="b2Sub">INITIALISING</div></header>
      <div class="b2-progress" role="progressbar" aria-label="Start-up progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
      <div class="b2-log" id="b2Log" aria-live="polite"></div>
      <div class="b2-final" id="b2Final" hidden></div>
    </div>
    <button class="b2-skip" id="b2Skip" type="button">Skip animation</button>`;
  document.body.append(el);
  return el;
}
function particles(canvas, still) {
  if (still) return () => {};
  const g = canvas.getContext("2d"); let w = 0, h = 0, raf = 0, last = 0, stopped = false;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const P = Array.from({ length: 48 }, () => ({ x: Math.random(), y: Math.random(), v: 0.004 + Math.random() * 0.012, r: 0.6 + Math.random() * 1.6, a: 0.15 + Math.random() * 0.5 }));
  const size = () => { w = canvas.clientWidth; h = canvas.clientHeight; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0); };
  size(); addEventListener("resize", size);
  const frame = (t) => {
    if (stopped) return; raf = requestAnimationFrame(frame);
    if (t - last < 33) return;                       // 30 fps is plenty for drifting particles
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    g.clearRect(0, 0, w, h);
    for (const p of P) {
      p.y -= p.v * dt * 4; if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); }
      g.globalAlpha = p.a * (0.6 + 0.4 * Math.sin(t / 900 + p.x * 9)); g.fillStyle = p.r > 1.6 ? "#e9d5ff" : "#a855f7";
      g.beginPath(); g.arc(p.x * w, p.y * h, p.r, 0, 6.283); g.fill();
    }
  };
  raf = requestAnimationFrame(frame);
  return () => { stopped = true; cancelAnimationFrame(raf); removeEventListener("resize", size); };
}

/**
 * Run the start-up. hooks: { view: Promise (Command Centre built), core: () => Promise<{kind, tier, ms}> }.
 * Resolves with the result when the user enters (or immediately after the checks when the screen is off).
 */
export async function runStartup(ctx, hooks) {
  const st = { ...STARTUP_DEFAULTS, ...(ctx.settings.startup || {}) };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("reduce-motion");
  if (reduce) st.skipAnimation = true;
  sounds.configure({ volume: st.volume, reduced: st.reducedAudio, enabled: st.sound && !st.silent });
  const headless = st.screen === "off";
  const el = headless ? null : buildScreen(st);
  let stopFx = el ? particles(el.querySelector(".b2-fx"), st.skipAnimation) : () => {};
  // Skipping the animation skips only the effects — every check still runs.
  el?.querySelector("#b2Skip").addEventListener("click", (e) => { e.stopPropagation(); st.skipAnimation = true; el.classList.add("still"); e.currentTarget.hidden = true; stopFx(); stopFx = () => {}; });
  const T0 = performance.now();
  const lines = new Map(), result = { lines: [], sound: "off", startedAt: new Date().toISOString() };
  window.__jarvisBoot = result;
  let total = 0, done = 0;
  const log = el?.querySelector("#b2Log");
  const progress = () => { if (!el) return; const p = total ? Math.round((done / total) * 100) : 0; el.querySelector(".b2-progress > i").style.transform = `scaleX(${p / 100})`; el.querySelector(".b2-progress").setAttribute("aria-valuenow", p); };
  const stamp = () => `${((performance.now() - T0) / 1000).toFixed(3).padStart(7, " ")}s`;
  // Text appears progressively (fast, and never slower than the work behind it). Skipped → instant.
  // Each line types itself over at most 220 ms of real time, independently, so text never lags behind the results.
  const typeInto = (node, text) => {
    if (!node) return;
    if (st.skipAnimation || st.screen === "minimal") { node.textContent = text; return; }
    const t0 = performance.now(), dur = Math.min(220, text.length * 12);
    const step = () => { const k = Math.min(1, (performance.now() - t0) / dur); node.textContent = text.slice(0, Math.ceil(text.length * k)); if (k < 1 && !st.skipAnimation) requestAnimationFrame(step); else node.textContent = text; };
    step();
  };
  const heading = (text) => { if (!log) return; const h = document.createElement("div"); h.className = "b2-head"; log.append(h); typeInto(h, `> ${text}`); };
  const line = (key, label, { critical = false, group = "check" } = {}) => {
    total++;
    const row = { key, label, status: "pending", detail: "", critical, group, ms: null };
    lines.set(key, row); result.lines.push(row);
    if (log) {
      row.el = document.createElement("div"); row.el.className = "b2-line pending";
      row.el.innerHTML = `<span class="b2-t">${stamp()}</span><span class="b2-dot"></span><span class="b2-name"></span><span class="b2-status">CHECKING</span><span class="b2-detail"></span>`;
      log.append(row.el); typeInto(row.el.querySelector(".b2-name"), label.toUpperCase());
      if (el.classList.contains("minimal")) el.querySelector("#b2Sub").textContent = label.toUpperCase();
    }
    progress();
    return row;
  };
  const settle = (row, r) => {
    Object.assign(row, { status: r.status, detail: r.detail || "", ms: r.ms ?? Math.round(performance.now() - T0) });
    if (row.status !== "initialising") { done++; progress(); }
    if (row.el) {
      row.el.className = `b2-line ${light(row.status)} ${row.status}`;
      row.el.querySelector(".b2-status").textContent = WORD[row.status] || row.status.toUpperCase();
      row.el.querySelector(".b2-detail").textContent = row.detail;
      row.el.querySelector(".b2-t").textContent = stamp();
      if (el.classList.contains("brief") && GOOD.includes(row.status) && row.group === "check") row.el.classList.add("quiet");
      log.scrollTop = log.scrollHeight;
    }
    const t = tone(row.status); if (t && row.status !== "initialising") sounds.check(t);
  };

  // ---- Stage 1 · POWER ON
  heading("POWER ON");
  // Launched hidden (Start with Windows → tray): no sound out of nowhere; it plays when you open JARVIS and enter.
  const soundState = document.hidden ? "deferred" : await sounds.unlock();
  result.sound = soundState;
  const audioRow = el && document.createElement("div");
  const AUDIO = {
    playing: ["PLAYING", "ok", (lvl) => `start-up sound playing through the default output device · signal peak ${lvl}`],
    checking: ["STARTING", "pending", () => "starting the start-up sound…"],
    blocked: ["BLOCKED", "warn", () => "this browser blocks sound until you tap — the activation sound will play when you enter"],
    off: ["SILENT", "info", () => "start-up sound off in Settings → Startup"],
    unavailable: ["UNAVAILABLE", "warn", () => "this device can't play generated sound"],
    deferred: ["WAITING", "info", () => "JARVIS started in the background — sound will play when you open it"],
    "no signal": ["NO SIGNAL", "warn", () => "the audio system started but no sound signal was measured"],
  };
  const showAudio = (state, lvl) => {
    if (!audioRow) return;
    const [word, cls, text] = AUDIO[state];
    audioRow.className = `b2-line ${cls}`;
    audioRow.querySelector(".b2-status").textContent = word;
    audioRow.querySelector(".b2-detail").textContent = text(lvl);
  };
  if (audioRow) {
    audioRow.innerHTML = `<span class="b2-t">${stamp()}</span><span class="b2-dot"></span><span class="b2-name">AUDIO</span><span class="b2-status"></span><span class="b2-detail"></span>`;
    log.append(audioRow);
  }
  // The sound is reported as playing only once a real signal is measured leaving JARVIS (checked alongside the system checks).
  if (soundState === "playing") {
    sounds.powerOn(); showAudio("checking");
    sounds.measure(450).then((lvl) => { result.soundLevel = lvl; result.sound = lvl ? "playing" : "no signal"; showAudio(result.sound, lvl); });
  } else showAudio(soundState);

  // ---- Stage 2 · SYSTEM CHECK (all started at once; each line updates as its result arrives)
  heading("SYSTEM CHECK");
  let list = null;
  try { list = await timeout(api("/api/boot"), 8000, "The JARVIS server"); }
  catch (e) { list = null; result.serverError = e.status === 0 ? "the JARVIS server can't be reached" : e.message; }
  const serverRows = new Map();
  const ORDER = ["runtime", "os", "hardware", "database", "storage", "ai", "stt", "tts", "mic", "scheduler", "notifications", "weather", "calendar", "world", "webgl", "core"];
  const labels = { tts: "Speech synthesis", mic: "Microphone", world: "World Explorer", webgl: "3D rendering", core: "Neural core rendering" };
  const serverDefs = Object.fromEntries((list?.checks || []).map((c) => [c.name, c]));
  for (const k of ORDER) {
    if (serverDefs[k] && k !== "tts") serverRows.set(k, line(k, serverDefs[k].label, { critical: serverDefs[k].critical }));
    else if (k === "runtime" && !list) serverRows.set(k, line(k, "Application runtime", { critical: true }));
    else if (labels[k]) line(k, labels[k]);
  }
  const serverCheck = async (name, row) => {
    const t = performance.now();
    for (let attempt = 0; ; attempt++) {
      let r;
      try { r = await timeout(api(`/api/boot/check/${name}`), name === "ai" || name === "weather" || name === "tts" || name === "calendar" ? 15000 : 10000, row?.label || name); }
      catch (e) { r = { status: e.status === 0 ? "offline" : "failed", detail: e.status === 0 ? "the JARVIS server can't be reached" : e.message }; }
      if (r.status === "initialising" && performance.now() - t < 45000) { if (row) settle(row, r); await new Promise((res) => setTimeout(res, 1200)); continue; }
      if (r.status === "initialising") r = { status: "degraded", detail: `${r.detail} — still loading after 45 s; it will finish in the background` };
      r.ms = Math.round(performance.now() - t);
      if (row) settle(row, r);
      return r;
    }
  };
  if (!list) settle(lines.get("runtime"), { status: "failed", detail: result.serverError });
  const serverResults = {};
  const serverP = list ? Promise.all(list.checks.map(async (c) => { serverResults[c.name] = await serverCheck(c.name, serverRows.get(c.name)); })) : Promise.resolve();
  const ttsP = list ? serverCheck("tts", null).then((r) => (serverResults.tts = r)) : Promise.resolve(null);
  const clientP = [
    (async () => { const t = performance.now(); const r = await checkMicrophone(ctx).catch((e) => ({ status: "failed", detail: e.message })); settle(lines.get("mic"), { ...r, ms: Math.round(performance.now() - t) }); })(),
    (async () => {
      const t = performance.now(); const [voices, cloud] = await Promise.all([systemVoices(), ttsP]);
      const sys = voices.find((v) => /en-GB/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || voices[0];
      let r;
      if (cloud?.status === "connected") r = { status: "connected", detail: `${cloud.detail}${sys ? ` · system voice ${sys.name} as backup` : ""}` };
      else if (sys) r = { status: cloud && cloud.status !== "not_configured" ? "degraded" : "operational", detail: `system voice: ${sys.name}${cloud && cloud.status !== "not_configured" ? ` · cloud voice ${cloud.status}: ${cloud.detail}` : ""}` };
      else r = { status: cloud && BAD.includes(cloud.status) ? cloud.status : "failed", detail: cloud?.status === "not_configured" || !cloud ? "no voice available on this device and no cloud voice set" : cloud.detail };
      settle(lines.get("tts"), { ...r, ms: Math.round(performance.now() - t) });
    })(),
    (async () => { const t = performance.now(); const r = checkWebGL(); settle(lines.get("webgl"), { ...r, ms: Math.round(performance.now() - t) }); })(),
    (async () => {
      const t = performance.now();
      let local = null;
      try { const res = await timeout(fetch("/vendor/world-lines.json", { credentials: "same-origin" }), 8000, "Map data"); if (!res.ok) throw new Error(`HTTP ${res.status}`); const j = await res.json(); local = j.lines?.length || 0; }
      catch (e) { settle(lines.get("world"), { status: "failed", detail: `map application available, but its map data didn't load: ${e.message}`, ms: Math.round(performance.now() - t) }); return; }
      await serverP;
      const w = serverResults.weather;
      settle(lines.get("world"), { status: w && GOOD.includes(w.status) ? "operational" : "degraded", detail: `globe ready · ${local} coastline paths loaded (stored locally) · live place data ${w && GOOD.includes(w.status) ? "connected" : `unavailable (${w?.detail || "not checked"})`}`, ms: Math.round(performance.now() - t) });
    })(),
    (async () => {
      const t = performance.now(); const row = lines.get("core");
      settle(row, { status: "initialising", detail: "building the neural core…" });
      try {
        const c = await timeout(hooks.core(), 25000, "The neural core");
        settle(row, { status: c.kind === "3d" ? "operational" : "degraded", detail: c.kind === "3d" ? `3D core live · ${c.tier} quality · first frame after ${c.ms ?? "?"} ms` : "WebGL isn't available — the 2D core is running instead", ms: Math.round(performance.now() - t) });
      } catch (e) { settle(row, { status: "failed", detail: `${e.message} — the rest of JARVIS works without it`, ms: Math.round(performance.now() - t) }); }
    })(),
  ];
  await Promise.all([serverP, ...clientP]);

  // ---- Stage 3 · AI INITIALISATION (each item restores something real)
  heading("AI INITIALISATION");
  if (result.sound === "playing") sounds.rise();
  const ai = serverResults.ai, s = ctx.settings;
  const init = [
    ["engine", "Initialise AI engine", async () => (!ai ? { status: "failed", detail: "the AI check didn't run" } : ai.status === "connected" ? { status: "operational", detail: ai.detail } : { status: ai.status, detail: ai.detail })],
    ["config", "Load application configuration", async () => ({ status: ctx.session?.signedIn ? "operational" : "failed", detail: `JARVIS ${list?.version || ctx.session?.version || ""} · ${ctx.session?.hosting === "laptop" ? "running on this laptop" : "server"} · ${s.timezone || "time zone not set"}` })],
    ["memory", "Load persistent memory", async () => {
      if ((s.memory?.mode || "ask") === "off") return { status: "not_configured", detail: "memory is switched off by you" };
      const p = await timeout(api("/api/memories/profile"), 8000, "Memory"); const n = Object.values(p).flat().length;
      return { status: "operational", detail: `${n} fact${n === 1 ? "" : "s"} restored · ${Object.keys(p).length} categories` };
    }],
    ["prefs", "Restore saved preferences", async () => ({ status: "operational", detail: `addressed as “${s.profile?.title || "Sir"}” · ${s.personality?.mode || "standard"} voice mode · ${s.appearance?.quality || "auto"} graphics` })],
    ["tasks", "Restore pending tasks and reminders", async () => {
      const [h, r] = await Promise.all([timeout(api("/api/home"), 10000, "Tasks"), timeout(api("/api/reminders"), 10000, "Reminders")]);
      ctx.homePrefetch = h;
      return { status: "operational", detail: `${h.tasks.total} open task${h.tasks.total === 1 ? "" : "s"} (${h.tasks.overdue.length} overdue) · ${r.upcoming.length} reminder${r.upcoming.length === 1 ? "" : "s"} · ${h.alarms?.next ? `next alarm ${new Date(h.alarms.next.at).toLocaleString("en-GB", { timeZone: s.timezone, weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "no alarm set"}` };
    }],
    ["voice", "Initialise voice interface", async () => {
      const mic = lines.get("mic"), stt = serverResults.stt;
      if (stt && BAD.includes(stt.status)) return { status: "degraded", detail: `speech recognition unavailable (${stt.detail}) · typing works` };
      if (ctx.desktop) return mic.status === "operational" ? { status: "operational", detail: "“Hey JARVIS”, push-to-talk (Ctrl+Shift+Space) and tap-to-talk ready" } : { status: mic.status === "initialising" ? "degraded" : mic.status, detail: mic.detail };
      return { status: mic.status === "operational" || mic.status === "permission_required" ? "operational" : "degraded", detail: mic.status === "permission_required" ? "tap the core to talk · the browser will ask for the microphone" : mic.detail };
    }],
    ["neural", "Initialise neural energy core", async () => { const c = lines.get("core"); return { status: c.status, detail: c.detail }; }],
    ["cc", "Prepare the Command Centre", async () => { await timeout(hooks.view, 20000, "The Command Centre"); const n = document.querySelectorAll("#view .panel").length; return { status: n ? "operational" : "degraded", detail: `${n} panels loaded with live data` }; }],
  ];
  const initRows = init.map(([k, label]) => line(`init-${k}`, label, { group: "init" }));
  await Promise.all(init.map(async ([, , fn], i) => { const t = performance.now(); let r; try { r = await fn(); } catch (e) { r = { status: e.status === 0 ? "offline" : "failed", detail: e.message }; } settle(initRows[i], { ...r, ms: Math.round(performance.now() - t) }); }));

  // ---- Stage 4 · SYSTEM STATUS (from the real results only)
  const all = result.lines;
  const criticalDown = all.filter((r) => r.critical && BAD.includes(r.status));
  const failed = all.filter((r) => BAD.includes(r.status) && !r.critical);
  const limited = all.filter((r) => LIMITED.includes(r.status));
  const notSet = all.filter((r) => r.status === "not_configured");
  const summary = criticalDown.length ? "SYSTEM INITIALISATION FAILED" : failed.length ? "SYSTEM INITIALISED — ATTENTION REQUIRED" : limited.length ? "SYSTEM OPERATIONAL — LIMITED SERVICES" : "SYSTEM OPERATIONAL";
  Object.assign(result, { summary, durationMs: Math.round(performance.now() - T0), problems: [...criticalDown, ...failed, ...limited].map((r) => ({ label: r.label, status: r.status, detail: r.detail })), notConfigured: notSet.map((r) => r.label) });
  heading("SYSTEM STATUS");
  window.__jarvisBootReady = true;
  if (headless) { stopFx(); return result; }

  const h = Number(new Date().toLocaleString("en-GB", { timeZone: s.timezone, hour: "2-digit", hour12: false }));
  const greet = `GOOD ${h < 12 ? "MORNING" : h < 18 ? "AFTERNOON" : "EVENING"}, ${(s.profile?.title || "Sir").toUpperCase()}.`;
  const fin = el.querySelector("#b2Final");
  const problemList = [...criticalDown, ...failed, ...limited];
  fin.innerHTML = `<div class="b2-summary ${criticalDown.length ? "bad" : failed.length ? "bad" : limited.length ? "warn" : "ok"}" role="status">${esc(summary)}</div>
    ${problemList.length ? `<ul class="b2-problems">${problemList.slice(0, 6).map((r) => `<li><b>${esc(r.label)}</b> — ${esc(WORD[r.status] || r.status)}: ${esc(r.detail)}${r.critical ? " <em>(critical)</em>" : ""}</li>`).join("")}</ul>` : ""}
    ${notSet.length ? `<div class="b2-note">Not set up (optional): ${esc(notSet.map((r) => r.label).join(", "))}</div>` : ""}
    <div class="b2-enter"><div>ALL AVAILABLE SYSTEMS INITIALISED.</div><div class="b2-greet">${esc(greet)}</div><div class="b2-tap">TAP ANYWHERE TO WAKE JARVIS<span class="b2-cursor"></span></div></div>
    ${problemList.length ? '<button class="b2-diag" id="b2Diag" type="button">Open diagnostics</button>' : ""}`;
  fin.hidden = false;
  el.classList.add("ready");
  if (log) log.scrollTop = log.scrollHeight;
  el.querySelector("#b2Sub").textContent = `${summary} · ${(result.durationMs / 1000).toFixed(1)} s`;
  el.querySelector("#b2Skip").hidden = true;

  // ---- Stage 5 · ENTER JARVIS
  return new Promise((resolve) => {
    let entered = false;
    const enter = async (goTo) => {
      if (entered) return; entered = true;
      // A tap is a user gesture: sound that was blocked can play now — and only then is it reported as played.
      const state = await sounds.unlock();
      if (state === "playing") { sounds.activate(); if (result.sound !== "playing") result.sound = "played after tap"; }
      result.enteredAt = new Date().toISOString();
      removeEventListener("keydown", onKey);
      el.classList.add("leaving");
      setTimeout(() => { stopFx(); el.remove(); }, st.skipAnimation ? 0 : 700);
      resolve({ ...result, goTo });
    };
    const onKey = (e) => { if (["Enter", " ", "Escape"].includes(e.key)) { e.preventDefault(); enter(); } };
    el.addEventListener("click", (e) => { if (e.target.closest("#b2Diag")) return enter("diagnostics"); enter(); });
    addEventListener("keydown", onKey);
    if (st.autoOpen) setTimeout(() => enter(), 1400);
  });
}
void sync;
