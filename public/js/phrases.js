// JARVIS's own short spoken lines (the ones said without asking the AI: "Standing by", "I'm here"…), varied so they
// never come out the same way twice running, and addressing the user by title only as often as the personality
// setting allows (Settings → Profile & personality → Form of address). Pure apart from a small memory of recent use.

const BANK = {
  end: ["Standing by.", "I'll be here.", "Very good.", "Understood. Standing by.", "Right you are."],
  stay: ["I'm here.", "Still with you.", "Go ahead.", "I'm listening."],
  again: ["Sorry, I didn't quite catch that. Could you say it again?", "I missed that, I'm afraid. Once more?", "Say that again for me?"],
  slower: ["Of course. I'll slow down.", "Slowing down.", "A little slower, then."],
  faster: ["Picking up the pace.", "I'll speed up.", "A bit quicker, then."],
  normalSpeed: ["Back to my usual pace.", "Normal speed."],
  brief: ["I'll keep it short.", "Brief it is.", "Short answers, then."],
  unbrief: ["Back to normal.", "I'll go into more detail when it helps."],
  nothingToRepeat: ["I haven't said anything yet.", "Nothing to repeat just yet."],
  muted: ["Microphone muted.", "Muted."],
};
const EVERY = { never: Infinity, rarely: 5, occasionally: 3, often: 1 };
const lastUsed = new Map();
let sinceTitle = 99;

/** Pick a line of `kind`, never the same one twice running; add the user's title only as often as allowed. */
export function phrase(kind, { title = "Sir", frequency = "occasionally", rand = Math.random } = {}) {
  const list = BANK[kind] || [kind];
  const prev = lastUsed.get(kind);
  const options = list.length > 1 ? list.filter((x) => x !== prev) : list;
  let line = options[Math.floor(rand() * options.length)];
  lastUsed.set(kind, line);
  const every = EVERY[frequency] ?? EVERY.occasionally;
  sinceTitle++;
  if (every !== Infinity && sinceTitle >= every && rand() < 0.6 && /[.?]$/.test(line) && !/\?$/.test(line)) {
    // "I'm here." → "I'm here, Sir."
    const first = line.match(/^[^.?!]+[.?!]/)[0];
    line = `${first.slice(0, -1)}, ${title}${first.slice(-1)}${line.slice(first.length)}`;
    sinceTitle = 0;
  }
  return line;
}
/** Tell the phrase picker JARVIS just used the title in an AI reply (so the next short line doesn't repeat it). */
export function noteTitleUsed(text, title = "Sir") { if (new RegExp(`\\b${title}\\b`, "i").test(String(text || ""))) sinceTitle = 0; }
export const PHRASE_KINDS = Object.keys(BANK);
