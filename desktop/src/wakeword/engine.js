// Local "Hey JARVIS" wake-word engine.
// A faithful JavaScript port of openWakeWord's streaming pipeline (v0.5 models):
//   16 kHz int16 audio, 1280-sample (80 ms) frames
//   -> melspectrogram.onnx (x/10 + 2)  -> rolling buffer of 32-bin mel frames
//   -> embedding_model.onnx on the last 76 mel frames -> 96-dim embedding
//   -> hey_jarvis_v0.1.onnx on the last 16 embeddings -> score 0..1
// Audio never leaves the machine. Works with onnxruntime-web (Electron renderer, Node tests).

export const FRAME = 1280;
const MEL_BINS = 32;
const MEL_WINDOW = 76;
const EMB_DIM = 96;
const N_FEATURES = 16;
const MEL_MAX = 10 * 97;     // ~10 s of mel frames, same cap as openWakeWord
const FEAT_MAX = 120;

export class WakeWordEngine {
  constructor(ort, sessions) {
    this.ort = ort;
    this.mel = sessions.melspec;
    this.emb = sessions.embedding;
    this.ww = sessions.wakeword;
    this.wwInput = this.ww.inputNames[0];
    this.reset();
  }

  /** load(ort, {melspec, embedding, wakeword}) — each a URL/path or Uint8Array of the ONNX model. */
  static async load(ort, models, options = {}) {
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all", ...options };
    const [melspec, embedding, wakeword] = await Promise.all([
      ort.InferenceSession.create(models.melspec, opts),
      ort.InferenceSession.create(models.embedding, opts),
      ort.InferenceSession.create(models.wakeword, opts),
    ]);
    const e = new WakeWordEngine(ort, { melspec, embedding, wakeword });
    await e.prime();
    return e;
  }

  reset() {
    this.raw = new Int16Array(0);              // recent raw audio (keeps last 480 + frame samples)
    this.melBuf = [];                           // array of Float32Array(32)
    for (let i = 0; i < MEL_WINDOW; i++) this.melBuf.push(new Float32Array(MEL_BINS).fill(1));
    this.features = [];                         // array of Float32Array(96)
    this.pending = new Int16Array(0);
    this.frames = 0;
  }

  async melspec(int16) {
    const f = Float32Array.from(int16);
    const out = await this.mel.run({ input: new this.ort.Tensor("float32", f, [1, f.length]) });
    const t = out[this.mel.outputNames[0]];
    const n = t.data.length / MEL_BINS;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const r = new Float32Array(MEL_BINS);
      for (let j = 0; j < MEL_BINS; j++) r[j] = t.data[i * MEL_BINS + j] / 10 + 2;
      rows.push(r);
    }
    return rows;
  }

  async embed(melRows) { // melRows: 76 x 32
    const buf = new Float32Array(MEL_WINDOW * MEL_BINS);
    melRows.forEach((r, i) => buf.set(r, i * MEL_BINS));
    const out = await this.emb.run({ input_1: new this.ort.Tensor("float32", buf, [1, MEL_WINDOW, MEL_BINS, 1]) });
    return Float32Array.from(out[this.emb.outputNames[0]].data);
  }

  /** Fill the feature buffer with embeddings of 10 s of silence, exactly as openWakeWord does at start-up. */
  async prime() {
    const rows = await this.melspec(new Int16Array(160000));
    const feats = [];
    for (let i = 0; i + MEL_WINDOW <= rows.length; i += 8) feats.push(await this.embed(rows.slice(i, i + MEL_WINDOW)));
    this.features = feats.slice(-FEAT_MAX);
  }

  /**
   * Feed any number of int16 samples. Returns an array of scores, one per completed 80 ms frame.
   * The first 5 scores after a reset are forced to 0, matching openWakeWord's warm-up behaviour.
   */
  async push(samples) {
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending); merged.set(samples, this.pending.length);
    const scores = [];
    let off = 0;
    while (merged.length - off >= FRAME) {
      scores.push(await this.processFrame(merged.subarray(off, off + FRAME)));
      off += FRAME;
    }
    this.pending = merged.slice(off);
    return scores;
  }

  async processFrame(frame) {
    // melspectrogram over this frame plus 480 samples (3 hops) of context
    const ctx = new Int16Array(this.raw.length + frame.length);
    ctx.set(this.raw); ctx.set(frame, this.raw.length);
    const input = ctx.length > FRAME + 480 ? ctx.subarray(ctx.length - FRAME - 480) : ctx;
    const rows = await this.melspec(input);
    this.raw = ctx.slice(Math.max(0, ctx.length - 480));
    this.melBuf.push(...rows);
    if (this.melBuf.length > MEL_MAX) this.melBuf.splice(0, this.melBuf.length - MEL_MAX);

    this.features.push(await this.embed(this.melBuf.slice(-MEL_WINDOW)));
    if (this.features.length > FEAT_MAX) this.features.splice(0, this.features.length - FEAT_MAX);

    const x = new Float32Array(N_FEATURES * EMB_DIM);
    this.features.slice(-N_FEATURES).forEach((f, i) => x.set(f, i * EMB_DIM));
    const out = await this.ww.run({ [this.wwInput]: new this.ort.Tensor("float32", x, [1, N_FEATURES, EMB_DIM]) });
    const score = out[this.ww.outputNames[0]].data[0];
    this.frames++;
    return this.frames <= 5 ? 0 : score;
  }
}

