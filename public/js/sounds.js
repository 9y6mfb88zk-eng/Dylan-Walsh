// JARVIS start-up sound design: every sound is synthesised live with the Web Audio API (original, royalty-free,
// no files, no paid services). Quiet by design. Plays through the system's default output (in Windows: the
// default playback device), or the speaker chosen in JARVIS when the browser supports choosing one.
// Honest about autoplay: `state()` says whether sound is actually playing or was blocked until a tap.
let ctx = null, master = null, verb = null, meter = null, blocked = false, failed = null;
const opts = { volume: 0.6, reduced: false, enabled: true };
// Interface transition sounds (Command Centre ⇄ Mission Control) have their own on/off, volume and reduced setting.
const ui = { enabled: true, volume: 0.5, reduced: false };
let uiMaster = null;

function ensure() {
  if (ctx || failed) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { failed = "this browser has no Web Audio"; return null; }
    ctx = new AC({ latencyHint: "interactive" });
    master = ctx.createGain(); master.gain.value = opts.volume * 0.8;
    // A short feedback delay gives the tones a sense of space without a reverb file.
    const delay = ctx.createDelay(1); delay.delayTime.value = 0.23;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const tone = ctx.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 2400;
    verb = ctx.createGain(); verb.gain.value = 0.22;
    verb.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay); tone.connect(master);
    master.connect(ctx.destination);
    meter = ctx.createAnalyser(); meter.fftSize = 1024; master.connect(meter);   // measures what is actually sent to the speakers
    const sink = (() => { try { return localStorage.getItem("jarvis.outputDevice"); } catch { return null; } })();
    if (sink && ctx.setSinkId) ctx.setSinkId(sink).catch(() => {});
  } catch (e) { failed = e.message; ctx = null; }
  return ctx;
}
const out = (g, wet = true) => { g.connect(master); if (wet) g.connect(verb); return g; };
function uiOut(g) {
  if (!uiMaster) { uiMaster = ctx.createGain(); uiMaster.gain.value = ui.volume * 0.7; uiMaster.connect(ctx.destination); if (meter) uiMaster.connect(meter); }
  g.connect(uiMaster); return g;
}
/** A UI tone: envelope-shaped oscillator routed to the interface sound bus. */
function utone(type, f, t, dur, peak, { a = 0.01, to = null, filter = null } = {}) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + a + dur);
  let node = o;
  if (filter) { const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.setValueAtTime(filter[0], t); fl.frequency.exponentialRampToValueAtTime(filter[1], t + a + dur); fl.Q.value = 3; o.connect(fl); node = fl; }
  node.connect(g); uiOut(g); env(g, t, a, peak, dur); o.start(t); o.stop(t + a + dur + 0.05);
}
/** Filtered noise on the interface bus (whooshes, hiss): band-pass swept from f0 to f1. */
function unoise(t, dur, peak, { f0 = 400, f1 = 3000, q = 0.8, a = 0.05 } = {}) {
  const n = Math.max(1, Math.round(ctx.sampleRate * (dur + a + 0.1)));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = buf; bp.type = "bandpass"; bp.Q.value = q; bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + a + dur);
  src.connect(bp); bp.connect(g); uiOut(g); env(g, t, a, peak, dur); src.start(t); src.stop(t + a + dur + 0.08);
}
function uiLive() { if (liveOverride) return true; return ui.enabled && ui.volume > 0 && ctx && ctx.state === "running"; }
function env(g, t, a, peak, d) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
function osc(type, f, t, dur, peak, a = 0.01, wet = true) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t); o.connect(g); out(g, wet); env(g, t, a, peak, dur); o.start(t); o.stop(t + a + dur + 0.05);
  return o;
}

