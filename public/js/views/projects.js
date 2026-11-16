// Project workspaces: personal, business, ideas, goals and plans — milestones, tasks, progress, deadline and notes.
import { api } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, fmtDay } from "../util.js";

const KINDS = [["personal", "Personal"], ["business", "Business"], ["client", "Client"], ["idea", "Idea"], ["goal", "Goal"], ["plan", "Plan"], ["learning", "Learning"]];
let sel = null, kind = "";

export async function render(root, ctx, params = {}) {
  if (params.focus) sel = Number(params.focus);
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Projects</h2><p>Say “I want to start…” and JARVIS plans milestones and first tasks for you.</p></div><button class="btn small primary" id="add">${icon("plus")}Project</button></div>
    <div class="seg" id="kinds" style="margin-bottom:14px"><button data-k="">All</button>${KINDS.map(([k, l]) => `<button data-k="${k}">${l}</button>`).join("")}</div>
    <div class="grid" style="grid-template-columns:minmax(260px,340px) minmax(0,1fr)" id="wrap"><article class="panel"><ul class="list" id="plist"></ul></article><div id="detail"></div></div>`;
  if (ctx.isPhone()) $("#wrap", root).style.gridTemplateColumns = "minmax(0,1fr)";
  $$("[data-k]", root).forEach((b) => b.onclick = () => { kind = b.dataset.k; load(); });
  $("#add", root).onclick = () => edit();
  await load();
}
export function refresh(e) { if (e.includes("*") || e.includes("projects") || e.includes("tasks")) load(); }

async function load() {
  $$("[data-k]").forEach((b) => b.classList.toggle("active", b.dataset.k === kind));
  const all = await api("/api/projects");
  const list = all.filter((p) => !kind || p.kind === kind);
  const L = $("#plist"); if (!L) return;
  if (!sel && list[0]) sel = list[0].id;
  L.innerHTML = list.map((p) => `<li class="item clickable ${p.id === sel ? "sel" : ""}" data-p="${p.id}"><div class="grow"><div class="spread"><b class="clip">${esc(p.title)}</b><span class="faint num">${p.progress.percent}%</span></div><div class="bar" style="margin:6px 0 4px"><i style="width:${p.progress.percent}%"></i></div><div class="meta">${esc(KINDS.find((k) => k[0] === p.kind)?.[1] || p.kind)} · ${esc(p.status)}${p.deadline ? ` · due ${esc(fmtDay(p.deadline))}` : ""}${p.progress.overdue ? ` · <span style="color:var(--bad)">${p.progress.overdue} overdue</span>` : ""}</div></div></li>`).join("") || '<li class="empty">No projects here yet.</li>';
  $$("[data-p]", L).forEach((li) => li.onclick = () => { sel = Number(li.dataset.p); load(); });
  const p = all.find((x) => x.id === sel);
  drawDetail(p);
}

function drawDetail(p) {
  const el = $("#detail"); if (!el) return;
  if (!p) { el.innerHTML = '<article class="panel"><p class="empty">Choose or create a project.</p></article>'; return; }
  el.innerHTML = `<article class="panel"><div class="spread wrap"><div><h3 style="font-size:24px">${esc(p.title)}</h3><p class="muted" style="margin:4px 0 0">${esc(p.goal || "No goal written yet.")}</p></div>
      <div class="row wrap"><span class="pill">${esc(KINDS.find((k) => k[0] === p.kind)?.[1] || p.kind)}</span><span class="pill ${p.status === "done" ? "ok" : p.status === "paused" ? "warn" : "info"}">${esc(p.status)}</span><button class="btn small ghost" id="editP">${icon("edit")}Edit</button></div></div>
    <div class="grid cols-4" style="margin:16px 0"><div class="stat"><b>${p.progress.percent}%</b><span>complete</span></div><div class="stat"><b>${p.progress.done}/${p.progress.total}</b><span>tasks done</span></div><div class="stat"><b>${p.progress.milestonesDone}/${p.progress.milestonesTotal}</b><span>milestones</span></div><div class="stat"><b>${p.deadline ? esc(fmtDay(p.deadline)) : "—"}</b><span>deadline</span></div></div>
    <div class="spread"><span class="label">Milestones & tasks</span><div class="row"><button class="btn tiny" id="addM">${icon("plus")}Milestone</button><button class="btn tiny" id="addT">${icon("plus")}Task</button></div></div>
    <div class="stack" style="margin-top:10px">${p.milestones.map((m) => `<div class="item" style="display:grid;gap:6px"><div class="row"><button class="check ${m.done ? "on" : ""}" data-ms="${m.id}" data-done="${m.done ? 1 : 0}" aria-label="Milestone done"></button><b class="grow">${esc(m.title)}</b>${m.due ? `<span class="faint" style="font-size:12px">${esc(fmtDay(m.due))}</span>` : ""}</div>
        <ul class="list" style="padding-left:30px">${m.tasks.map(taskRow).join("") || '<li class="faint" style="font-size:12.5px">No tasks.</li>'}</ul></div>`).join("")}
      ${p.tasks.filter((t) => !t.milestone_id).length ? `<div class="item" style="display:grid;gap:6px"><b>Other tasks</b><ul class="list">${p.tasks.filter((t) => !t.milestone_id).map(taskRow).join("")}</ul></div>` : ""}
      ${!p.milestones.length && !p.tasks.length ? '<p class="empty">Nothing planned yet.</p>' : ""}</div>
    <div class="panel-head" style="margin-top:16px"><span class="label">Notes</span></div><textarea class="inp" id="notes" placeholder="Workspace notes…">${esc(p.notes || "")}</textarea><div class="row end" style="margin-top:8px"><button class="btn small" id="saveNotes">Save notes</button></div></article>`;
  $$("[data-ms]", el).forEach((b) => b.onclick = () => api(`/api/milestones/${b.dataset.ms}`, { method: "PATCH", body: { done: b.dataset.done !== "1" } }));
  $$("[data-tdone]", el).forEach((b) => b.onclick = () => api(`/api/tasks/${b.dataset.tdone}`, { method: "PATCH", body: { done: !b.classList.contains("on") } }));
  $("#addM", el).onclick = async () => { const v = await formDialog("Add milestone", [{ name: "title", label: "Milestone", required: true }, { name: "due", label: "Due", type: "date" }]); if (v) api(`/api/projects/${p.id}/milestones`, { method: "POST", body: { title: v.title, due: v.due || null } }); };
  $("#addT", el).onclick = async () => { const v = await formDialog("Add task", [{ name: "title", label: "Task", required: true }, { name: "due", label: "Due", type: "date" }, { name: "milestone", label: "Milestone", type: "select", value: "", options: [["", "None"], ...p.milestones.map((m) => [String(m.id), m.title])] }]); if (v) api("/api/tasks", { method: "POST", body: { title: v.title, due: v.due || null, projectId: p.id, milestoneId: v.milestone ? Number(v.milestone) : null } }); };
  $("#saveNotes", el).onclick = () => api(`/api/projects/${p.id}`, { method: "PATCH", body: { notes: $("#notes", el).value } }).then(() => toast("Notes saved."));
  $("#editP", el).onclick = () => edit(p);
}
const taskRow = (t) => `<li class="item ${t.done ? "done" : ""}" style="padding:6px 8px"><button class="check ${t.done ? "on" : ""}" data-tdone="${t.id}" aria-label="Task done"></button><div class="grow"><span class="t">${esc(t.title)}</span>${t.due ? ` <span class="faint" style="font-size:12px">· ${esc(t.due)}</span>` : ""}</div>${t.priority === 1 ? '<span class="pill p1">high</span>' : ""}</li>`;

async function edit(p = null) {
  const v = await formDialog(p ? "Edit project" : "New project", [
    { name: "title", label: "Name", value: p?.title || "", required: true },
    { name: "kind", label: "Type", type: "select", value: p?.kind || kind || "personal", options: KINDS },
    { name: "goal", label: "Goal", type: "textarea", value: p?.goal || "" },
    { name: "deadline", label: "Deadline", type: "date", value: p?.deadline || "" },
    ...(p ? [{ name: "status", label: "Status", type: "select", value: p.status, options: [["active", "Active"], ["paused", "Paused"], ["done", "Done"]] }, { name: "delete", label: "Delete this project and its tasks", type: "checkbox", value: false }] : []),
  ]);
  if (!v) return;
  if (p && v.delete) { if (await confirmDialog(`Delete “${p.title}”?`, "Its milestones and tasks are deleted too.", { ok: "Delete", danger: true })) { await api(`/api/projects/${p.id}`, { method: "DELETE" }); sel = null; } return; }
  try {
    const r = p ? await api(`/api/projects/${p.id}`, { method: "PATCH", body: { title: v.title, kind: v.kind, goal: v.goal, deadline: v.deadline || null, status: v.status } })
      : await api("/api/projects", { method: "POST", body: { title: v.title, kind: v.kind, goal: v.goal, deadline: v.deadline || null } });
    sel = r.id; toast("Saved."); load();
  } catch (e) { toast(e.message); }
}
