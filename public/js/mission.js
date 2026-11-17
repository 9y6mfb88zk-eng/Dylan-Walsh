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
import { ensureCore, attachCore, parkCore, coreCanvas as hostCanvas, coreCtl as hostCtl } from "./corehost.js";
import { sounds } from "./sounds.js";
import { $, $$, esc, icon } from "./util.js";
import { PANELS, RENDER, SERIES_MAX } from "./mc-panels.js";
import { mountGoc } from "./goc.js";

// The first six are the Global Operations navigation; the rest are the earlier Mission Control views, kept as they were.
export const MC_SECTIONS = [
  ["globalops", "Global Operations", "globe"],
  ["world", "World Explorer", "world"],
  ["intelligence", "Intelligence", "intel"],
  ["events", "Global Events", "fire"],
  ["flights", "Flight Tracking", "send"],
  ["diagnostics", "System Diagnostics", "diagnostics"],
  // Operations: modules inside Mission Control (same core, map, data and voice), not separate applications.
  ["op-blackbox", "Blackbox", "intel"],
  ["op-wayfinder", "Wayfinder", "world"],
  ["op-sentinel", "Sentinel", "shield"],
  ["op-orbit", "Orbit", "globe"],
  ["overview", "Operational Overview", "home"],
  ["architecture", "System Architecture", "cpu"],
  ["processes", "Active Processes", "wave"],
  ["comms", "Communications", "notifications"],
  ["projects", "Projects", "projects"],
  ["personal", "Personal Operations", "tasks"],
];
const GOC_SECTIONS = ["globalops", "world", "events", "flights", "op-blackbox", "op-wayfinder", "op-sentinel", "op-orbit"];
export const OP_NAMES = { "op-blackbox": "Operation Blackbox", "op-wayfinder": "Operation Wayfinder", "op-sentinel": "Operation Sentinel", "op-orbit": "Operation Orbit" };
const isGoc = (sec) => GOC_SECTIONS.includes(sec);
const OVERVIEW = ["core", "overview", "ops", "arch", "diag", "map", "res", "intel", "comms", "act"];
const FOCUS = {
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
let coreCanvas = null, timers = [], offs = [], readyP = null, hideP = null, goc = null, gocP = null;
// Resolves with the Global Operations display once it has been created during activation (checks start before that).
let gocMounted = null, gocMountedResolve = null;
const resetGocMounted = () => { gocMounted = new Promise((r) => { gocMountedResolve = r; }); };
resetGocMounted();

const reduced = () => html.classList.contains("reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.2,.75,.15,1)";
const anim = (el, frames, opts = {}) => (reduced() || !el?.animate ? null : el.animate(frames, { duration: 500, easing: EASE, fill: "both", ...opts }));
const settle = (list, budget) => {
  const all = Promise.all(list.filter(Boolean).map((a) => a.finished.catch(() => {})));
  // A step never runs past its time budget, even on a slow machine; the animations are then finished early.
  return budget == null ? all : Promise.race([all, new Promise((r) => setTimeout(r, budget))]).then(() => list.forEach((a) => { try { if (a && a.playState === "running") a.finish(); } catch {} }));
};
const clearAnims = (els) => els.forEach((e) => e?.getAnimations?.().forEach((a) => a.cancel()));
const wait = (ms) => new Promise((r) => setTimeout(r, reduced() ? Math.min(ms, 60) : ms));
// Input keeps the core (and decorative animation) out of idle mode, so the transformation runs at full frame rate.
const wakeUi = () => dispatchEvent(new Event("wheel"));
const coreCtl = () => hostCtl() || coreCanvas?.__core || null;
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
  /** The Global Operations display (null until Mission Control is active). */
  get goc() { return goc; },
  /** What's on screen in Mission Control, for the AI ("research this aircraft", "save this journey"). */
  context() { return phase === "off" ? null : { section, ...(goc?.context?.() || {}) }; },
  /** Voice/AI commands for Global Operations: switches to the right section first. */
  async gocCommand(cmd) {
    if (phase === "off" || phase === "deactivating") await mission.show(CTX);
    else if (phase === "activating") await readyP;
    if (cmd.op) {
      const sec = `op-${cmd.op}`;
      if (section !== sec) await setSection(sec);
      await gocP;
      if (!cmd.action || (cmd.action === "open" && !cmd.id)) return { ok: !!goc };
      return goc ? goc.opCommand(cmd) : { ok: false, error: "Mission Control isn't available." };
    }
    if (cmd.action === "sitrep") { if (!isGoc(section)) await setSection("globalops"); await gocP; const r = await goc?.openSitrep(); return r ? { ok: true, sections: r.data.sections.length, problems: r.data.problems.length, summary: r.data.summary } : { ok: false, error: "The report couldn't be compiled." }; }
    const want = cmd.section || (/^flights|^select|^nearest/.test(cmd.action) ? "flights" : cmd.action === "events" ? "events" : null);
    if (want && section !== want && !(section === "globalops" && want !== "world")) await setSection(want);
    else if (!isGoc(section)) await setSection("globalops");
    await gocP;
    return goc ? goc.command(cmd) : { ok: false, error: "Global Operations isn't available." };
  },
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

// ---------------------------------------------------------------- Activation (about 1.5 s at normal speed)
// One persistent core (corehost.js) travels between the Command Centre and Mission Control, so it is never missing,
// duplicated or rebuilt. The real initialisation checks run alongside the animation and finish in the core panel
// after Mission Control is already interactive.
async function activate() {
  const view = $("#view");
  const ctx = CTX, I = iface(ctx);
  const T = (ms) => (I.instant ? 0 : Math.round(ms * I.speed));
  wakeUi();
  prevTitle = $("#pageTitle")?.textContent || "";
  mark("start");
  playTransitionSound("enter", ctx);
  const checks = startChecks(ctx);                                    // real checks, in parallel with the animation

  // 1 · the Command Centre darkens slightly; the core brightens, its particles speed up; a soft pulse goes out
  html.classList.add("mc-mode", "mc-activating");
  banner("ACTIVATING MISSION CONTROL", 1);
  coreCanvas = await ensureCore(ctx.settings).then(() => hostCanvas());
  mark("core ready");
  const cc = coreCtl();
  cc?.setPalette?.("mission"); cc?.setBoost?.(I.reducedEffects ? 1.3 : 1.8); cc?.pulse?.(I.reducedEffects ? 0.8 : 1.4);
  const inView = view.contains(coreCanvas) && !view.hidden;
  if (!I.instant && !I.reducedEffects) energyPulse(inView ? coreCanvas : $(".main"), T);
  const blocks = viewBlocks(view);
  if (!I.instant) blocks.forEach((b) => anim(b, [{ opacity: 1, transform: "none" }, { opacity: 0.55, transform: "scale(.985)" }], { duration: T(200) }));
  // Mission Control is assembled (hidden) while the Command Centre dims, so nothing waits on it later.
  build();
  applyLayout("globalops");
  root.hidden = true;
  mark("built");
  const gocReady = ensureGoc(ctx, "globalops").then((g) => { mark("map ready"); return g; }).catch((e) => { console.error("[mission] goc", e); return null; });
  await wait(T(160));

  // 2 · Command Centre panels slide away; the navigation becomes Mission Control's
  banner("RECONFIGURING INTERFACE", 2);
  const outs = I.instant ? [] : animateOut(blocks, T);
  const navDone = navSwap(true, I.instant, T);
  await Promise.all([settle(outs, T(480) + 60), gocReady]);
  mark("outs done");
  const first = inView ? coreCanvas.getBoundingClientRect() : null;
  view.hidden = true;
  scrollTo(0, 0);
  root.hidden = false;
  root.classList.add("mc-building");
  placeCore();                                                         // the same living core moves into its panel
  mark("core moved");
  renderAll();
  mark("rendered");
  // 3 · the map expands into place, the core panel locks in, the events column and status panels follow
  const enters = [];
  const last = coreCanvas.getBoundingClientRect();
  if (!I.instant) {
    enters.push(first?.width && last.width
      ? anim(coreCanvas, [{ transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }], { duration: T(640) })
      : anim(coreCanvas, [{ opacity: 0, transform: "scale(.7)" }, { opacity: 1, transform: "none" }], { duration: T(560) }));
    if (isGoc(section) && goc) {
      const g = goc.root;
      enters.push(anim($(".goc-centre", g), [{ opacity: 0, transform: "scale(.9)", filter: "brightness(1.6)" }, { opacity: 1, transform: "none", filter: "none" }], { duration: T(620), delay: T(30) }));
      enters.push(anim($(".goc-left .goc-box", g), ENTER.slideL, { duration: T(480), delay: T(120) }));
      enters.push(anim($(".goc-right", g), ENTER.slideR, { duration: T(520), delay: T(190) }));
      $$(".goc-bottom > *", g).forEach((b, i) => enters.push(anim(b, ENTER.rise, { duration: T(400), delay: T(220 + i * 35) })));
      enters.push(anim($(".goc-strip", g), [{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }], { duration: T(360), delay: T(260) }));
    } else for (const id of visibleIds()) enters.push(anim(panelEl(id), ENTER[PANELS[id].enter] || ENTER.rise, { duration: T(520), delay: T(ENTER_DELAY[id] || 0) * 0.6 }));
  }
  root.classList.remove("mc-building");
  await settle(enters, T(820) + 80);
  clearAnims([coreCanvas, ...$$("[data-panel]", root), ...(goc ? $$(".goc-strip, .goc-centre, .goc-left .goc-box, .goc-right, .goc-bottom > *", goc.root) : [])]);
  await navDone;
  mark("enters done");

  // 4 · status indicators light up; Mission Control is interactive. The checks finish in the core panel.
  html.classList.replace("mc-activating", "mc-active");
  goc?.root?.classList.add("goc-lit");
  banner("INITIALISING", 3);
  phase = "active";
  cc?.setBoost?.(1.25);
  startLive();
  load(neededKeys()).then(renderAll);
  mark("interactive");
  const result = await showChecks(checks);
  D.init = result;
  if (phase !== "active") return result;
  cc?.setBoost?.(1);
  banner(result.issues ? `MISSION CONTROL ACTIVE · ${result.issues} ${result.issues === 1 ? "ITEM NEEDS" : "ITEMS NEED"} ATTENTION` : "MISSION CONTROL ACTIVE", 4);
  hideBanner(1800);
  setTimeout(() => { const l = root && $(".mc-init", root); if (l && phase === "active") { const a = anim(l, [{ opacity: 1 }, { opacity: 0, transform: "translateY(8px)" }], { duration: 400 }); settle([a]).then(() => { l.hidden = true; clearAnims([l]); }); } }, 3200);
  return result;
}

// ---------------------------------------------------------------- Deactivation (about 1.2 s): the same, in reverse
async function deactivate({ instant }) {
  const I = iface(CTX);
  const fast = instant || I.instant;
  const T = (ms) => (fast ? 0 : Math.round(ms * I.speed));
  const view = $("#view");
  mark("exit start");
  stopLive();
  if (!fast) { banner("DEACTIVATING MISSION CONTROL", 2); playTransitionSound("exit", CTX); }
  html.classList.add("mc-deactivating");
  wakeUi();
  // 1 · Mission Control panels retract; the map recedes (it never just vanishes). The core stays visible.
  const outs = [];
  if (!fast && root) {
    if (isGoc(section) && goc) {
      const g = goc.root;
      outs.push(anim($(".goc-strip", g), [{ opacity: 1 }, { opacity: 0, transform: "translateY(-10px)" }], { duration: T(260) }));
      outs.push(anim($(".goc-right", g), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(70px)" }], { duration: T(340), easing: "cubic-bezier(.5,0,.75,0)" }));
      $$(".goc-bottom > *", g).forEach((b, i) => outs.push(anim(b, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(24px)" }], { duration: T(300), delay: T(i * 30), easing: "cubic-bezier(.5,0,.75,0)" })));
      outs.push(anim($(".goc-left .goc-box", g), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-60px)" }], { duration: T(320), delay: T(40) }));
      outs.push(anim($(".goc-centre", g), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.94)" }], { duration: T(420), delay: T(80), easing: "cubic-bezier(.4,0,.6,1)" }));
    } else visibleIds().filter((id) => id !== "core").forEach((id, i) => outs.push(anim(panelEl(id), [...(ENTER[PANELS[id]?.enter] || ENTER.rise)].reverse(), { duration: T(340), delay: T(i * 30), easing: "cubic-bezier(.5,0,.75,0)" })));
  }
  const navDone = navSwap(false, fast, T);
  await settle(outs, fast ? 0 : T(560) + 80);
  mark("exit outs done");
  // 2 · the core travels back to the Command Centre's stage (or is parked if another page is open)
  const first = coreCanvas?.getBoundingClientRect();
  view.hidden = false;
  scrollTo(0, 0);
  const stage = view.querySelector(".core-stage");
  if (stage) attachCore(stage, CTX.settings); else parkCore();
  if (root) root.hidden = true;
  const cc = coreCtl();
  cc?.setPalette?.(null); cc?.setBoost?.(1);
  const flips = [];
  const canvas = hostCanvas();
  if (!fast && stage && first?.width) {
    const last = canvas.getBoundingClientRect();
    if (last.width) flips.push(anim(canvas, [{ transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }], { duration: T(650) }));
  }
  // 3 · the Command Centre panels return; the interface becomes interactive
  const blocks = viewBlocks(view);
  if (fast) clearAnims(blocks);
  else blocks.forEach((b, i) => flips.push(anim(b, [{ opacity: 0, transform: "translateY(14px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: T(420), delay: T(120 + i * 22) })));
  html.classList.remove("mc-mode");
  mark("exit core home");
  await settle(flips, fast ? 0 : T(820) + 80);
  clearAnims([...blocks, canvas]);
  await navDone;
  teardown();
  html.classList.remove("mc-activating", "mc-initialising", "mc-active", "mc-deactivating", "mc-goc");
  hideBanner(0);
  mark("exit done");
  const t = $("#pageTitle"); if (t && prevTitle) t.textContent = prevTitle;
}
function teardown() {
  for (const id of ALL_PANELS) panelEl(id)?.querySelector(".mc-body")?.__map?.destroy?.();
  goc?.destroy(); goc = null; gocP = null; resetGocMounted();
  root?.remove(); root = null;
  navEl?.remove(); navEl = null;
  coreCanvas = null;
  section = "globalops";
}
/** Interface settings (Settings → Interface): transitions on/off and speed, sounds, reduced effects. */
function iface(ctx) {
  const s = ctx?.settings?.interface || {};
  const speed = { fast: 0.7, normal: 1, slow: 1.4 }[s.transitionSpeed] || 1;
  return { instant: s.transitions === false || reduced(), speed, reducedEffects: !!s.reducedEffects };
}
function playTransitionSound(kind, ctx) {
  const s = ctx?.settings?.interface || {};
  if (s.sound === false || s.silent) return;
  sounds.configureUi({ enabled: true, volume: s.soundVolume ?? 0.5, reduced: !!s.reducedSound });
  sounds.unlockUi().then((st) => { if (st === "playing") (kind === "enter" ? sounds.mcEnter : sounds.mcExit)(); }).catch(() => {});
}

// ---------------------------------------------------------------- Building blocks of the transformation
function viewBlocks(view) {
  if (view.querySelector(".cc")) return [...view.querySelectorAll(".cc-left > *, .cc-right > *, .cc-centre > :not(.core-stage), .core-stage > :not(canvas)")];
  return [...view.children];
}
function animateOut(blocks, T = (ms) => ms) {
  const cx = innerWidth / 2;
  return blocks.map((b, i) => {
    const r = b.getBoundingClientRect(), mid = r.left + r.width / 2;
    const dir = mid < cx - 60 ? -1 : mid > cx + 60 ? 1 : 0;
    return anim(b, [{ opacity: 0.55, transform: "scale(.985)" }, { opacity: 0, transform: `translate(${dir * 60}px, ${dir ? 0 : 24}px) scale(.94)` }], { duration: T(320), delay: T(Math.min(i * 14, 140)), easing: "cubic-bezier(.5,0,.75,0)" });
  });
}
async function navSwap(toMission, instant = false, T = (ms) => ms) {
  const nav = $("#nav");
  if (!navEl) return;
  const from = toMission ? nav : navEl, to = toMission ? navEl : nav;
  if (!instant) await settle([...from.children].map((e, i) => anim(e, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-26px)" }], { duration: T(200), delay: T(Math.min(i * 8, 120)), easing: "ease-in" })), instant ? 0 : T(320) + 60);
  from.hidden = true; to.hidden = false;
  clearAnims([...from.children]);
  if (!instant) await settle([...to.children].map((e, i) => anim(e, [{ opacity: 0, transform: "translateX(-26px)" }, { opacity: 1, transform: "none" }], { duration: T(280), delay: T(Math.min(i * 18, 260)) })), instant ? 0 : T(540) + 60);
  clearAnims([...to.children]);
}
function energyPulse(at, T = (ms) => ms) {
  const r = at?.getBoundingClientRect?.() || { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const size = Math.max(220, Math.min(r.width, r.height) * 0.8);
  const ring = Object.assign(document.createElement("div"), { className: "mc-pulse" });
  ring.style.cssText = `left:${r.left + r.width / 2 - size / 2}px;top:${r.top + r.height / 2 - size / 2}px;width:${size}px;height:${size}px`;
  const flash = Object.assign(document.createElement("div"), { className: "mc-flash" });
  document.body.append(flash, ring);
  const a = anim(ring, [{ transform: "scale(.3)", opacity: 0.7 }, { transform: "scale(2.6)", opacity: 0 }], { duration: T(900), easing: "cubic-bezier(.1,.6,.2,1)" });
  const b = anim(flash, [{ opacity: 0 }, { opacity: 0.6, offset: 0.25 }, { opacity: 0 }], { duration: T(800), easing: "ease-out" });
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
    run("Connecting public flight data", async () => {
      const g = await gocMounted; if (!g) return { state: "bad", detail: "Global Operations display didn't start" };
      const r = (await g.ready).flights;
      if (!r) return { state: "warn", detail: "flight layer off" };
      return r.ok ? { state: "ok", detail: `${r.n.toLocaleString("en-GB")} aircraft visible · ${r.source}` } : { state: "warn", detail: `unavailable — ${r.error}` };
    }),
    run("Retrieving global events", async () => {
      const g = await gocMounted; if (!g) return { state: "bad", detail: "Global Operations display didn't start" };
      const r = (await g.ready).events;
      if (!r?.ok) return { state: "warn", detail: `unavailable — ${r?.error || "no response"}` };
      const pv = Object.values(r.providers).filter((p) => p.configured), live = pv.filter((p) => p.state === "operational").length;
      return { state: live === pv.length ? "ok" : live ? "warn" : "bad", detail: `${r.n.toLocaleString("en-GB")} reports · ${live} of ${pv.length} sources live` };
    }),
    run("Loading operational overview", async () => {
      const [h, n, a] = await Promise.all([FETCH.home(), FETCH.notif(), FETCH.activity()]);
      D.home = h; D.notif = n; D.activity = a;
      return { state: "ok", detail: `${h.events.length} event${h.events.length === 1 ? "" : "s"} · ${h.tasks.overdue.length} overdue · ${h.tasks.dueToday.length} due today · ${n.unread} unread` };
    }),
  ];
}
async function showChecks(checks) {
  const out0 = { ok: 0, total: checks.length, issues: 0, failed: 0, lines: [] };
  if (!root) return out0;
  const list = $(".mc-init", root);
  list.hidden = false; list.innerHTML = "";
  const out = { ok: 0, total: checks.length, issues: 0, failed: 0, lines: [] };
  for (const c of checks) {
    const li = document.createElement("li");
    li.className = "pending";
    li.innerHTML = `<span class="mc-init-dot"></span><b>${esc(c.label)}</b><span class="faint">…</span>`;
    list.append(li);
    const r = await c.p;
    if (!root || !li.isConnected) { out.lines.push({ label: c.label, ...r }); if (r.state === "ok") out.ok++; else { out.issues++; if (r.state === "bad") out.failed++; } continue; }
    li.className = r.state; li.dataset.state = r.state;
    li.querySelector(".faint").textContent = r.detail;
    out.lines.push({ label: c.label, ...r });
    if (r.state === "ok") out.ok++; else { out.issues++; if (r.state === "bad") out.failed++; }
    renderAll();
    await wait(90);
  }
  if (!root) { out.at = new Date().toISOString(); return out; }
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
  navEl.innerHTML = `<div class="nav-group">Mission Control</div>${MC_SECTIONS.map(([id, l, ic]) => `${id === "op-blackbox" ? '<div class="nav-group">Operations</div>' : id === "overview" ? '<div class="nav-group">More</div>' : ""}<button class="nav-btn" data-mc="${id}" title="${esc(OP_NAMES[id] || l)}">${icon(ic)}<span>${esc(l)}</span></button>`).join("")}
    <div class="nav-group">Mode</div><button class="nav-btn mc-exit-btn" data-mcexit title="Exit Mission Control">${icon("x")}<span>Exit Mission Control</span></button>`;
  nav.after(navEl);
  root = document.createElement("section");
  root.id = "mcView"; root.className = "mcv view-mc";
  root.setAttribute("aria-label", "Mission Control");
  root.innerHTML = `<div class="mc-tabs" role="tablist" aria-label="Mission Control sections">${MC_SECTIONS.map(([id, l, ic]) => `<button class="mc-tab" role="tab" data-mc="${id}">${icon(ic)}<span>${esc(l)}</span></button>`).join("")}<button class="mc-tab exit" data-mcexit>${icon("x")}<span>Exit</span></button></div>
    <div class="mc-goc" hidden></div>
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
  html.classList.toggle("mc-goc", isGoc(sec));
  if (isGoc(sec)) {
    root.dataset.layout = "goc"; root.dataset.section = sec;
    $(".mc-goc", root).hidden = false; $(".mc-grid", root).hidden = true;
    for (const p of $$(".mc-grid > [data-panel]", root)) if (p.dataset.panel !== "core") { p.hidden = true; p.style.gridArea = ""; p.classList.remove("expanded"); }
    $$("[data-mc]").forEach((b) => { const on = b.dataset.mc === sec; b.classList.toggle("active", on); if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    const t = $("#pageTitle"); if (t) t.textContent = `Mission Control · ${OP_NAMES[sec] || sectionLabel(sec)}`;
    return;
  }
  $(".mc-goc", root).hidden = true; $(".mc-grid", root).hidden = false;
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
async function setSection(sec) {
  if (!root || !MC_SECTIONS.some((s) => s[0] === sec) || (sec === section && root.dataset.section === sec)) return;
  if (isGoc(sec) || isGoc(section)) {
    const was = section;
    applyLayout(sec);
    if (isGoc(sec)) { await ensureGoc(CTX, sec); goc?.setMode(sec); }
    placeCore();
    if (!isGoc(sec)) { renderAll(); load(neededKeys()).then(renderAll); }
    const shown = isGoc(sec) ? [goc?.root].filter(Boolean) : $$("[data-panel]", root).filter((x) => !x.hidden);
    if (isGoc(sec) !== isGoc(was)) settle(shown.map((p) => anim(p, [{ opacity: 0, transform: "scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 380 }))).then(() => clearAnims(shown));
    scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
    return;
  }
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

// ---------------------------------------------------------------- Global Operations
function ensureGoc(ctx, mode) {
  if (gocP) return gocP;
  const host = $(".mc-goc", root);
  gocP = mountGoc(host, ctx, { mode }).then((g) => { goc = g; gocMountedResolve(g); return g; }).catch((e) => { gocMountedResolve(null); host.innerHTML = `<p class="mc-empty">Global Operations couldn't start: ${esc(e.message)}</p>`; throw e; });
  return gocP;
}
/** The core panel lives in the Global Operations left column, or first in the panel grid for the other sections. */
function placeCore() {
  const cp = panelEl("core"); if (!cp) return;
  const slot = $(".mc-core-slot", cp), cv = hostCanvas();
  if (slot && cv && cv.parentNode !== slot) slot.append(cv);
  if (isGoc(section) && goc) { if (cp.parentNode !== goc.coreHost) goc.coreHost.append(cp); cp.style.gridArea = ""; }
  else { const grid = $(".mc-grid", root); if (cp.parentNode !== grid) grid.prepend(cp); cp.style.gridArea = FOCUS[section] ? `side${FOCUS[section].side.indexOf("core") + 1}` : "core"; }
  cp.hidden = false;
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
    // Global Operations reads diagnostics itself; the panel views only need them when they're on screen.
    setInterval(() => { if (!isGoc(section)) load(["diag"]).then(() => ["overview", "arch", "diag", "procs"].forEach(renderPanel)); }, 20_000),
    setInterval(() => { if (CTX?.desktop && visibleIds().includes("procs")) load(["awareness"]).then(() => renderPanel("procs")); }, 15_000),
    setInterval(() => { if (!isGoc(section)) load(neededKeys().filter((k) => !["perf", "diag", "awareness"].includes(k))).then(renderAll); }, 60_000),
    setInterval(() => { renderPanel("overview"); renderPanel("ops"); renderPanel("personal"); coreCtl()?.setPalette?.("mission"); }, 30_000),
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
