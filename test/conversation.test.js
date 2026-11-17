// JARVIS 6.8 — natural conversation: personality delivery rules, conversational context (follow-ups, interruptions),
// speech text, phrases, voice commands and voice settings. Unit tests plus the real backend against stand-in services.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startMock } from "./mock-upstream.js";
import { startServer, Device, sleep, waitFor } from "./helpers.js";
import { titleHint, recentOpenings, summariseArgs, toolTrace } from "../server/services/dialogue.js";
import { speakable } from "../public/js/speech-text.js";
import { phrase } from "../public/js/phrases.js";
import { localCommand } from "../public/js/voicecommands.js";

// ---------------------------------------------------------------- Unit
test("“Sir” stays occasional: the hint appears only after recent use, and follows the setting", () => {
  assert.equal(titleHint(["Good evening.", "Done."], "Sir", "occasionally"), "");
  assert.match(titleHint(["Very good, Sir.", "Done."], "Sir", "occasionally"), /don't use it in this one/);
  assert.equal(titleHint(["Very good, Sir."], "Sir", "often"), "", "often: always allowed");
  assert.match(titleHint([], "Sir", "never"), /at all/);
  assert.match(titleHint(["a", "b", "c", "Right, Sir."], "Sir", "rarely"), /don't use it/);
  assert.match(titleHint(["Of course, Madam."], "Madam", "occasionally"), /"Madam"/, "uses the user's own title");
});

test("recent openings are reported so replies don't all start the same way", () => {
  assert.deepEqual(recentOpenings(["Not bad at all, really.", "Not bad at all, again.", "Quite a bit, actually."]), ["Not bad at", "Quite a bit"]);
});

test("tool trace: what JARVIS looked up, newest first, with readable arguments", () => {
  assert.equal(summariseArgs({ place: "Larnaca", days: 3, empty: "", list: [], obj: { a: 1 } }), "place=Larnaca, days=3");
  const trace = toolTrace([{ tools: [{ name: "calendar_list", args: "from=2026-11-18" }] }, null, { tools: [{ name: "get_weather", args: "place=Larnaca" }] }]);
  assert.deepEqual(trace, ["last reply: get_weather(place=Larnaca)", "3 replies ago: calendar_list(from=2026-11-18)"]);
});

test("speech text: symbols, money, links and markdown are made speakable; pronunciations apply as whole words", () => {
  assert.equal(speakable("It's 21°C — mainly clear [1]."), "It's 21 degrees, mainly clear.");
  assert.equal(speakable("You spent £12.50 on food & £1 on tea (approx. 40% of it)."), "You spent 12 pounds 50 on food and 1 pound on tea (approximately 40 percent of it).");
  assert.equal(speakable("**Bold** and a [link](https://x.org) and https://example.com"), "Bold and a link and");
  assert.equal(speakable("- first\n- second"), "first. second");
  const prons = [{ from: "Dhekelia", to: "Deh-kay-lia" }];
  assert.equal(speakable("Dhekelia, then Dhekelias.", { pronunciations: prons }), "Deh-kay-lia, then Dhekelias.");
});

test("phrases: never the same line twice running; the title only as often as allowed", () => {
  let r = 0; const rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const lines = Array.from({ length: 30 }, () => phrase("end", { rand }));
  for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i].replace(/, Sir/, ""), lines[i - 1].replace(/, Sir/, ""), `repeated: ${lines[i]}`);
  const never = Array.from({ length: 20 }, () => phrase("stay", { frequency: "never", rand }));
  assert.ok(never.every((l) => !/Sir/.test(l)));
  const occ = Array.from({ length: 30 }, () => phrase("stay", { frequency: "occasionally", rand }));
  const withTitle = occ.filter((l) => /Sir/.test(l)).length;
  assert.ok(withTitle >= 1 && withTitle <= 10, `occasional title: ${withTitle}/30`);
  for (let i = 1; i < occ.length; i++) assert.ok(!(/Sir/.test(occ[i]) && /Sir/.test(occ[i - 1])), "never twice in a row");
});

