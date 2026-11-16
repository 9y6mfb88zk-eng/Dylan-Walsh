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
  // Ask Chromium for a 16 kHz graph so no resampling is needed; fall back if refused.
  try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
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

async function pump() {
  if (busy || !engine || !ctx) return;
  busy = true;
  try {
    while (queue.length) {
      const chunk = queue.shift();
      const pcm = resampleTo16k(chunk, ctx.sampleRate);
      const scores = await engine.push(pcm);
      for (const s of scores) {
        const now = Date.now();
        if (now - lastScoreSent > 100) { bridge.score(s); lastScoreSent = now; }
        if (detector.update(s, now)) { bridge.wake(s); engine.reset(); await engine.prime(); queue = []; break; }
      }
    }
  } catch (e) { report({ wakeWord: "error", error: `Wake-word engine: ${e.message}` }); }
  busy = false;
}

async function apply(c) {
  const prev = cfg; cfg = c;
  if (!engine) return;
  if (!c.enabled) { stopMic(); return report({ wakeWord: "disabled", mic: "off", error: null }); }
  if (c.paused) { stopMic(); return report({ wakeWord: "paused" }); }
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
