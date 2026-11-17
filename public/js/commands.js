// Interface commands carried out on this device: Mission Control, voice modes, narrated diagnostics and command
// macros. Spoken lines about the system always come from the real diagnostic result the server just produced.
import { api } from "./api.js";
import { voice } from "./voice.js";
import { core } from "./corestate.js";
import { mission } from "./mission.js";

const title = (ctx) => ctx.settings.profile?.title || "Sir";
const MODE_LINES = {
  standard: (t) => `Standard mode, ${t}.`,
  cinematic: (t) => `Cinematic mode engaged, ${t}.`,
  concise: () => "Concise mode.",
  professional: (t) => `Professional mode enabled, ${t}.`,
  focus: (t) => `Focus mode, ${t}. I'll keep interruptions to a minimum.`,
};
const SECTION_LINES = { overview: "Operational overview", globalops: "Global operations on screen", world: "World Explorer on screen", events: "Global events on screen", flights: "Flight tracking on screen", architecture: "System architecture on screen", diagnostics: "Diagnostics on screen", processes: "Active processes on screen", intelligence: "Intelligence feed on screen", comms: "Communications on screen", projects: "Projects on screen", personal: "Personal operations on screen" };
const LEVEL_LABEL = { quick: "quick diagnostics", full: "full system diagnostics", voice: "voice diagnostics", ai: "AI diagnostics", network: "network diagnostics", security: "security diagnostics", performance: "performance diagnostics", hardware: "hardware diagnostics", integrations: "integration diagnostics" };

/** Say (and caption) one line. Resolves when spoken, immediately when speech is off. */
async function say(ctx, text, speak) {
  ctx.caption(text);
  if (speak) await voice.speakShort(text);
}
const logCommand = (summary, text) => api("/api/activity/command", { method: "POST", body: { summary, text } }).catch(() => {});

export async function handleUi(cmd, ctx, { speak = true, text = "" } = {}) {
  const t = title(ctx);
  if (cmd.kind === "mission") {
    if (cmd.on) {
      const already = mission.phase === "active" || mission.phase === "activating";
      const r = await mission.show(ctx);
      if (!already) logCommand("Mission Control activated", text);
      // Only services that actually initialised are claimed as ready.
      const down = (r?.lines || []).filter((l) => l.state !== "ok").map((l) => l.label.replace(/^(Connecting|Retrieving|Checking|Verifying|Loading|Establishing|Initialising) /, "").toLowerCase());
      const line = already ? `Mission control is already active, ${t}.` : !down.length && !r?.error ? `Mission Control is online, ${t}. Global operations interface ready.`
        : `Mission Control is online, ${t}. ${down.length ? `${down.length === 1 ? "One service needs" : `${down.length} services need`} attention: ${down.join(", ")}.` : "The operations display reported a problem."}`;
      await say(ctx, line, speak);
      return line;
    }
    const was = mission.open;
    await mission.hide();
    if (was) logCommand("Mission Control closed", text);
    const line = was ? `Mission control deactivated. Standing by, ${t}.` : `Mission control isn't active, ${t}.`;
    await say(ctx, line, speak);
    return line;
  }
  if (cmd.kind === "mode") {
    await api("/api/settings", { method: "PATCH", body: { personality: { mode: cmd.mode } } });
    if (ctx.session?.settings) ctx.session.settings.personality = { ...(ctx.session.settings.personality || {}), mode: cmd.mode };
    logCommand(`Voice mode: ${cmd.mode}`, text);
    const line = MODE_LINES[cmd.mode](t);
    await say(ctx, line, speak);
    return line;
  }
  if (cmd.kind === "diagnostics") return narrateDiagnostics(cmd.level, ctx, { speak });
  if (cmd.kind === "goc") return gocCommand(cmd, ctx, { speak, text });
  if (cmd.kind === "op") return opCommand(cmd, ctx, { speak, text });
  if (cmd.kind === "mcSection") {
    if (!mission.open) return null;
    mission.setSection(cmd.section);
    const line = `${SECTION_LINES[cmd.section] || "Showing that"}, ${t}.`;
    await say(ctx, line, speak);
    return line;
  }
  return null;
}

/**
 * Run a diagnostic level on the server and narrate the real result. The opening line plays while the checks run;
 * every following line describes an actual check. Interruptible ("stop") like any reply.
 */
