// Diagnostics: every check is real and shows when it ran. Test buttons make real requests. Nothing is green without evidence.
import { api } from "../api.js";
import { voice } from "../voice.js";
import { $, $$, esc, icon, toast, fmtWhen, fmtRel, statusDot, sparkline } from "../util.js";

const GROUPS = [["ai", "AI"], ["voice", "Voice"], ["data", "Data"], ["integrations", "Integrations"], ["devices", "Devices"], ["services", "Background services"], ["hardware", "Hardware"]];
const TESTABLE = ["ai", "weather", "monzo", "google", "smarthome", "tts", "stt", "database", "network", "push"];
let logTab = "errors", CTX = null, meterStop = null;

const LEVELS = [["quick", "Quick"], ["full", "Full system"], ["voice", "Voice"], ["ai", "AI"], ["network", "Network"], ["security", "Security"], ["performance", "Performance"], ["hardware", "Hardware"], ["integrations", "Integrations"]];
export async function render(root, ctx, params = {}) {
  CTX = ctx;
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Diagnostics</h2><p id="dsum">Running checks…</p></div><div class="row wrap"><button class="btn small primary" id="rerun">${icon("refresh")}Run again</button></div></div>
    <article class="panel" style="margin-bottom:14px"><div class="panel-head"><span class="label">Spoken diagnostics</span><span class="faint" style="font-size:12px">Say “JARVIS, run a full system diagnostic” — every line is a real check</span></div>
      <div class="row wrap" id="levels">${LEVELS.map(([k, l]) => `<button class="btn small" data-level="${k}">${l}</button>`).join("")}</div>
      <div id="report" style="margin-top:12px"></div>
      <details style="margin-top:10px"><summary class="faint" style="cursor:pointer">Previous runs</summary><ul class="list" id="runs" style="margin-top:8px"></ul></details></article>
    <article class="panel" style="margin-bottom:14px"><div class="panel-head"><span class="label">Performance · live</span><span class="faint" id="perfAt" style="font-size:12px"></span></div><div class="grid cols-4" id="perf"></div></article>
    <div class="grid cols-4" id="gauges" style="margin-bottom:14px"></div>
    <div id="groups" class="stack"></div>
    ${ctx.desktop ? `<article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">This laptop</span></div><div class="grid cols-2">
      <div class="stack" style="gap:8px"><b>Microphone test</b><p class="muted" style="margin:0;font-size:13px">Speak — the bar should move. Uses the selected microphone.</p><div class="meter"><i id="micBar"></i></div><div class="row"><button class="btn small" id="micTest">${icon("mic")}Start</button><span class="faint" id="micOut" style="font-size:12.5px"></span></div></div>
      <div class="stack" style="gap:8px"><b>Speaker test</b><p class="muted" style="margin:0;font-size:13px">Plays a chime and checks that real audio left the app.</p><div class="row"><button class="btn small" id="spkTest">${icon("volume")}Play</button><span class="faint" id="spkOut" style="font-size:12.5px"></span></div></div></div></article>` : ""}
    <article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">AI latency · last 24 h</span><span class="faint" id="aiStats" style="font-size:12px"></span></div><div id="aiSpark"></div></article>
    <article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">History · last 24 h</span></div><div id="hist" class="stack" style="gap:6px"></div></article>
    <article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">Logs</span><div class="seg">${[["errors", "Errors"], ["api", "API calls"], ["audit", "Security audit"]].map(([k, l]) => `<button data-l="${k}">${l}</button>`).join("")}</div></div><div class="scroll-x"><table class="tbl" id="logs"></table></div></article>`;
  $("#rerun", root).onclick = load;
  $$("[data-level]", root).forEach((b) => b.onclick = async () => {
    $$("[data-level]", root).forEach((x) => x.disabled = true);
    try { await ctx.handleUi({ kind: "diagnostics", level: b.dataset.level }, { speak: ctx.settings.voice?.speakReplies !== false && (!!ctx.desktop || !!voice.cfg.tts) }); }
    catch (e) { toast(e.message); }
    $$("[data-level]", root).forEach((x) => x.disabled = false);
  });
  if (params.report) drawReport(params.report);
  drawRuns(); perf();
  $$("[data-l]", root).forEach((b) => b.onclick = () => { logTab = b.dataset.l; drawLogs(); });
  $("#micTest", root)?.addEventListener("click", micTest);
  $("#spkTest", root)?.addEventListener("click", speakerTest);
  await load();
  const t = setInterval(load, 30_000), tp = setInterval(perf, 5000);
  return () => { clearInterval(t); clearInterval(tp); meterStop?.(); };
}
export function refresh(e) { if (e.includes("health")) load(); }

