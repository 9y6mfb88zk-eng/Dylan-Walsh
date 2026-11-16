// Voice I/O: neural TTS (streamed per sentence, interruptible), browser British voice fallback,
// Web Speech or Whisper transcription with voice-activity detection, and live audio levels for the core.
import { api } from "./api.js";

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const voice = {
  state: "idle", level: 0, cfg: { tts: null, stt: false }, micDeviceId: null, vadThreshold: 0.035,
  ctx: null, out: null, mic: null, freq: new Uint8Array(128), td: new Uint8Array(1024),
  listeners: new Set(),
  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  setState(s, detail) { this.state = s; this.listeners.forEach((fn) => fn(s, detail)); },

  ensureAudio() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.out = this.ctx.createAnalyser(); this.out.fftSize = 256; this.out.smoothingTimeConstant = 0.7;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource();
    s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    return this.ctx;
  },

  /** Subtle two-tone activation chime. */
  chime() {
    try {
      const ctx = this.ensureAudio(), t = ctx.currentTime;
      for (const [f, d] of [[880, 0], [1320, 0.09]]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(0.08, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.35);
        o.connect(g); g.connect(ctx.destination); o.start(t + d); o.stop(t + d + 0.4);
      }
    } catch {}
  },

  /** Current 0..1 level and frequency bins from whichever source is live. */
  sample() {
    const src = this.state === "speaking" && this.realAudio ? this.out : this.state === "listening" ? this.mic : null;
    if (!src) return { level: null, freq: null };
    src.getByteTimeDomainData(this.td);
    let sum = 0; const n = Math.min(src.fftSize, this.td.length);
    for (let i = 0; i < n; i++) { const v = (this.td[i] - 128) / 128; sum += v * v; }
    src.getByteFrequencyData(this.freq);
    return { level: Math.min(1, Math.sqrt(sum / n) * (src === this.out ? 3.2 : 4)), freq: this.freq };
  },

  // ---------------- Speaking
  gen: 0, src: null, ctrl: null, realAudio: false,
  stop() {
    this.gen++; this.ctrl?.abort(); this.ctrl = null;
    try { this.src?.stop(); } catch {}
    this.src = null; this.realAudio = false;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (this.state === "speaking") this.setState("idle");
  },
  async speak(text) {
    this.stop();
    const gen = this.gen;
    if (!text) return;
    this.setState("speaking");
    const speakable = text.replace(/\[(\d+)\]/g, "").replace(/[*_#`>]/g, "").replace(/https?:\/\/\S+/g, "").trim();
    try {
      if (this.cfg.tts) await this.neural(speakable, gen);
      else await this.browser(speakable, gen);
    } catch (e) {
      if (gen !== this.gen) return;
      await this.browser(speakable, gen).catch(() => {});
    }
    if (gen === this.gen) { this.realAudio = false; this.setState("idle"); }
  },
  split(text) {
    const parts = (text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text]).map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) return parts;
    const rest = [];
    for (let i = 1; i < parts.length; i += 3) rest.push(parts.slice(i, i + 3).join(" "));
    return [parts[0], ...rest];
  },
  async neural(text, gen) {
    this.ensureAudio();
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    const chunks = this.split(text).map((chunk) =>
      fetch("/api/tts", { method: "POST", signal, credentials: "same-origin", headers: { "content-type": "application/json", "x-jarvis": "1" }, body: JSON.stringify({ text: chunk }) })
        .then((r) => { if (!r.ok) throw new Error(`TTS ${r.status}`); return r.arrayBuffer(); })
        .then((buf) => this.ctx.decodeAudioData(buf)));
    chunks.forEach((p) => p.catch(() => {}));
    for (const p of chunks) {
      const buffer = await p;
      if (gen !== this.gen) return;
      this.realAudio = true;
      await new Promise((resolve) => {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer; src.connect(this.out); src.onended = resolve;
        this.src = src; src.start();
      });
      if (gen !== this.gen) return;
    }
  },
  britishVoice() {
    if (!("speechSynthesis" in window)) return null;
    const vs = speechSynthesis.getVoices();
    for (const n of ["Daniel", "Arthur", "Google UK English Male", "Microsoft Ryan", "Microsoft George", "Oliver", "Malcolm"]) { const v = vs.find((x) => x.name.includes(n)); if (v) return v; }
    return vs.find((v) => v.lang === "en-GB") || vs.find((v) => v.lang?.startsWith("en"));
  },
  browser(text, gen) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.britishVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-GB";
      u.rate = 1; u.pitch = 0.92;
      u.onboundary = () => { this.boundary = performance.now(); };
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
      const iv = setInterval(() => { if (gen !== this.gen || !speechSynthesis.speaking) { clearInterval(iv); resolve(); } }, 250);
    });
  },

  // ---------------- Listening
  sttMode() {
    if (window.jarvisDesktop) return this.cfg.stt ? "server" : "none";   // Electron has no built-in speech service; Whisper is required
    if (this.cfg.stt && (isIOS || !SR || window.jarvisDesktop)) return "server";   // Whisper is more reliable on iPhone and in the desktop app
    if (SR) return "webspeech";
    return this.cfg.stt ? "server" : "none";
  },
  listening: null,
  /** Listen for one utterance. Resolves with the text ("" if nothing heard). */
  listen({ onPartial, maxMs = 15000 } = {}) {
    if (this.listening) return this.listening;
    const mode = this.sttMode();
    if (mode === "none") return Promise.reject(new Error("Voice input needs Whisper (OPENAI_API_KEY on the server) or a browser with speech recognition."));
    this.stop();
    this.setState("listening");
    const p = (mode === "webspeech" ? this.webSpeech(onPartial) : this.record(maxMs)).finally(() => { this.listening = null; this.cancelListen = null; });
    this.listening = p;
    return p;
  },
  stopListening(discard = false) { this.cancelListen?.(discard); },
  webSpeech(onPartial) {
    return new Promise((resolve, reject) => {
      const rec = new SR(); rec.lang = "en-GB"; rec.interimResults = true; rec.continuous = false;
      let finalText = "", discarded = false;
      this.cancelListen = (d) => { discarded = d; try { rec.stop(); } catch {} };
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript; }
        onPartial?.((finalText + interim).trim());
      };
      rec.onerror = (e) => { if (e.error === "not-allowed") reject(new Error("Microphone permission is needed.")); };
      rec.onend = () => resolve(discarded ? "" : finalText.trim());
      rec.start();
    });
  },
  async record(maxMs) {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: this.micDeviceId ? { exact: this.micDeviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch { throw new Error("Microphone permission is needed."); }
    this.ensureAudio();
    const node = this.ctx.createMediaStreamSource(stream);
    this.mic = this.ctx.createAnalyser(); this.mic.fftSize = 1024; node.connect(this.mic);
    // Capture raw PCM (works everywhere) and send 16 kHz WAV: readable by local Whisper and by OpenAI.
    const proc = this.ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    const sink = this.ctx.createGain(); sink.gain.value = 0;
    node.connect(proc); proc.connect(sink); sink.connect(this.ctx.destination);
    const rate = this.ctx.sampleRate;
    let spoke = false, discarded = false, done = false, quietSince = performance.now();
    const started = performance.now();
    let floor = 0.01;   // adaptive noise floor: speech must clear the room's background level
    return new Promise((resolve, reject) => {
      const finish = async () => {
        if (done) return; done = true;
        clearInterval(vad);
        try { node.disconnect(); proc.disconnect(); sink.disconnect(); } catch {}
        stream.getTracks().forEach((t) => t.stop());
        this.mic = null;
        if (discarded || !spoke) return resolve("");
        this.setState("thinking");
        try {
          const wav = encodeWav16k(chunks, rate);
          const { text } = await api("/api/transcribe", { method: "POST", raw: wav, headers: { "content-type": "audio/wav" } });
          resolve(text || "");
        } catch (e) { reject(e); }
      };
      this.cancelListen = (d) => { discarded = d; finish(); };
      const vad = setInterval(() => {
        this.mic.getByteTimeDomainData(this.td);
        let sum = 0; for (let i = 0; i < 1024; i++) { const v = (this.td[i] - 128) / 128; sum += v * v; }
        const l = Math.sqrt(sum / 1024);
        if (!spoke) floor = floor * 0.95 + l * 0.05;
        if (l > Math.max(this.vadThreshold, floor * 2.5)) { spoke = true; quietSince = performance.now(); }
        const now = performance.now();
        if ((spoke && now - quietSince > 1200) || now - started > maxMs || (!spoke && now - started > 7000)) finish();
      }, 60);
    });
  },
};
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};

/** Concatenate Float32 chunks, resample to 16 kHz and encode as 16-bit mono WAV. */
export function encodeWav16k(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = rate / 16000, len = Math.floor(n / ratio);
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const p = i * ratio, i0 = Math.floor(p), t = p - i0;
    const v = (all[i0] ?? 0) + ((all[i0 + 1] ?? all[i0] ?? 0) - (all[i0] ?? 0)) * t;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
  const w = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
  dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}
