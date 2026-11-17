// Microphone & speech: device choice, audio clean-up switches, a live visualiser driven by the real microphone signal,
// background-noise measurement, a calibration sentence transcribed by the real recogniser, and suggested settings.
import { api } from "../api.js";
import { voice, encodeWav16k } from "../voice.js";
import { conversation } from "../conversation.js";
import { $, $$, esc, toast } from "../util.js";

const SENTENCE = "JARVIS, set an alarm for seven tomorrow and remind me to call the fire station at nine.";
const LOCAL_KEY = "jarvis.mic";
let live = null, statusTimer = null, devWatch = null;

const words = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b7\b/g, "seven").replace(/\b9\b/g, "nine").split(/\s+/).filter(Boolean);
function accuracy(ref, hyp) {
  const r = words(ref), h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return Math.max(0, Math.round(100 * (1 - d[r.length][h.length] / r.length)));
}
const loadLocal = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}"); } catch { return {}; } };

export async function renderMicSetup(el, ctx) {
  stopLive();
  const d = ctx.desktop;
  const cfg = d ? await d.getSettings() : { vadThreshold: 0.03, endpointMs: 1200, noiseSuppression: true, echoCancellation: true, autoGainControl: true, ...loadLocal() };
  const health = await api("/api/health").catch(() => null);
  const engine = health?.integrations?.voice?.sttLocal?.model || (health?.integrations?.voice?.stt ? "OpenAI Whisper (cloud)" : "Browser speech recognition");
  el.innerHTML = `<div class="grid cols-2">
    <article class="panel"><div class="panel-head"><span class="label">Microphone</span><span class="pill" id="micState">off</span></div>
      <label class="field"><span>Input device</span><select class="inp" id="dev"><option value="">System default</option></select></label>
      <canvas id="viz" style="width:100%;height:110px;margin-top:12px;border-radius:10px;background:rgba(2,10,20,.6);border:1px solid var(--edge)"></canvas>
      <div class="spread" style="font-size:12.5px;margin-top:6px"><span>Level <b class="mono" id="db">— dB</b></span><span id="clip" class="faint">no clipping</span></div>
      <div class="meter" style="margin-top:6px"><i id="lvl"></i></div>
      <div class="row wrap" style="margin-top:12px"><button class="btn small" id="liveBtn">Start live test</button></div>
      <div class="hr"></div>
      <div class="set-row"><div><b>Noise suppression</b><div class="muted">Removes steady background noise (fans, air-con)</div></div><label class="switch"><input type="checkbox" id="ns" ${cfg.noiseSuppression !== false ? "checked" : ""}><span></span></label></div>
      <div class="set-row"><div><b>Echo cancellation</b><div class="muted">Stops JARVIS hearing its own voice from the speakers</div></div><label class="switch"><input type="checkbox" id="ec" ${cfg.echoCancellation !== false ? "checked" : ""}><span></span></label></div>
      <div class="set-row"><div><b>Automatic gain</b><div class="muted">Evens out quiet and loud speech</div></div><label class="switch"><input type="checkbox" id="agc" ${cfg.autoGainControl !== false ? "checked" : ""}><span></span></label></div>
    </article>
    <article class="panel"><div class="panel-head"><span class="label">Calibration</span>${cfg.calibratedAt ? `<span class="pill ok">calibrated ${esc(new Date(cfg.calibratedAt).toLocaleDateString("en-GB"))}</span>` : '<span class="pill warn">not calibrated</span>'}</div>
      <ol class="muted" style="font-size:13.5px;padding-left:18px;margin-top:0"><li>Stay quiet for 3 seconds while JARVIS measures the room.</li><li>Read the sentence below in your normal voice.</li><li>Check the result and save.</li></ol>
      <div class="row wrap"><button class="btn small" id="noiseBtn">1 · Measure background noise</button><span class="faint" id="noiseOut" style="font-size:12.5px"></span></div>
      <div class="banner info" style="margin:12px 0">“${esc(SENTENCE)}”</div>
      <div class="row wrap"><button class="btn small primary" id="speakBtn">2 · Record the sentence</button><span class="faint" id="recOut" style="font-size:12.5px"></span></div>
      <div id="result" style="margin-top:12px"></div>
      <div class="hr"></div>
      <div class="set-row"><div><b>Speech sensitivity</b><div class="muted">Lower = picks up quieter speech; higher = ignores more noise</div></div><input type="range" id="vad" min="0.005" max="0.12" step="0.001" value="${cfg.vadThreshold ?? 0.03}" style="width:150px"><span class="mono" id="vadV" style="width:52px;text-align:right">${(cfg.vadThreshold ?? 0.03).toFixed(3)}</span></div>
      <div class="set-row"><div><b>Pause before JARVIS stops listening</b><div class="muted">Longer if it cuts you off; shorter if it waits too long</div></div><input type="range" id="ep" min="600" max="2500" step="100" value="${cfg.endpointMs ?? 1200}" style="width:150px"><span class="mono" id="epV" style="width:52px;text-align:right">${((cfg.endpointMs ?? 1200) / 1000).toFixed(1)}s</span></div>
      <div class="row wrap end" style="margin-top:10px"><button class="btn small ghost" id="resetBtn">Reset audio settings</button><button class="btn small primary" id="saveBtn">3 · Save</button></div>
      <div class="mic-status" id="micStatus" aria-live="polite"></div>
      <p class="faint" style="font-size:12px;margin-bottom:0">Speech recognition: <b>${esc(engine)}</b> · English. Wake-word sensitivity is under “Wake word &amp; laptop”; continuous conversation under “Voice &amp; conversation”.</p>
    </article></div>`;

  // Devices (labels appear once the microphone has been allowed)
  async function listDevices() {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === "audioinput" && x.deviceId !== "default" && x.deviceId !== "communications");
    $("#dev", el).innerHTML = `<option value="">System default</option>${all.map((x, i) => `<option value="${esc(x.deviceId)}" ${x.deviceId === cfg.micDeviceId ? "selected" : ""}>${esc(x.label || `Microphone ${i + 1}`)}</option>`).join("")}`;
  }
  await listDevices().catch(() => {});
  // A microphone plugged in or removed shows up straight away.
  devWatch = () => listDevices().then(() => toast("Audio devices changed.")).catch(() => {});
  navigator.mediaDevices?.addEventListener?.("devicechange", devWatch);
  // Live status: what JARVIS is doing with the microphone right now, and how the last recognition went.
  const sttErr = health?.integrations?.voice?.sttLocal?.error;
  const renderStatus = () => {
    const box = $("#micStatus", el); if (!box) return;
    const h = conversation.lastHeard;
    const state = voice.state === "listening" ? "listening" : conversation.session ? "in a conversation" : voice.state === "speaking" ? "speaking" : "standby — not recording";
    box.innerHTML = `<dl class="kv">
      <div><dt>Microphone</dt><dd>${esc(d ? "laptop audio service" : $("#dev", el)?.selectedOptions?.[0]?.textContent || "system default")}</dd></div>
      <div><dt>State</dt><dd>${esc(state)}</dd></div>
      <div><dt>Recognition</dt><dd>${esc(engine)}</dd></div>
      <div><dt>Last heard</dt><dd>${h ? `“${esc(h.text.slice(0, 60))}” · ${esc(h.confidence?.level || "—")} confidence${h.latencyMs ? ` · ${h.latencyMs} ms` : ""}` : "nothing yet in this session"}</dd></div>
      ${sttErr ? `<div><dt>Error</dt><dd class="bad">${esc(sttErr)}</dd></div>` : ""}</dl>`;
  };
  renderStatus(); clearInterval(statusTimer); statusTimer = setInterval(() => { if (!el.isConnected) { clearInterval(statusTimer); return; } renderStatus(); }, 1000);
  const constraints = () => ({ audio: { deviceId: $("#dev", el).value ? { exact: $("#dev", el).value } : undefined, channelCount: 1, noiseSuppression: $("#ns", el).checked, echoCancellation: $("#ec", el).checked, autoGainControl: $("#agc", el).checked } });
  let noiseRms = null, speechRms = null;

  async function startLive() {
    stopLive();
    const stream = await navigator.mediaDevices.getUserMedia(constraints());
    await listDevices().catch(() => {});
    const ac = voice.ensureAudio(), source = ac.createMediaStreamSource(stream), an = ac.createAnalyser();
    an.fftSize = 2048; source.connect(an);
    const buf = new Float32Array(an.fftSize), cv = $("#viz", el), g = cv.getContext("2d");
    let raf = 0, clipAt = 0;
    const draw = () => {
      if (!cv.isConnected) return stopLive();
      an.getFloatTimeDomainData(buf);
      let s = 0, peak = 0; for (const v of buf) { s += v * v; peak = Math.max(peak, Math.abs(v)); }
      const rms = Math.sqrt(s / buf.length), db = rms > 0 ? 20 * Math.log10(rms) : -100;
      live.lastRms = rms;
      if (peak > 0.98) clipAt = performance.now();
      const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio;
      g.clearRect(0, 0, w, h); g.lineWidth = 1.5 * devicePixelRatio; g.strokeStyle = "#22d3ee"; g.shadowColor = "#00e5ff"; g.shadowBlur = 8;
      g.beginPath(); for (let i = 0; i < buf.length; i += 4) { const x = (i / buf.length) * w, y = h / 2 + buf[i] * h * 0.45; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
      const thr = Number($("#vad", el).value), ty = h / 2 - thr * h * 0.45 * 4;   // speech-start threshold marker (RMS, scaled)
      g.shadowBlur = 0; g.strokeStyle = "rgba(251,191,36,.6)"; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(0, ty); g.lineTo(w, ty); g.stroke(); g.setLineDash([]);
      $("#db", el).textContent = `${db.toFixed(0)} dB`;
      $("#lvl", el).style.width = `${Math.min(100, Math.max(0, (db + 60) * 1.7))}%`;
      const clipping = performance.now() - clipAt < 1500;
      $("#clip", el).textContent = clipping ? "CLIPPING — move back or lower the input volume" : rms > thr ? "speech detected" : "no clipping";
      $("#clip", el).style.color = clipping ? "var(--bad)" : rms > thr ? "var(--good)" : "";
      raf = requestAnimationFrame(draw);
    };
    live = { stream, source, stop: () => { cancelAnimationFrame(raf); source.disconnect(); stream.getTracks().forEach((t) => t.stop()); } };
    $("#micState", el).textContent = stream.getAudioTracks()[0]?.label?.slice(0, 32) || "live"; $("#micState", el).className = "pill live";
    $("#liveBtn", el).textContent = "Stop live test";
    draw();
  }
  $("#liveBtn", el).onclick = () => (live ? (stopLive(), ($("#liveBtn", el).textContent = "Start live test"), ($("#micState", el).textContent = "off")) : startLive().catch((e) => toast(`Microphone unavailable: ${e.message}`)));
  for (const id of ["dev", "ns", "ec", "agc"]) $(`#${id}`, el).onchange = () => { if (live) startLive().catch((e) => toast(e.message)); };
  $("#vad", el).oninput = (e) => { $("#vadV", el).textContent = Number(e.target.value).toFixed(3); };
  $("#ep", el).oninput = (e) => { $("#epV", el).textContent = `${(Number(e.target.value) / 1000).toFixed(1)}s`; };

  const sample = (ms) => new Promise((resolve) => { const vals = []; const iv = setInterval(() => vals.push(live?.lastRms || 0), 50); setTimeout(() => { clearInterval(iv); resolve(vals); }, ms); });
  $("#noiseBtn", el).onclick = async () => {
    if (!live) await startLive();
    $("#noiseOut", el).textContent = "Measuring — stay quiet…";
    const v = (await sample(3000)).sort((a, b) => a - b);
    noiseRms = v[Math.floor(v.length * 0.5)] || 0;
    const db = noiseRms > 0 ? (20 * Math.log10(noiseRms)).toFixed(0) : "−∞";
    $("#noiseOut", el).textContent = `Background noise ${db} dB — ${noiseRms < 0.004 ? "quiet room" : noiseRms < 0.015 ? "some noise" : "noisy: turn on noise suppression or move the microphone closer"}.`;
  };
  $("#speakBtn", el).onclick = async () => {
    if (!live) await startLive();
    const btn = $("#speakBtn", el); btn.disabled = true;
    const ac = voice.ensureAudio(), proc = ac.createScriptProcessor(4096, 1, 1), sink = ac.createGain(); sink.gain.value = 0;
    const chunks = [], levels = []; live.source.connect(proc); proc.connect(sink); sink.connect(ac.destination);
    proc.onaudioprocess = (e) => { const c = new Float32Array(e.inputBuffer.getChannelData(0)); chunks.push(c); let s = 0; for (const v of c) s += v * v; levels.push(Math.sqrt(s / c.length)); };
    const thr = Number($("#vad", el).value), endpoint = Number($("#ep", el).value), t0 = performance.now();
    $("#recOut", el).textContent = "Listening — read the sentence now…";
    let spoke = false, quiet = performance.now();
    await new Promise((resolve) => { const iv = setInterval(() => { const l = levels.at(-1) || 0; if (l > thr) { spoke = true; quiet = performance.now(); } if ((spoke && performance.now() - quiet > endpoint) || performance.now() - t0 > 12000) { clearInterval(iv); resolve(); } }, 60); });
    proc.disconnect(); sink.disconnect();
    btn.disabled = false;
    if (!spoke) { $("#recOut", el).textContent = "No speech detected — check the device, or lower the speech sensitivity."; return; }
    const loud = levels.filter((l) => l > thr).sort((a, b) => a - b); speechRms = loud[Math.floor(loud.length * 0.5)] || 0;
    $("#recOut", el).textContent = "Transcribing…";
    try {
      const r = await api("/api/transcribe", { method: "POST", raw: await encodeWav16k(chunks, ac.sampleRate), headers: { "content-type": "audio/wav" } });
      const acc = accuracy(SENTENCE, r.text || "");
      $("#recOut", el).textContent = "";
      const suggested = Math.min(Math.max((noiseRms ?? 0.004) * 3, 0.006), Math.max(0.006, speechRms * 0.45));
      $("#result", el).innerHTML = `<div class="panel flat" style="padding:12px"><div class="label" style="margin-bottom:6px">JARVIS heard</div><div style="font-size:15px">“${esc(r.text || "(nothing)")}”</div>
        <div class="grid cols-3" style="margin-top:10px"><div class="stat"><b>${acc}%</b><span>words correct</span></div><div class="stat"><b>${r.latencyMs ?? "—"} ms</b><span>recognition time</span></div><div class="stat"><b>${esc(r.confidence?.level || "—")}</b><span>confidence (estimated)</span></div></div>
        ${r.audio ? `<p class="faint" style="font-size:12px;margin:8px 0 0">Peak ${r.audio.peak} · clipping ${(r.audio.clipping * 100).toFixed(1)}% · speech ${r.audio.speechSec}s · gain applied ×${r.audio.gain}${r.confidence?.reasons?.length ? ` · ${esc(r.confidence.reasons.join(", "))}` : ""}</p>` : ""}
        <p class="muted" style="font-size:13px;margin:8px 0 0">${acc >= 90 ? "Excellent — JARVIS understood you." : acc >= 70 ? "Good. If words were missed, move closer or try noise suppression." : "Poor. Try another microphone, move closer, turn noise suppression on, or reduce background noise."} Suggested speech sensitivity: <b>${suggested.toFixed(3)}</b> (applied — press Save to keep it).</p></div>`;
      $("#vad", el).value = suggested; $("#vadV", el).textContent = suggested.toFixed(3);
      api("/api/diagnostics/report", { method: "POST", body: { check: "mic_calibration", status: acc >= 70 ? "ok" : "warn", detail: `${acc}% words correct, ${r.latencyMs} ms, noise ${noiseRms?.toFixed(4) ?? "?"}` } }).catch(() => {});
    } catch (e) { $("#recOut", el).textContent = e.message; }
  };
  const values = () => ({ micDeviceId: $("#dev", el).value || null, noiseSuppression: $("#ns", el).checked, echoCancellation: $("#ec", el).checked, autoGainControl: $("#agc", el).checked, vadThreshold: Number($("#vad", el).value), endpointMs: Number($("#ep", el).value), calibratedAt: new Date().toISOString() });
  $("#saveBtn", el).onclick = async () => {
    const v = values();
    if (d) await d.setSettings(v); else { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(v)); } catch {} voice.micDeviceId = v.micDeviceId; voice.vadThreshold = v.vadThreshold; }
    toast("Microphone settings saved."); renderMicSetup(el, ctx);
  };
  $("#resetBtn", el).onclick = async () => {
    const v = { micDeviceId: null, noiseSuppression: true, echoCancellation: true, autoGainControl: true, vadThreshold: 0.03, endpointMs: 1200, calibratedAt: null };
    if (d) await d.setSettings(v); else { try { localStorage.removeItem(LOCAL_KEY); } catch {} }
    toast("Audio settings reset to defaults."); renderMicSetup(el, ctx);
  };
}
export function stopLive() { live?.stop(); live = null; clearInterval(statusTimer); statusTimer = null; if (devWatch) navigator.mediaDevices?.removeEventListener?.("devicechange", devWatch); devWatch = null; }
// Apply saved browser/phone microphone settings at start-up.
export function applyLocalMicSettings() { const v = loadLocal(); if (v.micDeviceId) voice.micDeviceId = v.micDeviceId; if (v.vadThreshold) voice.vadThreshold = v.vadThreshold; }
void $$;
