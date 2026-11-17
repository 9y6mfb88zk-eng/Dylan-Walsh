// The one JARVIS core for the whole app.
//
// Previously the Command Centre created a core every time it was shown and destroyed it when it left, and Mission
// Control borrowed it. Leaving Mission Control by some routes therefore showed an empty centre while a new WebGL core
// was built (measured: 0.7 s gap by the Exit button, 5–6 s via the palette or browser Back).
//
// Now a single core (one canvas, one WebGL context) is created once and MOVED between places: the Command Centre's
// stage, Mission Control's core panel, or an off-screen holder when neither is on screen. Moving a canvas keeps its
// WebGL context, animation state and audio reactivity. The core pauses itself when off screen (IntersectionObserver).
import { mountBestCore, coreOptions } from "./core.js";

let canvas = null, ctl = null, ready = null, opts = null, holder = null;
const key = (o) => JSON.stringify([o.quality, o.animation, o.density, o.bloom]);

function hold() {
  if (!holder) { holder = Object.assign(document.createElement("div"), { id: "coreHold" }); holder.setAttribute("aria-hidden", "true"); holder.style.cssText = "position:fixed;left:-9999px;top:0;width:320px;height:320px;overflow:hidden;pointer-events:none"; document.body.append(holder); }
  return holder;
}
function create(o) {
  canvas = Object.assign(document.createElement("canvas"), { id: "core", tabIndex: 0 });
  canvas.setAttribute("role", "button"); canvas.setAttribute("aria-label", "Talk to JARVIS");
  hold().append(canvas);
  opts = o;
  ready = mountBestCore(canvas, o).then((c) => { ctl = c; canvas.dataset.core = c.kind; canvas.dataset.tier = c.tier || ""; return c; });
  return ready;
}

/** The shared core, created on first use. Rebuilt only when its quality settings change. */
export function ensureCore(settings) {
  const o = coreOptions(settings);
  if (canvas && opts && key(o) === key(opts)) return ready;
  if (canvas) {   // quality settings changed: a fresh core in the same place
    const parent = canvas.parentNode, next = canvas.nextSibling, old = canvas, oldCtl = ctl;
    ready?.then?.((c) => c?.destroy?.()).catch(() => {}); oldCtl?.destroy?.();
    create(o);
    if (parent && parent !== holder) parent.insertBefore(canvas, next && next.parentNode === parent ? next : null);
    old.remove();
  } else create(o);
  return ready;
}
/** Place the core as the first child of `container` (no-op if it's already there). */
export function attachCore(container, settings) {
  if (!canvas) ensureCore(settings || {});
  if (canvas.parentNode !== container) container.prepend(canvas);
  return canvas;
}
/** Park the core off screen (it stops drawing until it's placed again). */
export function parkCore() { if (canvas && canvas.parentNode !== hold()) hold().append(canvas); }
/** Draw the first frame even while parked (startup checks need proof the core renders), then park again. */
export async function warmCore(settings) {
  const c = await ensureCore(settings);
  if (canvas.parentNode !== hold()) return c;
  holder.style.left = "0px"; holder.style.opacity = "0"; holder.style.width = "64px"; holder.style.height = "64px";
  try { await Promise.race([c.firstFrame, new Promise((r) => setTimeout(r, 20000))]); }
  finally { holder.style.left = "-9999px"; holder.style.width = "320px"; holder.style.height = "320px"; }
  return c;
}
export const coreCanvas = () => canvas;
export const coreCtl = () => ctl;
export const coreReady = () => ready;
