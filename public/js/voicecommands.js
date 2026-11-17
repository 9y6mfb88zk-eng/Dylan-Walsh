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
const MC_SECTION_WORDS = [["overview", /^(the )?(operational )?overview$/], ["globalops", /^(the )?(global operations|operations centre|operations center|global information)$/],
  ["world", /^(the )?(world explorer|world map|map|globe)$/], ["events", /^(the )?(global events|events feed|conflict tracker|war tracker)$/], ["flights", /^(the )?(flight tracking|flights|air traffic)$/],
  ["architecture", /^(the )?(system )?architecture$/], ["diagnostics", /^(the )?(system )?diagnostics?( panel)?$/], ["processes", /^(the )?(active )?processes$/], ["intelligence", /^(the )?intelligence( feed)?$|^research$/], ["comms", /^(the )?communications$|^comms$/],
  ["projects", /^(the |my )?projects$/], ["personal", /^(the |my )?personal operations$/]];
const REGION_WORDS = { cyprus: "cyprus", europe: "europe", mediterranean: "mediterranean", "middle east": "middleeast", "north america": "northamerica", "south america": "southamerica", africa: "africa", "south asia": "southasia", "east asia": "eastasia", oceania: "oceania", uk: "uk", "united kingdom": "uk", britain: "uk" };
const EVENT_WORDS = { "global events": null, conflict: "conflict", conflicts: "conflict", war: "conflict", wars: "conflict", "war tracker": "conflict", "armed conflict": "conflict", "armed conflicts": "conflict", "natural disaster": "disaster", "natural disasters": "disaster", disaster: "disaster", disasters: "disaster", ceasefire: "ceasefire", ceasefires: "ceasefire", protest: "unrest", protests: "unrest", "civil unrest": "unrest", "humanitarian emergencies": "humanitarian" };
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
  // Mission Control operations.
  m = t.match(/^(?:initiate|open|start|launch|activate|engage|begin|go to|switch to|show)(?: the)? operation (blackbox|black box|wayfinder|way finder|sentinel|orbit)$/) || t.match(/^operation (blackbox|black box|wayfinder|way finder|sentinel|orbit)$/);
  if (m) return { kind: "op", op: m[1].replace(/\s+/g, ""), action: "open" };
  if (/^(track|show|find|where is)(?: me)? the (international space station|iss)( now)?$/.test(t) || /^track the iss$/.test(t)) return { kind: "op", op: "orbit", action: "iss" };
  if (/^(show|display|what'?s|what is|check)(?: me)?(?: the)? (current |latest )?space weather( now| today)?$/.test(t)) return { kind: "op", op: "orbit", action: "spaceweather" };
  if (/^(show|display|list)(?: me)?(?: the)? (upcoming |next )?(rocket )?launches$/.test(t)) return { kind: "op", op: "orbit", action: "launches" };
  if (/^(show|display|list|open)(?: me)?(?: the)? (available )?(public )?(city )?(web ?cams|webcams|cameras)$/.test(t)) return { kind: "op", op: "sentinel", action: "webcams" };
  if (/^(show|open|display)(?: me)?(?: my)? (sentinel )?watchlists?$/.test(t)) return { kind: "op", op: "sentinel", action: "watchlists" };
  if (/^(show|open)(?: me)? the latest global events$/.test(t) || /^(show|open)(?: me)? the latest (world )?news events$/.test(t)) return { kind: "goc", action: "events", category: null };
  if (/^(generate|create|compile|show|give me|run)(?: me)?(?: a| the)? (global )?situation report$/.test(t) || /^(global )?sitrep$/.test(t)) return { kind: "goc", action: "sitrep" };
  // Global Operations: flight tracking and events. Places other than the region presets go to the AI (it geocodes them).
  if (/^(hide|turn off|switch off|disable|stop) (the )?(flight tracking|aircraft|flights|air traffic)$/.test(t)) return { kind: "goc", action: "flights_hide" };
  if (/^(show|turn on|switch on|enable|start) (the )?(flight tracking|aircraft|flights)$/.test(t)) return { kind: "goc", action: "flights_show" };
  if (/^(zoom out to|show me|show|go to|return to) (the )?(worldwide|world|global) (air traffic|flight|flights|aircraft)( map| view)?$/.test(t) || /^zoom out to (the )?(worldwide|global) (view|map)$/.test(t)) return { kind: "goc", action: "flights_world" };
  if (/^(select|show me|find|pick|highlight) (the )?nearest (visible )?(aircraft|plane|flight)$/.test(t)) return { kind: "goc", action: "nearest" };
  m = t.match(/^(?:show(?: me)?|display|view)(?: the)?(?: commercial| civil| public)? (?:aircraft|air traffic|flights|planes)(?: flying)? (?:around|over|near|in|above) (?:the )?(cyprus|europe|the mediterranean|mediterranean|middle east|north america|south america|africa|south asia|east asia|oceania|uk|united kingdom|britain)$/);
  if (m) return { kind: "goc", action: "flights_area", region: REGION_WORDS[m[1].replace(/^the /, "")] };
  m = t.match(/^(?:find|track|locate|show me|follow)(?: flight| the flight| aircraft)? ([a-z]{2,3} ?\d{1,4}[a-z]?|[a-z0-9]{1,2}-[a-z0-9]{3,5})$/);
  if (m && /\d/.test(m[1])) return { kind: "goc", action: "flights_find", query: m[1].replace(/\s+/g, "").toUpperCase() };
  m = t.match(/^(?:show(?: me)?|display|open)(?: the)? (global events|conflicts?|wars?|war tracker|armed conflicts?|natural disasters?|disasters?|ceasefires?|protests?|civil unrest|humanitarian emergencies)$/);
  if (m) return { kind: "goc", action: "events", category: EVENT_WORDS[m[1]] ?? null };
  if (/^(full |complete )?(system )?status report$/.test(t) || /^are all systems (operational|online|working)$/.test(t)) return { kind: "diagnostics", level: /^(full|complete)/.test(t) ? "full" : "quick" };
  return null;
}
