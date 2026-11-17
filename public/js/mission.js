// Mission Control: a second operating mode of the same JARVIS app (not an overlay, not a reload).
// Activation is a four-stage transformation of the live interface:
//   1 ACTIVATING      the Command Centre dims, the core brightens and shifts to violet, an energy pulse, the banner
//   2 TRANSFORMATION  panels move away, the sidebar becomes Mission Control navigation, the same living core travels to
//                     its Mission Control position, architecture unfolds, diagnostics slide in, the map expands
//   3 INITIALISATION  real service checks, shown as they complete (only a check that passed is shown as passed)
//   4 ACTIVE          the Mission Control layout with live data
// Deactivation reverses it. Only transform and opacity are animated (GPU-composited); reduced motion skips the
// movement. Alarms, conversations and background services are never touched.
import { api } from "./api.js";
import * as sync from "./sync.js";
import { core, STATE_LABEL } from "./corestate.js";
import { mountBestCore } from "./core.js";
import { $, $$, esc, icon } from "./util.js";
import { PANELS, RENDER, SERIES_MAX } from "./mc-panels.js";

export const MC_SECTIONS = [
  ["overview", "Operational Overview", "home"],
  ["global", "Global Information", "globe"],
  ["architecture", "System Architecture", "cpu"],
  ["diagnostics", "Diagnostics", "diagnostics"],
  ["processes", "Active Processes", "wave"],
  ["intelligence", "Intelligence", "intel"],
  ["comms", "Communications", "notifications"],
  ["projects", "Projects", "projects"],
  ["personal", "Personal Operations", "tasks"],
];
const OVERVIEW = ["core", "overview", "ops", "arch", "diag", "map", "res", "intel", "comms", "act"];
const FOCUS = {
  global: { main: "map", side: ["core", "overview", "intel"] },
  architecture: { main: "arch", side: ["core", "diag", "res"] },
  diagnostics: { main: "diag", side: ["core", "arch", "res"] },
  processes: { main: "procs", side: ["core", "res", "act"] },
  intelligence: { main: "intel", side: ["core", "act", "comms"] },
  comms: { main: "comms", side: ["core", "act", "ops"] },
  projects: { main: "projects", side: ["core", "ops", "act"] },
  personal: { main: "personal", side: ["core", "overview", "ops"] },
};
const ALL_PANELS = [...OVERVIEW, "procs", "projects", "personal"];

const FETCH = {
  diag: () => api("/api/diagnostics"),
  perf: () => api("/api/performance"),
  home: () => api("/api/home"),
  notif: () => api("/api/notifications?limit=12"),
  activity: () => api("/api/activity?limit=25"),
  research: () => api("/api/research"),
  briefings: () => api("/api/briefings?limit=3"),
  world: () => api("/api/world"),
  projects: () => api("/api/projects"),
  devices: () => api("/api/devices"),
  pending: () => api("/api/pending"),
  focus: () => api("/api/focus"),
  routines: () => api("/api/routines"),
  reminders: () => api("/api/reminders"),
  runs: () => api("/api/diagnostics/runs?limit=3"),
  awareness: () => api("/api/awareness"),
  conv: async () => { const c = await api("/api/conversations"); return c.current ? api(`/api/conversations/${c.current}/messages?limit=8`) : []; },
};
const ENTITY_KEYS = {
  tasks: ["home"], events: ["home"], calendar: ["home"], alarms: ["home"], reminders: ["reminders", "home"], notifications: ["notif"], activity: ["activity"],
  research: ["research"], briefing: ["briefings"], projects: ["projects"], routines: ["routines"], focus: ["focus"], world: ["world"], settings: ["world"], health: ["diag"], pending: ["pending"],
};
const ENTER = {
  core: [{ opacity: 0 }, { opacity: 1 }],
  unfold: [{ opacity: 0, transform: "scaleY(.04)", transformOrigin: "50% 0" }, { opacity: 1, transform: "none", transformOrigin: "50% 0" }],
  slideR: [{ opacity: 0, transform: "translateX(90px)" }, { opacity: 1, transform: "none" }],
  slideL: [{ opacity: 0, transform: "translateX(-90px)" }, { opacity: 1, transform: "none" }],
  expand: [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }],
  rise: [{ opacity: 0, transform: "translateY(28px)" }, { opacity: 1, transform: "none" }],
};
const ENTER_DELAY = { core: 0, arch: 120, diag: 220, map: 320, overview: 420, ops: 470, res: 520, intel: 580, comms: 630, act: 680, procs: 120, projects: 120, personal: 120 };

