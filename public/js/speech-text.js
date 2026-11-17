// Text → what a voice should actually say (JARVIS 6.8). Shared by the server voices and the browser voice. Applied to every spoken sentence, whichever voice speaks it.
// The AI is already asked to write for speech; this is the safety net for symbols, abbreviations and links that make
// any synthetic voice sound like it's reading text, plus the user's own pronunciation list (Settings → Voice).

const ABBREV = [
  [/\be\.g\.(?=\s|,|$)/gi, "for example"], [/\bi\.e\.(?=\s|,|$)/gi, "that is"], [/\betc\.(?=\s|$)/gi, "et cetera"],
  [/\bapprox\.(?=\s)/gi, "approximately"], [/\bvs\.?(?=\s)/gi, "versus"], [/\bw\/(?=\s)/gi, "with"],
  [/\bkm\/h\b/gi, "kilometres per hour"], [/\bmph\b/g, "miles per hour"], [/\bkts?\b/g, "knots"],
];
const WORD = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {string} text
 * @param {{ pronunciations?: {from: string, to: string}[] }} [opts]
 */
export function speakable(text, { pronunciations = [] } = {}) {
  let t = String(text || "");
  t = t.replace(/\[(\d+)\]/g, "")                         // citation markers
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")      // markdown links → their text
    .replace(/https?:\/\/\S+/g, "")                        // bare links are never read out
    .replace(/[*_#`>|]+/g, "")                             // markdown emphasis, headings, quotes, tables
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, "")              // list markers
    .replace(/\p{Extended_Pictographic}/gu, "");           // emoji
  for (const [re, w] of ABBREV) t = t.replace(re, w);
  // Money: "£12.50" → "12 pounds 50"; "£1,200" → "1,200 pounds"; dollars and euros likewise.
  const cur = { "£": ["pound", "pounds", "pence"], "$": ["dollar", "dollars", "cents"], "€": ["euro", "euros", "cents"] };
  t = t.replace(/([£$€])\s?(\d[\d,]*)(?:\.(\d{2}))?\b/g, (_, c, whole, frac) => {
    const [one, many] = cur[c]; const n = Number(whole.replace(/,/g, ""));
    return `${whole} ${n === 1 ? one : many}${frac && frac !== "00" ? ` ${Number(frac)}` : ""}`;
  });
  t = t.replace(/(\d)\s?°\s?C\b/g, "$1 degrees").replace(/(\d)\s?°\s?F\b/g, "$1 degrees Fahrenheit").replace(/(\d)\s?°/g, "$1 degrees")
    .replace(/(\d)\s?%/g, "$1 percent")
    .replace(/\s&\s/g, " and ")
    .replace(/\s+[—–]\s+/g, ", ");                          // dashes: a short pause
  for (const p of pronunciations || []) {
    if (!p?.from || !p?.to) continue;
    t = t.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${WORD(p.from)}(?=$|[^\\p{L}\\p{N}])`, "giu"), (m, pre) => `${pre}${p.to}`);
  }
  // Line breaks (list items, paragraphs) become sentence pauses rather than being run together.
  t = t.replace(/([^\s.!?,;:])[ \t]*\n+\s*/g, "$1. ").replace(/\s*\n+\s*/g, " ");
  return t.replace(/\s+([,.!?;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
}
