// Mission Control activation sequence (JARVIS 6.9): a choreographed full-screen sequence that brings Mission Control
// online around the living JARVIS core.
//
//   1 SYSTEM ACTIVATION   the screen darkens; tactical grid, scanning line, frame and readouts wake up; identifier and
//                         "INITIALISING MISSION CONTROL" are typed out
//   2 CORE 808 DEPLOYMENT the same persistent core moves to the centre and physically assembles (core3d assemble())
//                         inside a reticle of range rings, bearings and crosshairs
//   3 INITIALISATION      the real Mission Control checks, one row each, with progress and their actual result
//   4 CONFIRMATION        "CORE 808 ONLINE" — with an honest count of anything unavailable
//   then the overlay irises open and the command centre is revealed around the core (mission.js does the reveal).
//
// Every readout shown is real (time, your home coordinates, link state, app version, check results). Nothing claims
// military capability or security JARVIS doesn't have. Skip: the button, Esc, Enter or Space.
import { esc } from "./util.js";

const MIL = {   // the check rows, in military register (the underlying checks are unchanged)
  "Initialising system architecture": "VERIFYING SYSTEM ARCHITECTURE",
  "Checking AI core": "ESTABLISHING AI LINK",
  "Verifying voice interface": "VERIFYING VOICE INTERFACE",
  "Establishing local system connections": "ESTABLISHING LIVE LINK",
  "Connecting public flight data": "CONNECTING FLIGHT TRACKING",
  "Retrieving global events": "LOADING GLOBAL SITUATION DATA",
  "Loading operational overview": "SYNCHRONISING OPERATIONAL DATA",
  "Initialising global mapping": "INITIALISING GLOBAL MAPPING",
  "Initialising satellite systems": "INITIALISING SATELLITE SYSTEMS",
};
const STATE_TAG = { ok: "ONLINE", warn: "DEGRADED", bad: "UNAVAILABLE" };
export const PLAN = {
  full: { darken: 450, ident: 350, title: 250, assemble: 2200, rowGap: 150, minChecks: 1200, maxChecks: 2200, confirm: 800, reveal: 780 },
  short: { darken: 200, ident: 0, title: 260, assemble: 950, rowGap: 0, minChecks: 300, maxChecks: 700, confirm: 420, reveal: 480 },
};

