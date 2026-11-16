// Free, private speech recognition on this machine via sherpa-onnx.
// Preferred model: NVIDIA Parakeet TDT 0.6B v2 (int8) — measured 2.6% vs 11.4% word errors for Whisper base.en on the
// same recordings, and faster (docs/asr-benchmark.json). Whisper base.en is still supported if that's what's installed.
// Before decoding, audio is cleaned: DC/rumble removed, quiet speech normalised, long silences trimmed, tail padded
// (so the last word isn't cut off). A confidence estimate is returned with every transcript.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DIR = process.env.JARVIS_ASR_DIR || "";
const PARAKEET = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
const WHISPER = ["base.en-encoder.int8.onnx", "base.en-decoder.int8.onnx", "base.en-tokens.txt"];
let recognizerPromise = null, sherpa = null, loadError = null;

const has = (files) => DIR && files.every((f) => fs.existsSync(path.join(DIR, f)));
export function localAsrModel() { return has(PARAKEET) ? "parakeet" : has(WHISPER) ? "whisper" : null; }
export function localAsrAvailable() { return !loadError && !!localAsrModel(); }
export function localAsrStatus() {
  const m = localAsrModel();
  return { available: localAsrAvailable(), model: m === "parakeet" ? "Parakeet TDT 0.6B v2 (on this laptop)" : m === "whisper" ? "Whisper base.en (on this laptop)" : null, engine: m, error: loadError };
}

function recognizer() {
  if (!recognizerPromise) {
    recognizerPromise = (async () => {
      sherpa = require("sherpa-onnx-node");
      const threads = Math.max(1, Math.min(4, (await import("node:os")).cpus().length - 1));
      const modelConfig = localAsrModel() === "parakeet"
        ? { transducer: { encoder: path.join(DIR, "encoder.int8.onnx"), decoder: path.join(DIR, "decoder.int8.onnx"), joiner: path.join(DIR, "joiner.int8.onnx") }, tokens: path.join(DIR, "tokens.txt"), modelType: "nemo_transducer" }
        : { whisper: { encoder: path.join(DIR, WHISPER[0]), decoder: path.join(DIR, WHISPER[1]), language: "en", task: "transcribe" }, tokens: path.join(DIR, WHISPER[2]) };
      return sherpa.OfflineRecognizer.createAsync({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { ...modelConfig, numThreads: threads, provider: "cpu", debug: 0 } });
    })().catch((e) => { loadError = e.message; recognizerPromise = null; throw e; });
  }
  return recognizerPromise;
}
/** Warm the model in the background so the first command isn't slow. */
export function preloadLocalAsr() { if (localAsrAvailable()) recognizer().catch(() => {}); }

/** Parse a PCM WAV (8/16-bit int or 32-bit float, any rate, mono or stereo) into mono Float32 samples. */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)); break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) return null;
  const bytes = fmt.bits / 8, frames = Math.floor(data.length / (bytes * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const p = (i * fmt.channels + c) * bytes;
      s += fmt.format === 3 ? data.readFloatLE(p) : fmt.bits === 16 ? data.readInt16LE(p) / 32768 : fmt.bits === 8 ? (data[p] - 128) / 128 : data.readInt32LE(p) / 2147483648;
    }
    out[i] = s / fmt.channels;
  }
  return { samples: out, sampleRate: fmt.rate };
}

/**
 * Clean up captured audio for recognition and measure it. Returns { samples, stats }.
 * stats: durationSec, speechSec, peak, rms, clipping (fraction of samples at full scale), gain applied.
 */
