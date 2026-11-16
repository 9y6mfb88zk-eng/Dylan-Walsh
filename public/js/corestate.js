// The single source of truth for what the JARVIS core shows. Every state comes from a real event:
//   alarm       — an alarm is ringing (server or Windows agent said so)
//   offline     — the live connection to JARVIS is down
//   listening   — the microphone is capturing a command (real mic level drives the core)
//   speaking    — JARVIS is talking (real output audio drives the core)
//   researching — a web search / research tool is running
//   executing   — any other tool (alarm, task, laptop action…) is running
//   thinking    — waiting for the AI's reply
//   idle        — ready
const PRIORITY = ["alarm", "offline", "listening", "speaking", "researching", "executing", "thinking", "idle"];
const flags = { alarm: false, offline: false, listening: false, speaking: false, researching: 0, executing: 0, thinking: false };
const listeners = new Set();
let external = null;            // { level, freq } pushed by the Windows app (mic level from the always-on listener)
let externalAt = 0;
let levelSource = () => ({ level: null, freq: null });

export const core = {
  state: "idle",
  detail: "",
  get flags() { return { ...flags }; },
  /** Set a boolean flag (alarm, offline, listening, speaking, thinking). */
  set(flag, on, detail) {
    if (!(flag in flags)) return;
    flags[flag] = typeof flags[flag] === "number" ? Math.max(0, flags[flag] + (on ? 1 : -1)) : !!on;
    if (detail !== undefined) core.detail = detail;
    recompute();
  },
  /** Tools: counted, so overlapping tool calls keep the state until all have finished. */
  tool(name, phase) {
    const k = /web_search|research|world_time|get_weather/.test(name) ? "researching" : "executing";
    flags[k] = Math.max(0, flags[k] + (phase === "start" ? 1 : -1));
    if (phase === "start") core.detail = name;
    recompute();
  },
  clearTools() { flags.researching = 0; flags.executing = 0; recompute(); },
  on(fn) { listeners.add(fn); fn(core.state, core.detail); return () => listeners.delete(fn); },
  /** Where the audio level comes from (voice.js registers itself). */
  setLevelSource(fn) { levelSource = fn; },
  pushExternalLevel(level, freq) { external = { level, freq }; externalAt = performance.now(); },
  levels() {
    const own = levelSource();
    if (own.level != null) return own;
    if (external && performance.now() - externalAt < 250) return external;
    return { level: null, freq: null };
  },
};
function recompute() {
  const next = PRIORITY.find((k) => (k === "idle" ? true : !!flags[k]));
  if (next === core.state) { listeners.forEach((fn) => fn(core.state, core.detail, true)); return; }
  core.state = next;
  listeners.forEach((fn) => fn(next, core.detail));
}
export const STATE_LABEL = {
  idle: "Online", listening: "Listening", thinking: "Processing", speaking: "Speaking",
  researching: "Researching", executing: "Executing", alarm: "Alarm", offline: "Offline",
};
