// Tasks (categories, priorities, progress) and reminders (one-off or repeating, snoozable).
import { api, send } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, fmtWhen, fmtRel, zonedToISO, zonedParts, localDateStr } from "../util.js";

const CATS = ["general", "personal", "work", "business", "home", "health", "finance", "learning", "errands"];
const REPEAT = { none: "Once", daily: "Every day", weekdays: "Weekdays", weekly: "Every week", monthly: "Every month" };
let tab = "tasks", cat = "", showDone = false, CTX = null;

export async function render(root, ctx, params = {}) {
  CTX = ctx;
  if (params.tab) tab = params.tab;
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Tasks & Reminders</h2><p>Reminders arrive on every device, even when the apps are closed.</p></div>
    <div class="row wrap"><div class="seg">${[["tasks", "Tasks"], ["reminders", "Reminders"]].map(([k, l]) => `<button data-t="${k}">${l}</button>`).join("")}</div><button class="btn small primary" id="add">${icon("plus")}<span id="addL">Task</span></button></div></div>
    <div id="body"></div>`;
  $$("[data-t]", root).forEach((b) => b.onclick = () => { tab = b.dataset.t; draw(); });
  $("#add", root).onclick = () => (tab === "tasks" ? editTask() : editReminder());
  await draw();
  if (params.new) (tab === "tasks" ? editTask() : editReminder());
}
export function refresh(e) { if (e.includes("*") || e.includes("tasks") || e.includes("reminders") || e.includes("projects")) draw(); }

async function draw() {
  $$("[data-t]").forEach((b) => b.classList.toggle("active", b.dataset.t === tab));
  $("#addL") && ($("#addL").textContent = tab === "tasks" ? "Task" : "Reminder");
  const el = $("#body"); if (!el) return;
  if (tab === "tasks") {
    const [list, counts, projects] = await Promise.all([api(`/api/tasks?all=${showDone ? 1 : 0}${cat ? `&category=${cat}` : ""}`), api("/api/tasks/categories"), api("/api/projects")]);
    const n = Object.fromEntries(counts.map((c) => [c.category, c.open]));
    const today = localDateStr();
    el.innerHTML = `<div class="row wrap" style="margin-bottom:12px"><div class="seg"><button data-c="" class="${cat ? "" : "active"}">All</button>${CATS.filter((c) => n[c] || c === cat).map((c) => `<button data-c="${c}" class="${c === cat ? "active" : ""}">${c[0].toUpperCase() + c.slice(1)} <span class="faint">${n[c] || 0}</span></button>`).join("")}</div>
      <label class="chip" style="cursor:pointer"><input type="checkbox" id="done" ${showDone ? "checked" : ""}> Show completed</label></div>
      <article class="panel"><ul class="list">${list.map((t) => `<li class="item ${t.done ? "done" : ""}"><button class="check ${t.done ? "on" : ""}" data-done="${t.id}" aria-label="Toggle done"></button>
        <div class="grow clickable" data-edit="${t.id}"><div class="t">${esc(t.title)}</div><div class="meta">${t.due ? (!t.done && t.due < today ? `<span style="color:var(--bad)">overdue · ${esc(t.due)}</span>` : `due ${esc(t.due)}`) : "no due date"} · ${esc(t.category || "general")}${t.project_title ? ` · ${esc(t.project_title)}` : ""}</div>
        ${t.progress && !t.done ? `<div class="bar" style="margin-top:6px;max-width:240px"><i style="width:${t.progress}%"></i></div>` : ""}</div>
        ${t.priority === 1 ? '<span class="pill p1">high</span>' : t.priority === 3 ? '<span class="pill p3">low</span>' : ""}<button class="x" data-del="${t.id}" aria-label="Delete">×</button></li>`).join("") || '<li class="empty">No tasks here.</li>'}</ul></article>`;
    $$("[data-c]", el).forEach((b) => b.onclick = () => { cat = b.dataset.c; draw(); });
    $("#done", el).onchange = (e) => { showDone = e.target.checked; draw(); };
    $$("[data-done]", el).forEach((b) => b.onclick = () => api(`/api/tasks/${b.dataset.done}`, { method: "PATCH", body: { done: !b.classList.contains("on") } }));
    $$("[data-edit]", el).forEach((b) => b.onclick = () => editTask(list.find((t) => String(t.id) === b.dataset.edit), projects));
    $$("[data-del]", el).forEach((b) => b.onclick = async () => { if (await confirmDialog("Delete this task?", "This can't be undone.", { ok: "Delete", danger: true })) api(`/api/tasks/${b.dataset.del}`, { method: "DELETE" }); });
    el.dataset.projects = JSON.stringify(projects.map((p) => [p.id, p.title]));
  } else {
    const r = await api("/api/reminders");
    el.innerHTML = `<div class="grid cols-2"><article class="panel"><div class="panel-head"><span class="label">Upcoming</span></div><ul class="list">${r.upcoming.map((x) => `<li class="item"><div class="grow"><div>${esc(x.text)}</div><div class="meta">${esc(fmtWhen(x.due_at))} · ${esc(fmtRel(x.due_at))}${x.repeat !== "none" ? ` · <span class="pill info">${esc(REPEAT[x.repeat])}</span>` : ""}</div></div><button class="btn tiny ghost" data-edit="${x.id}">${icon("edit")}</button><button class="x" data-del="${x.id}" aria-label="Delete">×</button></li>`).join("") || '<li class="empty">No reminders. Try “Remind me to call Mum at six”.</li>'}</ul></article>
      <article class="panel"><div class="panel-head"><span class="label">Recently delivered</span></div><ul class="list">${r.recent.map((x) => `<li class="item"><div class="grow"><div>${esc(x.text)}</div><div class="meta">${esc(fmtWhen(x.fired_at || x.due_at))}</div></div><button class="btn tiny ghost" data-snz="${x.id}" data-m="10">10 min</button><button class="btn tiny ghost" data-snz="${x.id}" data-m="60">1 h</button></li>`).join("") || '<li class="empty">None yet.</li>'}</ul></article></div>`;
    $$("[data-del]", el).forEach((b) => b.onclick = () => api(`/api/reminders/${b.dataset.del}`, { method: "DELETE" }));
    $$("[data-edit]", el).forEach((b) => b.onclick = () => editReminder(r.upcoming.find((x) => String(x.id) === b.dataset.edit)));
    $$("[data-snz]", el).forEach((b) => b.onclick = () => api(`/api/reminders/${b.dataset.snz}/snooze`, { method: "POST", body: { minutes: Number(b.dataset.m) } }).then(() => toast(`It'll remind you again in ${b.dataset.m === "60" ? "an hour" : "10 minutes"}.`)));
  }
}

