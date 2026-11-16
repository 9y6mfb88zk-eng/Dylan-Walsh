// Command Centre: the 3D core, a truthful greeting, voice and text input, and live panels — every figure is real.
import { api, send } from "../api.js";
import { voice } from "../voice.js";
import { core, STATE_LABEL } from "../corestate.js";
import { mountBestCore } from "../core.js";
import { $, $$, esc, gbp, fmtTime, wxIcon, icon, toast, formDialog, confirmDialog, fmtRel, debounce, statusDot } from "../util.js";

let H = null, CTX = null, coreCtl = null, briefingPending = null;

const partOfDay = (tz) => { const h = Number(new Date().toLocaleString("en-GB", { timeZone: tz, hour: "2-digit", hour12: false })); return h < 5 ? "evening" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"; };
const greet = (ctx) => `Good ${partOfDay(ctx.settings.timezone)}, ${ctx.settings.profile?.title || "Sir"}.`;
const hm = (iso, tz) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });

export async function render(root, ctx, params = {}) {
  CTX = ctx;
  const d = ctx.desktop;
  root.innerHTML = `
  <div class="cc">
    <div class="cc-col cc-left">
      <article class="panel tilt"><div class="panel-head"><span class="label">Quick commands</span></div><div class="qa" id="qa"></div></article>
      <article class="panel tilt" id="pPriorities"><div class="panel-head"><span class="label">Priorities</span></div><div class="body"><p class="empty">…</p></div></article>
      <article class="panel tilt clickable" id="pProjects" data-go="projects"><div class="panel-head"><span class="label">Projects</span>${icon("chevron")}</div><div class="body"><p class="empty">…</p></div></article>
      <article class="panel tilt" id="pActivity"><div class="panel-head"><span class="label">Recent activity</span></div><div class="body"><p class="empty">…</p></div></article>
    </div>
    <section class="cc-centre">
      <div class="core-stage"><canvas id="core" role="button" tabindex="0" aria-label="Talk to JARVIS"></canvas><div class="core-state" id="coreState">${STATE_LABEL[core.state]}</div></div>
      <h1 class="greeting" id="greet">${esc(greet(ctx))}</h1>
      <p class="subline" id="subline">JARVIS is online. Checking systems…</p>
      <p class="caption" id="caption" aria-live="polite">${d ? "Say “Hey JARVIS”, press Ctrl+Shift+Space, or tap the core." : "Tap the core or the microphone to speak."}</p>
      <div class="composer">
        <form class="pill-input" id="composer" autocomplete="off"><input id="say" placeholder="Ask JARVIS anything…" enterkeyhint="send" aria-label="Message JARVIS"><button class="icon-btn" aria-label="Send">${icon("send")}</button></form>
        <button class="mic" id="mic" aria-label="Speak to JARVIS">${icon("mic")}</button>
      </div>
      <div class="voice-ctl">
        <button class="btn small ghost" id="stopBtn">${icon("stop")}Stop speaking</button>
        ${d ? `<button class="btn small ghost" id="muteMic">${icon("micoff")}<span>Mute</span></button>` : ""}
        <button class="btn small ghost" data-go="talk">${icon("talk")}Conversation</button>
        <button class="btn small ghost" id="newConv">${icon("plus")}New topic</button>
      </div>
    </section>
    <div class="cc-col cc-right">
      <article class="panel tilt clickable" id="pWeather" data-go="world"><div class="panel-head"><span class="label">Weather</span><span class="faint" style="font-size:12px" id="wxPlace"></span></div><div class="body"><p class="empty">Fetching forecast…</p></div></article>
      <article class="panel tilt" id="pSchedule"><div class="panel-head"><span class="label">Schedule</span><button class="btn tiny ghost" data-go="calendar">Calendar</button></div><div class="body"><p class="empty">…</p></div></article>
      <article class="panel tilt" id="pAlarms"><div class="panel-head"><span class="label">Alarms</span><button class="btn tiny ghost" data-go="alarms">Alarm Centre</button></div><div class="body"><p class="empty">…</p></div></article>
      <article class="panel tilt" id="pTasks"><div class="panel-head"><span class="label">Tasks</span><button class="btn tiny ghost" data-go="tasks">All</button></div><div class="body"><p class="empty">…</p></div></article>
      <article class="panel tilt" id="pNotify"><div class="panel-head"><span class="label">Notifications</span><button class="btn tiny ghost" id="openBell">Centre</button></div><div class="body"><p class="empty">…</p></div></article>
      <article class="panel tilt clickable" id="pDiag" data-go="diagnostics"><div class="panel-head"><span class="label">Diagnostics</span><span id="diagAll"></span></div><div class="body"><p class="empty">Running checks…</p></div></article>
    </div>
  </div>`;

  // Core: 3D where possible. Clicking it talks (or interrupts).
  const anim = ctx.settings.appearance?.animation || "full";
  mountBestCore($("#core", root), { quality: ctx.settings.appearance?.quality || "auto", animation: anim }).then((c) => { const cv = $("#core", root); if (cv) { coreCtl = c; cv.dataset.core = c.kind; cv.dataset.tier = c.tier || ""; } else c.destroy(); });
  const offCore = core.on((s) => { const l = $("#coreState", root); if (l) { l.textContent = STATE_LABEL[s] || s; l.className = `core-state ${s}`; } $("#mic", root)?.classList.toggle("live", s === "listening"); });
  const offCap = ctx.onCaption((t, user) => { const c = $("#caption", root); if (!c) return; c.textContent = t || ""; c.classList.toggle("user", !!user); });

  const talk = () => {
    if (briefingPending) { const b = briefingPending; briefingPending = null; return speakBriefing(b); }
    ctx.listen();
  };
  $("#core", root).addEventListener("click", talk);
  $("#core", root).addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); talk(); } });
  $("#mic", root).addEventListener("click", talk);
  $("#composer", root).addEventListener("submit", (e) => {
    e.preventDefault(); voice.ensureAudio();
    const v = $("#say", root).value.trim(); if (!v) return;
    $("#say", root).value = "";
    ctx.converse(v);
  });
  $("#stopBtn", root).addEventListener("click", () => { ctx.conversation.interrupt(); ctx.conversation.endSession(); });
  $("#muteMic", root)?.addEventListener("click", () => ctx.desktop.setMuted(!ctx.agent?.muted));
  $("#newConv", root).addEventListener("click", async () => { await api("/api/conversations", { method: "POST" }); ctx.caption(`Fresh start, ${ctx.settings.profile?.title || "Sir"}. What shall we tackle?`); });
  $("#openBell", root).addEventListener("click", () => document.querySelector("#bellBtn").click());
  root.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g && !e.target.closest("button:not([data-go]), input, .item")) ctx.go(g.dataset.go); });
  quickCommands(root, ctx);

  await load(root);
  const tick = setInterval(() => { const g = $("#greet", root); if (g) g.textContent = greet(ctx); drawCountdowns(root); }, 30_000);
  const diagT = setInterval(() => drawDiag(root), 15_000);
  if (params.briefing) { try { briefingPending = await api(`/api/briefings/${Number(params.briefing)}`); ctx.caption(`Your ${briefingPending.kind} briefing is ready, ${ctx.settings.profile?.title || "Sir"}. Tap the core to hear it.`); } catch {} }
  return () => { offCore(); offCap(); clearInterval(tick); clearInterval(diagT); coreCtl?.destroy(); coreCtl = null; };
}