export const sounds = {
  configure({ volume, reduced, enabled } = {}) {
    if (volume != null) opts.volume = Math.max(0, Math.min(1, volume));
    if (reduced != null) opts.reduced = !!reduced;
    if (enabled != null) opts.enabled = !!enabled;
    if (master) master.gain.value = opts.volume * 0.8;
  },
  /** Try to start audio. Resolves to "playing", "blocked" (needs a tap first), "off" or "unavailable". */
  async unlock() {
    if (!opts.enabled || opts.volume === 0) return "off";
    if (!ensure()) return "unavailable";
    if (ctx.state !== "running") { try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]); } catch {} }
    blocked = ctx.state !== "running";
    return blocked ? "blocked" : "playing";
  },
  /** Peak level actually leaving JARVIS over the next `ms` (0 = silence). Proof that a sound played, not just that code ran. */
  async measure(ms = 500) {
    if (!meter || !ctx || ctx.state !== "running") return 0;
    const buf = new Float32Array(meter.fftSize); let peak = 0; const end = performance.now() + ms;
    while (performance.now() < end) { meter.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); await new Promise((r) => setTimeout(r, 40)); }
    return +peak.toFixed(4);
  },
  state() { return !opts.enabled || opts.volume === 0 ? "off" : failed ? "unavailable" : !ctx ? "idle" : ctx.state === "running" ? "playing" : "blocked"; },
  /** Interface sound settings: { enabled, volume (0–1), reduced }. */
  configureUi({ enabled, volume, reduced } = {}) {
    if (enabled != null) ui.enabled = !!enabled;
    if (volume != null) ui.volume = Math.max(0, Math.min(1, +volume || 0));
    if (reduced != null) ui.reduced = !!reduced;
    if (uiMaster) uiMaster.gain.value = ui.volume * 0.7;
  },
  /** Called from a click/keypress (a user gesture), so the browser lets audio start. */
  async unlockUi() {
    if (!ui.enabled || !ui.volume) return "off";
    if (!ensure()) return "unavailable";
    if (ctx.state !== "running") { try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 250))]); } catch {} }
    return ctx.state === "running" ? "playing" : "blocked";
  },
  /** Entering Mission Control: low activation tone, digital confirmation beeps, a rising sweep, a final system tone. */
  mcEnter() {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.02;
    utone("sine", 55, t, 0.55, 0.16, { a: 0.08, to: 82 });
    utone("triangle", 110, t, 0.5, 0.05, { a: 0.06, to: 164 });
    if (!ui.reduced) {
      [1318.5, 1568, 1760].forEach((f, i) => utone("square", f, t + 0.34 + i * 0.11, 0.045, 0.018, { a: 0.003 }));
      utone("sawtooth", 220, t + 0.42, 0.62, 0.035, { a: 0.18, to: 880, filter: [400, 3600] });
    }
    utone("sine", 880, t + 1.08, 0.5, 0.05, { a: 0.02 });
    utone("sine", 1318.5, t + 1.12, 0.45, 0.025, { a: 0.02 });
  },
  /** Leaving Mission Control: a descending tone, two quiet beeps and a soft settling note. */
  mcExit() {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.02;
    utone("sine", 660, t, 0.55, 0.06, { a: 0.03, to: 165 });
    if (!ui.reduced) {
      utone("square", 1046.5, t + 0.36, 0.04, 0.015, { a: 0.003 });
      utone("square", 784, t + 0.48, 0.04, 0.013, { a: 0.003 });
    }
    utone("sine", 110, t + 0.6, 0.6, 0.08, { a: 0.05, to: 98 });
  },
  /** Conversation over (back to standby): two soft descending notes. */
  standby() {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.02;
    utone("sine", 988, t, 0.16, 0.035, { a: 0.01 });
    utone("sine", 740, t + 0.11, 0.26, 0.03, { a: 0.01 });
  },
  /** JARVIS stopped because you spoke over it: one short, quiet acknowledgement. */
  interrupted() {
    if (!uiLive() || ui.reduced) return;
    const t = ctx.currentTime + 0.01;
    utone("triangle", 1174.7, t, 0.06, 0.022, { a: 0.004 });
  },
  /** Something failed (the AI couldn't be reached, the voice couldn't play): a low two-step, never alarming. */
  fault() {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.02;
    utone("triangle", 330, t, 0.14, 0.04, { a: 0.01 });
    utone("triangle", 262, t + 0.15, 0.22, 0.04, { a: 0.01 });
  },
  // ---------------- Mission Control activation sequence (6.9). Restrained, original, all synthesised.
  /** Stage 1: the system powers up — a sub swell under a slow noise breath. */
  seqPower() {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.02;
    utone("sine", 41, t, 1.6, 0.16, { a: 0.5, to: 62 });
    utone("triangle", 82, t + 0.1, 1.2, 0.035, { a: 0.4, to: 124 });
    if (!ui.reduced) unoise(t, 1.4, 0.02, { f0: 180, f1: 900, q: 0.6, a: 0.6 });
  },
  /** Typing / readout tick. */
  seqTick() { if (!uiLive() || ui.reduced) return; utone("square", 2637, ctx.currentTime + 0.005, 0.012, 0.006, { a: 0.002 }); },
  /** A ring of Core 808 locking into place: a metallic click and a short rising blip, higher for each ring. */
  seqRing(i = 0) {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.01, f = [880, 1046.5, 1318.5][i % 3];
    if (!ui.reduced) unoise(t, 0.035, 0.03, { f0: 4200, f1: 2600, q: 4, a: 0.002 });
    utone("triangle", f, t + 0.02, 0.12, 0.03, { a: 0.006, to: f * 1.5 });
  },
  /** The core powering up: a rising, filtered sweep. */
  seqAssemble() {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.02;
    utone("sawtooth", 110, t, 1.3, 0.026, { a: 0.5, to: 440, filter: [300, 2400] });
    if (!ui.reduced) utone("sine", 220, t + 0.2, 1.1, 0.02, { a: 0.5, to: 660 });
  },
  /** Core 808 online: a two-note chord with a soft attack. */
  seqCoreOnline() {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.02;
    utone("sine", 440, t, 0.9, 0.05, { a: 0.02 });
    utone("sine", 659.3, t + 0.04, 0.85, 0.035, { a: 0.02 });
    if (!ui.reduced) utone("triangle", 1318.5, t + 0.08, 0.5, 0.012, { a: 0.01 });
  },
  /** A system check settling: two quick chirps (online), one lower (degraded), a low buzz (unavailable). */
  seqCheck(state = "ok") {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.005;
    if (state === "ok") { utone("square", 1760, t, 0.025, 0.008, { a: 0.003 }); if (!ui.reduced) utone("square", 2349.3, t + 0.05, 0.025, 0.007, { a: 0.003 }); }
    else if (state === "warn") utone("triangle", 587.3, t, 0.12, 0.03, { a: 0.006 });
    else utone("sawtooth", 146.8, t, 0.18, 0.025, { a: 0.006, filter: [900, 500] });
  },
  /** Operational confirmation: a rising three-note figure over a held tone (a lower, minor ending if anything is down). */
  seqConfirm(state = "ok") {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.02, notes = state === "ok" ? [523.3, 659.3, 784] : [523.3, 622.3, 698.5];
    notes.forEach((f, i) => utone("sine", f, t + i * 0.11, 0.55 - i * 0.08, 0.04, { a: 0.012 }));
    utone("sine", 130.8, t, 1.2, 0.05, { a: 0.08 });
  },
  /** The command centre deploys: a filtered whoosh and a soft low thump. */
  seqReveal() {
    if (!uiLive()) return;
    const t = ctx.currentTime + 0.01;
    if (!ui.reduced) unoise(t, 0.7, 0.05, { f0: 300, f1: 4800, q: 0.7, a: 0.25 });
    utone("sine", 70, t + 0.18, 0.5, 0.12, { a: 0.02, to: 48 });
  },
  /** Moving between Mission Control sections: one quiet tick. */
  navTick() { if (!uiLive() || ui.reduced) return; const t = ctx.currentTime + 0.005; utone("triangle", 1567.98, t, 0.04, 0.014, { a: 0.003 }); utone("triangle", 2093, t + 0.03, 0.03, 0.008, { a: 0.003 }); },
  /** A genuine warning (amber): two alternating mid tones. */
  warning() { if (!uiLive()) return; const t = ctx.currentTime + 0.01; [0, 0.18].forEach((d, i) => utone("triangle", i ? 659.3 : 830.6, t + d, 0.14, 0.04, { a: 0.008 })); },
  /** Low electronic power-on: a sub sweep with a filtered noise swell. */
  powerOn() {
    if (!live()) return;
    const t = ctx.currentTime + 0.02;
    const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = "sawtooth"; o.frequency.setValueAtTime(38, t); o.frequency.exponentialRampToValueAtTime(96, t + 1.3);
    f.type = "lowpass"; f.frequency.setValueAtTime(120, t); f.frequency.exponentialRampToValueAtTime(900, t + 1.2); f.Q.value = 6;
    o.connect(f); f.connect(g); out(g); env(g, t, 0.35, 0.22, 1.2); o.start(t); o.stop(t + 1.7);
    if (!opts.reduced) {
      const n = ctx.createBufferSource(), b = ctx.createBuffer(1, ctx.sampleRate * 1.4, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
      n.buffer = b; const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(3200, t + 1.2); bp.Q.value = 1.2;
      const ng = ctx.createGain(); n.connect(bp); bp.connect(ng); out(ng); env(ng, t + 0.1, 0.6, 0.05, 0.7); n.start(t); n.stop(t + 1.5);
      osc("sine", 659.3, t + 1.15, 0.6, 0.05, 0.02);
    }
  },
  /** Soft confirmation as a check completes: one tick for a pass, a lower pair for a warning, a dull note for a fault. */
  check(status) {
    if (!live() || opts.reduced) return;
    const now = ctx.currentTime;
    if (now - (sounds._last || 0) < 0.07) return;          // never a machine-gun of ticks
    sounds._last = now;
    const t = now + 0.01;
    if (status === "ok") osc("sine", 1760, t, 0.06, 0.035, 0.004, false);
    else if (status === "warn") { osc("triangle", 880, t, 0.07, 0.04, 0.005, false); osc("triangle", 740, t + 0.09, 0.08, 0.035, 0.005, false); }
    else osc("square", 196, t, 0.16, 0.03, 0.008, false);
  },
  /** Short rising energy sound while the AI initialises. */
  rise() {
    if (!live() || opts.reduced) return;
    const t = ctx.currentTime + 0.02;
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = "sawtooth"; o2.type = "sawtooth"; o2.detune.value = 9;
    for (const x of [o, o2]) { x.frequency.setValueAtTime(110, t); x.frequency.exponentialRampToValueAtTime(440, t + 1.3); x.connect(f); }
    f.type = "lowpass"; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(4200, t + 1.3); f.Q.value = 4;
    f.connect(g); out(g); env(g, t, 1.1, 0.06, 0.35); o.start(t); o2.start(t); o.stop(t + 1.6); o2.stop(t + 1.6);
  },
  /** Final activation: a bright, soft E-major chord with a low anchor. */
  activate() {
    if (!live()) return;
    const t = ctx.currentTime + 0.02;
    osc("sine", 82.4, t, 1.2, 0.12, 0.04);
    [329.6, 493.9, 659.3, 987.8].forEach((f, i) => osc(i % 2 ? "triangle" : "sine", f, t + i * 0.06, 1.3 - i * 0.12, 0.06 - i * 0.008, 0.03));
  },
};
/** Render one sound into memory (no speakers needed) and measure it — used by the automated tests. */
export async function renderSound(name, seconds = 2, { uiVolume = null, reduced = false } = {}) {
  const saved = { ctx, master, verb, meter, uiMaster, opts: { ...opts }, ui: { ...ui } };
  const off = new OfflineAudioContext(1, Math.round(44100 * seconds), 44100);
  ctx = off; meter = null; opts.enabled = true; opts.reduced = false; opts.volume = saved.opts.volume || 0.6;
  master = off.createGain(); master.gain.value = opts.volume * 0.8; master.connect(off.destination);
  verb = off.createGain(); verb.gain.value = 0; verb.connect(master);
  // Interface sounds go through their own volume (Settings → Interface) when one is given.
  if (uiVolume != null) { uiMaster = off.createGain(); uiMaster.gain.value = uiVolume * 0.7; uiMaster.connect(master); } else uiMaster = master;
  ui.enabled = true; ui.reduced = !!reduced;
  liveOverride = true; sounds._last = -1;
  try { sounds[name](name === "check" ? "ok" : undefined); } finally { liveOverride = false; }
  const buf = await off.startRendering();
  ({ ctx, master, verb, meter, uiMaster } = saved); Object.assign(opts, saved.opts); Object.assign(ui, saved.ui);
  const d = buf.getChannelData(0); let peak = 0, sum = 0;
  for (const v of d) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  return { peak: +peak.toFixed(4), rms: +Math.sqrt(sum / d.length).toFixed(5), seconds };
}
let liveOverride = false;
function live() { if (liveOverride) return true; return opts.enabled && opts.volume > 0 && ctx && ctx.state === "running"; }
