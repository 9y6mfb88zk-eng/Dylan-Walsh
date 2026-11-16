// Calendar: day / week / month views, recurring events, search, and Google Calendar (changes to Google need a yes).
import { api } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, zonedToISO, zonedParts, addDaysStr, debounce, DAYS } from "../util.js";

let view = "week", anchor = null, CTX = null, events = [], google = null;
const tzOf = () => CTX.settings.timezone || "Europe/Nicosia";
const todayStr = () => zonedParts(new Date().toISOString(), tzOf()).date;
const dowOf = (ds) => new Date(ds + "T12:00:00Z").getUTCDay();
const evDate = (e) => (e.all_day ? String(e.start).slice(0, 10) : zonedParts(e.start, tzOf()).date);

export async function render(root, ctx, params = {}) {
  CTX = ctx;
  anchor = anchor || todayStr();
  if (params.error) toast(params.error, 7000);
  if (params.connected === "google") toast("Google Calendar connected.");
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Calendar</h2><p id="calRange"></p></div>
    <div class="row wrap"><div class="seg" id="views">${["day", "week", "month"].map((v) => `<button data-v="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div>
      <button class="icon-btn" id="prev" aria-label="Previous">${icon("chevronLeft")}</button><button class="btn small ghost" id="today">Today</button><button class="icon-btn" id="next" aria-label="Next">${icon("chevron")}</button>
      <input class="inp" id="q" placeholder="Search events" style="width:180px"><button class="btn small primary" id="add">${icon("plus")}Event</button></div></div>
    <div id="results"></div><div id="cal" class="panel"></div>
    <article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">Google Calendar</span></div><div id="gcal"></div></article>`;
  $$("[data-v]", root).forEach((b) => b.onclick = () => { view = b.dataset.v; load(); });
  $("#prev", root).onclick = () => { anchor = step(-1); load(); };
  $("#next", root).onclick = () => { anchor = step(1); load(); };
  $("#today", root).onclick = () => { anchor = todayStr(); load(); };
  $("#add", root).onclick = () => edit({ date: anchor });
  $("#q", root).oninput = debounce(search, 250);
  await load();
}
export function refresh(e) { if (e.includes("*") || e.includes("calendar")) load(); }

function step(dir) {
  if (view === "day") return addDaysStr(anchor, dir);
  if (view === "week") return addDaysStr(anchor, 7 * dir);
  const [y, m] = anchor.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + dir, 1)); return t.toISOString().slice(0, 10);
}
function range() {
  if (view === "day") return [anchor, addDaysStr(anchor, 1)];
  if (view === "week") { const s = addDaysStr(anchor, -((dowOf(anchor) + 6) % 7)); return [s, addDaysStr(s, 7)]; }
  const first = anchor.slice(0, 8) + "01"; const s = addDaysStr(first, -((dowOf(first) + 6) % 7)); return [s, addDaysStr(s, 42)];
}

async function load() {
  const [from, to] = range(), tz = tzOf();
  $$("[data-v]").forEach((b) => b.classList.toggle("active", b.dataset.v === view));
  const r = await api(`/api/calendar?from=${encodeURIComponent(zonedToISO(from, "00:00", tz))}&to=${encodeURIComponent(zonedToISO(to, "00:00", tz))}`);
  events = r.events; google = r.google;
  const el = $("#cal"); if (!el) return;
  const fmt = (ds, o) => new Date(ds + "T12:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", ...o });
  $("#calRange").textContent = view === "month" ? fmt(anchor, { month: "long", year: "numeric" }) : view === "week" ? `${fmt(from, { day: "numeric", month: "short" })} – ${fmt(addDaysStr(to, -1), { day: "numeric", month: "short", year: "numeric" })}` : fmt(anchor, { weekday: "long", day: "numeric", month: "long" });
  if (view === "month") drawMonth(el, from); else drawWeek(el, from, view === "day" ? 1 : 7);
  drawGoogle();
}

