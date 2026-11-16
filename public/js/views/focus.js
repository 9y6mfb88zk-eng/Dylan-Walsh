// Focus: Pomodoro-style sessions that finish on the server (so the end is announced even if this page is closed).
import { api } from "../api.js";
import { $, $$, esc, icon, toast, fmtWhen, barChart } from "../util.js";

let st = null, timer = null;

export async function render(root, ctx) {
  const f = ctx.settings.focus || { workMinutes: 25, breakMinutes: 5 };
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Focus</h2><p>JARVIS announces the end of each session on your laptop and phone.</p></div></div>
    <div class="grid cols-2">
      <article class="panel" style="display:grid;gap:16px;justify-items:center;padding:28px">
        <div class="focus-ring" id="ring"><div><b id="left">--:--</b><div class="label" id="what" style="margin-top:8px">Ready</div></div></div>
        <input class="inp" id="label" placeholder="What are you focusing on?" style="max-width:360px">
        <div class="row wrap" style="justify-content:center">${[15, 25, 45, 60, 90].map((m) => `<button class="btn small ${m === f.workMinutes ? "primary" : ""}" data-m="${m}">${m} min</button>`).join("")}</div>
        <div class="row wrap" style="justify-content:center"><button class="btn ghost small" id="brk">${icon("pause")}${f.breakMinutes}-min break</button><button class="btn danger small" id="stop" hidden>${icon("stop")}Stop</button><button class="btn small" id="done" hidden>${icon("check")}Finished early</button></div>
      </article>
      <div class="stack">
        <article class="panel"><div class="panel-head"><span class="label">Today</span></div><div class="grid cols-3" id="stats"></div></article>
        <article class="panel"><div class="panel-head"><span class="label">Last 7 days (minutes)</span></div><div id="chart"></div></article>
        <article class="panel"><div class="panel-head"><span class="label">History</span></div><ul class="list" id="hist"></ul></article>
      </div></div>`;
  $$("[data-m]", root).forEach((b) => b.onclick = () => start(Number(b.dataset.m), "work"));
  $("#brk", root).onclick = () => start(f.breakMinutes || 5, "break");
  $("#stop", root).onclick = async () => { await api("/api/focus/stop", { method: "POST", body: { completed: false } }); load(); };
  $("#done", root).onclick = async () => { await api("/api/focus/stop", { method: "POST", body: { completed: true } }); toast("Nicely done."); load(); };
  await load();
  timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
export function refresh(e) { if (e.includes("*") || e.includes("focus")) load(); }

async function start(minutes, kind) {
  try { await api("/api/focus/start", { method: "POST", body: { minutes, kind, label: kind === "break" ? "Break" : $("#label")?.value.trim() || "Focus" } }); load(); }
  catch (e) { toast(e.message); }
}
async function load() {
  st = await api("/api/focus");
  const a = st.active;
  if (!$("#ring")) return;
  $("#stop").hidden = !a; $("#done").hidden = !a || a.kind === "break";
  if (a) $("#label").value = a.kind === "work" ? a.label : $("#label").value;
  $("#stats").innerHTML = `<div class="stat"><b>${st.stats.today}</b><span>minutes focused</span></div><div class="stat"><b>${st.stats.completedToday}</b><span>sessions completed</span></div><div class="stat"><b>${st.stats.week}</b><span>minutes this week</span></div>`;
  $("#chart").innerHTML = barChart(st.stats.last7.map((d) => ({ label: new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short" }), value: d.minutes })), { height: 120, fmt: (v) => `${v} min` });
  $("#hist").innerHTML = st.history.slice(0, 12).map((h) => `<li class="item"><div class="grow"><div>${esc(h.label)} <span class="pill">${h.kind}</span></div><div class="meta">${esc(fmtWhen(h.started_at))} · ${h.planned_minutes} min</div></div>${h.ended_at ? `<span class="pill ${h.completed ? "ok" : ""}">${h.completed ? "completed" : "stopped"}</span>` : '<span class="pill live">running</span>'}</li>`).join("") || '<li class="empty">No sessions yet.</li>';
  tick();
}
function tick() {
  const a = st?.active, ring = $("#ring"); if (!ring) return;
  if (!a) { $("#left").textContent = "--:--"; $("#what").textContent = "Ready"; ring.style.setProperty("--p", 0); return; }
  const left = Math.max(0, Math.round((Date.parse(a.ends_at) - Date.now()) / 1000));
  $("#left").textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
  $("#what").textContent = a.kind === "break" ? "Break" : a.label;
  ring.style.setProperty("--p", (100 * (1 - left / (a.planned_minutes * 60))).toFixed(1));
  if (left === 0) setTimeout(load, 2500);
}