export async function narrateDiagnostics(level, ctx, { speak = true } = {}) {
  const t = title(ctx);
  let cancelled = false;
  const prevAbort = ctx.conversation.abort;
  ctx.conversation.abort = () => { cancelled = true; voice.stop(); };
  core.tool("run_diagnostics", "start");
  try {
    const run = api("/api/diagnostics/run", { method: "POST", body: { level } });
    await Promise.all([say(ctx, `Certainly, ${t}. Initiating ${LEVEL_LABEL[level] || "diagnostics"}.`, speak), run.catch(() => {})]);
    let r;
    try { r = await run; }
    catch (e) { const line = `I couldn't complete the diagnostics, ${t}: ${e.message}`; await say(ctx, line, speak && !cancelled); return line; }
    core.tool("run_diagnostics", "done");
    if (mission.open) mission.showReport(r); else ctx.go("diagnostics", { report: r }, { push: ctx.current?.() !== "diagnostics" });
    // Full runs have many checks: healthy ones are grouped, problems are read out individually.
    const lines = r.narration.slice(1, -1);
    let spoken = lines;
    if (r.results.length > 8) {
      const ok = r.results.filter((x) => x.status === "ok").map((x) => x.label);
      const groups = [];
      for (let i = 0; i < ok.length; i += 4) { const g = ok.slice(i, i + 4); groups.push(`${g.length > 1 ? `${g.slice(0, -1).join(", ")} and ${g.at(-1)}` : g[0]}: operational.`); }
      const other = r.results.map((x, i) => [x, lines[i]]).filter(([x]) => x.status !== "ok").map(([, l]) => l);
      spoken = [...groups, ...other];
    }
    for (const line of [...spoken, r.narration.at(-1)]) {
      if (cancelled) break;
      await say(ctx, line, speak);
    }
    ctx.caption(r.narration.at(-1));
    return r.narration.join(" ");
  } finally {
    core.tool("run_diagnostics", "done"); core.clearTools?.();
    ctx.conversation.abort = prevAbort;
  }
}

/** "Start my working session" → the macro with that trigger phrase. Consequential macros go through the AI to confirm. */
export async function tryMacro(text, ctx, { speak = true } = {}) {
  const m = await api("/api/macros/match", { method: "POST", body: { text } }).catch(() => null);
  if (!m) return null;
  const t = title(ctx);
  core.tool("routine", "start");
  try {
    const r = await api(`/api/routines/${m.id}/run`, { method: "POST", body: { voice: true } });
    if (r.status === "needs_confirmation") return { needsConfirmation: true };
    if (r.status === "already_running") { const l = `"${m.name}" is already running, ${t}.`; await say(ctx, l, speak); return { reply: l }; }
    const failed = (r.output || []).filter((l) => l.startsWith("✗"));
    const line = !failed.length ? `${m.name}: complete, ${t}.` : `${m.name} finished, but ${failed.length} step${failed.length === 1 ? "" : "s"} failed: ${failed.map((l) => l.slice(2)).join("; ")}.`;
    await say(ctx, line, speak);
    return { reply: line };
  } finally { core.tool("routine", "done"); }
}