/**
 * Turns a stream of scores into wake events with false-trigger protection:
 * - `threshold`: score needed (0..1)
 * - `minFrames`: consecutive frames above threshold required
 * - `cooldownMs`: refractory period after a detection
 */
export class WakeDetector {
  constructor({ threshold = 0.5, minFrames = 2, cooldownMs = 2500 } = {}) {
    Object.assign(this, { threshold, minFrames, cooldownMs });
    this.run = 0; this.lastFire = -Infinity; this.peak = 0;
  }
  update(score, now = Date.now()) {
    this.peak = Math.max(this.peak * 0.97, score);
    if (score >= this.threshold) this.run++; else this.run = 0;
    if (this.run >= this.minFrames && now - this.lastFire > this.cooldownMs) {
      this.lastFire = now; this.run = 0;
      return true;
    }
    return false;
  }
}

/** Linear-interpolating resampler from any rate to 16 kHz, producing int16. */
export function resampleTo16k(float32, fromRate) {
  if (fromRate === 16000) return floatToInt16(float32);
  const ratio = fromRate / 16000;
  const n = Math.floor(float32.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), t = p - i0;
    const a = float32[i0] ?? 0, b = float32[i0 + 1] ?? a;
    const v = a + (b - a) * t;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}
export function floatToInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
  return out;
}

/**
 * Streaming resampler to 16 kHz with a proper anti-aliasing low-pass filter (windowed-sinc, 7.2 kHz cut-off).
 * Keeps its position and filter history between chunks, so there are no clicks or lost samples at chunk edges.
 * (The plain linear interpolation above folds 8–24 kHz noise back into the speech band at 48 kHz input.)
 */
export function createResampler(fromRate, toRate = 16000) {
  if (fromRate === toRate) return (f) => floatToInt16(f);
  const ratio = fromRate / toRate;
  const cutoff = Math.min(0.45 * toRate, 7200) / fromRate;     // normalised to the input rate
  const half = Math.ceil(8 * ratio);                            // filter half-width in input samples
  const taps = new Float32Array(2 * half + 1);
  let norm = 0;
  for (let k = -half; k <= half; k++) {
    const x = 2 * cutoff * k, sinc = k === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const win = 0.42 + 0.5 * Math.cos(Math.PI * k / (half + 1)) + 0.08 * Math.cos(2 * Math.PI * k / (half + 1));   // Blackman
    taps[k + half] = 2 * cutoff * sinc * win; norm += taps[k + half];
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= norm;
  let hist = new Float32Array(0), pos = half;                   // pos: next output position (in input samples) within buf
  return function resample(chunk) {
    const buf = new Float32Array(hist.length + chunk.length); buf.set(hist); buf.set(chunk, hist.length);
    const out = [];
    const fir = (c) => { let acc = 0; for (let k = -half; k <= half; k++) acc += buf[c + k] * taps[k + half]; return acc; };
    while (pos + half + 1 < buf.length) {
      const c = Math.floor(pos), t = pos - c;
      const v = t ? fir(c) * (1 - t) + fir(c + 1) * t : fir(c);      // fractional positions (e.g. 44.1 kHz) interpolate filtered samples
      out.push(Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
      pos += ratio;
    }
    const keepFrom = Math.max(0, Math.floor(pos) - half);
    hist = buf.slice(keepFrom); pos -= keepFrom;
    return Int16Array.from(out);
  };
}