const html = document.documentElement;
const mark = (label) => (window.__mcTimeline ||= []).push({ label, t: Math.round(performance.now()) });
const D = { series: { cpu: [], ram: [], ai: [], lag: [] } };
let phase = "off", CTX = null, root = null, navEl = null, bannerEl = null, section = "overview", prevTitle = "";
let borrowed = null, ownCore = null, coreCanvas = null, timers = [], offs = [], readyP = null, hideP = null;

const reduced = () => html.classList.contains("reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.2,.75,.15,1)";
const anim = (el, frames, opts = {}) => (reduced() || !el?.animate ? null : el.animate(frames, { duration: 500, easing: EASE, fill: "both", ...opts }));
const settle = (list) => Promise.all(list.filter(Boolean).map((a) => a.finished.catch(() => {})));
const clearAnims = (els) => els.forEach((e) => e?.getAnimations?.().forEach((a) => a.cancel()));
const wait = (ms) => new Promise((r) => setTimeout(r, reduced() ? Math.min(ms, 60) : ms));
// Input keeps the core (and decorative animation) out of idle mode, so the transformation runs at full frame rate.
const wakeUi = () => dispatchEvent(new Event("wheel"));
const coreCtl = () => coreCanvas?.__core || ownCore;
const panelEl = (id) => root?.querySelector(`[data-panel="${id}"]`);
const visibleIds = () => (root ? $$("[data-panel]", root).filter((p) => !p.hidden).map((p) => p.dataset.panel) : []);
const sectionLabel = (id) => MC_SECTIONS.find((s) => s[0] === id)?.[1] || "";

export const mission = {
  get open() { return phase !== "off"; },
  get phase() { return phase; },
  get section() { return section; },
  /** Activate. Resolves when Mission Control is fully active, with the real initialisation result. */
  async show(ctx) {
    CTX = ctx || CTX;
    if (phase === "active") return D.init;
    if (phase === "activating") return readyP;
    if (phase === "deactivating") await hideP;
    phase = "activating";
    readyP = activate().catch((e) => { console.error("[mission]", e); phase = "active"; return { issues: 1, failed: 1, error: e.message }; });
    return readyP;
  },
  /** Deactivate. instant: no animation (used when another section is opened directly). */
  async hide({ instant = false } = {}) {
    if (phase === "off") return;
    if (phase === "deactivating") return hideP;
    if (phase === "activating") await readyP;
    phase = "deactivating";
    hideP = deactivate({ instant }).catch((e) => console.error("[mission]", e)).finally(() => { phase = "off"; });
    return hideP;
  },
  setSection,
  /** Live entity changes from the server. */
  refresh(entities) {
    if (phase !== "active") return;
    const keys = entities.includes("*") ? neededKeys() : [...new Set(entities.flatMap((e) => ENTITY_KEYS[e] || []))].filter((k) => neededKeys().includes(k));
    if (keys.length) load(keys).then(renderAll);
  },
  /** A narrated diagnostic run finished while Mission Control is open: show it on the Diagnostics section. */
  showReport(r) {
    D.report = r;
    if (phase === "off") return;
    if (section !== "diagnostics") setSection("diagnostics"); else renderPanel("diag");
    load(["diag", "runs"]).then(() => renderPanel("diag"));
  },
};

// ---------------------------------------------------------------- Activation
async function activate() {
  const view = $("#view");
  const ctx = CTX;
  wakeUi();
  prevTitle = $("#pageTitle")?.textContent || "";
  const checks = startChecks(ctx);                                   // real checks run during the animation

  // Stage 1 — ACTIVATING
  html.classList.add("mc-mode", "mc-activating");
  banner("ACTIVATING MISSION CONTROL", 1);
  coreCanvas = view.querySelector("canvas#core");
  coreCtl()?.setPalette("mission"); coreCtl()?.setBoost(1.8); coreCtl()?.pulse(1.6);
  energyPulse(coreCanvas || $(".main"));
  const blocks = viewBlocks(view);
  blocks.forEach((b) => anim(b, [{ opacity: 1 }, { opacity: 0.38 }], { duration: 420 }));
  await wait(650);

  // Stage 2 — INTERFACE TRANSFORMATION
  banner("RECONFIGURING INTERFACE", 2);
  build();
  applyLayout("overview");
  const outs = animateOut(blocks);
  const navDone = navSwap(true);
  root.hidden = true;
  await settle(outs);
  mark("outs done");
  const first = coreCanvas?.getBoundingClientRect();
  view.hidden = true;
  scrollTo(0, 0);
  root.hidden = false;
  root.classList.add("mc-building");
  const slot = $(".mc-core-slot", root);
  if (coreCanvas) {
    borrowed = { canvas: coreCanvas, parent: coreCanvas.parentNode, next: coreCanvas.nextSibling };
    slot.append(coreCanvas);                                         // the same living core moves; no second 3D scene
  } else {
    coreCanvas = Object.assign(document.createElement("canvas"), { id: "mcCore" });
    coreCanvas.setAttribute("aria-label", "JARVIS core"); slot.append(coreCanvas);
    ownCore = await mountBestCore(coreCanvas, { quality: ctx.settings.appearance?.quality || "auto", animation: ctx.settings.appearance?.animation });
    ownCore.setPalette("mission"); ownCore.setBoost(1.8);
  }
  mark("core moved");
  renderAll();
  mark("rendered");
  const enters = [];
  const last = coreCanvas.getBoundingClientRect();
  enters.push(borrowed && first?.width
    ? anim(coreCanvas, [{ transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }], { duration: 950 })
    : anim(coreCanvas, [{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, transform: "none" }], { duration: 800 }));
  root.classList.remove("mc-building");
  for (const id of visibleIds()) {
    const p = panelEl(id);
    enters.push(anim(p, ENTER[PANELS[id].enter] || ENTER.rise, { duration: id === "map" ? 750 : 600, delay: ENTER_DELAY[id] || 0 }));
  }
  if (!reduced()) $(".mc-arch", root)?.classList.add("mc-draw");
  await settle(enters);
  mark("enters done");
  clearAnims([coreCanvas, ...$$("[data-panel]", root)]);
  await navDone;
  mark("nav done");

  // Stage 3 — INITIALISATION (real checks; a line is only green if the check passed)
  html.classList.replace("mc-activating", "mc-initialising");
  banner("INITIALISING", 3);
  const result = await showChecks(checks);
  D.init = result;

  // Stage 4 — ACTIVE
  html.classList.replace("mc-initialising", "mc-active");
  coreCtl()?.setBoost(1);
  banner(result.issues ? `MISSION CONTROL ACTIVE · ${result.issues} ${result.issues === 1 ? "ITEM NEEDS" : "ITEMS NEED"} ATTENTION` : "MISSION CONTROL ACTIVE", 4);
  hideBanner(2200);
  phase = "active";
  startLive();
  load(neededKeys()).then(renderAll);
  setTimeout(() => { const l = root && $(".mc-init", root); if (l && phase === "active") { const a = anim(l, [{ opacity: 1 }, { opacity: 0, transform: "translateY(8px)" }], { duration: 500 }); settle([a]).then(() => { l.hidden = true; clearAnims([l]); }); } }, 3200);
  return result;
}

// ---------------------------------------------------------------- Deactivation (the transformation in reverse)
async function deactivate({ instant }) {
  const fast = instant || reduced();
  const view = $("#view");
  stopLive();
  if (!fast) banner("DEACTIVATING MISSION CONTROL", 2);
  html.classList.add("mc-deactivating");
  wakeUi();
  const panels = root ? visibleIds().filter((id) => id !== "core").map(panelEl) : [];
  const outs = fast ? [] : panels.map((p, i) => anim(p, [...(ENTER[PANELS[p.dataset.panel].enter] || ENTER.rise)].reverse(), { duration: 380, delay: i * 35, easing: "cubic-bezier(.5,0,.75,0)" }));
  const navDone = navSwap(false, fast);
  await settle(outs);
  const first = coreCanvas?.getBoundingClientRect();
  if (root) root.hidden = true;
  view.hidden = false;
  scrollTo(0, 0);
  const flips = [];
  if (borrowed) {
    const { canvas, parent, next } = borrowed;
    if (parent.isConnected) {
      parent.insertBefore(canvas, next && next.parentNode === parent ? next : null);
      canvas.__core?.setPalette(null); canvas.__core?.setBoost(1);
      const last = canvas.getBoundingClientRect();
      if (!fast && first?.width && last.width) flips.push(anim(canvas, [{ transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }], { duration: 850 }));
    } else { canvas.__core?.destroy?.(); canvas.remove(); }      // the page it came from was replaced meanwhile
  }
  ownCore?.destroy?.(); ownCore = null;
  const blocks = viewBlocks(view);
  if (fast) clearAnims(blocks);
  else blocks.forEach((b, i) => flips.push(anim(b, [{ opacity: 0, transform: "translateY(16px) scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 480, delay: 160 + i * 28 })));
  html.classList.remove("mc-mode");                                 // colours return while the panels come back
  await settle(flips);
  clearAnims([...blocks, borrowed?.canvas]);
  await navDone;
  teardown();
  html.classList.remove("mc-activating", "mc-initialising", "mc-active", "mc-deactivating");
  hideBanner(0);
  const t = $("#pageTitle"); if (t && prevTitle) t.textContent = prevTitle;
}
function teardown() {
  for (const id of ALL_PANELS) panelEl(id)?.querySelector(".mc-body")?.__map?.destroy?.();
  root?.remove(); root = null;
  navEl?.remove(); navEl = null;
  borrowed = null; coreCanvas = null;
  section = "overview";
}

// ---------------------------------------------------------------- Building blocks of the transformation
function viewBlocks(view) {
  if (view.querySelector(".cc")) return [...view.querySelectorAll(".cc-left > *, .cc-right > *, .cc-centre > :not(.core-stage), .core-stage > :not(canvas)")];
  return [...view.children];
}
function animateOut(blocks) {
  const cx = innerWidth / 2;
  return blocks.map((b, i) => {
    const r = b.getBoundingClientRect(), mid = r.left + r.width / 2;
    const dir = mid < cx - 60 ? -1 : mid > cx + 60 ? 1 : 0;
    return anim(b, [{ opacity: 0.38, transform: "none" }, { opacity: 0, transform: `translate(${dir * 80}px, ${dir ? 0 : 36}px) scale(.9)` }], { duration: 460, delay: i * 22, easing: "cubic-bezier(.5,0,.75,0)" });
  });
}
async function navSwap(toMission, instant = false) {
  const nav = $("#nav");
  if (!navEl) return;
  const from = toMission ? nav : navEl, to = toMission ? navEl : nav;
  if (!instant) await settle([...from.children].map((e, i) => anim(e, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-26px)" }], { duration: 240, delay: i * 12, easing: "ease-in" })));
  from.hidden = true; to.hidden = false;
  clearAnims([...from.children]);
  if (!instant) await settle([...to.children].map((e, i) => anim(e, [{ opacity: 0, transform: "translateX(-26px)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: i * 30 })));
  clearAnims([...to.children]);
}
function energyPulse(at) {
  const r = at?.getBoundingClientRect?.() || { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const size = Math.max(220, Math.min(r.width, r.height) * 0.8);
  const ring = Object.assign(document.createElement("div"), { className: "mc-pulse" });
  ring.style.cssText = `left:${r.left + r.width / 2 - size / 2}px;top:${r.top + r.height / 2 - size / 2}px;width:${size}px;height:${size}px`;
  const flash = Object.assign(document.createElement("div"), { className: "mc-flash" });
  document.body.append(flash, ring);
  const a = anim(ring, [{ transform: "scale(.25)", opacity: 0.95 }, { transform: "scale(3.4)", opacity: 0 }], { duration: 1150, easing: "cubic-bezier(.1,.6,.2,1)" });
  const b = anim(flash, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: 1150, easing: "ease-out" });
  settle([a, b]).then(() => { ring.remove(); flash.remove(); });
}
function banner(text, stage) {
  (window.__mcTimeline ||= []).push({ stage, text, t: Math.round(performance.now()) });
  if (!bannerEl) {
    bannerEl = Object.assign(document.createElement("div"), { className: "mc-banner" });
    bannerEl.setAttribute("role", "status"); bannerEl.setAttribute("aria-live", "polite");
    bannerEl.innerHTML = '<span class="mc-banner-mark" aria-hidden="true"></span><b></b><i class="mc-banner-bar" aria-hidden="true"><i></i></i>';
    document.body.append(bannerEl);
  }
  clearTimeout(bannerEl.__t);
  bannerEl.querySelector("b").textContent = text;
  bannerEl.querySelector(".mc-banner-bar > i").style.transform = `scaleX(${stage / 4})`;
  bannerEl.dataset.stage = stage;
  bannerEl.classList.add("on");
}
function hideBanner(delay) { if (bannerEl) { clearTimeout(bannerEl.__t); bannerEl.__t = setTimeout(() => bannerEl.classList.remove("on"), delay); } }

// ---------------------------------------------------------------- Real initialisation checks
function startChecks(ctx) {
  const diagP = api("/api/diagnostics").then((d) => (D.diag = d));
  const run = (label, fn) => ({ label, p: fn().catch((e) => ({ state: "bad", detail: e.message })) });
  return [
    run("Initialising system architecture", async () => {
      const d = await diagP; const n = (d.counts.error || 0) + (d.counts.warn || 0);
      return { state: d.counts.error ? "warn" : "ok", detail: `${d.checks.length} components mapped${n ? ` · ${n} need attention` : ""}` };
    }),
    run("Checking AI core", async () => {
      const a = (await diagP).checks.find((c) => c.name === "ai");
      if (!a || a.status === "off") return { state: "warn", detail: "not set up" };
      try { const t = await api("/api/diagnostics/test/ai", { method: "POST" }); return t.ok ? { state: "ok", detail: `responding · ${t.latencyMs} ms` } : { state: "bad", detail: t.detail }; }
      catch (e) { return { state: "warn", detail: e.status === 429 ? "not re-tested (tested moments ago)" : e.message }; }
    }),
    run("Verifying voice interface", async () => {
      const d = await diagP, stt = d.checks.find((c) => c.name === "stt"), tts = d.checks.find((c) => c.name === "tts");
      if (!stt || stt.status === "off" || stt.status === "error") return { state: stt?.status === "error" ? "bad" : "warn", detail: stt ? `speech recognition: ${stt.detail}` : "no speech recognition" };
      const ag = ctx.agent;
      if (ctx.desktop && ag?.muted) return { state: "warn", detail: "microphone muted" };
      const wake = ctx.desktop ? (ag?.wakeWord === "listening" ? " · “Hey JARVIS” listening" : ` · wake word ${ag?.wakeWord || "not reporting"}`) : " · tap or type on this device";
      return { state: ctx.desktop && ag?.wakeWord !== "listening" ? "warn" : "ok", detail: `recognition ready${tts && tts.status !== "off" ? ", voice output ready" : ""}${wake}` };
    }),
    run("Establishing local system connections", async () => {
      if (!sync.status.online) return { state: "bad", detail: "live link to the JARVIS server is down — working offline" };
      const dv = await api("/api/devices").then((x) => (D.devices = x)).catch(() => null);
      const live = dv ? dv.filter((x) => !x.revoked_at && x.online).length : null;
      const agent = ctx.desktop ? (ctx.agent ? "Windows agent connected" : "Windows agent not reporting") : "browser session";
      return { state: ctx.desktop && !ctx.agent ? "warn" : "ok", detail: `live link up · ${agent}${live != null ? ` · ${live} device${live === 1 ? "" : "s"} online` : ""}` };
    }),
    run("Loading operational overview", async () => {
      const [h, n, a] = await Promise.all([FETCH.home(), FETCH.notif(), FETCH.activity()]);
      D.home = h; D.notif = n; D.activity = a;
      return { state: "ok", detail: `${h.events.length} event${h.events.length === 1 ? "" : "s"} · ${h.tasks.overdue.length} overdue · ${h.tasks.dueToday.length} due today · ${n.unread} unread` };
    }),
  ];
}
async function showChecks(checks) {
  const list = $(".mc-init", root);
  list.hidden = false; list.innerHTML = "";
  const out = { ok: 0, total: checks.length, issues: 0, failed: 0, lines: [] };
  for (const c of checks) {
    const li = document.createElement("li");
    li.className = "pending";
    li.innerHTML = `<span class="mc-init-dot"></span><b>${esc(c.label)}</b><span class="faint">…</span>`;
    list.append(li);
    const r = await c.p;
    li.className = r.state; li.dataset.state = r.state;
    li.querySelector(".faint").textContent = r.detail;
    out.lines.push({ label: c.label, ...r });
    if (r.state === "ok") out.ok++; else { out.issues++; if (r.state === "bad") out.failed++; }
    renderAll();
    await wait(220);
  }
  const fin = document.createElement("li");
  fin.className = `final ${out.issues ? "warn" : "ok"}`; fin.dataset.state = out.issues ? "warn" : "ok";
  fin.innerHTML = `<span class="mc-init-dot"></span><b>${out.issues ? "Mission Control active" : "Mission Control ready"}</b><span class="faint">${out.issues ? `${out.issues} of ${out.total} checks need attention` : `${out.ok} of ${out.total} checks passed`}</span>`;
  list.append(fin);
  out.at = new Date().toISOString();
  await wait(500);
  return out;
}

// ---------------------------------------------------------------- Layout
function build() {
  const nav = $("#nav");
  navEl = document.createElement("nav");
  navEl.id = "mcNav"; navEl.className = "nav mc-nav"; navEl.hidden = true;
  navEl.setAttribute("aria-label", "Mission Control sections");
  navEl.innerHTML = `<div class="nav-group">Mission Control</div>${MC_SECTIONS.map(([id, l, ic]) => `<button class="nav-btn" data-mc="${id}" title="${esc(l)}">${icon(ic)}<span>${esc(l)}</span></button>`).join("")}
    <div class="nav-group">Mode</div><button class="nav-btn mc-exit-btn" data-mcexit title="Exit Mission Control">${icon("x")}<span>Exit Mission Control</span></button>`;
  nav.after(navEl);
  root = document.createElement("section");
  root.id = "mcView"; root.className = "mcv view-mc";
  root.setAttribute("aria-label", "Mission Control");
  root.innerHTML = `<div class="mc-tabs" role="tablist" aria-label="Mission Control sections">${MC_SECTIONS.map(([id, l, ic]) => `<button class="mc-tab" role="tab" data-mc="${id}">${icon(ic)}<span>${esc(l)}</span></button>`).join("")}<button class="mc-tab exit" data-mcexit>${icon("x")}<span>Exit</span></button></div>
    <div class="mc-grid">
      <article class="panel mc-panel mc-core-panel" data-panel="core" aria-label="JARVIS core">
        <div class="mc-core-slot"><span class="mc-ring r1" aria-hidden="true"></span><span class="mc-ring r2" aria-hidden="true"></span></div>
        <div class="mc-core-state" id="mcState">${esc(STATE_LABEL[core.state] || "Standing by")}</div>
        <div class="mc-caption" id="mcCaption" aria-live="polite"></div>
        <form class="mc-cmd" autocomplete="off"><div class="pill-input"><input id="mcSay" placeholder="Command JARVIS…" aria-label="Command JARVIS" enterkeyhint="send"><button class="icon-btn" aria-label="Send">${icon("send")}</button></div><button type="button" class="mic" id="mcMic" aria-label="Speak to JARVIS">${icon("mic")}</button></form>
        <ol class="mc-init" hidden aria-label="Initialisation checks"></ol>
      </article>
      ${ALL_PANELS.filter((id) => id !== "core").map((id) => `<article class="panel mc-panel" data-panel="${id}" hidden><div class="panel-head"><span class="label">${esc(PANELS[id].title)}</span><span class="mc-meta faint"></span></div><div class="mc-body"></div></article>`).join("")}
    </div>`;
  $("#view").after(root);
  $$("[data-mc]").forEach((b) => b.onclick = () => setSection(b.dataset.mc));
  $$("[data-mcexit]").forEach((b) => b.onclick = () => CTX.handleUi({ kind: "mission", on: false }, { speak: false }));
  $(".mc-cmd", root).onsubmit = (e) => { e.preventDefault(); const t = $("#mcSay").value.trim(); if (!t) return; $("#mcSay").value = ""; CTX.converse(t); };
  $("#mcMic", root).onclick = () => CTX.listen();
}
function applyLayout(sec) {
  section = sec;
  const F = FOCUS[sec];
  root.dataset.layout = F ? "focus" : "overview";
  root.dataset.section = sec;
  const show = F ? [F.main, ...F.side] : OVERVIEW;
  for (const p of $$("[data-panel]", root)) {
    const id = p.dataset.panel, on = show.includes(id);
    p.hidden = !on;
    p.style.gridArea = !on ? "" : F ? (id === F.main ? "main" : `side${F.side.indexOf(id) + 1}`) : id;
    p.classList.toggle("expanded", !!F && id === F.main);
  }
  $$("[data-mc]").forEach((b) => { const on = b.dataset.mc === sec; b.classList.toggle("active", on); if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  const t = $("#pageTitle"); if (t) t.textContent = `Mission Control · ${sectionLabel(sec)}`;
}
/** Switch section: panels glide to their new places (FLIP); newly shown ones appear. */
function setSection(sec) {
  if (!root || !MC_SECTIONS.some((s) => s[0] === sec) || (sec === section && root.dataset.section === sec)) return;
  const before = new Map($$("[data-panel]", root).filter((p) => !p.hidden).map((p) => [p, p.getBoundingClientRect()]));
  applyLayout(sec);
  renderAll();
  const moves = [];
  for (const p of $$("[data-panel]", root).filter((x) => !x.hidden)) {
    const b = before.get(p), a = p.getBoundingClientRect();
    if (b && a.width && a.height) moves.push(anim(p, [{ transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width}, ${b.height / a.height})`, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }], { duration: 520 }));
    else moves.push(anim(p, [{ opacity: 0, transform: "scale(.95)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: 140 }));
  }
  settle(moves).then(() => clearAnims($$("[data-panel]", root || document.createElement("div"))));
  load(neededKeys()).then(renderAll);
  scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
}

// ---------------------------------------------------------------- Data
function neededKeys() {
  const keys = new Set();
  for (const id of visibleIds()) {
    const p = PANELS[id]; if (!p) continue;
    p.needs.forEach((k) => keys.add(k));
    if (panelEl(id)?.classList.contains("expanded")) (p.expandedNeeds || []).forEach((k) => keys.add(k));
  }
  if (!CTX?.desktop) keys.delete("awareness");
  return [...keys];
}
async function load(keys) {
  await Promise.all([...new Set(keys)].filter((k) => FETCH[k]).map(async (k) => {
    try { D[k] = await FETCH[k](); D[`${k}Err`] = null; if (k === "perf") pushSeries(D.perf); }
    catch (e) { D[`${k}Err`] = e.status === 0 ? "offline" : e.message; }
  }));
  D.loadedAt = new Date();
}
function pushSeries(p) {
  const push = (k, v) => { if (v == null) return; const s = D.series[k]; s.push(v); if (s.length > SERIES_MAX) s.shift(); };
  push("cpu", p.cpuPct); push("ram", p.ramPct); push("ai", p.ai?.medianMs); push("lag", p.lagMs + p.dbMs);
}
function renderPanel(id) {
  if (!root || id === "core") return;
  const p = panelEl(id);
  if (!p || p.hidden) return;
  try {
    RENDER[id](p.querySelector(".mc-body"), D, { expanded: p.classList.contains("expanded"), ctx: CTX, exitTo, refresh: (keys) => load(keys).then(renderAll) });
    const meta = p.querySelector(".mc-meta");
    if (meta) meta.textContent = D.loadedAt ? `updated ${D.loadedAt.toLocaleTimeString("en-GB", { timeZone: CTX.settings.timezone, hour: "2-digit", minute: "2-digit" })}` : "";
  } catch (e) { console.error("[mission]", id, e); p.querySelector(".mc-body").innerHTML = `<p class="mc-empty">This panel couldn't be drawn: ${esc(e.message)}</p>`; }
}
function renderAll() { visibleIds().forEach(renderPanel); }
function startLive() {
  stopLive();
  timers.push(
    setInterval(() => { if (visibleIds().includes("res")) load(["perf"]).then(() => renderPanel("res")); }, 3000),
    setInterval(() => load(["diag"]).then(() => ["overview", "arch", "diag", "procs"].forEach(renderPanel)), 20_000),
    setInterval(() => { if (CTX?.desktop && visibleIds().includes("procs")) load(["awareness"]).then(() => renderPanel("procs")); }, 15_000),
    setInterval(() => load(neededKeys().filter((k) => !["perf", "diag", "awareness"].includes(k))).then(renderAll), 60_000),
    setInterval(() => { renderPanel("overview"); renderPanel("ops"); renderPanel("personal"); if (coreCanvas?.__core && !ownCore) coreCanvas.__core.setPalette("mission"); }, 30_000),
  );
  let opsT = 0;
  offs.push(core.on((s) => { const st = $("#mcState"); if (st) st.textContent = STATE_LABEL[s] || s; clearTimeout(opsT); opsT = setTimeout(() => renderPanel("ops"), 300); }));
  offs.push(CTX.onCaption((t) => { const c = $("#mcCaption"); if (c) c.textContent = t || ""; }));
}
function stopLive() { timers.forEach(clearInterval); timers = []; offs.forEach((f) => f()); offs = []; }

/** Leave Mission Control (reversing the transformation) and open a normal section. */
async function exitTo(tab, params = {}) {
  await mission.hide();
  CTX.go(tab, params);
}