const reload = debounce(() => load(document), 400);
export function refresh(entities) {
  if (entities.includes("*") || entities.some((e) => ["tasks", "reminders", "calendar", "alarms", "notifications", "activity", "projects", "focus", "habits", "finance", "briefing", "settings", "pending", "business"].includes(e))) reload();
  if (entities.includes("health")) drawDiag(document);
}

async function load(root) {
  try { H = await api("/api/home"); } catch (e) { const s = $("#subline", root); if (s) s.textContent = e.status === 0 ? "Offline — reconnecting to JARVIS…" : e.message; return; }
  if (!$("#pWeather", root)) return;
  drawWeather(root); drawSchedule(root); drawAlarms(root); drawTasks(root); drawNotifications(root); drawPriorities(root); drawProjects(root); drawActivity(root); drawDiag(root); drawCountdowns(root);
}

function drawDiag(root) {
  const d = CTX.diag(), el = $("#pDiag .body", root), sub = $("#subline", root);
  if (!el) return;
  const t = CTX.settings.profile?.title || "Sir";
  if (!d) { el.innerHTML = '<p class="empty">Running checks…</p>'; return; }
  const issues = d.checks.filter((c) => c.status === "error" || c.status === "warn");
  if (sub) sub.textContent = !CTX.session?.brain ? "JARVIS is online, but the AI isn't set up yet — add an Anthropic key in API keys."
    : issues.length ? `JARVIS is online. ${issues.length} system${issues.length === 1 ? " needs" : "s need"} attention.` : "JARVIS is online. All available systems are ready.";
  $("#diagAll", root).innerHTML = `<span class="pill ${d.overall === "ok" ? "ok" : d.overall === "warn" ? "warn" : "bad"}">${d.overall === "ok" ? "nominal" : d.overall === "warn" ? "check" : "fault"}</span>`;
  const pick = ["ai", "stt", "mic", "database", "network", "cpu", "ram", "storage"].map((n) => d.checks.find((c) => c.name === n)).filter(Boolean);
  el.innerHTML = `<div class="diag-mini">${pick.map((c) => `<div title="${esc(c.detail)}">${statusDot(c.status)}<span>${esc(c.label.replace(" (Anthropic)", ""))}${c.value != null ? ` · ${c.value}%` : ""}</span></div>`).join("")}</div>
    ${issues.length ? `<p class="muted" style="font-size:12px;margin:8px 0 0">${esc(issues[0].label)}: ${esc(issues[0].detail)}</p>` : ""}`;
  void t;
}