export function prepareAudio(samples, rate) {
  const n = samples.length;
  let clipped = 0;
  for (let i = 0; i < n; i++) if (Math.abs(samples[i]) > 0.985) clipped++;
  // 1. Remove DC offset and rumble: one-pole high-pass at ~80 Hz.
  const a = Math.exp(-2 * Math.PI * 80 / rate);
  const x = new Float32Array(n);
  let px = 0, py = 0;
  for (let i = 0; i < n; i++) { const v = samples[i]; py = a * (py + v - px); px = v; x[i] = py; }
  // 2. Frame energies (20 ms) → noise floor and speech frames.
  const F = Math.max(1, Math.round(rate * 0.02)), frames = Math.ceil(n / F), e = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let s = 0; const end = Math.min(n, (f + 1) * F); for (let i = f * F; i < end; i++) s += x[i] * x[i]; e[f] = Math.sqrt(s / Math.max(1, end - f * F)); }
  const sorted = Array.from(e).sort((p, q) => p - q);
  const floor = sorted[Math.floor(sorted.length * 0.15)] || 0;
  const thr = Math.max(floor * 3, 0.004);
  const speech = Array.from(e, (v) => v > thr);
  const first = speech.indexOf(true), last = speech.lastIndexOf(true);
  const speechFrames = speech.filter(Boolean).length;
  // 3. Trim silence beyond 0.3 s either side of the speech (faster decoding, fewer hallucinations).
  let start = 0, stop = n;
  if (first >= 0 && speechFrames >= 3) { start = Math.max(0, (first - 15) * F); stop = Math.min(n, (last + 16) * F); }
  // 4. Normalise quiet speech towards a 0.7 peak (max ×8 gain), never amplifying loud audio.
  let peak = 0, sum = 0;
  for (let i = start; i < stop; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; sum += x[i] * x[i]; }
  const gain = peak > 0 ? Math.min(8, Math.max(1, 0.7 / peak)) : 1;
  // 5. Pad 0.4 s of silence at the end so the recogniser finishes the last word.
  const pad = Math.round(rate * 0.4), out = new Float32Array(stop - start + pad);
  for (let i = start; i < stop; i++) out[i - start] = Math.max(-1, Math.min(1, x[i] * gain));
  return {
    samples: out,
    stats: { durationSec: +(n / rate).toFixed(2), speechSec: +(speechFrames * F / rate).toFixed(2), peak: +peak.toFixed(3), rms: +Math.sqrt(sum / Math.max(1, stop - start)).toFixed(4), clipping: +(clipped / Math.max(1, n)).toFixed(4), gain: +gain.toFixed(2), noiseFloor: +floor.toFixed(4) },
  };
}

/** Honest, heuristic confidence: the model gives no probability, so judge from the audio and the text it produced. */
export function estimateConfidence(text, stats) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  const reasons = [];
  if (!words) return { level: "none", reasons: ["no words recognised"] };
  if (stats.speechSec < 0.25) reasons.push("very little speech");
  if (stats.clipping > 0.02) reasons.push("microphone overloaded (clipping)");
  if (stats.peak < 0.02) reasons.push("speech very quiet");
  const rate = words / Math.max(0.3, stats.speechSec);
  if (stats.speechSec > 1.5 && rate < 0.5) reasons.push("long speech but few words recognised");
  if (rate > 7) reasons.push("more words than the audio allows");
  if (/\b(\w+)( \1\b){3,}/i.test(text)) reasons.push("repeated words");
  const noisy = stats.noiseFloor > 0 && stats.rms / stats.noiseFloor < 3;
  if (noisy) reasons.push("a lot of background noise");
  return { level: reasons.length >= 2 ? "low" : reasons.length === 1 ? "medium" : "high", reasons };
}

export async function transcribeLocal(buffer, { details = false } = {}) {
  const wav = parseWav(buffer);
  if (!wav) throw Object.assign(new Error("Local transcription needs WAV audio."), { status: 415, expose: true, code: "not_wav" });
  const { samples, stats } = prepareAudio(wav.samples, wav.sampleRate);
  const rec = await recognizer();
  const t0 = performance.now();
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate: wav.sampleRate, samples });
  await rec.decodeAsync(stream);
  const text = (rec.getResult(stream).text || "").trim();
  if (!details) return text;
  return { text, decodeMs: Math.round(performance.now() - t0), stats, confidence: estimateConfidence(text, stats), model: localAsrModel() };
}
