// Renders a Global Situation Report (used on screen and for the PDF). Every line shows what kind of data it is,
// where it came from and when.
import { esc } from "../util.js";

const NATURE = { live: "Live", recent: "Reported", forecast: "Forecast", "live / forecast": "Live + forecast", calculated: "Calculated", scheduled: "Scheduled", historical: "Saved research", user: "Your plan" };
export function renderReport(rep, tz, { print = false } = {}) {
  const d = rep.data, fmt = (iso) => { if (!iso) return "—"; const t = new Date(/T|Z|\+/.test(iso) ? iso : `${iso}Z`); return Number.isNaN(t.getTime()) ? String(iso) : t.toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
  return `<div class="sr ${print ? "sr-print" : ""}">
    <p class="goc-muted goc-small">Compiled ${esc(fmt(d.compiledAt))}. Each line is labelled: Live, Reported (as published), Forecast, Calculated, Scheduled, Saved research or Your plan.</p>
    ${d.summary ? `<section class="bb-sec"><h4>Executive summary</h4><p>${esc(d.summary)}</p><p class="goc-muted goc-small">${esc(d.summaryNote)}</p></section>` : ""}
    ${d.sections.map((s) => `<section class="bb-sec"><h4>${esc(s.title)}</h4><ul class="sr-items">${s.items.map((i) => `<li><span class="sr-nat n-${esc(String(i.nature).split(" ")[0])}">${esc(NATURE[i.nature] || i.nature)}</span> ${esc(i.text)}${i.place ? ` <span class="goc-muted">· ${esc(i.place)}</span>` : ""}
      <div class="goc-muted goc-small">${esc(i.source)}${i.verification ? ` · ${esc(i.verification)}` : ""} · ${esc(fmt(i.when))}${i.retrievedAt ? ` · retrieved ${esc(fmt(i.retrievedAt))}` : ""}${i.url ? ` · <a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${print ? esc(i.url) : "source ↗"}</a>` : ""}${i.detail ? ` · ${esc(i.detail)}` : ""}</div></li>`).join("")}</ul></section>`).join("")}
    ${d.problems?.length ? `<section class="bb-sec"><h4>Unavailable or degraded sources</h4><ul>${d.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></section>` : ""}
  </div>`;
}