/** Global Operations voice commands: every reply describes what was actually retrieved. */
const REGION_NAME = { cyprus: "Cyprus", europe: "Europe", mediterranean: "the Mediterranean", middleeast: "the Middle East", northamerica: "North America", southamerica: "South America", africa: "Africa", southasia: "South Asia", eastasia: "East Asia", oceania: "Oceania", uk: "the UK and Ireland", world: "the world" };
async function gocCommand(cmd, ctx, { speak, text }) {
  const t = title(ctx);
  let r;
  try { r = await mission.gocCommand(cmd); } catch (e) { r = { ok: false, error: e.message }; }
  logCommand(`Global Operations: ${cmd.action}${cmd.region ? ` ${cmd.region}` : ""}${cmd.query ? ` ${cmd.query}` : ""}`, text);
  const n = (x) => Number(x || 0).toLocaleString("en-GB");
  let line;
  switch (cmd.action) {
    case "flights_hide": line = `Flight tracking hidden, ${t}.`; break;
    case "flights_show": line = `Flight tracking on, ${t}.`; break;
    case "flights_world": line = r.ok && !r.error ? `Worldwide air traffic on screen, ${t}: ${n(r.aircraft)} aircraft currently visible from ${r.source}. Coverage is incomplete.` : `I couldn't load worldwide flight data, ${t}: ${r.error}.`; break;
    case "flights_area": line = r.ok ? `${n(r.aircraft)} aircraft visible over ${REGION_NAME[cmd.region] || "that area"}, ${t}, from ${r.source}.` : `Flight data for ${REGION_NAME[cmd.region] || "that area"} isn't available right now, ${t}: ${r.error}.`; break;
    case "flights_find": line = r?.ok && r.results?.length ? `Found ${r.results[0].callsign || cmd.query}, ${t}: ${r.results[0].ground ? "on the ground" : `${n(r.results[0].alt)} feet`}${r.results[0].gs != null ? `, ${Math.round(r.results[0].gs)} knots` : ""}.` : `${cmd.query} isn't visible in the available flight data right now, ${t}.${r?.error && !/not visible/.test(r.error) ? ` ${r.error}.` : ""}`; break;
    case "nearest": line = r.ok ? `Nearest visible aircraft selected, ${t}: ${r.aircraft.callsign || r.aircraft.hex.toUpperCase()}${r.aircraft.alt != null ? ` at ${n(r.aircraft.alt)} feet` : ""}.` : `No aircraft are visible near there, ${t}.${r.error ? ` ${r.error}.` : ""}`; break;
    case "events": line = r.ok ? `${n(r.count)} ${cmd.category ? `${cmd.category} ` : ""}reports on screen, ${t}. Each links to its original source.` : `Global events aren't available right now, ${t}.`; break;
    case "sitrep": line = r.ok ? `Global situation report compiled, ${t}: ${r.sections} sections${r.problems ? `, ${r.problems} source${r.problems === 1 ? "" : "s"} unavailable` : ""}. ${r.summary ? r.summary.split(/(?<=\.)\s/)[0] : ""}` : `I couldn't compile the report, ${t}: ${r.error}.`; break;
    default: line = r.ok ? `Done, ${t}.` : `I couldn't do that, ${t}: ${r.error}.`;
  }
  await say(ctx, line, speak);
  return line;
}

const OP_TITLE = { blackbox: "Operation Blackbox", wayfinder: "Operation Wayfinder", sentinel: "Operation Sentinel", orbit: "Operation Orbit" };
async function opCommand(cmd, ctx, { speak, text }) {
  const t = title(ctx);
  let r;
  try { r = await mission.gocCommand(cmd); } catch (e) { r = { ok: false, error: e.message }; }
  logCommand(`${OP_TITLE[cmd.op]}${cmd.action && cmd.action !== "open" ? `: ${cmd.action}` : ""}`, text);
  const fmtN = (x) => Math.round(x).toLocaleString("en-GB");
  let line;
  if (!cmd.action || cmd.action === "open") line = r.ok ? `${OP_TITLE[cmd.op]} is open, ${t}.` : `I couldn't open ${OP_TITLE[cmd.op]}, ${t}.`;
  else if (cmd.action === "iss") line = r.ok ? `The International Space Station is over ${Math.abs(r.lat).toFixed(0)}° ${r.lat >= 0 ? "north" : "south"}, ${Math.abs(r.lon).toFixed(0)}° ${r.lon >= 0 ? "east" : "west"}, at about ${fmtN(r.altKm)} kilometres, ${t} — calculated from orbital elements ${r.epochAgeH} hours old.` : `I can't place the ISS right now, ${t}: ${r.error}.`;
  else if (cmd.action === "spaceweather") line = r.ok ? `Space weather, ${t}: planetary K index ${r.kp ?? "unavailable"}${r.storm ? ` — ${r.storm}` : ""}${r.flare ? `; X-ray flux ${r.flare}` : ""}. Source: NOAA.` : `Space weather data isn't available right now, ${t}.`;
  else if (cmd.action === "launches") line = `Upcoming launches on screen, ${t}. Times are as announced and often change.`;
  else if (cmd.action === "webcams") line = r.ok ? `${r.count} public cameras listed, ${t}${r.verified ? `, ${r.verified} verified live` : ", live status not yet verified"}. They're operator-published feeds, not evidence of events.` : `The webcam registry isn't available, ${t}.`;
  else if (cmd.action === "watchlists") line = `Your Sentinel watchlists, ${t}: ${r.count ?? 0}.`;
  else line = r.ok ? `Done, ${t}.` : `I couldn't do that, ${t}: ${r.error}.`;
  await say(ctx, line, speak);
  return line;
}
