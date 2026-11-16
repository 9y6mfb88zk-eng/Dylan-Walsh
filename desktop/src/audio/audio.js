// Always-on local wake-word service.
// Microphone → 16 kHz → openWakeWord "hey_jarvis" (ONNX, in this process) → wake event.
// Nothing is sent anywhere: only the wake event (a number) leaves this window.
import { WakeWordEngine, WakeDetector, createResampler } from "../wakeword/engine.js";

const bridge = window.audioBridge;
const ort = window.ort;
ort.env.wasm.wasmPaths = new URL("../../node_modules/onnxruntime-web/dist/", location.href).href;
ort.env.wasm.numThreads = 1;

let engine = null, detector = null, cfg = null;
let ctx = null, stream = null, node = null, src = null, deviceLabel = "", resample = null;
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
      audio: { deviceId: cfg.micDeviceId ? { exact: cfg.micDeviceId } : undefined, channelCount: 1, echoCancellation: cfg.echoCancellation !== false, noiseSuppression: cfg.noiseSuppression !== false, autoGainControl: cfg.autoGainControl !== false },
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
  resample = createResampler(ctx.sampleRate);   // anti-aliased, keeps its place between chunks
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
let capture = null;   // { id, chunks, spoke, quietSince, started, floor, noSpeechMs, maxMs, lastProgress, lastLevel }
// A capture starts after a wake word (with the 0.5 s pre-roll, so nothing said right after "JARVIS" is lost) or when the
// conversation asks for a follow-up (no pre-roll, so the tail of JARVIS's own voice isn't included).
function startCapture({ id = "wake", preRoll = true, noSpeechMs = 6000, maxMs = 15000 } = {}) {
  if (capture) { if (id !== "wake") { const prev = capture; capture = null; bridge.captured(null, prev.id); } else return; }
  capture = { id, chunks: preRoll ? [ring.slice()] : [], spoke: false, quietSince: Date.now(), started: Date.now(), floor: 0.008, noSpeechMs, maxMs, lastProgress: 0, lastLevel: 0 };
}
function cancelCapture() { if (!capture) return; const id = capture.id; capture = null; bridge.captured(null, id); }
function rms(pcm) { let s = 0; for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; s += v * v; } return Math.sqrt(s / Math.max(1, pcm.length)); }
// Voice activity: speech must clear a start threshold for ~160 ms (so clicks and taps don't count); once you're talking,
// a lower "still talking" threshold keeps quiet, trailing words from being treated as silence (hysteresis).
// End of speech: a pause of endpointMs (default 1.2 s) — or 1.8 s while you've said very little, so a pause after
// "JARVIS…" doesn't cut you off. The background-noise floor keeps adapting while you're quiet.
function captureChunk(pcm) {
  const c = capture; c.chunks.push(pcm);
  const l = rms(pcm), now = Date.now();
  const startThr = Math.max(cfg.vadThreshold || 0.03, c.floor * 2.5), keepThr = Math.max((cfg.vadThreshold || 0.03) * 0.55, c.floor * 1.6);
  if (l < keepThr) c.floor = c.floor * 0.95 + l * 0.05;
  if (!c.spoke) {
    c.loud = l > startThr ? (c.loud || 0) + 1 : 0;
    if (c.loud >= 2) { c.spoke = true; c.quietSince = now; c.speechStart = now; }
  } else if (l > keepThr) { c.quietSince = now; c.voiced = (c.voiced || 0) + pcm.length / 16000; }
  if (now - c.lastLevel > 66) { c.lastLevel = now; bridge.level?.(Math.min(1, rms(pcm) * 6)); }
  // Live transcription: while you talk, hand the audio so far to the app every 1.5 s.
  if (c.spoke && now - c.lastProgress > 1500 && now - c.started > 1200) { c.lastProgress = now; bridge.progress?.(wav16k(c.chunks)); }
  const endpoint = cfg.endpointMs || 1200;
  const doneSpeaking = c.spoke && now - c.quietSince > ((c.voiced || 0) < 1 ? Math.max(endpoint, 1800) : endpoint);
  if (doneSpeaking || now - c.started > c.maxMs || (!c.spoke && now - c.started > c.noSpeechMs)) {
    const spoke = c.spoke, id = c.id; capture = null;
    bridge.captured(spoke ? wav16k(c.chunks) : null, id);
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
bridge.onCapture?.((opts) => startCapture(opts || {}));
bridge.onCancel?.(() => cancelCapture());

async function pump() {
  if (busy || !engine || !ctx) return;
  busy = true;
  try {
    while (queue.length) {
      const chunk = queue.shift();
      const pcm = resample(chunk);
      if (!pcm.length) continue;
      const merged = new Int16Array(Math.min(RING, ring.length + pcm.length));
      merged.set(ring.subarray(Math.max(0, ring.length + pcm.length - RING)), 0);
      merged.set(pcm.subarray(Math.max(0, pcm.length - RING)), merged.length - Math.min(pcm.length, RING));
      ring = merged;
      if (capture) { captureChunk(pcm); continue; }   // recording a command: don't look for wake words
      if (!cfg?.detect) continue;            // in a conversation (and JARVIS isn't talking): the mic is only kept warm
      bridge.pcm(pcm);                       // also feed the "JARVIS" keyword spotter (local, separate process)
      const scores = await engine.push(pcm);
      for (const s of scores) {
        const now = Date.now();
        if (now - lastScoreSent > 100) { bridge.score(s); lastScoreSent = now; }
        if (detector.update(s, now)) { startCapture({ id: "wake" }); bridge.wake(s); engine.reset(); await engine.prime(); break; }
      }
    }
  } catch (e) { report({ wakeWord: "error", error: `Wake-word engine: ${e.message}` }); }
  busy = false;
}

async function apply(c) {
  const prev = cfg; cfg = c;
  if (!engine) return;
  const micOn = c.micOn ?? (c.enabled && !c.paused);
  if (!micOn) { cancelCapture(); stopMic(); return report({ wakeWord: c.muted ? "muted" : c.wakeEnabled === false ? "disabled" : "paused", mic: "off", error: null }); }
  if (detector) Object.assign(detector, { threshold: c.threshold, minFrames: c.minFrames });
  const deviceChanged = (prev && prev.micDeviceId !== c.micDeviceId) || c.restartMic;
  if (!stream || deviceChanged || state.mic !== "ok") await startMic();
  report({ wakeWord: c.detect === false ? (c.wakeEnabled === false ? "disabled" : "conversation") : "listening" });
}

navigator.mediaDevices.addEventListener("devicechange", () => { if ((cfg?.micOn ?? cfg?.enabled) && state.mic !== "ok") apply(cfg); });
bridge.onConfig((c) => apply(c));

(async () => {
  report({ wakeWord: "loading" });
  try { await loadEngine(); } catch (e) { return report({ wakeWord: "error", error: `Could not load the wake-word model: ${e.message}` }); }
  await apply(await bridge.getConfig());
})();