/** A date-time group, e.g. 181942Z NOV 26. */
export function dtg(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase()} ${String(d.getUTCFullYear()).slice(2)}`;
}
const fmtCoord = (lat, lon) => (lat == null || lon == null ? "—" : `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? "N" : "S"} ${String(Math.abs(lon).toFixed(3)).padStart(7, "0")}°${lon >= 0 ? "E" : "W"}`);

function reticleSvg() {
  const ticks = Array.from({ length: 72 }, (_, i) => { const a = (i / 72) * Math.PI * 2, r0 = 236, r1 = i % 6 === 0 ? 222 : 229; return `<line x1="${250 + Math.cos(a) * r0}" y1="${250 + Math.sin(a) * r0}" x2="${250 + Math.cos(a) * r1}" y2="${250 + Math.sin(a) * r1}"/>`; }).join("");
  const labels = [0, 90, 180, 270].map((d) => { const a = ((d - 90) / 180) * Math.PI; return `<text x="${250 + Math.cos(a) * 208}" y="${250 + Math.sin(a) * 208 + 3}">${String(d).padStart(3, "0")}</text>`; }).join("");
  return `<svg class="mcb-reticle" viewBox="0 0 500 500" aria-hidden="true">
    <g class="mcb-r-ticks">${ticks}</g>
    <circle class="mcb-r-ring r1" cx="250" cy="250" r="244"/>
    <circle class="mcb-r-ring r2" cx="250" cy="250" r="190"/>
    <g class="mcb-r-spin"><path class="mcb-r-arc" d="M250 18 A232 232 0 0 1 455 140"/><path class="mcb-r-arc" d="M250 482 A232 232 0 0 1 45 360"/></g>
    <g class="mcb-r-spin2"><path class="mcb-r-arc thin" d="M66 160 A200 200 0 0 1 160 66"/><path class="mcb-r-arc thin" d="M434 340 A200 200 0 0 1 340 434"/></g>
    <g class="mcb-r-labels">${labels}</g>
    <g class="mcb-r-cross"><line x1="250" y1="0" x2="250" y2="40"/><line x1="250" y1="460" x2="250" y2="500"/><line x1="0" y1="250" x2="40" y2="250"/><line x1="460" y1="250" x2="500" y2="250"/></g>
  </svg>`;
}

/**
 * Create the sequence overlay. Returns controls used by mission.js:
 *   el, coreSlot, skipped, onSkip(fn), wait(ms), stage1(), stage2(cc), stage3(checks), stage4(result), reveal(), destroy()
 */
export function createSequence({ mode = "full", info = {}, sound = () => {} } = {}) {
  const P = PLAN[mode] || PLAN.full;
  const el = document.createElement("div");
  el.className = `mcb mcb-${mode}`;
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Mission Control activation");
  el.innerHTML = `
    <div class="mcb-dark"></div><div class="mcb-grid"></div><div class="mcb-scan"></div><div class="mcb-vignette"></div>
    <div class="mcb-frame" aria-hidden="true"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>
    <div class="mcb-rail top" aria-hidden="true"><span>SYS ID · JARVIS-808</span><span class="mcb-dtg">${esc(dtg())}</span><span>NODE · ${esc(info.node || "BROWSER")}</span><span>BUILD · ${esc(info.version || "—")}</span></div>
    <div class="mcb-rail bottom" aria-hidden="true"><span>REF · ${esc(fmtCoord(info.lat, info.lon))}</span><span>AO · ${esc((info.place || "HOME").toUpperCase())}</span><span class="mcb-link">LINK · ${info.online ? "UP" : "DOWN"}</span><span class="mcb-phase">PHASE · 1/4</span></div>
    <div class="mcb-ident"><b>J.A.R.V.I.S.</b><span>JOINT ARTIFICIAL RESEARCH AND VIRTUAL INTELLIGENCE SYSTEM</span></div>
    <div class="mcb-centre"><div class="mcb-stage">${reticleSvg()}<div class="mcb-core-slot"></div><div class="mcb-core-label">CORE 808 · <b>STANDBY</b></div></div></div>
    <div class="mcb-title" aria-live="polite"><h1></h1><p></p></div>
    <ol class="mcb-checks" aria-label="Initialisation"></ol>
    <div class="mcb-confirm" aria-live="polite"></div>
    <button class="mcb-skip" type="button">Skip <kbd>Esc</kbd></button>`;
  const $ = (s) => el.querySelector(s);
  let skipped = false, skipFns = [], timers = [];
  const skip = () => { if (skipped) return; skipped = true; el.classList.add("skipped"); skipFns.forEach((f) => f()); skipFns = []; };
  const onKey = (e) => { if (["Escape", "Enter", " "].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); skip(); } };
  addEventListener("keydown", onKey, true);
  $(".mcb-skip").onclick = skip;
  const wait = (ms) => new Promise((r) => { if (skipped || ms <= 0) return r(); const t = setTimeout(() => { skipFns = skipFns.filter((f) => f !== r); r(); }, ms); timers.push(t); skipFns.push(r); });
  // Test hook only: when a test sets window.__mcbHold (a Set of stage names), the sequence pauses there until
  // window.__mcbRelease() is called, so slow screenshot tools can capture each stage. Unused in normal operation.
  const hold = async (name) => { const h = window.__mcbHold; if (h?.has?.(name)) await new Promise((r) => { window.__mcbRelease = r; }); };
  const setPhase = (n) => { $(".mcb-phase").textContent = `PHASE · ${n}/4`; el.dataset.phase = n; };
  const clock = setInterval(() => { const d = $(".mcb-dtg"); if (d) d.textContent = dtg(); }, 1000);
  async function type(node, text, cps = 70) {
    if (skipped || mode === "short") { node.textContent = text; return; }
    node.textContent = "";
    for (let i = 0; i < text.length && !skipped; i++) { node.textContent = text.slice(0, i + 1); if (text[i] === " " && i % 3 === 0) sound("tick"); await wait(1000 / cps); }
    node.textContent = text;
  }

  return {
    el, mode,
    get coreSlot() { return $(".mcb-core-slot"); },
    get stage() { return $(".mcb-stage"); },
    get skipped() { return skipped; },
    skip, wait,
    /** Stage 1: darkness, then the system wakes up. */
    async stage1() {
      document.body.append(el);
      sound("power");
      el.getBoundingClientRect(); el.classList.add("on");
      await wait(P.darken);
      el.classList.add("s1");
      if (P.ident) { await type($(".mcb-ident b"), "J.A.R.V.I.S.", 36); el.classList.add("ident-on"); await wait(P.ident); } else el.classList.add("ident-on");
      el.classList.add("title-on");
      await type($(".mcb-title h1"), "INITIALISING MISSION CONTROL", 90);
      await wait(P.title);
      await hold("wake");
    },
    /** Stage 2: Core 808 assembles in the centre (cc = the live core). */
    async stage2(cc) {
      setPhase(2);
      el.classList.add("s2");
      $(".mcb-core-label b").textContent = "INITIALISING";
      if (!skipped) [0.2, 0.28, 0.36].forEach((f, i) => timers.push(setTimeout(() => !skipped && sound("ring", i), P.assemble * f)));
      if (!skipped) timers.push(setTimeout(() => !skipped && sound("assemble"), P.assemble * 0.42));
      const asm = cc?.assemble ? cc.assemble(skipped ? 1 : window.__mcbHold?.has?.("assembly") ? 30000 : P.assemble) : Promise.resolve();
      await hold("assembly");
      await Promise.race([asm, new Promise((r) => skipFns.push(r))]);
      if (skipped) cc?.assemble?.(1);
      el.classList.add("core-on");
      $(".mcb-core-label b").textContent = "ONLINE";
      sound("coreOnline");
      $(".mcb-title h1").textContent = "MISSION CONTROL";
      $(".mcb-title p").innerHTML = "JARVIS CORE 808 <span>·</span> PREPARING FOR OPERATIONS";
      el.classList.add("sub-on");
      await hold("core");
      await wait(mode === "full" ? 250 : 0);
    },
    /** Stage 3: real checks, a row each; waits for them (up to a limit) and returns what is known. */
    async stage3(checks) {
      setPhase(3);
      el.classList.add("s3");
      const list = $(".mcb-checks"), t0 = performance.now(), rows = [];
      const results = new Array(checks.length).fill(null);
      checks.forEach((c, i) => c.p.then((r) => { results[i] = r; }));
      for (let i = 0; i < checks.length; i++) {
        const c = checks[i], li = document.createElement("li");
        li.className = "pending";
        li.innerHTML = `<span class="mcb-ck-dot"></span><b>${esc(MIL[c.label] || c.label.toUpperCase())}</b><span class="mcb-ck-tag">IN PROGRESS</span><i class="mcb-bar"><i></i></i><small></small>`;
        list.append(li); rows.push(li);
        const settle = (r) => {
          if (!li.isConnected || li.dataset.state) return;
          li.className = r.state; li.dataset.state = r.state;
          li.querySelector(".mcb-ck-tag").textContent = STATE_TAG[r.state] || r.state.toUpperCase();
          li.querySelector("small").textContent = r.detail || "";
          sound("check", r.state);
        };
        c.p.then((r) => setTimeout(() => settle(r), Math.max(0, (skipped ? 0 : 260) - (performance.now() - t0 - i * P.rowGap))));
        await wait(P.rowGap);
      }
      const all = Promise.all(checks.map((c) => c.p));
      await Promise.race([all, new Promise((r) => { timers.push(setTimeout(r, P.maxChecks)); skipFns.push(r); })]);
      const rest = P.minChecks - (performance.now() - t0);
      if (rest > 0) await wait(rest);
      await hold("checks");
      rows.forEach((li, i) => { if (!li.dataset.state) { li.className = "pending later"; li.querySelector(".mcb-ck-tag").textContent = "CONTINUING"; li.querySelector("small").textContent = "finishing in the background"; } });
      return results;
    },
    /** Stage 4: confirmation, with an honest count. */
    async stage4(results) {
      setPhase(4);
      el.classList.add("s4");
      const done = results.filter(Boolean), bad = done.filter((r) => r.state !== "ok").length, pend = results.length - done.length;
      const status = bad ? `${bad} SYSTEM${bad === 1 ? "" : "S"} UNAVAILABLE OR DEGRADED` : pend ? `${pend} CHECK${pend === 1 ? "" : "S"} STILL RUNNING` : "";
      $(".mcb-confirm").innerHTML = `<b>J.A.R.V.I.S.</b><strong>CORE 808 ONLINE</strong><span>MISSION CONTROL INITIALISED</span><em>ALL AVAILABLE OPERATIONAL SYSTEMS READY</em>${status ? `<i class="${bad ? "warn" : ""}">${esc(status)}</i>` : ""}`;
      el.classList.add("confirm-on");
      sound("confirm", bad ? "warn" : "ok");
      await hold("confirm");
      await wait(P.confirm);
    },
    /** The overlay irises open from the core (mission.js reveals the layout underneath at the same time). */
    async reveal() {
      el.classList.add("reveal");
      sound("reveal");
      await new Promise((r) => setTimeout(r, skipped ? Math.min(P.reveal, 380) : P.reveal));
    },
    destroy() {
      removeEventListener("keydown", onKey, true);
      clearInterval(clock); timers.forEach(clearTimeout); skipFns.forEach((f) => f()); skipFns = [];
      el.remove();
    },
  };
}
