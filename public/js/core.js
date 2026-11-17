// The 2D JARVIS core (canvas): used for small cores (HUD, sign-in) and as the fallback when WebGL isn't available.
// Same states and the same real audio levels as the 3D core.
import { core } from "./corestate.js";

const HUES = { idle: [188, 214], listening: [186, 192], thinking: [196, 214], speaking: [186, 190], researching: [190, 206], executing: [200, 206], alarm: [186, 190], offline: [210, 212] };
const SAT = { offline: 12, executing: 30 };

export function mountCore(canvas, { animation = "full" } = {}) {
  const g = canvas.getContext("2d");
  let w = 0, h = 0, level = 0, raf = 0, t0 = performance.now(), last = 0, prevLevel = 0, gone = false;
  const reduced = animation === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = animation === "off";
  const particles = Array.from({ length: 70 }, () => ({ a: Math.random() * Math.PI * 2, r: 0.55 + Math.random() * 0.45, s: (Math.random() - 0.5) * 0.004, z: Math.random() }));
  const ripples = [];
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (still) frame(performance.now());
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  resize();

  function frame(now) {
    if (gone) return;
    const t = ((now - t0) / 1000) * (reduced ? 0.35 : 1);
    const st = core.state;
    const { level: real, freq } = core.levels();
    let target = real;
    if (target == null) target = st === "speaking" ? 0.25 + 0.2 * Math.abs(Math.sin(t * 7)) : st === "alarm" ? 0.6 + 0.4 * Math.max(0, Math.sin(t * 7)) : st === "listening" ? 0.12 + 0.06 * Math.sin(t * 2.6) : st === "thinking" ? 0.1 + 0.08 * Math.sin(t * 5) : 0.03 + 0.02 * Math.sin(t * 0.8);
    level += (target - level) * (target > level ? 0.45 : 0.1);
    if (w > 200) document.documentElement.style.setProperty("--level", level.toFixed(3));
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.36;
    const [h1, h2] = HUES[st] || HUES.idle, sat = SAT[st] ?? 95, dim = st === "offline" ? 0.45 : 1;
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = "lighter";
    const coreR = R * (0.42 + level * 0.12);
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.2);
    grad.addColorStop(0, `hsla(${h1}, ${sat}%, 94%, ${0.85 * dim})`);
    grad.addColorStop(0.18, `hsla(${h1}, ${sat}%, 66%, ${(0.55 + level * 0.3) * dim})`);
    grad.addColorStop(0.5, `hsla(${h2}, ${sat}%, 42%, ${(0.18 + level * 0.2) * dim})`);
    grad.addColorStop(1, "hsla(210, 90%, 15%, 0)");
    g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, coreR * 2.2, 0, Math.PI * 2); g.fill();
    g.lineWidth = 0.7;
    for (let i = 0; i < 7; i++) {
      const rot = t * 0.35 + (i * Math.PI) / 7;
      g.strokeStyle = `hsla(${h1}, ${sat}%, 80%, ${(0.12 + level * 0.15) * dim})`;
      g.beginPath(); g.ellipse(cx, cy, Math.max(0.1, coreR * Math.abs(Math.cos(rot))), coreR, 0, 0, Math.PI * 2); g.stroke();
    }
    const bars = 96;
    for (let i = 0; i < bars; i++) {
      const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const bin = freq ? freq[Math.floor(2 + (i < bars / 2 ? i : bars - i) * 0.9)] / 255 : level * (0.4 + 0.6 * Math.abs(Math.sin(t * 6 + i * 0.7)));
      const len = R * 0.04 + bin * R * (st === "speaking" || st === "listening" ? 0.42 : 0.18);
      const r0 = R * 0.78;
      g.strokeStyle = `hsla(${h1 + i * 0.2}, ${sat}%, ${65 + bin * 25}%, ${(0.25 + bin * 0.7) * dim})`;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); g.stroke();
    }
    const ring = (radius, segs, gap, speed, alpha, width, hue) => {
      g.lineWidth = width; g.strokeStyle = `hsla(${hue}, ${sat}%, 76%, ${alpha * dim})`;
      const seg = (Math.PI * 2) / segs;
      for (let i = 0; i < segs; i++) { const s0 = t * speed + i * seg; g.beginPath(); g.arc(cx, cy, radius, s0, s0 + seg * (1 - gap)); g.stroke(); }
    };
    const spin = st === "thinking" || st === "researching" ? 3 : st === "executing" ? 2.2 : st === "alarm" ? 3.5 : st === "listening" ? 1.4 : st === "offline" ? 0.2 : 1;
    ring(R * 0.66, 3, 0.35, 0.5 * spin, 0.5, 1.6, h1);
    ring(R * 1.02, 24, 0.55, -0.12 * spin, 0.35, 1, h2);
    ring(R * 1.12, 2, 0.7, 0.25 * spin, 0.4, 2.2, h1);
    ring(R * 1.24, 60, 0.7, 0.05 * spin, 0.22, 3, h2);
    if (st === "thinking" || st === "researching") for (let k = 0; k < 3; k++) { const a = t * (2 + k) + k * 2; g.strokeStyle = `hsla(${h1}, 100%, 85%, 0.55)`; g.lineWidth = 2.5; g.beginPath(); g.arc(cx, cy, R * (0.88 + k * 0.08), a, a + 0.6); g.stroke(); }
    for (const p of particles) {
      p.a += p.s * (1 + level * 3);
      const rr = R * (p.r + 0.6) * (1 + level * 0.08);
      g.fillStyle = `hsla(${h2}, ${sat}%, 85%, ${(0.15 + p.z * 0.4) * dim})`;
      g.fillRect(cx + Math.cos(p.a) * rr, cy + Math.sin(p.a) * rr * (0.9 + p.z * 0.1), 1.4, 1.4);
    }
    if (!reduced) {
      if (st === "speaking" && level > 0.2 && level - prevLevel > 0.03 && now - last > 140) { ripples.push({ r: R * 0.5, a: 0.5 + level * 0.5, w: 1 + level * 2.5 }); last = now; }
      if ((st === "listening" && now - last > 1100) || (st === "alarm" && now - last > 600)) { ripples.push({ r: R * 0.5, a: 0.5, w: 1.4 }); last = now; }
    }
    prevLevel = level;
    for (let i = ripples.length - 1; i >= 0; i--) {
      const p = ripples[i]; p.r += 1.4 + level * 2;
      const life = 1 - (p.r - R * 0.5) / (R * 1.1);
      if (life <= 0) { ripples.splice(i, 1); continue; }
      g.strokeStyle = `hsla(${h1}, 95%, 80%, ${p.a * life})`; g.lineWidth = p.w * life + 0.3;
      g.beginPath(); g.arc(cx, cy, p.r, 0, Math.PI * 2); g.stroke();
    }
    g.globalCompositeOperation = "source-over";
    if (!still) raf = requestAnimationFrame(frame);
  }
  const off = still ? core.on(() => frame(performance.now())) : () => {};
  if (!still) raf = requestAnimationFrame(frame);
  return { kind: "2d", pulse() {}, setPalette() {}, setBoost() {}, destroy() { gone = true; cancelAnimationFrame(raf); ro.disconnect(); off(); } };
}

/** The best core this device can show: 3D with a 2D fallback. */
export async function mountBestCore(canvas, opts = {}) {
  if (opts.animation !== "off" && opts.quality !== "2d") {
    try { const { mountCore3D } = await import("./core3d.js"); const c = await mountCore3D(canvas, opts); canvas.__core = c; return c; }
    catch (e) { console.warn("[core] 3D unavailable, using 2D:", e.message); }
  }
  const c = mountCore(canvas, opts); canvas.__core = c; return c;
}
