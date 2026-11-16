// Speech-recognition benchmark: the same recorded sentences through each on-device model, measuring word error rate
// and latency. Conditions: short commands, long sentences, slow/fast speech, quiet speech, background noise, clipping.
// Usage: node scripts/asr-bench.mjs <whisperDir> <parakeetDir> [outJson]
// Speech is synthesised with espeak-ng (several voices) — a fair A/B comparison, but not the same as a real human voice.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");
const [, , whisperDir, parakeetDir, outJson] = process.argv;
// PREP=1: pass each recording through JARVIS's audio clean-up (server/local-asr.js prepareAudio) first.
const prep = process.env.PREP === "1" ? (await import("../server/local-asr.js")).prepareAudio : null;

const SENTENCES = [
  "Set an alarm for seven tomorrow morning",
  "What's the weather like tomorrow",
  "Remind me to call my mum at six",
  "Open Chrome",
  "Start a twenty five minute focus session",
  "I just spent twelve pounds fifty on food",
  "Let's work on the next chapter of my story about the civil war",
  "What was that business idea I was working on last week",
  "Can you summarise my tasks for today and tell me which ones are overdue",
  "Add a meeting with the accountant on Friday at half past two in the afternoon",
  "Run a full system diagnostic",
  "How much money have I got left until the end of the month",
];
const VOICES = ["en-gb", "en-gb-x-rp", "en-us", "en-gb-scotland"];
const CONDITIONS = [
  { name: "normal", speed: 150 },
  { name: "fast", speed: 210 },
  { name: "slow", speed: 110 },
  { name: "quiet (-24 dB)", speed: 150, gain: 0.063 },
  { name: "noisy (SNR 10 dB)", speed: 150, noise: 0.316 },
  { name: "clipped", speed: 150, clip: 4 },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asr-bench-"));
function synth(text, voice, speed) {
  const f = path.join(tmp, "s.wav");
  execFileSync("espeak-ng", ["-v", voice, "-s", String(speed), "-w", f, text]);
  const raw = path.join(tmp, "s16.raw");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", f, "-ar", "16000", "-ac", "1", "-f", "f32le", raw]);
  const b = fs.readFileSync(raw);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice();
}
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
function condition(x, c) {
  const rmsS = Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
  const pad = new Float32Array(8000);   // 0.5 s room tone before and after, like a real capture
  const y = new Float32Array(x.length + pad.length * 2); y.set(x, pad.length);
  for (let i = 0; i < y.length; i++) {
    let v = y[i];
    if (c.gain) v *= c.gain;
    if (c.clip) v = Math.max(-0.3, Math.min(0.3, v * c.clip));
    if (c.noise) v += rnd() * rmsS * c.noise * 1.732;       // uniform noise with RMS = signal RMS × noise
    y[i] = v;
  }
  return y;
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\b(\d+)\b/g, (n) => n).split(/\s+/).filter(Boolean);
const NUM = { "7": "seven", "6": "six", "25": "twenty five", "12": "twelve", "50": "fifty", "£12.50": "twelve pounds fifty", "2:30": "half past two", "half past 2": "half past two" };
// Spoken and written forms of the same words count as correct (£12.50 = "twelve pounds fifty", summarise = summarize).
function canon(s) {
  let t = ` ${s.toLowerCase()} `;
  for (const [k, v] of Object.entries(NUM).sort((a, b) => b[0].length - a[0].length)) t = t.split(k.toLowerCase()).join(v);
  return norm(t.replace(/twenty-five/g, "twenty five").replace(/£/g, " pounds ").replace(/(\w)iz(e|es|ed|ing)\b/g, "$1is$2"));
}
function wer(ref, hyp) {
  const r = canon(ref), h = canon(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], words: r.length };
}

const models = {
  "Whisper base.en (current)": sherpa.OfflineRecognizer.createAsync ? await sherpa.OfflineRecognizer.createAsync({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { whisper: { encoder: path.join(whisperDir, "base.en-encoder.int8.onnx"), decoder: path.join(whisperDir, "base.en-decoder.int8.onnx"), language: "en", task: "transcribe" }, tokens: path.join(whisperDir, "base.en-tokens.txt"), numThreads: 2, provider: "cpu", debug: 0 } }) : null,
  "Parakeet TDT 0.6B v2 (new)": await sherpa.OfflineRecognizer.createAsync({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: { encoder: path.join(parakeetDir, "encoder.int8.onnx"), decoder: path.join(parakeetDir, "decoder.int8.onnx"), joiner: path.join(parakeetDir, "joiner.int8.onnx") }, tokens: path.join(parakeetDir, "tokens.txt"), modelType: "nemo_transducer", numThreads: 2, provider: "cpu", debug: 0 } }),
};
const results = {};
for (const name of Object.keys(models)) results[name] = { byCondition: {}, errors: 0, words: 0, ms: 0, audioSec: 0, samples: [] };
for (const c of CONDITIONS) {
  for (const [si, text] of SENTENCES.entries()) {
    const voice = VOICES[si % VOICES.length];
    let audio = condition(synth(text, voice, c.speed), c);
    if (prep) audio = prep(audio, 16000).samples;
    for (const [name, rec] of Object.entries(models)) {
      const t0 = performance.now();
      const st = rec.createStream(); st.acceptWaveform({ sampleRate: 16000, samples: audio });
      await rec.decodeAsync(st);
      const hyp = rec.getResult(st).text.trim();
      const ms = performance.now() - t0;
      const w = wer(text, hyp), R = results[name];
      R.errors += w.errors; R.words += w.words; R.ms += ms; R.audioSec += audio.length / 16000;
      const bc = (R.byCondition[c.name] ||= { errors: 0, words: 0 }); bc.errors += w.errors; bc.words += w.words;
      if (w.errors) R.samples.push({ condition: c.name, voice, ref: text, hyp });
    }
  }
}
const report = Object.fromEntries(Object.entries(results).map(([n, r]) => [n, {
  wer: +(100 * r.errors / r.words).toFixed(1), avgLatencyMs: Math.round(r.ms / (SENTENCES.length * CONDITIONS.length)), realTimeFactor: +(r.ms / 1000 / r.audioSec).toFixed(3),
  byCondition: Object.fromEntries(Object.entries(r.byCondition).map(([k, v]) => [k, +(100 * v.errors / v.words).toFixed(1)])), mistakes: r.samples.slice(0, 12),
}]));
console.log(JSON.stringify(report, null, 2));
if (outJson) fs.writeFileSync(outJson, JSON.stringify({ at: new Date().toISOString(), cpu: os.cpus()[0]?.model, threads: 2, sentences: SENTENCES.length, conditions: CONDITIONS.map((c) => c.name), voices: VOICES, report }, null, 2));