test("conversation commands: stop/end/standby, stay, listen, repeat, slower, faster, be brief — and real requests pass through", () => {
  const cases = { "Stop listening.": "end", "End conversation": "end", "Go back to standby": "end", "Stay with me": "stay", "Listen again": "listen", "Repeat that": "repeat",
    "Speak more slowly.": "slower", "Slow down please": "slower", "Could you speak a bit faster?": "faster", "Normal speed": "normalSpeed", "Be brief.": "brief", "Keep it short": "brief",
    "Wait.": "hush", "Hang on": "hush", "Wait, explain that again": null, "What about the weekend?": null, "Brief me on today": null };
  for (const [t, want] of Object.entries(cases)) assert.equal(localCommand(t), want, t);
});

// ---------------------------------------------------------------- Backend
let mock, srv, laptop;
const TTS_DIR = process.env.JARVIS_TEST_TTS_DIR || "";
before(async () => {
  mock = await startMock();
  srv = await startServer(mock, TTS_DIR ? { JARVIS_TTS_DIR: TTS_DIR, ELEVENLABS_API_KEY: "", OPENAI_API_KEY: "" } : {});
  laptop = new Device(srv.base, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JARVIS-Desktop/6.8 Electron/33");
  assert.equal((await laptop.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "correct horse battery" } })).status, 201);
});
after(async () => { await srv?.stop(); mock?.server.close(); });

