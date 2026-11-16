// Free, private speech recognition on this machine: Whisper base.en (int8) via sherpa-onnx.
// Used when JARVIS runs on the laptop (the Windows app points JARVIS_ASR_DIR at the bundled model).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DIR = process.env.JARVIS_ASR_DIR || "";
let recognizerPromise = null, sherpa = null, loadError = null;

export function localAsrAvailable() {
  if (!DIR || loadError) return false;
  return ["base.en-encoder.int8.onnx", "base.en-decoder.int8.onnx", "base.en-tokens.txt"].every((f) => fs.existsSync(path.join(DIR, f)));
}
export function localAsrStatus() { return { available: localAsrAvailable(), model: "Whisper base.en (on this laptop)", error: loadError }; }

function recognizer() {
  if (!recognizerPromise) {
    recognizerPromise = (async () => {
      sherpa = require("sherpa-onnx-node");
      return sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          whisper: { encoder: path.join(DIR, "base.en-encoder.int8.onnx"), decoder: path.join(DIR, "base.en-decoder.int8.onnx"), language: "en", task: "transcribe" },
          tokens: path.join(DIR, "base.en-tokens.txt"), numThreads: 2, provider: "cpu", debug: 0,
        },
      });
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

export async function transcribeLocal(buffer) {
  const wav = parseWav(buffer);
  if (!wav) throw Object.assign(new Error("Local transcription needs WAV audio."), { status: 415, expose: true, code: "not_wav" });
  const rec = await recognizer();
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate: wav.sampleRate, samples: wav.samples });
  await rec.decodeAsync(stream);
  return (rec.getResult(stream).text || "").trim();
}
