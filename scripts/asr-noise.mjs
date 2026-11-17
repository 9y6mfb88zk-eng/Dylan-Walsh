// Usage: JARVIS_TTS_DIR=<piper model> JARVIS_ASR_DIR=<parakeet model> [JARVIS_ASR_GATE_DB=0|-12] node scripts/asr-noise.mjs
// Word error rate of JARVIS's local speech recognition (Parakeet, server/local-asr.js) on spoken commands with background noise.
const { synthesizeLocal } = await import("/home/user/Dylan-Walsh/server/local-tts.js");
const { transcribeLocal } = await import("/home/user/Dylan-Walsh/server/local-asr.js");
const S = ["What's the weather like tomorrow in Larnaca?", "Set an alarm for half past six on weekdays.", "Remind me to call the accountant at four.", "Wait, explain that again.", "Show me aircraft around Cyprus.",
  "How much have I spent on food this month?", "Add buy milk to my task list.", "Open Operation Sentinel.", "What about the weekend?", "Plan me something for Saturday.",
  "Read me my schedule for today.", "Is it going to rain this afternoon?", "Start a focus session for twenty five minutes.", "Turn off the living room lights.", "Who won the football last night?",
  "Repeat that please.", "Speak a little more slowly.", "Book the gym for tomorrow at seven.", "How long would it take to drive to Limassol?", "That's all for now, thank you."];
const BABBLE = "The committee met on Thursday to discuss the budget and the new library opening hours in the town centre.";
const pcm = (w) => { const n = (w.length - 44) / 2, f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = w.readInt16LE(44 + i * 2) / 32768; return f; };
const wav = (f, rate) => { const b = Buffer.alloc(44 + f.length * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + f.length * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(f.length * 2, 40); for (let i = 0; i < f.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767))), 44 + i * 2); return b; };
const rms = (f) => Math.sqrt(f.reduce((a, v) => a + v * v, 0) / f.length);
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim().split(" ").map((w) => ({ "6": "six", "4": "four" }[w] || w));
function wer(ref, hyp) { const r = norm(ref), h = norm(hyp); const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]); for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)); return { err: d[r.length][h.length], n: r.length }; }
const babble = pcm(await synthesizeLocal(BABBLE, { speed: 1.1 }));
const conds = (process.env.CONDS ? JSON.parse(process.env.CONDS) : [["clean", null, null], ["hiss 20 dB", "white", 20], ["hiss 10 dB", "white", 10], ["hiss 5 dB", "white", 5], ["talker 15 dB", "babble", 15], ["talker 10 dB", "babble", 10], ["talker 5 dB", "babble", 5]]);
const res = {};
for (const [name, kind, snr] of conds) {
  let err = 0, n = 0, ms = 0; const samples = [];
  for (const s of S) {
    const clean = pcm(await synthesizeLocal(s)), pad = new Float32Array(8000);
    const x = new Float32Array(clean.length + 16000); x.set(clean, 8000);
    if (kind) { const sp = rms(clean), target = sp / Math.pow(10, snr / 20);
      const noise = new Float32Array(x.length); for (let i = 0; i < x.length; i++) noise[i] = kind === "white" ? rnd() : babble[i % babble.length];
      const g = target / rms(noise); for (let i = 0; i < x.length; i++) x[i] += noise[i] * g; }
    const t0 = Date.now(); const r = await transcribeLocal(wav(x, 22050), { details: true }); ms += Date.now() - t0;
    const w = wer(s, r.text); err += w.err; n += w.n; if (w.err) samples.push(`${s} → ${r.text}`);
    const bad = w.err / w.n > 0.2; (res.conf ||= {}); const k = `${name}|${bad ? "wrong" : "right"}`; (res.conf[k] ||= {}); res.conf[k][r.confidence?.level || "none"] = (res.conf[k][r.confidence?.level || "none"] || 0) + 1;
  }
  res[name] = { wer: +(100 * err / n).toFixed(1), msPerCommand: Math.round(ms / S.length), mistakes: samples.slice(0, 3) };
  console.log(name, JSON.stringify(res[name]));
}
console.log("CONF", JSON.stringify(res.conf));
