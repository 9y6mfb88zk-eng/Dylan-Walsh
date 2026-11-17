// The on-device voice commands of continuous conversation, the Whisper silence filter and wake-word clean-up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localCommand, isHallucination, cleanCommand, uiCommand } from "../public/js/voicecommands.js";

test("conversation control phrases are recognised locally", () => {
  for (const t of ["Stop listening", "End conversation", "end the conversation.", "Go back to standby", "That's all", "That will be all, JARVIS", "Goodbye", "Never mind"]) assert.equal(localCommand(t), "end", t);
  assert.equal(localCommand("Stay with me"), "stay");
  assert.equal(localCommand("Listen again"), "listen");
  assert.equal(localCommand("Stop speaking"), "hush");
  assert.equal(localCommand("Stop."), "hush");
  assert.equal(localCommand("Repeat that"), "repeat");
  assert.equal(localCommand("Say that again"), "repeat");
  assert.equal(localCommand("Mute the microphone"), "mute");
});
test("ordinary requests are not mistaken for commands", () => {
  for (const t of ["Stop the alarm at seven tomorrow", "Remind me to stop by the shop", "What's the weather?", "End of month spending", "Repeat my last order from Tesco"]) assert.equal(localCommand(t), null, t);
});
test("Whisper's silence hallucinations are ignored, real speech is kept", () => {
  for (const t of ["", " ", ".", "Thank you.", "Thanks for watching!", "you", "[BLANK_AUDIO]", "(silence)"]) assert.ok(isHallucination(t), t);
  for (const t of ["Thank you, what's next?", "You there?", "Set an alarm"]) assert.ok(!isHallucination(t), t);
});
test("wake word and its fragments are removed from the start of a command", () => {
  assert.equal(cleanCommand("Hey JARVIS, what's the weather tomorrow?"), "what's the weather tomorrow?");
  assert.equal(cleanCommand("Jarvis. Set an alarm"), "Set an alarm");
  assert.equal(cleanCommand("this. What time is it?"), "What time is it?");
  assert.equal(cleanCommand("What is the weather in Jarvis Bay"), "What is the weather in Jarvis Bay");
});

test("interface commands: Mission Control, voice modes and diagnostic levels are recognised on the device", () => {
  assert.deepEqual(uiCommand("JARVIS, activate mission control"), { kind: "mission", on: true });
  assert.deepEqual(uiCommand("Exit Mission Control."), { kind: "mission", on: false });
  assert.deepEqual(uiCommand("Switch to concise mode"), { kind: "mode", mode: "concise" });
  assert.deepEqual(uiCommand("cinematic mode"), { kind: "mode", mode: "cinematic" });
  assert.deepEqual(uiCommand("Run a full system diagnostic"), { kind: "diagnostics", level: "full" });
  assert.deepEqual(uiCommand("run diagnostics"), { kind: "diagnostics", level: "quick" });
  assert.deepEqual(uiCommand("Run a security diagnostic"), { kind: "diagnostics", level: "security" });
  assert.deepEqual(uiCommand("Perform an integration check"), { kind: "diagnostics", level: "integrations" });
  assert.deepEqual(uiCommand("Status report"), { kind: "diagnostics", level: "quick" });
  assert.deepEqual(uiCommand("Are all systems operational?"), { kind: "diagnostics", level: "quick" });
  // Ordinary requests go to the AI.
  for (const t of ["Run the dishwasher", "What mode are you in?", "Start a focus session", "Check my emails", "Tell me about mission control in Houston", "run a check"]) assert.equal(uiCommand(t), null, t);
});

test("Mission Control sections can be opened by voice, but only while Mission Control is active", () => {
  assert.deepEqual(uiCommand("JARVIS, deactivate Mission Control"), { kind: "mission", on: false });
  assert.deepEqual(uiCommand("Show system architecture", { missionOpen: true }), { kind: "mcSection", section: "architecture" });
  assert.deepEqual(uiCommand("Open the world map", { missionOpen: true }), { kind: "mcSection", section: "world" });
  assert.deepEqual(uiCommand("show me personal operations", { missionOpen: true }), { kind: "mcSection", section: "personal" });
  assert.deepEqual(uiCommand("go to communications", { missionOpen: true }), { kind: "mcSection", section: "comms" });
  assert.equal(uiCommand("Show system architecture"), null, "outside Mission Control this goes to the AI");
  assert.equal(uiCommand("Show me the weather", { missionOpen: true }), null);
});

test("Global Operations voice commands: the phrases from the brief, handled instantly where no lookup is needed", () => {
  assert.deepEqual(uiCommand("JARVIS, show me aircraft around Cyprus."), { kind: "goc", action: "flights_area", region: "cyprus" });
  assert.deepEqual(uiCommand("Show me commercial air traffic over Europe"), { kind: "goc", action: "flights_area", region: "europe" });
  assert.deepEqual(uiCommand("Show me aircraft flying over the Mediterranean"), { kind: "goc", action: "flights_area", region: "mediterranean" });
  assert.deepEqual(uiCommand("Zoom out to the worldwide air traffic map"), { kind: "goc", action: "flights_world" });
  assert.deepEqual(uiCommand("Select the nearest visible aircraft"), { kind: "goc", action: "nearest" });
  assert.deepEqual(uiCommand("Hide flight tracking"), { kind: "goc", action: "flights_hide" });
  assert.deepEqual(uiCommand("Show flight tracking"), { kind: "goc", action: "flights_show" });
  assert.deepEqual(uiCommand("Find flight BA 123"), { kind: "goc", action: "flights_find", query: "BA123" });
  assert.deepEqual(uiCommand("Show me conflicts"), { kind: "goc", action: "events", category: "conflict" });
  assert.deepEqual(uiCommand("Show global events"), { kind: "goc", action: "events", category: null });
  // Needs a lookup or a place JARVIS must geocode → the AI and its global_operations tool.
  assert.equal(uiCommand("Find this flight by its callsign"), null);
  assert.equal(uiCommand("Show me aircraft around Paphos airport"), null);
  assert.equal(uiCommand("Find my keys"), null);
});