let last = null;
async function load() {
  const d = await api("/api/diagnostics");
  last = d;
  if (!$("#groups")) return;
  const c = d.counts;
  $("#dsum").innerHTML = `${statusDot(d.overall)} ${d.overall === "ok" ? "All checked systems are working." : `${c.error || 0} fault${c.error === 1 ? "" : "s"}, ${c.warn || 0} warning${c.warn === 1 ? "" : "s"}.`} <span class="faint">Checked ${esc(fmtWhen(d.at))}${d.version ? ` · JARVIS ${esc(d.version)}` : ""}</span>`;
  const g = (n) => d.checks.find((x) => x.name === n);
  $("#gauges").innerHTML = ["cpu", "ram", "storage"].map((n) => { const x = g(n); return x ? `<article class="panel"><div class="spread"><span class="label">${esc(x.label)}</span>${statusDot(x.status)}</div><div class="mid" style="margin:6px 0">${x.value != null ? `${x.value}%` : "—"}</div><div class="bar ${x.status === "warn" ? "warn" : x.status === "error" ? "bad" : ""}"><i style="width:${x.value || 0}%"></i></div><div class="faint" style="font-size:12px;margin-top:6px">${esc(x.detail)}</div></article>` : ""; }).join("")
    + (() => { const x = g("network"); return x ? `<article class="panel"><div class="spread"><span class="label">Network</span>${statusDot(x.status)}</div><div class="faint" style="font-size:12.5px;margin-top:8px">${esc(x.detail)}</div></article>` : ""; })();
  $("#groups").innerHTML = GROUPS.map(([k, l]) => { const cs = d.checks.filter((x) => x.group === k && !(k === "hardware" && ["cpu", "ram", "storage", "network"].includes(x.name))); return cs.length ? `<article class="panel"><div class="panel-head"><span class="label">${l}</span></div><div class="diag-grid">${cs.map(card).join("")}</div></article>` : ""; }).join("");
  $$("[data-test]").forEach((b) => b.onclick = () => test(b));
  const m = g("ai")?.metrics;
  if (m) $("#aiStats").textContent = m.calls ? `${m.calls} calls · median ${m.medianMs} ms · p95 ${m.p95Ms} ms · ${m.errorRate}% errors` : "No AI calls yet";
  drawLogs(); drawHistory();
}
function card(x) {
  const tName = x.name.replace("svc:", "");
  return `<div class="check-card ${x.status}"><div class="spread"><div class="row">${statusDot(x.status)}<b>${esc(x.label)}</b></div>${TESTABLE.includes(tName) ? `<button class="btn tiny ghost" data-test="${tName}">Test</button>` : ""}</div><div class="detail">${esc(x.detail)}</div><div class="faint" style="font-size:11px" data-res="${tName}"></div></div>`;
}
async function test(b) {
  b.disabled = true; b.textContent = "Testing…";
  const out = document.querySelector(`[data-res="${b.dataset.test}"]`);
  try { const r = await api(`/api/diagnostics/test/${b.dataset.test}`, { method: "POST" }); if (out) out.innerHTML = `${r.ok ? '<span style="color:var(--good)">✓ passed</span>' : '<span style="color:var(--bad)">✗ failed</span>'} in ${r.latencyMs} ms — ${esc(r.detail)}`; }
  catch (e) { if (out) out.textContent = e.message; }
  b.disabled = false; b.textContent = "Test";
  setTimeout(load, 500);
}
async function drawHistory() {
  const h = await api("/api/diagnostics/history?hours=24");
  const el = $("#hist"); if (!el) return;
  const byCheck = {};
  for (const r of h) (byCheck[r.check_name] ||= []).push(r);
  const names = Object.keys(byCheck).filter((n) => !n.startsWith("svc:")).slice(0, 24);
  const col = { ok: "var(--good)", warn: "var(--warn)", error: "var(--bad)", off: "var(--steel-3)", unknown: "transparent" };
  el.innerHTML = names.map((n) => `<div class="row" style="gap:8px;font-size:12px"><span class="clip" style="width:180px;color:var(--muted)">${esc(n.replace("desktop:", "laptop: "))}</span><div style="display:flex;gap:2px;flex:1">${byCheck[n].slice(-72).map((r) => `<i title="${esc(fmtWhen(r.at))}: ${esc(r.status)} — ${esc(r.detail)}" style="flex:1;height:12px;border-radius:2px;background:${col[r.status]};${r.status === "unknown" ? "border:1px dashed var(--steel-2)" : ""}"></i>`).join("")}</div></div>`).join("") || '<p class="muted">History builds up every 10 minutes.</p>';
  const logs = await api("/api/diagnostics/logs?limit=200");
  const ai = logs.apiCalls.filter((c) => c.provider === "anthropic").reverse();
  $("#aiSpark").innerHTML = ai.length > 1 ? sparkline(ai.map((c) => c.latency_ms), { height: 50 }) + `<div class="spread faint" style="font-size:11px"><span>${esc(fmtWhen(ai[0].at))}</span><span>${esc(fmtWhen(ai.at(-1).at))}</span></div>` : '<p class="muted" style="margin:0">Not enough AI calls yet.</p>';
}
async function drawLogs() {
  $$("[data-l]").forEach((b) => b.classList.toggle("active", b.dataset.l === logTab));
  const logs = await api("/api/diagnostics/logs?limit=200");
  const el = $("#logs"); if (!el) return;
  if (logTab === "errors") el.innerHTML = `<thead><tr><th>When</th><th>Source</th><th>Message</th></tr></thead><tbody>${logs.errors.map((e) => `<tr><td class="mono faint">${esc(fmtWhen(e.at))}</td><td><span class="pill">${esc(e.source)}</span></td><td>${esc(e.message)}</td></tr>`).join("") || '<tr><td colspan="3" class="empty">No errors recorded.</td></tr>'}</tbody>`;
  else if (logTab === "api") el.innerHTML = `<thead><tr><th>When</th><th>Service</th><th>Purpose</th><th class="amt">Latency</th><th>Result</th></tr></thead><tbody>${logs.apiCalls.map((c) => `<tr><td class="mono faint">${esc(fmtWhen(c.at))}</td><td>${esc(c.provider)} <span class="faint">${esc(c.model)}</span></td><td>${esc(c.purpose)}</td><td class="amt">${c.latency_ms} ms</td><td>${c.ok ? '<span class="pill ok">ok</span>' : `<span class="pill bad">failed</span> <span class="faint">${esc(c.error || "")}</span>`}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">No calls yet.</td></tr>'}</tbody>`;
  else el.innerHTML = `<thead><tr><th>When</th><th>Device</th><th>Action</th><th>Detail</th></tr></thead><tbody>${logs.audit.map((a) => `<tr><td class="mono faint">${esc(fmtWhen(a.at))}</td><td>${esc(a.device || "")}</td><td>${esc(a.action)}</td><td class="faint" style="font-size:12px">${esc(JSON.stringify(a.detail)).slice(0, 160)}</td></tr>`).join("")}</tbody>`;
}

