// Conversation engine: streamed replies spoken sentence by sentence, interruption (barge-in), and continuous
// conversation — after one "Hey JARVIS", follow-ups need no wake word until you go quiet, say "End conversation",
// or the timeout passes. Continuous mode only runs after you activated it, and the microphone is only open while
// JARVIS is actually waiting for you (never while idle, never sent anywhere until you speak).
import { api, send, uid } from "./api.js";
import { voice } from "./voice.js";
import { core } from "./corestate.js";
import { localCommand, isHallucination, cleanCommand, uiCommand } from "./voicecommands.js";
export { localCommand, isHallucination, cleanCommand, uiCommand };

const streamListeners = new Set();
export const conversation = {
  session: null,                 // { source, stay, started }
  lastReply: "",
  ctx: null,                     // set by app.js: { caption, settings, desktop, toast }
  onStream(fn) { streamListeners.add(fn); return () => streamListeners.delete(fn); },

  /** Send one message, stream the reply, speak it as it arrives. Resolves when it has been spoken. */
  async ask(text, { viaVoice = false, speak = true } = {}) {
    const ctx = this.ctx;
    text = String(text || "").trim();
    if (!text) return null;
    // The same request twice in quick succession (a double tap, an echoed wake) runs once.
    if (this.inflight && this.inflight.text.toLowerCase() === text.toLowerCase() && Date.now() - this.inflight.at < 4000) return null;
    const flight = this.inflight = { text, at: Date.now() };
    try { return await this.askInner(text, { viaVoice, speak }); } finally { if (this.inflight === flight) this.inflight = null; }
  },
  async askInner(text, { viaVoice, speak }) {
    const ctx = this.ctx;
    voice.stop();
    // Interface commands and command macros run here, without an AI round trip.
    const ui = uiCommand(text, { missionOpen: !!ctx.mission?.open });
    const local = ui && ctx.handleUi ? { run: () => ctx.handleUi(ui, { speak, text }) }
      : ctx.tryMacro && text.split(/\s+/).length <= 8 ? await ctx.tryMacro(text, { speak }).then((m) => (m && !m.needsConfirmation ? { done: m.reply } : null)) : null;
    if (local) {
      ctx.caption(`“${text}”`, true);
      streamListeners.forEach((fn) => fn({ type: "start", text }));
      let reply;
      try { reply = local.done ?? (await local.run()) ?? ""; } catch (e) { reply = e.message; ctx.caption(reply); }
      this.lastReply = reply;
      streamListeners.forEach((fn) => fn({ type: "done", reply, sources: [], local: true }));
      return { reply, local: true };
    }
    ctx.caption(`“${text}”`, true);
    core.set("thinking", true);
    const speaker = speak ? voice.createSpeaker() : null;
    let reply = "", sources = [], failed = null, gotFirst = false;
    const clientId = uid();
    const ac = new AbortController();
    let interrupted = false;
    this.abort = () => { interrupted = true; ac.abort(); };
    streamListeners.forEach((fn) => fn({ type: "start", text }));
    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST", credentials: "same-origin", signal: ac.signal,
        headers: { "content-type": "application/json", "x-jarvis": "1" },
        body: JSON.stringify({ text, clientId, voice: viaVoice, loc: ctx.loc?.() || undefined }),
      });
      if (!res.ok || !res.body) { const j = await res.json().catch(() => ({})); throw Object.assign(new Error(j.error || `Request failed (${res.status})`), { status: res.status }); }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "delta") {
            if (!gotFirst) { gotFirst = true; core.set("thinking", false); }
            reply += ev.text; speaker?.push(ev.text); ctx.caption(reply);
            streamListeners.forEach((fn) => fn({ type: "delta", text: ev.text, reply }));
          } else if (ev.type === "tool") {
            core.tool(ev.name, ev.phase);
            if (ev.phase === "start" && !reply) ctx.caption(TOOL_CAPTION[ev.name] || "Working on it…");
          } else if (ev.type === "done") { reply = ev.reply || reply; sources = ev.sources || []; }
          else if (ev.type === "error") failed = ev.error;
        }
      }
    } catch (e) {
      if (interrupted || e.name === "AbortError") { /* barge-in: the reply was cut short on purpose */ }
      else if (e instanceof TypeError || e.status === 0) {
        // Offline: queue it (the server de-duplicates by clientId) and say so.
        const r = await send("/api/chat", { text, clientId }).catch(() => null);
        failed = r?.queued ? `You're offline, ${title(ctx)}. I'll send that as soon as we're reconnected.` : r?.reply ? null : e.message;
        if (r?.reply) reply = r.reply;
      } else failed = e.message;
    } finally {
      core.set("thinking", false); core.clearTools();
      this.abort = null;
    }
    if (interrupted) { speaker?.cancel(); streamListeners.forEach((fn) => fn({ type: "done", reply, sources, interrupted: true })); return { reply, interrupted: true }; }
    if (failed && !reply) {
      reply = failed;
      speaker?.push(`${failed}`);
    }
    this.lastReply = reply;
    ctx.caption(reply);
    streamListeners.forEach((fn) => fn({ type: "done", reply, sources, failed }));
    speaker?.finish();
    if (speaker) await speaker.done;
    return { reply, sources, failed };
  },

  /** Begin a voice session. `first` is the command already captured with the wake word, if any. */
  async startSession({ source = "tap", first = null } = {}) {
    const ctx = this.ctx;
    if (this.session) { if (first != null) this.inject(first); else this.interrupt(); return; }
    this.session = { source, stayUntil: 0 };
    ctx.desktop?.setSessionActive?.(true);
    let text = first;
    try {
      for (let turn = 0; this.session; turn++) {
        if (text == null) text = this.takeInjected();
        if (text == null) {
          const s = ctx.settings?.voice || {};
          const stayLeft = this.session.stayUntil - Date.now();
          const noSpeechMs = stayLeft > 0 ? stayLeft : Math.max((s.timeoutSec || 8) * 1000, turn === 0 && first == null ? 7000 : 0);
          text = await this.hear({ noSpeechMs });
          if (!this.session) break;
          const inj = this.takeInjected(); if (inj != null) text = inj;
          if (!text) { if (this.session.stayUntil > Date.now()) { text = null; continue; } break; }
        }
        const said = text, cmd = localCommand(said);
        text = null;
        // Unsure what was said? Ask again rather than act on a guess.
        const heard = this.lastHeard;
        if (!cmd && heard?.text === said && heard.confidence?.level === "low") {
          this.lastHeard = null;
          ctx.caption(`I heard “${said}”, but I'm not confident (${heard.confidence.reasons.join(", ")}). Could you say that again?`);
          await voice.speakShort(`Apologies, ${title(ctx)}, I didn't quite catch that. Could you say it again?`);
          continue;
        }
        if (cmd === "end") { ctx.caption(`Standing by, ${title(ctx)}.`); await voice.speakShort(`Very good, ${title(ctx)}.`); break; }
        if (cmd === "stay") { this.session.stayUntil = Date.now() + (ctx.settings?.voice?.stayWithMeSec || 120) * 1000; ctx.caption(`I'm here, ${title(ctx)}.`); await voice.speakShort(`I'm here, ${title(ctx)}.`); continue; }
        if (cmd === "listen") continue;
        if (cmd === "hush") { voice.stop(); continue; }
        if (cmd === "repeat") { ctx.caption(this.lastReply || "Nothing to repeat yet."); if (this.lastReply) await speakAll(this.lastReply); continue; }
        if (cmd === "mute") { ctx.caption(`Microphone muted, ${title(ctx)}.`); await voice.speakShort("Microphone muted."); ctx.desktop?.setMuted?.(true); break; }
        await this.ask(said, { viaVoice: true, speak: true });
        if (!(ctx.settings?.voice?.continuous ?? true)) break;
      }
    } catch (e) {
      ctx.caption(e.message); ctx.toast?.(e.message);
    } finally {
      this.endSession({ quiet: true });
    }
  },
  /** Barge-in: stop speaking/streaming and take the next words as the new request. */
  interrupt() { this.abort?.(); voice.stop(); },
  inject(text) { this.injected = text; this.interrupt(); },
  takeInjected() { const t = this.injected; this.injected = null; return t ?? null; },
  endSession({ quiet = false } = {}) {
    const had = !!this.session;
    this.session = null;
    voice.stopListening(true);
    this.ctx.desktop?.cancelListen?.();
    this.ctx.desktop?.setSessionActive?.(false);
    if (had && !quiet) { this.interrupt(); this.ctx.caption(`Standing by, ${title(this.ctx)}.`); }
    if (voice.state === "listening" || voice.state === "thinking") voice.setState("idle");
  },

  /** Capture one utterance and return its text ("" for silence). Uses the laptop's always-on audio when available. */
  async hear({ noSpeechMs = 8000 } = {}) {
    const ctx = this.ctx;
    ctx.caption("Listening…", true);
    if (ctx.desktop?.listen) {
      voice.setState("listening");
      if (ctx.settings?.voice?.chime !== false) { voice.chime(); await new Promise((r) => setTimeout(r, 450)); }  // don't record our own chime
      const deadline = Date.now() + noSpeechMs;
      // A capture can turn out to be only noise (a cough, the speakers' echo): keep listening until the timeout.
      while (this.session) {
        const left = deadline - Date.now();
        if (left < 1200) break;
        const wav = await ctx.desktop.listen({ noSpeechMs: left, maxMs: 20000 });
        if (!wav || !this.session) break;
        const text = await this.transcribe(wav);
        if (text) return text;
        voice.setState("listening"); ctx.caption("Listening…", true);
      }
      voice.setState("idle");
      return "";
    }
    voice.lastResult = null;
    const t = await voice.listen({ noSpeechMs, onPartial: (p) => ctx.caption(p || "Listening…", true) });
    if (isHallucination(t)) return "";
    // Phone/browser recordings get the same confidence check as the laptop (Safari's own recogniser gives none).
    const r = voice.lastResult;
    this.lastHeard = r && r.text === t ? { text: t, confidence: r.confidence, latencyMs: r.latencyMs, engine: r.engine } : null;
    return t;
  },
  async transcribe(wav, { partial = false } = {}) {
    voice.setState("thinking");
    core.set("thinking", true);
    try {
      const r = await api("/api/transcribe", { method: "POST", raw: new Blob([wav], { type: "audio/wav" }), headers: { "content-type": "audio/wav", ...(partial ? { "x-partial": "1" } : {}) } });
      const t = cleanCommand(r.text);
      if (isHallucination(t)) return "";
      this.lastHeard = { text: t, confidence: r.confidence, latencyMs: r.latencyMs, engine: r.engine };
      return t;
    } finally { core.set("thinking", false); if (voice.state === "thinking") voice.setState("idle"); }
  },
};

const TOOL_CAPTION = {
  web_search: "Searching the web…", start_research: "Starting the research…", get_weather: "Checking the weather…", world_time: "Checking the time there…",
  set_alarm: "Setting the alarm…", change_alarm: "Updating the alarm…", computer: "Working on your laptop…", finance: "Checking your accounts…",
  calendar_list: "Checking your calendar…", calendar_create: "Booking it…", add_task: "Adding the task…", add_reminder: "Setting the reminder…",
  record_money: "Recording that…", smart_home: "Talking to the house…", routine: "Running the routine…",
};
const title = (ctx) => ctx?.settings?.profile?.title || "Sir";
async function speakAll(text) { const sp = voice.createSpeaker(); sp.push(text); sp.finish(); await sp.done; }
voice.speakShort = (text) => speakAll(text);

