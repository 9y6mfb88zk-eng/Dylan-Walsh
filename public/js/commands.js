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
      await mission.show(ctx);
      logCommand("Mission Control activated", text);
      await say(ctx, `Mission control activated, ${t}.`, speak);
      return `Mission control activated, ${t}.`;
    }
    const was = mission.open;
    mission.hide();
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
