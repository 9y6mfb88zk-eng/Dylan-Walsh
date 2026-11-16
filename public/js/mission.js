// Mission Control: an immersive, full-screen mode of the command centre. Expanded core, live system status, real
// resource telemetry, tasks, schedule, notifications, laptop processes, the live conversation and the latest
// diagnostic report. Every number on screen is measured; nothing is decorative data.
// Exit: the Exit button, Esc, or say "Exit Mission Control".
import { api } from "./api.js";
import { core, STATE_LABEL } from "./corestate.js";
import { voice } from "./voice.js";
import { mountBestCore } from "./core.js";
import { $, $$, esc, icon, statusDot, fmtTime, fmtWhen } from "./util.js";

let el = null, coreCtl = null, timers = [], offs = [], CTX = null, report = null;
const series = { cpu: [], ram: [], ai: [], lag: [] };
const MAX = 40;

export const mission = {
  get open() { return !!el; },
  async show(ctx) {
    CTX = ctx;
    if (el) return;
    document.documentElement.classList.add("mission-open");
    el = document.createElement("section");
    el.id = "mission";
    el.className = "mission";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Mission Control");
    el.innerHTML = `
      <header class="mc-top"><div class="row"><span class="logo-mark" aria-hidden="true"></span><div><div class="mc-title">MISSION CONTROL</div><div class="faint mc-sub" id="mcClock"></div></div></div>
        <div class="row"><span class="chip" id="mcOverall"><span class="dot unknown"></span>Checking…</span><button class="btn small" id="mcExit">${icon("x")}Exit Mission Control</button></div></header>
      <div class="mc-grid">
        <aside class="mc-col">
          <article class="panel mc-panel"><div class="panel-head"><span class="label">Systems</span><span class="faint" id="mcChecked"></span></div><ul class="mc-checks" id="mcChecks"><li class="faint">Running checks…</li></ul></article>
          <article class="panel mc-panel"><div class="panel-head"><span class="label">Background services</span></div><ul class="mc-checks" id="mcSvc"></ul></article>
        </aside>
        <main class="mc-centre">
          <div class="mc-core-wrap"><canvas id="mcCore" aria-label="JARVIS core"></canvas><div class="mc-ring" aria-hidden="true"></div></div>
          <div class="mc-state" id="mcState">${esc(STATE_LABEL[core.state] || "Standing by")}</div>
          <div class="mc-caption" id="mcCaption" aria-live="polite"></div>
          <div class="mc-telemetry">
            ${[["cpu", "Processor", "%"], ["ram", "Memory", "%"], ["ai", "AI latency", " ms"], ["lag", "Server response", " ms"]].map(([k, l, u]) => `<div class="mc-tile"><div class="spread"><span class="label">${l}</span><b id="mcv-${k}">—</b></div><div class="mc-spark" id="mcs-${k}" data-unit="${u}"></div></div>`).join("")}
          </div>
          <article class="panel mc-panel" id="mcReportPanel" hidden><div class="panel-head"><span class="label" id="mcReportTitle">Diagnostic report</span><span class="faint" id="mcReportMeta"></span></div><ul class="mc-checks" id="mcReport"></ul></article>
        </main>
        <aside class="mc-col">
          <article class="panel mc-panel"><div class="panel-head"><span class="label">Today</span></div><ul class="mc-list" id="mcToday"><li class="faint">Loading…</li></ul></article>
          <article class="panel mc-panel"><div class="panel-head"><span class="label">Notifications</span></div><ul class="mc-list" id="mcNotif"></ul></article>
          <article class="panel mc-panel"><div class="panel-head"><span class="label">Laptop processes</span><span class="faint" style="font-size:11px">by memory</span></div><ul class="mc-list" id="mcProc"><li class="faint">Waiting for the Windows app…</li></ul></article>
          <article class="panel mc-panel"><div class="panel-head"><span class="label">Activity</span></div><ul class="mc-list mc-feed" id="mcFeed"></ul></article>
        </aside>
      </div>`;
    document.body.append(el);
    requestAnimationFrame(() => el?.classList.add("in"));
    $("#mcExit", el).onclick = () => ctx.handleUi?.({ kind: "mission", on: false }, { speak: false }) ?? mission.hide();
    mountBestCore($("#mcCore", el), { quality: ctx.settings.appearance?.quality || "auto", animation: ctx.settings.appearance?.animation }).then((c) => { if (el) coreCtl = c; else c.destroy(); });
    offs.push(core.on((s) => { const st = $("#mcState"); if (st) st.textContent = STATE_LABEL[s] || s; }));
    offs.push(ctx.onCaption((t) => { const c = $("#mcCaption"); if (c) c.textContent = t || ""; }));
    const tick = () => { const c = $("#mcClock"); if (c) c.textContent = new Date().toLocaleString("en-GB", { timeZone: ctx.settings.timezone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
    tick();
    timers.push(setInterval(tick, 1000), setInterval(telemetry, 3000), setInterval(systems, 20_000), setInterval(processes, 15_000), setInterval(today, 60_000));
    telemetry(); systems(); today(); notifications(); feed(); processes();
    if (report) mission.showReport(report);
  },
  hide() {
    if (!el) return;
    timers.forEach(clearInterval); timers = [];
    offs.forEach((f) => f()); offs = [];
    coreCtl?.destroy?.(); coreCtl = null;
    const gone = el; el = null;
    gone.classList.remove("in");
    setTimeout(() => gone.remove(), 260);
    document.documentElement.classList.remove("mission-open");
  },
  /** Live entity changes while open. */
  refresh(entities) {
    if (!el) return;
    if (entities.some((e) => ["notifications", "*"].includes(e))) notifications();
    if (entities.some((e) => ["activity", "*"].includes(e))) feed();
    if (entities.some((e) => ["tasks", "events", "alarms", "reminders", "*"].includes(e))) today();
    if (entities.some((e) => ["health", "*"].includes(e))) systems();
  },
  showReport(r) {
    report = r;
    if (!el) return;
    $("#mcReportPanel").hidden = false;
    $("#mcReportTitle").textContent = r.label || "Diagnostic report";
    $("#mcReportMeta").textContent = `${r.results.length} checks · ${(r.durationMs / 1000).toFixed(1)} s · ${fmtTime(r.at)}`;
    $("#mcReport").innerHTML = r.results.map((x) => `<li>${statusDot(x.status)}<div><b>${esc(x.label)}</b>${x.tested ? ' <span class="pill info">tested</span>' : ""}<div class="faint">${esc(x.detail)}</div></div></li>`).join("");
  },
};

async function telemetry() {
  try {
    const p = await api("/api/performance");
    if (!el) return;
    const push = (k, v) => { if (v == null) return; series[k].push(v); if (series[k].length > MAX) series[k].shift(); };
    push("cpu", p.cpuPct); push("ram", p.ramPct); push("ai", p.ai?.medianMs); push("lag", p.lagMs + p.dbMs);
    for (const k of Object.keys(series)) {
      const s = series[k], box = $(`#mcs-${k}`), v = s.at(-1);
      $(`#mcv-${k}`).textContent = v == null ? "—" : `${Math.round(v)}${box.dataset.unit}`;
      box.innerHTML = k === "ai" && v == null ? '<div class="faint" style="font-size:11px;margin-top:8px">No AI calls in the last 24 h</div>' : spark(s, k === "cpu" || k === "ram" ? 100 : null);
    }
  } catch {}
}
function spark(values, fixedMax) {
  if (values.length < 2) return '<div class="faint" style="font-size:11px">Collecting…</div>';
  const H = 42, max = fixedMax ?? (Math.max(...values) * 1.2 || 1);
  // Newest sample on the right; history scrolls in from the left like a live trace.
  const x = (i) => ((MAX - values.length + i) / (MAX - 1)) * 100;
  const pts = values.map((v, i) => `${x(i).toFixed(2)},${(H - 2 - (Math.min(v, max) / max) * (H - 4)).toFixed(2)}`).join(" ");
  return `<svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${x(0).toFixed(2)},${H} ${pts} 100,${H}" class="fill"/><polyline points="${pts}" class="line"/></svg>`;
}
async function systems() {
  try {
    const d = await api("/api/diagnostics");
    if (!el) return;
    const n = (d.counts.error || 0) + (d.counts.warn || 0);
    $("#mcOverall").innerHTML = `<span class="dot ${d.overall === "error" ? "bad" : d.overall}"></span>${d.overall === "ok" ? "All systems operational" : `${n} item${n === 1 ? " needs" : "s need"} attention`}`;
    $("#mcChecked").textContent = fmtTime(d.at);
    const main = d.checks.filter((c) => !c.name.startsWith("svc:"));
    $("#mcChecks").innerHTML = main.map((c) => `<li title="${esc(c.detail)}">${statusDot(c.status)}<div><b>${esc(c.label)}</b><div class="faint">${esc(String(c.detail).slice(0, 90))}</div></div></li>`).join("");
    const svc = d.checks.filter((c) => c.name.startsWith("svc:"));
    $("#mcSvc").innerHTML = svc.map((c) => `<li>${statusDot(c.status)}<div><b>${esc(c.label)}</b><div class="faint">${esc(String(c.detail).slice(0, 70))}</div></div></li>`).join("") || '<li class="faint">None registered.</li>';
  } catch (e) { if (el) $("#mcChecks").innerHTML = `<li class="error">${esc(e.message)}</li>`; }
}
async function today() {
  try {
    const h = await api("/api/home");
    if (!el) return;
    const items = [
      ...(h.events || []).slice(0, 4).map((e) => `<li>${icon("calendar")}<div><b>${esc(e.title)}</b><div class="faint">${esc(fmtWhen(e.start))}</div></div></li>`),
      ...(h.alarms?.next ? [`<li>${icon("alarm")}<div><b>${esc(h.alarms.next.label || "Alarm")}</b><div class="faint">${esc(fmtWhen(h.alarms.next.at))}</div></div></li>`] : []),
      ...(h.tasks?.open || []).slice(0, 5).map((t) => `<li>${icon("tasks")}<div><b>${esc(t.title)}</b><div class="faint">${t.due ? `due ${esc(t.due)}` : "open"}${t.priority === 1 ? " · high priority" : ""}</div></div></li>`),
    ];
    $("#mcToday").innerHTML = items.join("") || '<li class="faint">Nothing scheduled. A clear horizon, Sir.</li>';
  } catch {}
}
async function notifications() {
  try {
    const n = await api("/api/notifications?limit=6");
    if (!el) return;
    $("#mcNotif").innerHTML = n.items.map((x) => `<li class="${x.read_at ? "" : "unread"}">${icon("notifications")}<div><b>${esc(x.title)}</b><div class="faint">${esc(fmtWhen(x.created_at))}</div></div></li>`).join("") || '<li class="faint">All quiet.</li>';
  } catch {}
}
async function feed() {
  try {
    const a = await api("/api/activity?limit=10");
    if (!el) return;
    $("#mcFeed").innerHTML = a.map((x) => `<li><span class="mc-time">${esc(fmtTime(/[zZ]$/.test(x.at) ? x.at : `${x.at.replace(" ", "T")}Z`))}</span><div>${esc(x.summary)}</div></li>`).join("") || '<li class="faint">No activity yet.</li>';
  } catch {}
}
async function processes() {
  if (!CTX?.desktop) { const p = el && $("#mcProc"); if (p) p.innerHTML = '<li class="faint">Open JARVIS in the Windows app to see the laptop\'s processes.</li>'; return; }
  try {
    const a = await api("/api/awareness");
    if (!el) return;
    const list = a.laptop?.topProcesses;
    $("#mcProc").innerHTML = Array.isArray(list) && list.length
      ? list.slice(0, 6).map((p) => `<li><span class="mc-time">${p.memMb} MB</span><div><b>${esc(p.name)}</b><div class="faint">${p.cpuSec != null ? `${p.cpuSec} s CPU time` : ""}</div></div></li>`).join("")
      : `<li class="faint">${esc(typeof a.laptop === "string" ? a.laptop : "Process list unavailable.")}</li>`;
  } catch (e) { if (el) $("#mcProc").innerHTML = `<li class="error">${esc(e.message)}</li>`; }
}
void $$; void voice;
