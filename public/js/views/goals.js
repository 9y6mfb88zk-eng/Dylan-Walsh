// Goals (with milestones) and habits (streaks, 14-day history, optional daily reminder).
import { api } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, fmtDay } from "../util.js";

const KINDS = [["short", "Short-term"], ["long", "Long-term"], ["career", "Career"], ["financial", "Financial"], ["learning", "Learning"], ["personal", "Personal"]];

export async function render(root) {
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Goals & Habits</h2><p>Tell JARVIS “I read today” or “tick off meditation” and it updates here.</p></div>
    <div class="row wrap"><button class="btn small" id="addH">${icon("plus")}Habit</button><button class="btn small primary" id="addG">${icon("plus")}Goal</button></div></div>
    <div class="grid cols-2"><article class="panel"><div class="panel-head"><span class="label">Habits</span></div><ul class="list" id="habits"></ul></article>
    <article class="panel"><div class="panel-head"><span class="label">Goals</span></div><div class="stack" id="goals"></div></article></div>`;
  $("#addH", root).onclick = () => editHabit();
  $("#addG", root).onclick = () => editGoal();
  await load();
}
export function refresh(e) { if (e.includes("*") || e.includes("habits") || e.includes("goals")) load(); }

async function load() {
  const [hs, gs] = await Promise.all([api("/api/habits"), api("/api/goals")]);
  const H = $("#habits"); if (!H) return;
  H.innerHTML = hs.map((h) => `<li class="item" style="display:grid;gap:8px;${h.active ? "" : "opacity:.5"}"><div class="row"><button class="check ${h.doneToday ? "on" : ""}" data-check="${h.id}" aria-label="Tick ${esc(h.name)}"></button>
      <div class="grow"><b>${esc(h.name)}</b><div class="meta">${h.frequency === "daily" ? `${h.today}/${h.target} today` : `${h.thisWeek}/${h.target} this week`}${h.reminder_time ? ` · reminder ${esc(h.reminder_time)}` : ""}</div></div>
      <span class="pill ${h.streak ? "info" : ""}">${icon("fire")}${h.streak} ${h.frequency === "daily" ? "day" : "week"}${h.streak === 1 ? "" : "s"}</span><button class="btn tiny ghost" data-edith="${h.id}">${icon("edit")}</button></div>
      <div class="heat" title="Last 14 days">${h.last14.map((d) => `<i class="${d.count >= h.target ? "on" : d.count ? "part" : ""}" title="${esc(d.date)}: ${d.count}"></i>`).join("")}</div></li>`).join("") || '<li class="empty">No habits yet. Add one you want to build.</li>';
  $$("[data-check]", H).forEach((b) => b.onclick = () => api(`/api/habits/${b.dataset.check}/check`, { method: "POST", body: { delta: b.classList.contains("on") ? -1 : 1 } }));
  $$("[data-edith]", H).forEach((b) => b.onclick = () => editHabit(hs.find((h) => String(h.id) === b.dataset.edith)));
  const G = $("#goals");
  G.innerHTML = gs.map((g) => `<div class="item" style="display:grid;gap:8px"><div class="spread"><div><b>${esc(g.title)}</b> <span class="pill">${esc(KINDS.find((k) => k[0] === g.kind)?.[1] || g.kind)}</span> ${g.status !== "active" ? `<span class="pill ${g.status === "done" ? "ok" : ""}">${g.status}</span>` : ""}<div class="meta">${g.target_date ? `target ${esc(fmtDay(g.target_date))}` : "no target date"}</div></div>
      <div class="ring" style="--p:${g.progress};width:54px;height:54px"><span>${g.progress}%</span></div></div>
      ${g.description ? `<div class="muted" style="font-size:13px">${esc(g.description)}</div>` : ""}
      <ul class="list">${g.milestones.map((m) => `<li class="item" style="padding:6px 8px"><button class="check ${m.done ? "on" : ""}" data-ms="${m.id}" data-done="${m.done ? 1 : 0}"></button><div class="grow ${m.done ? "faint" : ""}">${esc(m.title)}${m.due ? ` <span class="faint">· ${esc(fmtDay(m.due))}</span>` : ""}</div><button class="x" data-delms="${m.id}" aria-label="Delete">×</button></li>`).join("")}</ul>
      <div class="row wrap"><button class="btn tiny" data-addms="${g.id}">${icon("plus")}Milestone</button>${g.milestones.length ? "" : `<button class="btn tiny ghost" data-prog="${g.id}">Set progress</button>`}<button class="btn tiny ghost" data-editg="${g.id}">${icon("edit")}Edit</button></div></div>`).join("") || '<p class="empty">No goals yet. Short, long, career, financial, learning or personal — add one.</p>';
  $$("[data-ms]", G).forEach((b) => b.onclick = () => api(`/api/goal-milestones/${b.dataset.ms}`, { method: "PATCH", body: { done: b.dataset.done !== "1" } }));
  $$("[data-delms]", G).forEach((b) => b.onclick = () => api(`/api/goal-milestones/${b.dataset.delms}`, { method: "DELETE" }));
  $$("[data-addms]", G).forEach((b) => b.onclick = async () => { const v = await formDialog("Add milestone", [{ name: "title", label: "Milestone", required: true }, { name: "due", label: "Due", type: "date" }]); if (v) api("/api/goal-milestones", { method: "POST", body: { goal_id: Number(b.dataset.addms), title: v.title, due: v.due || null } }); });
  $$("[data-prog]", G).forEach((b) => b.onclick = async () => { const g = gs.find((x) => String(x.id) === b.dataset.prog); const v = await formDialog("Progress", [{ name: "progress", label: "Progress (%)", type: "range", value: g.progress, min: 0, max: 100 }]); if (v) api(`/api/goals/${g.id}`, { method: "PATCH", body: { progress: Number(v.progress), ...(Number(v.progress) >= 100 ? { status: "done" } : {}) } }); });
  $$("[data-editg]", G).forEach((b) => b.onclick = () => editGoal(gs.find((x) => String(x.id) === b.dataset.editg)));
}

async function editHabit(h = null) {
  const v = await formDialog(h ? "Edit habit" : "New habit", [
    { name: "name", label: "Habit", value: h?.name || "", required: true, placeholder: "Read 20 pages" },
    { name: "frequency", label: "How often", type: "select", value: h?.frequency || "daily", options: [["daily", "Daily"], ["weekly", "Weekly"]] },
    { name: "target", label: "Times per day / week", type: "number", value: h?.target || 1, min: 1, max: 50 },
    { name: "reminder_time", label: "Daily reminder (optional)", type: "time", value: h?.reminder_time || "" },
    ...(h ? [{ name: "active", label: "Active", type: "checkbox", value: h.active }, { name: "delete", label: "Delete this habit", type: "checkbox", value: false }] : []),
  ]);
  if (!v) return;
  if (h && v.delete) { if (await confirmDialog("Delete this habit?", "Its history is removed too.", { ok: "Delete", danger: true })) api(`/api/habits/${h.id}`, { method: "DELETE" }); return; }
  const body = { name: v.name, frequency: v.frequency, target: Number(v.target), reminder_time: v.reminder_time || null, ...(h ? { active: v.active } : {}) };
  try { h ? await api(`/api/habits/${h.id}`, { method: "PATCH", body }) : await api("/api/habits", { method: "POST", body }); toast("Saved."); } catch (e) { toast(e.message); }
}
async function editGoal(g = null) {
  const v = await formDialog(g ? "Edit goal" : "New goal", [
    { name: "title", label: "Goal", value: g?.title || "", required: true },
    { name: "kind", label: "Type", type: "select", value: g?.kind || "personal", options: KINDS },
    { name: "description", label: "Why it matters / details", type: "textarea", value: g?.description || "" },
    { name: "target_date", label: "Target date", type: "date", value: g?.target_date || "" },
    ...(g ? [{ name: "status", label: "Status", type: "select", value: g.status, options: [["active", "Active"], ["paused", "Paused"], ["done", "Done"]] }, { name: "delete", label: "Delete this goal", type: "checkbox", value: false }] : []),
  ]);
  if (!v) return;
  if (g && v.delete) { if (await confirmDialog("Delete this goal?", "Its milestones are removed too.", { ok: "Delete", danger: true })) api(`/api/goals/${g.id}`, { method: "DELETE" }); return; }
  const body = { title: v.title, kind: v.kind, description: v.description, target_date: v.target_date || null, ...(g ? { status: v.status } : {}) };
  try { g ? await api(`/api/goals/${g.id}`, { method: "PATCH", body }) : await api("/api/goals", { method: "POST", body }); toast("Saved."); } catch (e) { toast(e.message); }
}