function drawWeather(root) {
  const el = $("#pWeather .body", root), w = H.weather;
  if (!w) { el.innerHTML = `<p class="muted">Weather unavailable${H.weatherError ? `: ${esc(H.weatherError)}` : ""}.</p>`; return; }
  $("#wxPlace", root).textContent = w.place;
  const c = w.current, t = w.today, hhmm = (s) => (s ? s.slice(11, 16) : "—");
  el.innerHTML = `<div class="wx-now"><span class="ico">${wxIcon(c.code, c.isDay)}</span><div><div class="big glowtext">${c.temp}${w.unitTemp}</div><div class="muted" style="font-size:13px">${esc(c.summary)} · feels ${c.feels}${w.unitTemp}</div></div></div>
    <div class="wx-meta"><div><b>${t.low}–${t.high}°</b>today</div><div><b>${t.uv ?? "—"}</b>UV index</div><div><b>${c.wind}</b>${w.unitWind} wind</div><div><b>${hhmm(t.sunrise)}</b>sunrise</div><div><b>${hhmm(t.sunset)}</b>sunset</div><div><b>${t.rain ?? "—"}%</b>rain chance</div></div>
    <div class="wx-days">${w.daily.slice(1, 6).map((d) => `<div><b>${new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short" })}</b>${wxIcon(d.code)}<div class="num">${d.high}°<span class="faint"> ${d.low}°</span></div></div>`).join("")}</div>
    <p class="faint" style="font-size:11px;margin:8px 0 0">${esc(w.source)} · updated ${esc(fmtTime(w.fetchedAt))}</p>`;
}

function drawSchedule(root) {
  const el = $("#pSchedule .body", root), tz = H.timezone;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const todays = H.events.filter((e) => (e.all_day ? e.start : new Date(e.start).toLocaleDateString("en-CA", { timeZone: tz })) === today);
  const next = H.nextEvent;
  el.innerHTML = `${next ? `<div class="item" style="margin-bottom:8px;border-color:var(--edge-2)"><div class="grow"><div class="label" style="margin-bottom:3px">Next appointment</div><b>${esc(next.title)}</b><div class="meta">${esc(new Date(next.start).toLocaleString("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" }))}${next.location ? ` · ${esc(next.location)}` : ""}</div></div><span class="pill info" data-count="${esc(next.start)}">${esc(fmtRel(next.start))}</span></div>` : ""}
    ${todays.length ? `<div class="feed">${todays.map((e) => `<div class="ev"><time>${e.all_day ? "all day" : hm(e.start, tz)}</time><div>${esc(e.title)}${e.location ? `<div class="faint" style="font-size:12px">${esc(e.location)}</div>` : ""}</div></div>`).join("")}</div>` : `<p class="muted" style="margin:0">Nothing else scheduled today.</p>`}`;
}

function drawAlarms(root) {
  const el = $("#pAlarms .body", root), a = H.alarms, tz = H.timezone;
  if (a.ringing.length) { el.innerHTML = `<div class="banner">⏰ ${esc(a.ringing[0].label)} is ringing.</div>`; return; }
  el.innerHTML = a.next ? `<div class="spread"><div><div class="big glowtext mono">${hm(a.next.at, tz)}</div><div class="muted" style="font-size:13px">${esc(a.next.label)} · ${esc(new Date(a.next.at).toLocaleDateString("en-GB", { timeZone: tz, weekday: "long" }))}</div></div><span class="pill info" data-count="${esc(a.next.at)}">${esc(fmtRel(a.next.at))}</span></div>
      ${a.upcoming.filter((x) => x.at !== a.next.at).slice(0, 3).map((x) => `<div class="spread faint" style="font-size:12.5px;margin-top:6px"><span>${esc(x.label)}${x.snoozed ? " (snoozed)" : ""}</span><span class="mono">${esc(new Date(x.at).toLocaleString("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" }))}</span></div>`).join("")}`
    : `<p class="muted" style="margin:0 0 8px">No alarms set.</p><button class="btn small" id="quickAlarm">${icon("plus")}Set an alarm</button>`;
  $("#quickAlarm", el)?.addEventListener("click", () => alarmDialog());
}

function drawTasks(root) {
  const el = $("#pTasks .body", root), t = H.tasks;
  const list = [...t.overdue, ...t.dueToday, ...t.open.filter((x) => !t.overdue.some((o) => o.id === x.id) && !t.dueToday.some((o) => o.id === x.id))].slice(0, 6);
  el.innerHTML = list.length ? `<ul class="list">${list.map((x) => `<li class="item"><button class="check" data-done="${x.id}" aria-label="Complete ${esc(x.title)}"></button><div class="grow"><div class="t">${esc(x.title)}</div><div class="meta">${x.due ? (t.overdue.some((o) => o.id === x.id) ? `<span style="color:var(--bad)">overdue · ${esc(x.due)}</span>` : `due ${esc(x.due)}`) : esc(x.category || "")}</div></div>${x.priority === 1 ? '<span class="pill p1">high</span>' : ""}</li>`).join("")}</ul>
    <p class="faint" style="font-size:12px;margin:8px 0 0">${t.total} open · ${t.overdue.length} overdue · ${H.reminders.length} reminder${H.reminders.length === 1 ? "" : "s"} coming up${H.reminders[0] ? ` (next: ${esc(H.reminders[0].text)} ${esc(fmtRel(H.reminders[0].due_at))})` : ""}</p>`
    : `<p class="muted" style="margin:0">No open tasks. ${H.reminders.length ? `Next reminder: ${esc(H.reminders[0].text)} ${esc(fmtRel(H.reminders[0].due_at))}.` : ""}</p>`;
  $$("[data-done]", el).forEach((b) => b.onclick = async () => { b.classList.add("on"); await api(`/api/tasks/${b.dataset.done}`, { method: "PATCH", body: { done: true } }); toast("Done."); });
}

function drawNotifications(root) {
  const el = $("#pNotify .body", root), n = H.notifications;
  el.innerHTML = n.latest.length ? `<div class="feed">${n.latest.slice(0, 5).map((x) => `<div class="ev"><time>${esc(new Date(x.created_at).toLocaleTimeString("en-GB", { timeZone: H.timezone, hour: "2-digit", minute: "2-digit" }))}</time><div>${x.read_at ? "" : '<span class="dot live" style="margin-right:6px"></span>'}${esc(x.title)}</div></div>`).join("")}</div>${n.unread ? `<p class="faint" style="font-size:12px;margin:8px 0 0">${n.unread} unread</p>` : ""}` : '<p class="muted" style="margin:0">All quiet.</p>';
}

function drawPriorities(root) {
  const el = $("#pPriorities .body", root), items = [];
  for (const p of H.pending) items.push(`<li class="item" style="border-color:rgba(251,191,36,.4)"><div class="grow"><div>${esc(p.summary)}</div><div class="meta">Waiting for your confirmation</div></div><button class="btn tiny primary" data-pend="${esc(p.id)}" data-d="confirm">Yes</button><button class="btn tiny ghost" data-pend="${esc(p.id)}" data-d="reject">No</button></li>`);
  for (const t of H.tasks.overdue.slice(0, 3)) items.push(`<li class="item"><span class="dot bad"></span><div class="grow"><div>${esc(t.title)}</div><div class="meta">overdue since ${esc(t.due)}</div></div></li>`);
  for (const t of H.tasks.open.filter((x) => x.priority === 1 && !H.tasks.overdue.some((o) => o.id === x.id)).slice(0, 3)) items.push(`<li class="item"><span class="dot warn"></span><div class="grow"><div>${esc(t.title)}</div><div class="meta">high priority${t.due ? ` · due ${esc(t.due)}` : ""}</div></div></li>`);
  if (H.business.followUps) items.push(`<li class="item clickable" data-go="business"><span class="dot live"></span><div class="grow">${H.business.followUps} client follow-up${H.business.followUps === 1 ? "" : "s"} due</div></li>`);
  if (H.business.overdueInvoices) items.push(`<li class="item clickable" data-go="business"><span class="dot bad"></span><div class="grow">${H.business.overdueInvoices} overdue invoice${H.business.overdueInvoices === 1 ? "" : "s"}</div></li>`);
  const openHabits = H.habits.filter((h) => h.frequency === "daily" && !h.doneToday);
  if (openHabits.length) items.push(`<li class="item clickable" data-go="goals"><span class="dot"></span><div class="grow"><div>Habits left today</div><div class="meta">${openHabits.map((h) => esc(h.name)).join(", ")}</div></div></li>`);
  if (H.focus.active) items.push(`<li class="item clickable" data-go="focus"><span class="dot live"></span><div class="grow"><div>Focus: ${esc(H.focus.active.label)}</div><div class="meta">${Math.ceil(H.focus.active.remainingSeconds / 60)} min left</div></div></li>`);
  if (H.money && !H.money.connected) {} else if (H.money?.connected) items.push(`<li class="item clickable" data-go="money"><span class="dot ok"></span><div class="grow"><div>${gbp(H.money.projected)} projected to month end${H.money.testData ? ' <span class="pill test">TEST DATA</span>' : ""}</div><div class="meta">≈ ${gbp(H.money.perDay)} a day · available ${gbp(H.money.available)}</div></div></li>`);
  el.innerHTML = items.length ? `<ul class="list">${items.join("")}</ul>` : `<p class="muted" style="margin:0">Nothing pressing. A rare luxury, ${esc(CTX.settings.profile?.title || "Sir")}.</p>`;
  $$("[data-pend]", el).forEach((b) => b.onclick = async () => { try { const r = await api(`/api/pending/${b.dataset.pend}`, { method: "POST", body: { decision: b.dataset.d } }); toast(r.status === "done" ? "Done — confirmed." : "Cancelled."); } catch (e) { toast(e.message); } });
}

function drawProjects(root) {
  const el = $("#pProjects .body", root);
  el.innerHTML = H.projects.length ? `<div class="stack" style="gap:10px">${H.projects.map((p) => `<div><div class="spread" style="font-size:13.5px"><span class="clip">${esc(p.title)}</span><span class="num faint">${p.progress.percent}%</span></div><div class="bar" style="margin-top:5px"><i style="width:${p.progress.percent}%"></i></div>${p.progress.overdue ? `<div class="faint" style="font-size:11.5px;color:var(--bad)">${p.progress.overdue} overdue</div>` : ""}</div>`).join("")}</div>` : '<p class="muted" style="margin:0">No active projects. Say “I want to start…” and JARVIS will plan one.</p>';
}

function drawActivity(root) {
  const el = $("#pActivity .body", root);
  el.innerHTML = H.activity.length ? `<div class="feed">${H.activity.slice(0, 8).map((a) => `<div class="ev"><time>${esc(new Date(a.at).toLocaleTimeString("en-GB", { timeZone: H.timezone, hour: "2-digit", minute: "2-digit" }))}</time><div style="font-size:12.5px">${esc(a.summary)}</div></div>`).join("")}</div>` : '<p class="muted" style="margin:0">Nothing yet today.</p>';
}

function drawCountdowns(root) { $$("[data-count]", root).forEach((el) => { el.textContent = fmtRel(el.dataset.count); }); }

// ---------------------------------------------------------------- Quick commands (each one performs a real action)
function quickCommands(root, ctx) {
  const d = ctx.desktop;
  const cmds = [
    ["briefing", "Morning briefing", () => runBriefing("morning")],
    ["alarm", "Set alarm", () => alarmDialog()],
    ["focus", "Focus 25 min", async () => { await api("/api/focus/start", { method: "POST", body: { minutes: ctx.settings.focus?.workMinutes || 25, label: "Focus" } }); toast("Focus session started."); }],
    ["tasks", "Add task", () => taskDialog()],
    ["calendar", "Today's schedule", () => ctx.converse("What's on my schedule today?")],
    ["money", "Record spending", () => ctx.go("money", { record: "1" })],
    ["computer", "Open Chrome", () => computer("open_app", { app: "chrome" }), !d],
    ["download", "Screenshot", () => computer("screenshot", {}), !d],
    ["alarm", "Test alarm", async () => { await api("/api/alarms/test", { method: "POST", body: {} }); toast(d ? "Test alarm sent to this laptop." : "Test alarm sent."); }],
    ["diagnostics", "Run diagnostics", () => ctx.go("diagnostics")],
  ].filter((c) => !c[3]);
  $("#qa", root).innerHTML = cmds.map(([ic, label], i) => `<button data-q="${i}">${icon(ic)}<span>${esc(label)}</span></button>`).join("");
  $$("[data-q]", root).forEach((b) => b.onclick = async () => { b.disabled = true; try { await cmds[Number(b.dataset.q)][2](); } catch (e) { toast(e.message); } finally { b.disabled = false; } });
}
async function computer(action, args) {
  const r = await api("/api/computer", { method: "POST", body: { action, args } });
  toast(r.ok ? (action === "screenshot" ? `Screenshot saved${r.result?.file ? `: ${r.result.file}` : ""}.` : "Done.") : r.error || "The laptop couldn't do that.", 6000);
}
async function runBriefing(kind) {
  voice.ensureAudio();
  CTX.core.set("thinking", true);
  CTX.caption(`Preparing your ${kind} briefing…`);
  try { const b = await api(`/api/briefings/${kind}`, { method: "POST", body: { speak: false } }); CTX.core.set("thinking", false); await speakBriefing(b); }
  catch (e) { CTX.core.set("thinking", false); CTX.caption(e.message); }
}
async function speakBriefing(b) {
  CTX.caption(b.text);
  const sp = voice.createSpeaker(); sp.push(b.text); sp.finish(); await sp.done;
}
export async function alarmDialog(a = {}) {
  const v = await formDialog("Set an alarm", [
    { name: "time", label: "Time", type: "time", value: a.time || "07:00", required: true },
    { name: "label", label: "Label", value: a.label || "Wake up" },
    { name: "repeat", label: "Repeat", type: "select", value: a.repeat || "once", options: [["once", "Once"], ["daily", "Every day"], ["weekdays", "Weekdays"], ["weekends", "Weekends"], ["custom", "Custom days"]] },
    { name: "days", label: "Custom days", type: "days", value: a.days || [] },
  ], { ok: "Set alarm" });
  if (!v) return null;
  try { const r = await api("/api/alarms", { method: "POST", body: v }); toast(`Alarm set: ${r.next_local}.`); return r; } catch (e) { toast(e.message); return null; }
}
async function taskDialog() {
  const v = await formDialog("Add a task", [
    { name: "title", label: "Task", required: true },
    { name: "due", label: "Due date", type: "date" },
    { name: "priority", label: "Priority", type: "select", value: "2", options: [["1", "High"], ["2", "Normal"], ["3", "Low"]] },
  ], { ok: "Add" });
  if (!v) return;
  const r = await send("/api/tasks", { title: v.title, due: v.due || null, priority: Number(v.priority) });
  toast(r?.queued ? "Saved offline — it will sync when you're back online." : "Task added.");
}
void confirmDialog;