// ---------------------------------------------------------------- Laptop-side tests (results are recorded in history)
async function micTest() {
  if (meterStop) { meterStop(); return; }
  const out = $("#micOut"), bar = $("#micBar"), btn = $("#micTest");
  let stream, peak = 0;
  try {
    const dev = (await CTX.desktop?.getSettings?.().catch(() => ({})))?.micDeviceId;
    stream = await navigator.mediaDevices.getUserMedia({ audio: dev ? { deviceId: { exact: dev } } : true });
  } catch (e) { out.textContent = `Microphone unavailable: ${e.message}`; report("mic_test", "error", e.message); return; }
  const ctx = voice.ensureAudio(), src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
  const buf = new Uint8Array(1024), t0 = performance.now();
  btn.textContent = "Stop";
  const iv = setInterval(() => {
    an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) { const x = (v - 128) / 128; s += x * x; }
    const lvl = Math.min(1, Math.sqrt(s / buf.length) * 5); peak = Math.max(peak, lvl);
    bar.style.width = `${Math.round(lvl * 100)}%`;
    out.textContent = `peak ${Math.round(peak * 100)}% · ${stream.getAudioTracks()[0]?.label || "microphone"}`;
    if (performance.now() - t0 > 8000) meterStop();
  }, 60);
  meterStop = () => {
    clearInterval(iv); stream.getTracks().forEach((t) => t.stop()); src.disconnect(); bar.style.width = "0"; btn.innerHTML = `${icon("mic")}Start`; meterStop = null;
    const ok = peak > 0.08;
    out.textContent = ok ? `✓ Microphone works (peak ${Math.round(peak * 100)}%).` : `No sound picked up (peak ${Math.round(peak * 100)}%). Check the microphone choice in Settings → Voice.`;
    report("mic_test", ok ? "ok" : "warn", out.textContent);
  };
}
async function speakerTest() {
  const out = $("#spkOut");
  const ctx = voice.ensureAudio(), an = ctx.createAnalyser(); an.fftSize = 512; an.connect(ctx.destination);
  const buf = await fetch("/sounds/chime.wav").then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(an);
  const d = new Uint8Array(512); let peak = 0;
  const iv = setInterval(() => { an.getByteTimeDomainData(d); for (const v of d) peak = Math.max(peak, Math.abs(v - 128) / 128); }, 30);
  src.start();
  await new Promise((r) => (src.onended = r));
  clearInterval(iv); an.disconnect();
  const ok = peak > 0.05 && ctx.state === "running";
  out.textContent = ok ? `✓ Audio played (signal peak ${Math.round(peak * 100)}%). If you heard nothing, check the Windows volume and output device.` : `✗ No audio signal was produced (audio engine ${ctx.state}).`;
  report("speaker_test", ok ? "ok" : "error", out.textContent);
}
const report = (check, status, detail) => api("/api/diagnostics/report", { method: "POST", body: { check, status, detail } }).catch(() => {});
void fmtRel;

