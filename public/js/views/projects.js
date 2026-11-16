import { api } from "../api.js";
import { $, $$, esc, toast, confirmDialog, formDialog } from "../util.js";

let openId = null;

export async function render(root, ctx, params = {}) {
  if (params.id) openId = Number(params.id);
  root.innerHTML = `<div class="spread" style="margin-bottom:12px"><h2 class="title">Projects</h2><button class="btn small primary" id="newP">+ Project</button></div>
    <p class="muted" style="margin-top:0">Tell JARVIS what you want to achieve (“I want to start a business”) and he will build the plan here. Ask “continue working on my website business” to pick it up later.</p>
    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.4fr)" id="pGrid"><div class="stack" id="pList"></div><div id="pDetail"></div></div>`;
  if (matchMedia("(max-width: 900px)").matches) $("#pGrid", root).style.gridTemplateColumns = "minmax(0,1fr)";
  $("#newP", root).onclick = async () => {
    const v = await formDialog("New project", [{ name: "title", label: "Title", required: true }, { name: "goal", label: "Goal", type: "textarea" }]);
    if (!v) return;
    const p = await api("/api/projects", { method: "POST", body: v }); openId = p.id; load();
  };
  await load();
}
export function refresh(e) { if (e.includes("*") || e.includes("projects") || e.includes("tasks")) load(); }

async function load() {
  const list = $("#pList"); if (!list) return;
  const ps = await api("/api/projects");
  if (!openId && ps[0]) openId = ps[0].id;
  list.innerHTML = ps.length ? ps.map((p) => `<button class="glass panel" style="text-align:left;${p.id === openId ? "border-color:var(--violet-2)" : ""}" data-id="${p.id}">
    <div class="spread"><h3>${esc(p.title)}</h3><span class="pill ${p.status === "done" ? "ok" : ""}">${p.status}</span></div>
    <div class="bar" style="margin:10px 0 6px"><i style="width:${p.progress.percent}%"></i></div>
    <div class="muted" style="font-size:13px">${p.progress.done}/${p.progress.total} tasks · ${p.progress.milestonesDone}/${p.progress.milestonesTotal} milestones${p.progress.overdue ? ` · <span style="color:var(--bad)">${p.progress.overdue} overdue</span>` : ""}</div></button>`).join("")
    : '<div class="glass panel empty">No projects yet.</div>';
  $$("[data-id]", list).forEach((b) => b.onclick = () => { openId = Number(b.dataset.id); load(); });
  const p = ps.find((x) => x.id === openId);
  const d = $("#pDetail");
  if (!p) { d.innerHTML = ""; return; }
  const today = new Date().toISOString().slice(0, 10);
  const taskLi = (t) => `<li class="item prio-${t.priority} ${t.done ? "done" : ""}" data-task="${t.id}"><button class="check" aria-label="Toggle">${t.done ? "✓" : ""}</button><div class="grow"><div>${esc(t.title)}</div>${t.due ? `<div class="meta" style="${!t.done && t.due < today ? "color:var(--bad)" : ""}">${!t.done && t.due < today ? "Overdue · " : ""}${t.due}</div>` : ""}</div></li>`;
  const loose = p.tasks.filter((t) => !t.milestone_id);
  d.innerHTML = `<article class="glass panel">
    <div class="spread"><h3 style="font-size:20px">${esc(p.title)}</h3><div class="row"><select class="inp" id="pStatus" style="width:auto">${["active", "paused", "done"].map((s) => `<option ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}</select><button class="x" id="pDel" aria-label="Delete project">×</button></div></div>
    ${p.goal ? `<p class="muted">${esc(p.goal)}</p>` : ""}
    <div class="row wrap" style="margin:8px 0"><button class="btn small" id="addT">+ Task</button><button class="btn small" id="addM">+ Milestone</button><button class="btn small ghost" id="ask">Ask JARVIS for next steps</button></div>
    ${p.milestones.map((m) => `<div class="ms ${m.done ? "done" : ""}"><div class="spread"><b>${esc(m.title)}</b><label class="row" style="font-size:13px"><input type="checkbox" data-ms="${m.id}" ${m.done ? "checked" : ""}> done${m.due ? ` · ${m.due}` : ""}</label></div><ul class="list" style="margin-top:6px">${m.tasks.map(taskLi).join("") || '<li class="faint" style="font-size:13px">No tasks</li>'}</ul></div>`).join("")}
    ${loose.length ? `<div class="ms"><b>Other tasks</b><ul class="list" style="margin-top:6px">${loose.map(taskLi).join("")}</ul></div>` : ""}
    <label class="field" style="margin-top:12px"><span>Notes</span><textarea class="inp" id="pNotes">${esc(p.notes || "")}</textarea></label>
  </article>`;
  $("#pStatus").onchange = (e) => api(`/api/projects/${p.id}`, { method: "PATCH", body: { status: e.target.value } });
  $("#pNotes").onchange = (e) => api(`/api/projects/${p.id}`, { method: "PATCH", body: { notes: e.target.value } }).then(() => toast("Notes saved."));
  $("#pDel").onclick = async () => { if (await confirmDialog("Delete project?", "Its tasks will be deleted too.", { ok: "Delete", danger: true })) { await api(`/api/projects/${p.id}`, { method: "DELETE" }); openId = null; load(); } };
  $("#addT").onclick = async () => { const v = await formDialog("New task", [{ name: "title", label: "Task", required: true }, { name: "due", label: "Due", type: "date" }]); if (v) { await api("/api/tasks", { method: "POST", body: { ...v, due: v.due || null, projectId: p.id } }); load(); } };
  $("#addM").onclick = async () => { const v = await formDialog("New milestone", [{ name: "title", label: "Milestone", required: true }, { name: "due", label: "Target date", type: "date" }]); if (v) { await api(`/api/projects/${p.id}/milestones`, { method: "POST", body: v }); load(); } };
  $("#ask").onclick = () => { import("../app.js").then(({ ctx }) => { ctx.go("talk"); ctx.converse(`Continue working on my project "${p.title}". Review progress, flag anything overdue and suggest the next three priorities.`, { speak: false }); }); };
  $$("[data-ms]", d).forEach((c) => c.onchange = () => api(`/api/milestones/${c.dataset.ms}`, { method: "PATCH", body: { done: c.checked } }));
  $$("[data-task] .check", d).forEach((b) => b.onclick = async () => { const li = b.closest("[data-task]"); await api(`/api/tasks/${li.dataset.task}`, { method: "PATCH", body: { done: !li.classList.contains("done") } }); load(); });
}
