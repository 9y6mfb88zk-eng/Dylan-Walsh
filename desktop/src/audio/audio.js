// Always-on local wake-word service.
// Microphone → 16 kHz → openWakeWord "hey_jarvis" (ONNX, in this process) → wake event.
// Nothing is sent anywhere: only the wake event (a number) leaves this window.
import { WakeWordEngine, WakeDetector, resampleTo16k } from "../wakeword/engine.js";

const bridge = window.audioBridge;
const ort = window.ort;
ort.env.wasm.wasmPaths = new URL("../../node_modules/onnxruntime-web/dist/", location.href).href;
ort.env.wasm.numThreads = 1;

let engine = null, detector = null, cfg = null;
let ctx = null, stream = null, node = null, src = null, deviceLabel = "";
let queue = [], busy = false, retryTimer = null;
let state = { wakeWord: "loading", mic: "unknown", error: null };
let lastScoreSent = 0;

function report(patch = {}) {
  state = { ...state, ...patch };
  bridge.status({ ...state, micDevice: deviceLabel });
}

async function loadEngine() {
  const m = (f) => new URL(`../../models/${f}`, location.href).href;
  const bytes = async (f) => new Uint8Array(await (await fetch(m(f))).arrayBuffer());
  engine = await WakeWordEngine.load(ort, { melspec: await bytes("melspectrogram.onnx"), embedding: await bytes("embedding_model.onnx"), wakeword: await bytes("hey_jarvis_v0.1.onnx") });
}

async function startMic() {
  stopMic();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: cfg.micDeviceId ? { exact: cfg.micDeviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const denied = e.name === "NotAllowedError" || e.name === "SecurityError";
    const missing = e.name === "NotFoundError" || e.name === "OverconstrainedError";
    report({ wakeWord: "error", mic: denied ? "denied" : missing ? "missing" : "error", error: denied ? "Microphone permission denied" : missing ? "No microphone found" : e.message });
    scheduleRetry();
    return;
  }
  const track = stream.getAudioTracks()[0];
  deviceLabel = track.label || "Default microphone";
  track.addEventListener("ended", () => { report({ wakeWord: "error", mic: "missing", error: "Microphone disconnected — retrying" }); scheduleRetry(); });
  // Use the microphone's native rate (usually 48 kHz on laptops) and resample to 16 kHz ourselves —
  // forcing a 16 kHz graph can fail silently with some Windows audio drivers.
  ctx = new AudioContext();
  await ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
  src = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, "jarvis-capture");
  node.port.onmessage = (e) => { queue.push(e.data); if (queue.length > 15) queue.splice(0, queue.length - 15); pump(); };
  src.connect(node);
  engine.reset(); await engine.prime();
  detector = new WakeDetector({ threshold: cfg.threshold, minFrames: cfg.minFrames, cooldownMs: 2500 });
  report({ wakeWord: "listening", mic: "ok", error: null });
}

function stopMic() {
  clearTimeout(retryTimer);
  try { src?.disconnect(); node?.disconnect(); } catch {}
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close().catch(() => {});
  stream = ctx = src = node = null; queue = [];
}
function scheduleRetry() { clearTimeout(retryTimer); retryTimer = setTimeout(() => apply(cfg), 3000); }

// ---- Command capture: after a wake word, the same always-on stream records the command (no gap, no re-opening
// the microphone), starting with the last 0.5 s so nothing said straight after "JARVIS" is clipped.
const RING = 16000 * 0.5;
let ring = new Int16Array(0);
let capture = null;   // { chunks, spoke, quietSince, started, floor }
function startCapture() {
  if (capture) return;
  capture = { chunks: [ring.slice()], spoke: false, quietSince: Date.now(), started: Date.now(), floor: 0.008 };
}
function rms(pcm) { let s = 0; for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; s += v * v; } return Math.sqrt(s / Math.max(1, pcm.length)); }
function captureChunk(pcm) {
  const c = capture; c.chunks.push(pcm);
  const l = rms(pcm), now = Date.now();
  if (!c.spoke) c.floor = c.floor * 0.9 + l * 0.1;
  if (l > Math.max(cfg.vadThreshold || 0.03, c.floor * 2.2)) { c.spoke = true; c.quietSince = now; }
  const doneSpeaking = c.spoke && now - c.quietSince > 1200;
  if (doneSpeaking || now - c.started > 15000 || (!c.spoke && now - c.started > 6000)) {
    const spoke = c.spoke; capture = null;
    bridge.captured(spoke ? wav16k(c.chunks) : null);
  }
}
function wav16k(chunks) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, n * 2, true);
  const out = new Int16Array(buf, 44); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return new Uint8Array(buf);
}
bridge.onCapture?.(() => startCapture());

async function pump() {
  if (busy || !engine || !ctx) return;
  busy = true;
  try {
    while (queue.length) {
      const chunk = queue.shift();
      const pcm = resampleTo16k(chunk, ctx.sampleRate);
      const merged = new Int16Array(Math.min(RING, ring.length + pcm.length));
      merged.set(ring.subarray(Math.max(0, ring.length + pcm.length - RING)), 0);
      merged.set(pcm.subarray(Math.max(0, pcm.length - RING)), merged.length - Math.min(pcm.length, RING));
      ring = merged;
      if (capture) { captureChunk(pcm); continue; }   // recording a command: don't look for wake words
      bridge.pcm(pcm);                       // also feed the "JARVIS" keyword spotter (local, separate process)
      const scores = await engine.push(pcm);
      for (const s of scores) {
        const now = Date.now();
        if (now - lastScoreSent > 100) { bridge.score(s); lastScoreSent = now; }
        if (detector.update(s, now)) { startCapture(); bridge.wake(s); engine.reset(); await engine.prime(); break; }
      }
    }
  } catch (e) { report({ wakeWord: "error", error: `Wake-word engine: ${e.message}` }); }
  busy = false;
}

async function apply(c) {
  const prev = cfg; cfg = c;
  if (!engine) return;
  if (!c.enabled) { stopMic(); return report({ wakeWord: "disabled", mic: "off", error: null }); }
  if (c.paused) { capture = null; stopMic(); return report({ wakeWord: "paused" }); }
  if (detector) Object.assign(detector, { threshold: c.threshold, minFrames: c.minFrames });
  const deviceChanged = prev && prev.micDeviceId !== c.micDeviceId;
  if (!stream || deviceChanged || state.wakeWord !== "listening") await startMic();
}

navigator.mediaDevices.addEventListener("devicechange", () => { if (cfg?.enabled && !cfg.paused && state.wakeWord !== "listening") apply(cfg); });
bridge.onConfig((c) => apply(c));

(async () => {
  report({ wakeWord: "loading" });
  try { await loadEngine(); } catch (e) { return report({ wakeWord: "error", error: `Could not load the wake-word model: ${e.message}` }); }
  await apply(await bridge.getConfig());
})();
