import { config } from "./config.js";
import { reminders, kvGet, kvSet } from "./db.js";
import { notifyAll } from "./push.js";
import { generateIdea, briefing, brainReady } from "./brain.js";

function localParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}

export async function fireDueReminders() {
  const due = reminders.due();
  for (const r of due) {
    reminders.markFired(r.id);
    const sent = await notifyAll({ title: "Reminder, sir", body: r.text, tag: `reminder-${r.id}`, url: "/?tab=reminders", urgency: "high", kind: "reminder" });
    console.log(`[scheduler] reminder #${r.id} fired → ${sent} device(s)`);
  }
  return due.length;
}

let ideaRunning = false;
export async function runIdeaJob({ force = false } = {}) {
  if (ideaRunning || !brainReady()) return null;
  const last = kvGet("ideas.lastRun", 0);
  if (!force && Date.now() - last < config.ideasEveryMinutes * 60_000 - 5_000) return null;
  ideaRunning = true;
  kvSet("ideas.lastRun", Date.now());
  try {
    const idea = await generateIdea();
    if (idea) {
      console.log(`[scheduler] new idea #${idea.id}: ${idea.title}`);
      await notifyAll({ title: `New idea: ${idea.title}`, body: `First move: ${idea.first_move}`, tag: `idea-${idea.id}`, url: `/?tab=ideas&idea=${idea.id}`, kind: "idea" });
    }
    return idea;
  } catch (e) {
    console.warn("[scheduler] idea job failed:", e.message);
    return null;
  } finally { ideaRunning = false; }
}

export async function runBriefingJob({ force = false } = {}) {
  const { date, hm } = localParts();
  if (!force && (hm < config.briefingTime || kvGet("briefing.lastDate") === date)) return null;
  kvSet("briefing.lastDate", date);
  try {
    const b = await briefing(kvGet("lastLocation"));
    kvSet("briefing.latest", { text: b.text, at: new Date().toISOString() });
    const first = b.text.split(/(?<=[.!?])\s/)[0];
    await notifyAll({ title: "Your briefing, sir", body: first, tag: "briefing", url: "/?briefing=1", kind: "briefing" });
    return b;
  } catch (e) { console.warn("[scheduler] briefing failed:", e.message); return null; }
}

export function startScheduler() {
  const timers = [
    setInterval(() => fireDueReminders().catch((e) => console.warn("[scheduler] reminders:", e.message)), config.reminderPollSeconds * 1000),
    setInterval(() => runBriefingJob(), 60_000),
  ];
  if (config.ideasEnabled) {
    timers.push(setInterval(() => runIdeaJob(), 60_000));
    setTimeout(() => runIdeaJob(), 15_000); // first idea shortly after boot if one is due
  }
  fireDueReminders().catch(() => {});
  console.log(`[scheduler] reminders every ${config.reminderPollSeconds}s, ideas every ${config.ideasEveryMinutes}m${config.ideasEnabled ? "" : " (disabled)"}, briefing at ${config.briefingTime} ${config.timezone}`);
  return () => timers.forEach(clearInterval);
}
