// Cinematic startup: shows JARVIS's real start-up steps as they actually complete (with timings and failures).
// It never delays anything — the app loads underneath — and any click or key skips it.
// Settings → Appearance → Startup sequence: Cinematic or Instant.
import { esc } from "./util.js";

export function beginStartup({ greeting = "" } = {}) {
  const el = document.createElement("div");
  el.className = "boot";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `<div class="boot-inner"><div class="boot-mark" aria-hidden="true"></div><div class="boot-title">J.A.R.V.I.S.</div><ul class="boot-steps"></ul><div class="boot-final"></div><div class="boot-skip faint">Press any key to skip</div></div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add("in"));
  const list = el.querySelector(".boot-steps");
  const t0 = performance.now();
  const pending = [];
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    removeEventListener("keydown", close); el.removeEventListener("click", close);
    el.classList.remove("in"); el.classList.add("out");
    setTimeout(() => el.remove(), 450);
  };
  addEventListener("keydown", close); el.addEventListener("click", close);
  return {
    /** Show a step; it resolves to ✓ with its real duration (and detail), or ✗ with the real error. */
    step(label, promise) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="boot-dot"></span><span class="boot-label">${esc(label)}</span><span class="boot-detail faint">…</span>`;
      list.append(li);
      const s = performance.now();
      const rec = { label, ok: null, detail: "", ms: null };
      (window.__jarvisBoot ||= []).push(rec);
      const p = Promise.resolve(promise).then(
        (v) => {
          // A step can finish without being verified (e.g. the AI is configured but not yet tested): shown amber, never green.
          const warn = v && typeof v === "object" && "warn" in v, detail = warn ? v.warn : v;
          rec.ok = true; rec.warn = warn; rec.detail = detail || ""; rec.ms = Math.round(performance.now() - s);
          li.classList.add(warn ? "warn" : "ok"); li.querySelector(".boot-detail").textContent = `${detail ? `${detail} · ` : ""}${rec.ms} ms`;
        },
        (e) => { rec.ok = false; rec.detail = e?.message || String(e); li.classList.add("bad"); li.querySelector(".boot-detail").textContent = rec.detail; },
      );
      pending.push(p);
      return p;
    },
    /** When every step has finished: the closing line (honest about failures), then fade out. */
    async finish() {
      await Promise.all(pending);
      if (closed) return;
      const bad = list.querySelectorAll("li.bad").length, warn = [...list.querySelectorAll("li.warn .boot-label")].map((x) => x.textContent);
      el.querySelector(".boot-final").textContent = bad ? `${bad} start-up step${bad === 1 ? "" : "s"} failed — details in Diagnostics.`
        : warn.length ? `Ready. ${warn.join(" and ")} ${warn.length === 1 ? "is" : "are"} not verified yet.` : greeting || "All systems online.";
      const elapsed = performance.now() - t0;
      setTimeout(close, Math.max(900, 1600 - elapsed) + (bad ? 1500 : 0));
    },
    close,
  };
}
