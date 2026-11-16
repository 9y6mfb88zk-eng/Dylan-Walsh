// Time-zone aware helpers shared by alarms, reminders, routines, habits and briefings.
import { getSettings } from "../db.js";

export const userTz = () => getSettings().timezone || "Europe/Nicosia";

const fmtCache = new Map();
function partsFmt(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false }));
  return fmtCache.get(tz);
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a time zone. */
export function localParts(date = new Date(), tz = userTz()) {
  const p = Object.fromEntries(partsFmt(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, weekday: WD[p.weekday] };
}
export const pad = (n) => String(n).padStart(2, "0");
export function localDate(date = new Date(), tz = userTz()) { const p = localParts(date, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
export function localHM(date = new Date(), tz = userTz()) { const p = localParts(date, tz); return `${pad(p.h)}:${pad(p.mi)}`; }

/** The UTC instant of a local wall-clock time (handles DST; non-existent times roll forward). */
export function zonedToUtc(y, m, d, h = 0, mi = 0, tz = userTz()) {
  const target = Date.UTC(y, m - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(guess), tz);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    if (seen === target) break;
    guess += target - seen;
  }
  return new Date(guess);
}
export function fromLocal(dateStr, hm, tz = userTz()) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mi] = String(hm || "00:00").split(":").map(Number);
  return zonedToUtc(y, m, d, h, mi, tz);
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export const weekdayOf = (dateStr) => { const [y, m, d] = dateStr.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

/** Days of the week a repeat rule fires on (0 = Sunday). */
export function repeatDays(repeat, days = []) {
  switch (repeat) {
    case "daily": return [0, 1, 2, 3, 4, 5, 6];
    case "weekdays": return [1, 2, 3, 4, 5];
    case "weekends": return [0, 6];
    case "custom": return [...new Set(days.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    default: return null;
  }
}

/**
 * Next instant (after `after`) at local time `hm` on one of `days` (array of weekdays), searching 8 days ahead.
 * For days = null, the next occurrence of hm today or tomorrow.
 */
export function nextAt(hm, days, after = new Date(), tz = userTz()) {
  const today = localDate(after, tz);
  for (let i = 0; i < 9; i++) {
    const ds = addDays(today, i);
    if (days && !days.includes(weekdayOf(ds))) continue;
    const t = fromLocal(ds, hm, tz);
    if (t > after) return t;
  }
  return null;
}

/** "7 AM", "half past seven in the evening" style phrasing for speech. */
export function spokenTime(date, tz = userTz()) {
  const p = localParts(date, tz);
  const h12 = p.h % 12 || 12, ampm = p.h < 12 ? "AM" : "PM";
  if (p.mi === 0) return `${h12} ${ampm}`;
  if (p.mi === 30) return `half past ${h12} ${ampm}`;
  if (p.mi === 15) return `quarter past ${h12} ${ampm}`;
  if (p.mi === 45) return `quarter to ${(h12 % 12) + 1} ${p.h + 1 < 12 || p.h + 1 === 24 ? "AM" : "PM"}`;
  return `${h12}:${pad(p.mi)} ${ampm}`;
}
export function partOfDay(date = new Date(), tz = userTz()) {
  const h = localParts(date, tz).h;
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
export function describeLocal(date, tz = userTz()) {
  return new Date(date).toLocaleString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}
