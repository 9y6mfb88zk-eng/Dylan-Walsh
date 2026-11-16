// Generates the built-in alarm sounds (public/sounds/*.wav): synthesised, royalty-free, loopable.
// Run: node scripts/make-sounds.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sounds");
const RATE = 22050;
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));
const tone = (buf, start, dur, f, amp, { attack = 0.005, decay = 0.3, harm = [1], type = "sine" } = {}) => {
  const s0 = Math.floor(start * RATE), n = Math.floor(dur * RATE);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / RATE; let v = 0;
    harm.forEach((h, k) => { const ph = 2 * Math.PI * f * (k + 1) * t; v += (type === "square" ? Math.sign(Math.sin(ph)) * 0.6 : Math.sin(ph)) * h; });
    buf[s0 + i] += v * amp * env(t, attack, decay);
  }
};
const SOUNDS = {
  chime(b) { [[0, 1318.5], [0.18, 1046.5], [0.36, 1568], [1.2, 1318.5], [1.38, 1046.5], [1.56, 1568]].forEach(([t, f]) => tone(b, t, 1.2, f, 0.33, { decay: 0.35, harm: [1, 0.3, 0.12] })); },
  classic(b) { for (let k = 0; k < 2; k++) for (let i = 0; i < 14; i++) tone(b, k * 1.5 + i * 0.05, 0.05, 2200 + (i % 2) * 300, 0.35, { attack: 0.001, decay: 0.03, harm: [1, 0.5] }); },
  radar(b) { for (let i = 0; i < 4; i++) tone(b, i * 0.25, 0.18, 1760, 0.32, { attack: 0.002, decay: 0.1, harm: [1, 0.2] }); for (let i = 0; i < 4; i++) tone(b, 1.5 + i * 0.25, 0.18, 1760, 0.32, { attack: 0.002, decay: 0.1, harm: [1, 0.2] }); },
  gentle(b) { [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25].forEach((f, i) => tone(b, i * 0.45, 1.4, f, 0.22, { attack: 0.08, decay: 0.6, harm: [1, 0.15] })); },
  digital(b) { for (let k = 0; k < 2; k++) for (let i = 0; i < 4; i++) tone(b, k * 1.5 + i * 0.16, 0.09, 2793.8, 0.25, { attack: 0.001, decay: 0.5, type: "square" }); },
};
fs.mkdirSync(out, { recursive: true });
for (const [name, fn] of Object.entries(SOUNDS)) {
  const buf = new Float32Array(RATE * 3);
  fn(buf);
  const peak = Math.max(...buf.map(Math.abs)) || 1;
  const pcm = Buffer.alloc(44 + buf.length * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + buf.length * 2, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(RATE, 24); pcm.writeUInt32LE(RATE * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(buf.length * 2, 40);
  for (let i = 0; i < buf.length; i++) pcm.writeInt16LE(Math.round((buf[i] / peak) * 0.89 * 32767), 44 + i * 2);
  fs.writeFileSync(path.join(out, `${name}.wav`), pcm);
  console.log(`${name}.wav`, pcm.length, "bytes");
}