async function stream(body, { abortAfter = null } = {}) {
  const ac = new AbortController();
  const res = await fetch(srv.base + "/api/chat/stream", { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", cookie: laptop.cookie, "x-jarvis": "1" }, body: JSON.stringify(body) });
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "", text = "", done = null;
  try {
    for (;;) {
      const { value, done: end } = await reader.read(); if (end) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const l = buf.slice(0, i).split("\n").find((x) => x.startsWith("data: ")); buf = buf.slice(i + 2);
        if (!l) continue; const ev = JSON.parse(l.slice(6));
        if (ev.type === "delta") text += ev.text; if (ev.type === "done") done = ev;
        if (abortAfter && text.split(/\s+/).length >= abortAfter) { ac.abort(); return { text, aborted: true }; }
      }
    }
  } catch (e) { if (e.name !== "AbortError") throw e; }
  return { text, done };
}
const lastSystem = () => JSON.stringify(mock.log.anthropic.at(-1).system);
const lastMessages = () => mock.log.anthropic.at(-1).messages;

test("the personality prompt carries the natural speaking rules (no stock phrases, direct, varied)", async () => {
  await stream({ text: "Hello there", clientId: "c-hello" });
  const sys = lastSystem();
  for (const re of [/No preamble, no \\"Certainly\\"/, /Use contractions/, /don't open replies the same way/, /Tone illustrations/, /roughly one reply in three/]) assert.match(sys, re);
  assert.match(sys, /Truthfulness rules/, "truthfulness rules unchanged");
});

test("follow-ups keep context: what was looked up last turn is given to the next turn", async () => {
  await stream({ text: "What's the weather tomorrow?", clientId: "c-w1" });
  await stream({ text: "What about the weekend?", clientId: "c-w2" });
  assert.match(lastSystem(), /What you looked up recently in this conversation[^"]*last reply: get_weather/);
  const msgs = lastMessages();
  assert.ok(msgs.some((m) => m.role === "user" && /weather tomorrow/.test(m.content)), "earlier turn is in the history");
});

test("“Sir” rule: after a reply that used it, the next turn is told not to", async () => {
  await stream({ text: "Tell me a long story", clientId: "c-s1" });   // the stand-in reply says "Sir"
  await stream({ text: "Brilliant.", clientId: "c-s2" });
  assert.match(lastSystem(), /You called the user \\"Sir\\" (once|\d times) in your last/);
  assert.match(lastSystem(), /Your recent replies began/);
});

test("interrupting a reply stops generation, keeps only what was produced, and the next turn knows what was heard", async () => {
  const before = mock.log.anthropicAborted || 0;
  const r = await stream({ text: "Tell me a very long story", clientId: "c-int1" }, { abortAfter: 12 });
  assert.ok(r.aborted && r.text.length > 20);
  await waitFor(() => (mock.log.anthropicAborted || 0) > before, 5000);
  assert.ok((mock.log.anthropicAborted || 0) > before, "the AI request was cancelled, not left running");
  const heard = r.text.split(/\s+/).slice(0, 8).join(" ");
  const mark = await laptop.call("/api/chat/interrupted", { method: "POST", body: { clientId: "c-int1", heard } });
  assert.equal(mark.data.ok, true);
  const conv = (await laptop.call("/api/conversations")).data.current;
  const msgs = (await laptop.call(`/api/conversations/${conv}/messages`)).data;
  const reply = msgs.find((m) => m.role === "assistant" && /Once upon a time there was a laptop/.test(m.content));
  assert.ok(reply, "the partial reply was saved");
  assert.ok(reply.content.length < 300, "only the part produced before the interruption");
  assert.match(reply.meta, /"interrupted":true/);
  await stream({ text: "Wait, explain that again", clientId: "c-int2" });
  assert.match(lastSystem(), /The user interrupted your last reply\. They heard only: \\"Once upon a time/);
  const hist = lastMessages();
  const prior = hist.filter((m) => m.role === "assistant").at(-1);
  assert.match(prior.content, /…$/, "history shows what was heard, ending in an ellipsis");
});

test("“be brief” for the rest of a conversation reaches the AI", async () => {
  await stream({ text: "What's happening around the world?", clientId: "c-b1", session: { brief: true } });
  assert.match(lastSystem(), /keep answers brief for now/);
});

test("short remarks skip the memory search; memory is still searched for real questions", async () => {
  await stream({ text: "What was that business idea of mine?", clientId: "c-m1" });
  assert.match(lastSystem(), /Memories relevant to this message/);
  await stream({ text: "Brilliant.", clientId: "c-m2" });
  assert.doesNotMatch(lastSystem(), /Memories relevant to this message/);
});

test("voice and personality settings are validated", async () => {
  assert.equal((await laptop.call("/api/settings", { method: "PATCH", body: { personality: { sir: "always" } } })).status, 400);
  assert.equal((await laptop.call("/api/settings", { method: "PATCH", body: { voice: { provider: "acme" } } })).status, 400);
  const ok = await laptop.call("/api/settings", { method: "PATCH", body: { personality: { sir: "rarely" }, voice: { speed: 3, volume: 0.4, pronunciations: [{ from: "Dhekelia", to: "Deh-kay-lia" }, { from: "", to: "x" }] }, memory: { saveSummaries: "yes" } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.personality.sir, "rarely");
  assert.equal(ok.data.voice.speed, 1.3, "speed clamped");
  assert.equal(ok.data.voice.volume, 0.4);
  assert.deepEqual(ok.data.voice.pronunciations, [{ from: "Dhekelia", to: "Deh-kay-lia" }]);
  assert.equal(ok.data.memory.saveSummaries, false, "only an explicit true turns summaries-as-memories on");
  await stream({ text: "Hello again", clientId: "c-r1" });
  assert.match(lastSystem(), /one reply in five at most/);
  await laptop.call("/api/settings", { method: "PATCH", body: { personality: { sir: "occasionally" }, voice: { speed: 1, volume: 1 } } });
});

test("the session reports which voices can actually be used", async () => {
  const s = (await laptop.call("/api/session")).data;
  assert.ok(Array.isArray(s.ttsProviders) && s.ttsProviders.includes("auto") && s.ttsProviders.includes("browser"));
  if (!TTS_DIR) assert.ok(!s.ttsProviders.includes("piper"), "the local voice isn't offered when it isn't installed");
});

test("local voice (Piper): synthesises speakable WAV, honours speed, and is preferred when no premium key is set", { skip: !TTS_DIR || !fs.existsSync(TTS_DIR) ? "set JARVIS_TEST_TTS_DIR to the Piper model folder" : false }, async () => {
  const s = (await laptop.call("/api/session")).data;
  assert.ok(s.ttsProviders.includes("piper"));
  assert.equal(s.tts, "piper", "automatic choice without premium keys");
  const say = async (body) => { const r = await fetch(srv.base + "/api/tts", { method: "POST", headers: { "content-type": "application/json", cookie: laptop.cookie, "x-jarvis": "1" }, body: JSON.stringify(body) }); return { ok: r.ok, type: r.headers.get("content-type"), buf: Buffer.from(await r.arrayBuffer()) }; };
  const a = await say({ text: "Always good to hear." });
  assert.ok(a.ok); assert.equal(a.type, "audio/wav"); assert.equal(a.buf.toString("ascii", 0, 4), "RIFF");
  const slow = await say({ text: "Quite a bit, actually. A few developments are worth a look.", speed: 0.8 });
  const normal = await say({ text: "Quite a bit, actually. A few developments are worth a look.", speed: 1 });
  assert.ok(slow.buf.length > normal.buf.length * 1.05, `slower speech is longer (${slow.buf.length} vs ${normal.buf.length})`);
});
