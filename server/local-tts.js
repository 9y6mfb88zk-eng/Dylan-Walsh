// Free, private speech synthesis on this machine (JARVIS 6.8): a Piper voice run by sherpa-onnx, which JARVIS already
// uses for speech recognition — no new engine, no account, no per-use cost.
//
// Voice: Piper "northern_english_male" (medium), trained on the OpenSLR 83 dataset (CC-BY-SA 4.0). Text is turned into
// phonemes by espeak-ng (the `phonemizer` package; sherpa-onnx 2.x no longer bundles a phonemiser) clause by clause,
// keeping the punctuation so the voice pauses naturally at commas and full stops.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DIR = process.env.JARVIS_TTS_DIR || "";
export const VOICE = { id: "en_GB-northern_english_male-medium", name: "Northern English male (Piper, on this laptop)", licence: "CC-BY-SA 4.0 (OpenSLR 83); Piper voice model" };
const MODEL = `${VOICE.id}.onnx`;
let ttsPromise = null, loadError = null, ready = false, phonemize = null, sherpa = null;
const cache = new Map();             // recent sentences → WAV (short replies such as "Standing by." repeat often)
let chain = Promise.resolve();       // one synthesis at a time on the shared model

export function localTtsAvailable() { return !loadError && !!DIR && fs.existsSync(path.join(DIR, MODEL)) && fs.existsSync(path.join(DIR, "tokens.txt")); }
export function localTtsStatus() { return { available: localTtsAvailable(), voice: localTtsAvailable() ? VOICE.name : null, ready, error: loadError }; }

function engine() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      sherpa = require("sherpa-onnx-node");
      ({ phonemize } = await import("phonemizer"));
      const threads = Math.max(1, Math.min(2, (await import("node:os")).cpus().length - 1));
      const tts = await sherpa.OfflineTts.createAsync({ model: { vits: { model: path.join(DIR, MODEL), tokens: path.join(DIR, "tokens.txt") }, numThreads: threads, provider: "cpu", debug: 0 }, maxNumSentences: 1 });
      await phonemize("Ready.", "en-gb-x-rp");      // loads the phonemiser now, not on the first reply
      ready = true;
      return tts;
    })().catch((e) => { loadError = e.message; ttsPromise = null; throw e; });
  }
  return ttsPromise;
}
/** Load the voice in the background (called at start-up when it's the chosen voice). */
export function warmLocalTts() { if (localTtsAvailable()) engine().catch(() => {}); }

/** Phonemes per sentence as Unicode code points, with punctuation kept for pauses. */
export async function toPhonemes(text) {
  if (!phonemize) ({ phonemize } = await import("phonemizer"));
  const sentences = (String(text).match(/[^.!?]+[.!?]*/g) || []).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of sentences) {
    const parts = s.split(/([,;:.!?]+)/);
    let ph = "";
    for (let i = 0; i < parts.length; i += 2) {
      const words = parts[i].trim(), p = (parts[i + 1] || "").trim();
      if (words) ph += (await phonemize(words, "en-gb-x-rp")).join(" ");
      if (p) ph += p[0];
      ph += " ";
    }
    const cps = [...ph.trim()].map((c) => c.codePointAt(0));
    if (cps.length) out.push(cps);
  }
  return out;
}

/** Synthesise text → 16-bit mono WAV (Buffer). speed: 1 = normal, higher is faster. */
export function synthesizeLocal(text, { speed = 1 } = {}) {
  const key = `${speed.toFixed(2)}|${text}`;
  if (cache.has(key)) { const b = cache.get(key); cache.delete(key); cache.set(key, b); return Promise.resolve(b); }
  const job = chain.then(async () => {
    const tts = await engine();
    const pc = await toPhonemes(text);
    if (!pc.length) return wav(new Float32Array(0), tts.sampleRate);
    const a = await tts.generateAsync({ text: "", sid: 0, speed, generationConfig: new sherpa.GenerationConfig({ phonemeCodepoints: pc, speed, sid: 0 }) });
    const buf = wav(a.samples, a.sampleRate);
    if (text.length < 200) { cache.set(key, buf); if (cache.size > 60) cache.delete(cache.keys().next().value); }
    return buf;
  });
  chain = job.catch(() => {});
  return job;
}

function wav(samples, rate) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}
