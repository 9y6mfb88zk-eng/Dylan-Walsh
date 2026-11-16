// The central AI core: a holographic, audio-reactive canvas rendering.
// Idle: slow orbiting rings. Listening: calm cyan pulse. Thinking: fast scanning arcs. Speaking: radial spectrum driven by real audio.
import { voice } from "./voice.js";

export function mountCore(canvas) {
  const g = canvas.getContext("2d");
  let w = 0, h = 0, dpr = 1, level = 0, target = 0, t0 = performance.now(), boundaryPulse = 0;
  const particles = Array.from({ length: 70 }, () => ({ a: Math.random() * Math.PI * 2, r: 0.55 + Math.random() * 0.45, s: (Math.random() - 0.5) * 0.004, z: Math.random() }));
  const ripples = [];
  let last = 0, prevLevel = 0;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const palette = { idle: [268, 285], listening: [180, 200], thinking: [290, 255], speaking: [268, 300] };

  function frame(now) {
    const t = (now - t0) / 1000;
    const st = voice.state;
    const { level: real, freq } = voice.sample();
    if (real != null) target = real;
    else if (st === "speaking") { if (voice.boundary && now - voice.boundary < 90) boundaryPulse = 1; target = boundaryPulse ? 0.5 + Math.random() * 0.5 : target * 0.94; boundaryPulse = 0; if (Math.random() < 0.12) target = 0.25 + Math.random() * 0.6; }
    else if (st === "listening") target = 0.12 + 0.06 * Math.sin(t * 2.6);
    else if (st === "thinking") target = 0.1 + 0.08 * Math.sin(t * 5);
    else target = 0.03 + 0.02 * Math.sin(t * 0.8);
    level += (target - level) * (target > level ? 0.45 : 0.1);
    document.documentElement.style.setProperty("--level", level.toFixed(3));

    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.36;
    const [h1, h2] = palette[st] || palette.idle;
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = "lighter";

    // Glow core
    const coreR = R * (0.42 + level * 0.12);
    let grad = g.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.2);
    grad.addColorStop(0, `hsla(${h1}, 100%, 92%, ${0.85})`);
    grad.addColorStop(0.18, `hsla(${h1}, 95%, 70%, ${0.55 + level * 0.3})`);
    grad.addColorStop(0.5, `hsla(${h2}, 90%, 45%, ${0.18 + level * 0.2})`);
    grad.addColorStop(1, "hsla(270, 90%, 20%, 0)");
    g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, coreR * 2.2, 0, Math.PI * 2); g.fill();

    // Inner lattice sphere (rotating meridians)
    g.lineWidth = 0.7;
    for (let i = 0; i < 7; i++) {
      const rot = t * 0.35 + (i * Math.PI) / 7;
      g.strokeStyle = `hsla(${h1}, 90%, 80%, ${0.12 + level * 0.15})`;
      g.beginPath(); g.ellipse(cx, cy, coreR * Math.abs(Math.cos(rot)), coreR, 0, 0, Math.PI * 2); g.stroke();
    }
    for (let i = 1; i < 4; i++) {
      g.strokeStyle = `hsla(${h2}, 90%, 80%, 0.1)`;
      g.beginPath(); g.ellipse(cx, cy, coreR, coreR * (i / 4), 0, 0, Math.PI * 2); g.stroke();
    }

    // Radial spectrum (real frequency data when available)
    const bars = 96;
    for (let i = 0; i < bars; i++) {
      const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const bin = freq ? freq[Math.floor(2 + (i < bars / 2 ? i : bars - i) * 0.9)] / 255 : level * (0.4 + 0.6 * Math.abs(Math.sin(t * 6 + i * 0.7)));
      const len = R * 0.04 + bin * R * (st === "speaking" ? 0.42 : 0.18);
      const r0 = R * 0.78;
      g.strokeStyle = `hsla(${h1 + i * 0.4}, 95%, ${65 + bin * 25}%, ${0.25 + bin * 0.7})`;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); g.stroke();
    }

    // Segmented orbit rings
    const ring = (radius, segs, gap, speed, alpha, width, hue) => {
      g.lineWidth = width; g.strokeStyle = `hsla(${hue}, 90%, 78%, ${alpha})`;
      const seg = (Math.PI * 2) / segs;
      for (let i = 0; i < segs; i++) { const s0 = t * speed + i * seg; g.beginPath(); g.arc(cx, cy, radius, s0, s0 + seg * (1 - gap)); g.stroke(); }
    };
    const spin = st === "thinking" ? 3 : st === "listening" ? 1.4 : 1;
    ring(R * 0.66, 3, 0.35, 0.5 * spin, 0.5, 1.6, h1);
    ring(R * 1.02, 24, 0.55, -0.12 * spin, 0.35, 1, h2);
    ring(R * 1.12, 2, 0.7, 0.25 * spin, 0.4, 2.2, h1);
    ring(R * 1.24, 60, 0.7, 0.05 * spin, 0.22, 3, h2);

    // Scanning arcs while thinking
    if (st === "thinking") {
      for (let k = 0; k < 3; k++) {
        const a = t * (2 + k) + k * 2;
        g.strokeStyle = `hsla(${h1}, 100%, 85%, 0.55)`; g.lineWidth = 2.5;
        g.beginPath(); g.arc(cx, cy, R * (0.88 + k * 0.08), a, a + 0.6); g.stroke();
      }
    }

    // Tick marks (instrument bezel)
    g.strokeStyle = "hsla(270, 60%, 85%, 0.18)"; g.lineWidth = 1;
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const r1 = R * 1.36, r2 = r1 + (i % 10 === 0 ? 8 : 3);
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
    }

    // Particles
    for (const p of particles) {
      p.a += p.s * (1 + level * 3);
      const rr = R * (p.r + 0.6) * (1 + level * 0.08);
      const x = cx + Math.cos(p.a) * rr, y = cy + Math.sin(p.a) * rr * (0.9 + p.z * 0.1);
      g.fillStyle = `hsla(${h2}, 90%, 85%, ${0.15 + p.z * 0.4})`;
      g.fillRect(x, y, 1.4, 1.4);
    }

    // Ripples from speech onsets / listening pulse
    if (st === "speaking" && level > 0.2 && level - prevLevel > 0.03 && now - last > 140) { ripples.push({ r: R * 0.5, a: 0.5 + level * 0.5, w: 1 + level * 2.5 }); last = now; }
    if (st === "listening" && now - last > 1100) { ripples.push({ r: R * 0.5, a: 0.4, w: 1.2 }); last = now; }
    prevLevel = level;
    for (let i = ripples.length - 1; i >= 0; i--) {
      const p = ripples[i]; p.r += st === "speaking" ? 2.4 + level * 2 : 1.2;
      const life = 1 - (p.r - R * 0.5) / (R * 1.1);
      if (life <= 0) { ripples.splice(i, 1); continue; }
      g.strokeStyle = `hsla(${h1}, 95%, 80%, ${p.a * life})`; g.lineWidth = p.w * life + 0.3;
      g.beginPath(); g.arc(cx, cy, p.r, 0, Math.PI * 2); g.stroke();
    }
    g.globalCompositeOperation = "source-over";
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
