// Anti-aliased conversion of microphone audio (usually 44.1 or 48 kHz on iPhone and in browsers) to the 16 kHz the
// speech recogniser expects. A windowed-sinc low-pass (7.2 kHz) is applied while resampling, so hiss and other
// high-frequency sound above 8 kHz can't fold back into the speech band (plain interpolation lets it through at full
// strength). Pure function: also used by the automated tests.
export function resampleTo16k(input, rate) {
  if (!input.length) return new Float32Array(0);
  if (rate === 16000) return Float32Array.from(input);
  const ratio = rate / 16000, len = Math.floor(input.length / ratio);
  const fc = Math.min(0.5, 7200 / rate);               // cut-off in cycles per input sample
  const H = Math.ceil(4 / fc);                         // half-width of the filter in input samples
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const p = i * ratio, c = Math.floor(p);
    let s = 0, wsum = 0;
    const k0 = Math.max(0, c - H + 1), k1 = Math.min(input.length - 1, c + H);
    for (let k = k0; k <= k1; k++) {
      const d = p - k, x = 2 * fc * d;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / H) + 0.08 * Math.cos((2 * Math.PI * d) / H);   // Blackman
      const h = sinc * w;
      s += input[k] * h; wsum += h;
    }
    out[i] = wsum ? s / wsum : 0;
  }
  return out;
}
