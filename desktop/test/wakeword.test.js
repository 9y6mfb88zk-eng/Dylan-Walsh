// The real openWakeWord "hey_jarvis" model through the JavaScript engine used by the Windows app.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WakeWordEngine, WakeDetector, resampleTo16k } from "../src/wakeword/engine.js";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-web");
const fx = (f) => new URL(`./fixtures/${f}`, import.meta.url);
const models = new URL("../models/", import.meta.url);
let engine;

function wav(f) { const b = fs.readFileSync(fx(f)); return new Int16Array(b.buffer.slice(b.byteOffset + 44)); }
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Int16Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const silence = (s) => new Int16Array(Math.round(16000 * s));
function noise(seconds, amp = 1500, seed = 7) { let x = seed; const o = new Int16Array(16000 * seconds); for (let i = 0; i < o.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; o[i] = ((x / 0x7fffffff) * 2 - 1) * amp; } return o; }
function mix(a, b) { const o = new Int16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.max(-32768, Math.min(32767, a[i] + (b[i % b.length] || 0))); return o; }

async function detections(audio, opts) {
  engine.reset(); await engine.prime();
  const d = new WakeDetector(opts);
  let n = 0, peak = 0, t = 0;
  for (let i = 0; i < audio.length; i += 1280) {
    for (const s of await engine.push(audio.subarray(i, i + 1280))) { peak = Math.max(peak, s); t += 80; if (d.update(s, t)) n++; }
  }
  return { n, peak };
}

before(async () => {
  engine = await WakeWordEngine.load(ort, { melspec: fileURLToPath(new URL("melspectrogram.onnx", models)), embedding: fileURLToPath(new URL("embedding_model.onnx", models)), wakeword: fileURLToPath(new URL("hey_jarvis_v0.1.onnx", models)) });
});

test("detects “hey jarvis” in four different voices", async () => {
  for (const f of ["en-gb-hey_jarvis-150.wav", "en-gb-x-rp-hey_jarvis-130.wav", "en-us-hey_jarvis-140.wav", "en-us+m3-hey_jarvis-120.wav"]) {
    const r = await detections(concat(silence(1), wav(f), silence(1.5)), { threshold: 0.5, minFrames: 2 });
    assert.equal(r.n, 1, `${f}: ${r.n} detections, peak ${r.peak.toFixed(3)}`);
  }
});

test("does not trigger on other phrases, silence or background noise", async () => {
  for (const f of ["en-gb-hello_there-150.wav", "en-gb-hey_service-150.wav"]) {
    const r = await detections(concat(silence(1), wav(f), silence(1.5)), { threshold: 0.5, minFrames: 2 });
    assert.equal(r.n, 0, `${f} falsely triggered (peak ${r.peak.toFixed(3)})`);
  }
  assert.equal((await detections(noise(20), { threshold: 0.5, minFrames: 2 })).n, 0, "20 s of noise");
  assert.equal((await detections(silence(10), { threshold: 0.5, minFrames: 2 })).n, 0, "silence");
});

test("still detects the phrase over moderate background noise", async () => {
  const clip = concat(silence(1), wav("en-gb-hey_jarvis-150.wav"), silence(1.5));
  const r = await detections(mix(clip, noise(4, 900)), { threshold: 0.5, minFrames: 2 });
  assert.equal(r.n, 1, `peak ${r.peak.toFixed(3)}`);
});

test("cooldown prevents double triggers; one detection per utterance in a long stream", async () => {
  const stream = concat(silence(1), wav("en-gb-hello_there-150.wav"), silence(2), wav("en-gb-hey_jarvis-150.wav"), silence(3), wav("en-gb-hey_service-150.wav"), silence(2), wav("en-us-hey_jarvis-140.wav"), silence(2));
  assert.equal((await detections(stream, { threshold: 0.5, minFrames: 2, cooldownMs: 2500 })).n, 2);
});

test("higher threshold trades sensitivity for fewer false triggers", async () => {
  const r = await detections(concat(silence(1), wav("en-us+m3-hey_jarvis-120.wav"), silence(1.5)), { threshold: 0.95, minFrames: 3 });
  assert.equal(r.n, 0);
});

test("resampler converts 48 kHz float audio to 16 kHz int16", () => {
  const f = new Float32Array(48000).map((_, i) => Math.sin(i / 10) * 0.5);
  const o = resampleTo16k(f, 48000);
  assert.equal(o.length, 16000);
  assert.ok(Math.max(...o) > 15000 && Math.max(...o) <= 16384);
});

test("runs comfortably in real time", async () => {
  engine.reset(); await engine.prime();
  const audio = noise(5);
  const t0 = performance.now(); await engine.push(audio); const ms = performance.now() - t0;
  assert.ok(ms < 2500, `5 s of audio took ${ms.toFixed(0)} ms`);
});
