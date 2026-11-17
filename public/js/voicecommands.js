// Voice commands handled on the device (no AI round trip), the Whisper "silence" filter, and wake-word cleanup.
// Pure functions: also used by the automated tests.
const HALLUCINATION = /^\s*(\.+|you\.?|thank you\.?|thanks for watching!?|thanks\.?|bye\.?|\[[^\]]*\]|\([^)]*\)|♪+)?\s*$/i;
const COMMANDS = [
  ["end", /^(ok(ay)?[,.]?\s*)?(stop listening|end (the |this )?conversation|go back to (standby|sleep)|standby|stand by|that'?s all|that will be all|that'?ll be all|goodbye|bye( bye)?|good ?night|never ?mind|cancel|nothing|no thanks?|dismissed)( jarvis)?[.!]?$/i],
  ["stay", /^(stay with me|keep listening|stay (on|here)|don'?t go|hold on)[.!]?$/i],
  ["listen", /^(listen again|start again|try again)[.!]?$/i],
  ["hush", /^(stop|stop (speaking|talking)|quiet|be quiet|silence|shush|shut up|enough)[.!]?$/i],
  ["repeat", /^(repeat( that)?|say (that|it) again|come again|what did you (just )?say|pardon( me)?|sorry\?|what\?)[.!?]?$/i],
  ["mute", /^(mute|mute (the )?(mic|microphone)|stop the mic(rophone)?)[.!]?$/i],
];
export function localCommand(text) {
  const t = String(text || "").trim().replace(/[,]/g, "");
  for (const [kind, re] of COMMANDS) if (re.test(t)) return kind;
  return null;
}
export const isHallucination = (t) => HALLUCINATION.test(String(t || ""));

/** Remove the wake word (and fragments of it caught in the safety buffer) from the start of a command. */
export function cleanCommand(text) {
  let t = String(text || "").trim();
  t = t.replace(/^\W*(hey|hi|ok|okay)?\W*(jarvis|jervis|jarvi)\b[\s,.!?:-]*/i, "");
  t = t.replace(/^\W*(jar|jarv|arvis|vis|this|is|davis|travis|harvis|service)[.,!?]\s+(?=\S)/i, "");
  return t.trim();
}

// Interface commands handled on the device straight away (no AI round trip). Diagnostics still run on the server
// and every spoken line comes from the real result.
const LEVEL_WORDS = { quick: "quick", full: "full", complete: "full", comprehensive: "full", voice: "voice", audio: "voice", ai: "ai", "a.i.": "ai", network: "network", security: "security", performance: "performance", hardware: "hardware", integration: "integrations", integrations: "integrations" };
const MC_SECTION_WORDS = [["overview", /^(the )?(operational )?overview$/], ["global", /^(the )?(global information|world map|map|globe)$/], ["architecture", /^(the )?(system )?architecture$/],
  ["diagnostics", /^(the )?diagnostics?( panel)?$/], ["processes", /^(the )?(active )?processes$/], ["intelligence", /^(the )?intelligence( feed)?$|^research$/], ["comms", /^(the )?communications$|^comms$/],
  ["projects", /^(the |my )?projects$/], ["personal", /^(the |my )?personal operations$/]];
/** missionOpen: section names ("show system architecture") only mean something while Mission Control is open. */
export function uiCommand(text, { missionOpen = false } = {}) {
  const t = String(text || "").toLowerCase().replace(/^(hey |ok |okay )?jarvis[,.!]?\s*/, "").replace(/[,.!?]+$/g, "").replace(/\bplease\b/g, "").replace(/\s+/g, " ").trim();
  if (/^(activate|engage|enter|open|start|launch|initiate|go to|switch to) mission control( mode)?$/.test(t) || t === "mission control") return { kind: "mission", on: true };
  if (/^(exit|close|leave|deactivate|disengage|end|stop|quit) mission control( mode)?$/.test(t) || /^(stand down|exit mission mode)$/.test(t)) return { kind: "mission", on: false };
  let m = t.match(/^(?:switch to|change to|go to|use|activate|enable|engage|enter|set) (standard|normal|cinematic|concise|short|professional|focus) mode$/) || t.match(/^(standard|cinematic|concise|professional|focus) mode(?: on)?$/);
  if (m) return { kind: "mode", mode: { normal: "standard", short: "concise" }[m[1]] || m[1] };
  m = t.match(/^(?:run|perform|start|initiate|begin|do)(?: an?| the| me a)? ?(quick|full|complete|comprehensive|voice|audio|ai|a\.i\.|network|security|performance|hardware|integrations?)? ?(?:system |systems )?(?:diagnostics?|diagnostic check|systems? check|check)$/);
  if (m && (m[1] || /diagnostic/.test(t))) return { kind: "diagnostics", level: LEVEL_WORDS[m[1]] || "quick" };
  if (missionOpen) {
    const s = t.match(/^(?:show|open|go to|switch to|display|view)(?: me)? (.+)$/);
    if (s) for (const [id, re] of MC_SECTION_WORDS) if (re.test(s[1])) return { kind: "mcSection", section: id };
  }
  if (/^(full |complete )?(system )?status report$/.test(t) || /^are all systems (operational|online|working)$/.test(t)) return { kind: "diagnostics", level: /^(full|complete)/.test(t) ? "full" : "quick" };
  return null;
}