function chip(e) { return `<div class="cal-ev ${e.source === "google" ? "google" : ""}" data-ev="${e.id}" data-occ="${esc(e.start)}" title="${esc(e.title)}">${e.all_day ? "" : `${zonedParts(e.start, tzOf()).time} `}${esc(e.title)}${e.recurring ? " ↻" : ""}</div>`; }
function drawMonth(el, from) {
  const today = todayStr(), month = anchor.slice(0, 7);
  let html = `<div class="cal-month">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="dow">${d}</div>`).join("")}`;
  for (let i = 0; i < 42; i++) {
    const ds = addDaysStr(from, i), evs = events.filter((e) => evDate(e) === ds);
    html += `<div class="cal-day ${ds.slice(0, 7) !== month ? "other" : ""} ${ds === today ? "today" : ""}" data-day="${ds}"><span class="n">${+ds.slice(8)}</span>${evs.slice(0, 3).map(chip).join("")}${evs.length > 3 ? `<span class="faint" style="font-size:11px">+${evs.length - 3} more</span>` : ""}</div>`;
  }
  el.innerHTML = html + "</div>";
  wire(el);
}
function drawWeek(el, from, days) {
  const tz = tzOf(), today = todayStr(), START = 6, END = 24, PX = 48;
  const cols = Array.from({ length: days }, (_, i) => addDaysStr(from, i));
  el.innerHTML = `<div class="scroll-x"><div class="cal-week" style="grid-template-columns:56px repeat(${days},minmax(${days === 1 ? 260 : 110}px,1fr))">
    <div class="colhead"></div>${cols.map((ds) => `<div class="colhead ${ds === today ? "today" : ""}">${DAYS[dowOf(ds)]} ${+ds.slice(8)}<div style="text-transform:none;letter-spacing:0;font-weight:400">${events.filter((e) => e.all_day && evDate(e) === ds).map(chip).join("")}</div></div>`).join("")}
    <div class="hours" style="height:${(END - START) * PX}px">${Array.from({ length: END - START }, (_, h) => `<div class="h" style="top:${h * PX}px">${String(START + h).padStart(2, "0")}:00</div>`).join("")}</div>
    ${cols.map((ds) => `<div class="col" data-day="${ds}" style="min-height:${(END - START) * PX}px">${Array.from({ length: END - START }, (_, h) => `<div style="position:absolute;left:0;right:0;top:${h * PX}px;border-top:1px solid rgba(103,205,255,.05)"></div>`).join("")}
      ${events.filter((e) => !e.all_day && evDate(e) === ds).map((e) => { const s = zonedParts(e.start, tz).time, en = zonedParts(e.end, tz); const sm = +s.slice(0, 2) * 60 + +s.slice(3), em = en.date === ds ? +en.time.slice(0, 2) * 60 + +en.time.slice(3) : 24 * 60; const top = Math.max(0, (sm - START * 60) / 60 * PX), h = Math.max(22, (em - Math.max(sm, START * 60)) / 60 * PX); return `<div class="cal-block ${e.source === "google" ? "google" : ""}" style="top:${top}px;height:${h}px" data-ev="${e.id}" data-occ="${esc(e.start)}"><b>${esc(s)}</b> ${esc(e.title)}${e.recurring ? " ↻" : ""}${e.location ? `<div class="faint">${esc(e.location)}</div>` : ""}</div>`; }).join("")}
      ${ds === today ? (() => { const n = zonedParts(new Date().toISOString(), tz).time, m = +n.slice(0, 2) * 60 + +n.slice(3); return m >= START * 60 ? `<div style="position:absolute;left:0;right:0;top:${(m - START * 60) / 60 * PX}px;height:2px;background:var(--cyan-2);box-shadow:0 0 8px var(--cyan-2)"></div>` : ""; })() : ""}</div>`).join("")}
  </div></div>`;
  wire(el);
  const now = el.querySelector(".cal-week");
  if (now) el.querySelector(".scroll-x").scrollTop = 0;
}
function wire(el) {
  $$("[data-ev]", el).forEach((c) => c.onclick = (e) => { e.stopPropagation(); edit({ event: events.find((x) => String(x.id) === c.dataset.ev && x.start === c.dataset.occ) || events.find((x) => String(x.id) === c.dataset.ev) }); });
  $$("[data-day]", el).forEach((d) => d.ondblclick = () => edit({ date: d.dataset.day }));
  $$(".cal-day[data-day]", el).forEach((d) => d.onclick = () => { anchor = d.dataset.day; view = "day"; load(); });
}

async function edit({ event = null, date } = {}) {
  const tz = tzOf();
  const s = event && !event.all_day ? zonedParts(event.start, tz) : null, en = event && !event.all_day ? zonedParts(event.end, tz) : null;
  const rec = event?.recurrence;
  const v = await formDialog(event ? `Edit “${event.title}”` : "New event", [
    { name: "title", label: "Title", value: event?.title || "", required: true },
    { name: "date", label: "Date", type: "date", value: event ? (event.all_day ? String(event.start).slice(0, 10) : s.date) : date, required: true },
    { name: "all_day", label: "All day", type: "checkbox", value: !!event?.all_day },
    { name: "start", label: "Starts", type: "time", value: s?.time || "09:00" },
    { name: "end", label: "Ends", type: "time", value: en?.time || "10:00" },
    { name: "location", label: "Location", value: event?.location || "" },
    { name: "notes", label: "Notes", type: "textarea", value: event?.notes || "" },
    { name: "freq", label: "Repeats", type: "select", value: rec?.freq || "", options: [["", "Doesn't repeat"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["yearly", "Yearly"]] },
    { name: "until", label: "Repeat until (optional)", type: "date", value: rec?.until || "" },
    ...(event ? [{ name: "delete", label: "Delete this event", type: "checkbox", value: false }] : []),
  ], { ok: event ? "Save" : "Create" });
  if (!v) return;
  const google = event?.source === "google";
  if (event && v.delete) {
    if (!(await confirmDialog(`Delete “${event.title}”?`, google ? "This deletes it from your Google Calendar too." : event.recurrence ? "This deletes every occurrence." : "It will be removed.", { ok: "Delete", danger: true }))) return;
    try { await api(`/api/calendar/${event.id}`, { method: "DELETE" }); toast("Deleted."); } catch (e) { toast(e.message); }
    return;
  }
  const body = {
    title: v.title, all_day: v.all_day, location: v.location, notes: v.notes,
    start: v.all_day ? v.date : zonedToISO(v.date, v.start, tz),
    end: v.all_day ? addDaysStr(v.date, 1) : zonedToISO(v.date, v.end > v.start ? v.end : v.start, tz),
    recurrence: v.freq ? { freq: v.freq, interval: 1, until: v.until || undefined } : null,
  };
  if (!v.all_day && v.end <= v.start) body.end = new Date(Date.parse(body.start) + 3600_000).toISOString();
  if (google && !(await confirmDialog("Change your Google Calendar?", `“${event.title}” lives in Google Calendar, so this change will be made there too.`, { ok: "Change it" }))) return;
  try {
    if (event) await api(`/api/calendar/${event.id}`, { method: "PATCH", body });
    else {
      const clash = await api(`/api/calendar/conflicts?start=${encodeURIComponent(body.start)}&end=${encodeURIComponent(body.end)}`).catch(() => []);
      if (!v.all_day && clash.length && !(await confirmDialog("That clashes", `It overlaps ${clash.map((c) => `“${c.title}”`).join(", ")}. Book it anyway?`, { ok: "Book anyway" }))) return;
      await api("/api/calendar", { method: "POST", body });
    }
    toast("Saved.");
  } catch (e) { toast(e.message, 6000); }
}

async function search() {
  const q = $("#q")?.value.trim(), el = $("#results"); if (!el) return;
  if (!q || q.length < 2) { el.innerHTML = ""; return; }
  const r = await api(`/api/calendar/search?q=${encodeURIComponent(q)}`);
  el.innerHTML = `<article class="panel" style="margin-bottom:14px"><div class="panel-head"><span class="label">${r.length} result${r.length === 1 ? "" : "s"}</span></div><ul class="list">${r.map((e) => `<li class="item clickable" data-jump="${esc(evDate(e))}"><div class="grow"><b>${esc(e.title)}</b><div class="meta">${esc(e.all_day ? e.start : new Date(e.start).toLocaleString("en-GB", { timeZone: tzOf(), weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))}${e.location ? ` · ${esc(e.location)}` : ""}</div></div>${e.recurrence ? '<span class="pill">repeats</span>' : ""}</li>`).join("") || '<li class="empty">Nothing found.</li>'}</ul></article>`;
  $$("[data-jump]", el).forEach((li) => li.onclick = () => { anchor = li.dataset.jump; view = "day"; load(); });
}

function drawGoogle() {
  const el = $("#gcal"); if (!el) return;
  const c = google?.connection;
  el.innerHTML = !google?.configured ? '<p class="muted" style="margin:0">Google Calendar isn\'t set up. JARVIS\'s own calendar works without it; to sync Google, add the Google client ID and secret in API keys (see the README).</p>'
    : c ? `<div class="row wrap"><span class="dot ${c.status === "active" ? "ok" : "bad"}"></span><span>${c.status === "active" ? "Connected" : esc(c.status)} · synced ${c.last_sync_at ? esc(new Date(c.last_sync_at).toLocaleString("en-GB")) : "never"}</span><button class="btn small ghost" id="gsync">Sync now</button><button class="btn small danger" id="gdis">Disconnect</button></div>${c.last_error ? `<p class="error">${esc(c.last_error)}</p>` : ""}<p class="faint" style="font-size:12px">JARVIS asks before changing or deleting anything in Google Calendar.</p>`
    : '<p class="muted">Connect Google Calendar to see and manage your Google events here.</p><button class="btn primary small" id="gcon">Connect Google Calendar</button>';
  $("#gcon", el)?.addEventListener("click", async () => { try { const { url } = await api("/api/calendar/google/connect", { method: "POST" }); if (CTX.desktop) { window.open(url, "_blank"); toast("Google's sign-in has opened in your browser. Come back here when it says connected.", 9000); } else location.href = url; } catch (e) { toast(e.message); } });
  $("#gsync", el)?.addEventListener("click", async () => { try { const r = await api("/api/calendar/google/sync", { method: "POST" }); toast(r.synced ? `Synced ${r.events} events.` : "Not connected."); } catch (e) { toast(e.message); } });
  $("#gdis", el)?.addEventListener("click", async () => { if (await confirmDialog("Disconnect Google Calendar?", "Google events are removed from JARVIS (nothing is deleted in Google).", { ok: "Disconnect", danger: true })) api("/api/calendar/google/disconnect", { method: "POST" }); });
}