const utc = (at) => (/[zZ]$|[+-]\d\d:\d\d$/.test(at) ? at : at.replace(" ", "T") + "Z");
export function drawReport(r) {
  const el = $("#report"); if (!el) return;
  el.innerHTML = `<div class="spread" style="margin-bottom:8px"><b>${statusDot(r.overall)} ${esc(r.label)}</b><span class="faint" style="font-size:12px">${r.results.length} checks · ${(r.durationMs / 1000).toFixed(1)} s · ${esc(fmtWhen(r.at))}</span></div>
    <div class="diag-grid">${r.results.map((x) => `<div class="check-card ${x.status}"><div class="row">${statusDot(x.status)}<b>${esc(x.label)}</b>${x.tested ? '<span class="pill info">tested</span>' : ""}</div><div class="detail">${esc(x.detail)}</div></div>`).join("")}</div>
    <p class="muted" style="font-size:13px;margin:10px 0 0"><span class="label">Spoken</span> ${esc(r.narration.join(" "))}</p>`;
  drawRuns();
}
async function drawRuns() {
  const el = $("#runs"); if (!el) return;
  try {
    const runs = await api("/api/diagnostics/runs?limit=15");
    const name = (lv) => LEVELS.find(([k]) => k === lv)?.[1] || lv;
    el.innerHTML = runs.map((r) => `<li class="item clickable" data-run="${r.id}">${statusDot(r.overall)}<div class="grow"><b>${esc(name(r.level))}</b> <span class="faint">${r.summary.length} checks · ${(r.duration_ms / 1000).toFixed(1)} s</span><div class="meta">${esc(fmtWhen(utc(r.at)))}</div></div></li>`).join("") || '<li class="empty">No spoken diagnostics yet.</li>';
    $$("[data-run]", el).forEach((li) => li.onclick = () => { const r = runs.find((x) => String(x.id) === li.dataset.run); drawReport({ level: r.level, label: `${name(r.level)} diagnostics`, overall: r.overall, results: r.summary, narration: r.narration, durationMs: r.duration_ms, at: utc(r.at) }); });
  } catch {}
}
async function perf() {
  const el = $("#perf"); if (!el) return;
  try {
    const p = await api("/api/performance");
    const c = window.__jarvisCore || {};
    const tile = (label, value, sub) => `<div class="stack" style="gap:2px"><span class="label">${label}</span><b class="mid" style="font-size:20px">${value}</b><span class="faint" style="font-size:11.5px">${sub}</span></div>`;
    el.innerHTML = [
      tile("AI response", p.ai.medianMs != null ? `${p.ai.medianMs} ms` : "—", p.ai.n ? `median of ${p.ai.n} calls · p95 ${p.ai.p95Ms} ms` : "no AI calls in 24 h"),
      tile("Speech recognition", p.sttLocal.medianMs != null ? `${p.sttLocal.medianMs} ms` : p.sttCloud.medianMs != null ? `${p.sttCloud.medianMs} ms` : "—", p.sttLocal.n ? `on this laptop · ${p.sttLocal.n} clips` : p.sttCloud.n ? `cloud · ${p.sttCloud.n} clips` : "nothing transcribed in 24 h"),
      tile("Database", `${p.dbMs} ms`, `event loop lag ${p.lagMs} ms`),
      tile("Server", `${p.rssMb} MB`, `${p.cpuPct != null ? `CPU ${p.cpuPct}% · ` : ""}RAM ${p.ramPct}% · up ${Math.round(p.uptimeSec / 60)} min`),
      tile("3D core", c.alive ? `${c.fps} fps` : "—", c.alive ? `${c.tier || ""} quality${c.idle ? " · idle mode (saving power)" : ""}` : "not on screen"),
    ].join("");
    $("#perfAt").textContent = `measured ${new Date(p.at).toLocaleTimeString("en-GB")}`;
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
