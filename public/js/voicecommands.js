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