async function editTask(t = null, projects) {
  projects ||= await api("/api/projects").catch(() => []);   // still works offline (the task is queued)
  const v = await formDialog(t ? "Edit task" : "New task", [
    { name: "title", label: "Task", value: t?.title || "", required: true },
    { name: "notes", label: "Notes", type: "textarea", value: t?.notes || "" },
    { name: "due", label: "Due", type: "date", value: t?.due || "" },
    { name: "priority", label: "Priority", type: "select", value: String(t?.priority || 2), options: [["1", "High"], ["2", "Normal"], ["3", "Low"]] },
    { name: "category", label: "Category", type: "select", value: t?.category || cat || "general", options: CATS.map((c) => [c, c[0].toUpperCase() + c.slice(1)]) },
    { name: "projectId", label: "Project", type: "select", value: String(t?.project_id || ""), options: [["", "None"], ...projects.map((p) => [String(p.id), p.title])] },
    ...(t ? [{ name: "progress", label: "Progress (%)", type: "range", value: t.progress || 0, min: 0, max: 100 }] : []),
  ], { ok: t ? "Save" : "Add" });
  if (!v) return;
  const body = { title: v.title, notes: v.notes, due: v.due || null, priority: Number(v.priority), category: v.category, projectId: v.projectId ? Number(v.projectId) : null, ...(t ? { progress: Number(v.progress) } : {}) };
  try { const r = t ? await api(`/api/tasks/${t.id}`, { method: "PATCH", body }) : await send("/api/tasks", body); toast(r?.queued ? "Saved offline — it will sync when you're back online." : "Saved."); } catch (e) { toast(e.message); }
}
async function editReminder(r = null) {
  const tz = CTX.settings.timezone;
  const p = r ? zonedParts(r.due_at, tz) : zonedParts(new Date(Date.now() + 3600_000).toISOString(), tz);
  const v = await formDialog(r ? "Edit reminder" : "New reminder", [
    { name: "text", label: "Remind me to…", value: r?.text || "", required: true },
    { name: "date", label: "Date", type: "date", value: p.date, required: true },
    { name: "time", label: "Time", type: "time", value: p.time, required: true },
    { name: "repeat", label: "Repeat", type: "select", value: r?.repeat || "none", options: Object.entries(REPEAT) },
  ], { ok: r ? "Save" : "Remind me" });
  if (!v) return;
  const body = { text: v.text, due_at: zonedToISO(v.date, v.time, tz), repeat: v.repeat };
  if (Date.parse(body.due_at) < Date.now() - 60_000) return toast("That time has already passed.");
  try { const x = r ? await api(`/api/reminders/${r.id}`, { method: "PATCH", body }) : await send("/api/reminders", body); toast(x?.queued ? "Saved offline — it will sync when you're back online." : "Reminder set."); } catch (e) { toast(e.message); }
}
