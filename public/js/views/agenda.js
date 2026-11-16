// Agenda: calendar (day / week / month), tasks, reminders and pending confirmations.
import { api, send } from "../api.js";
import { $, $$, esc, fmtTime, fmtWhen, toast, confirmDialog, formDialog, ago } from "../util.js";

let mode = "week", showDone = false, cursor = new Date();

export async function render(root, ctx, params = {}) {
  if (params.error) toast(params.error, 6000);
  if (params.connected === "google") toast("Google Calendar connected, sir.");
  root.innerHTML = `
  <div class="spread" style="margin-bottom:12px"><h2 class="title">Agenda</h2><div class="row"><button class="btn small" id="addEv">+ Event</button><button class="btn small" id="addRem">+ Reminder</button></div></div>
  <div id="pending"></div>
  <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)" id="agGrid">
    <section class="glass panel">
      <div class="spread" style="margin-bottom:10px;flex-wrap:wrap"><div class="tabs" style="margin:0">${["day", "week", "month"].map((m) => `<button data-mode="${m}" class="${m === mode ? "active" : ""}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}</div>
        <div class="row"><button class="btn small ghost" id="prev">‹</button><b id="calTitle" class="num"></b><button class="btn small ghost" id="next">›</button><button class="btn small ghost" id="todayBtn">Today</button></div></div>
      <div id="cal"></div>
      <div class="spread" style="margin-top:12px;font-size:13px" id="gcal"></div>
    </section>
    <section class="stack">
      <article class="glass panel"><div class="panel-head"><span class="label">Tasks</span><button class="link" id="toggleDone">Show done</button></div>
        <form id="taskForm" class="row" style="margin-bottom:10px" autocomplete="off"><input class="inp" id="taskIn" placeholder="Add a task…" aria-label="New task"><input class="inp" id="taskDue" type="date" style="max-width:150px" aria-label="Due date"><button class="btn small primary">Add</button></form>
        <ul class="list" id="tasks"></ul></article>
      <article class="glass panel"><div class="panel-head"><span class="label">Reminders</span><span class="faint" style="font-size:12px">delivered by the server, even with apps closed</span></div><ul class="list" id="rems"></ul>
        <details style="margin-top:8px"><summary class="faint" style="font-size:13px;cursor:pointer">Recently delivered</summary><ul class="list" id="remRecent" style="margin-top:6px"></ul></details></article>
    </section>
  </div>`;
  if (matchMedia("(max-width: 900px)").matches) $("#agGrid", root).style.gridTemplateColumns = "minmax(0,1fr)";

  $$("[data-mode]", root).forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode; $$("[data-mode]", root).forEach((x) => x.classList.toggle("active", x === b)); loadCal(); }));
  const step = (d) => { const c = new Date(cursor); if (mode === "day") c.setDate(c.getDate() + d); else if (mode === "week") c.setDate(c.getDate() + 7 * d); else c.setMonth(c.getMonth() + d); cursor = c; loadCal(); };
  $("#prev", root).onclick = () => step(-1); $("#next", root).onclick = () => step(1); $("#todayBtn", root).onclick = () => { cursor = new Date(); loadCal(); };
  $("#toggleDone", root).onclick = () => { showDone = !showDone; $("#toggleDone", root).textContent = showDone ? "Hide done" : "Show done"; loadTasks(); };
  $("#taskForm", root).addEventListener("submit", async (e) => {
    e.preventDefault(); const t = $("#taskIn", root).value.trim(); if (!t) return;
    const r = await send("/api/tasks", { title: t, due: $("#taskDue", root).value || null });
    $("#taskIn", root).value = ""; $("#taskDue", root).value = "";
    if (r.queued) toast("Saved offline — it will sync when you're back online.");
    loadTasks();
  });
  $("#addEv", root).onclick = addEvent;
  $("#addRem", root).onclick = async () => {
    const v = await formDialog("New reminder", [{ name: "text", label: "Remind me to…", required: true }, { name: "when", label: "When", type: "datetime-local", required: true }]);
    if (!v) return;
    const r = await send("/api/reminders", { text: v.text, due_at: new Date(v.when).toISOString() });
    toast(r.queued ? "Saved offline — will sync." : "Reminder set, sir."); loadRems();
  };
  await refresh(["*"]);
}

async function addEvent() {
  const d = new Date(cursor); d.setHours(d.getHours() + 1, 0, 0, 0);
  const local = (x) => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const v = await formDialog("New event", [
    { name: "title", label: "Title", required: true }, { name: "start", label: "Starts", type: "datetime-local", value: local(d), required: true },
    { name: "end", label: "Ends", type: "datetime-local", value: local(new Date(d.getTime() + 3600_000)) }, { name: "location", label: "Location" },
  ]);
  if (!v) return;
  const start = new Date(v.start).toISOString(), end = v.end ? new Date(v.end).toISOString() : undefined;
  const clash = await api(`/api/calendar/conflicts?start=${start}&end=${end || new Date(Date.parse(start) + 3600_000).toISOString()}`);
  if (clash.length && !(await confirmDialog("This clashes", `It overlaps ${clash.map((c) => `“${c.title}”`).join(", ")}. Book it anyway?`, { ok: "Book anyway" }))) return;
  try { await api("/api/calendar", { method: "POST", body: { title: v.title, start, end, location: v.location } }); toast("Event added."); loadCal(); } catch (e) { toast(e.message); }
}

export async function refresh(entities) {
  const all = entities.includes("*");
  if (all || entities.includes("calendar")) loadCal();
  if (all || entities.includes("tasks")) loadTasks();
  if (all || entities.includes("reminders")) loadRems();
  if (all || entities.includes("pending")) loadPending();
}

function range() {
  const c = new Date(cursor); c.setHours(0, 0, 0, 0);
  if (mode === "day") return [c, new Date(c.getTime() + 86400_000)];
  if (mode === "week") { const s = new Date(c); s.setDate(c.getDate() - ((c.getDay() + 6) % 7)); return [s, new Date(s.getTime() + 7 * 86400_000)]; }
  const s = new Date(c.getFullYear(), c.getMonth(), 1); const gridStart = new Date(s); gridStart.setDate(1 - ((s.getDay() + 6) % 7));
  return [gridStart, new Date(gridStart.getTime() + 42 * 86400_000)];
}

async function loadCal() {
  const el = $("#cal"); if (!el) return;
  const [from, to] = range();
  const [{ events, google }, rem, tasks] = await Promise.all([api(`/api/calendar?from=${from.toISOString()}&to=${to.toISOString()}`), api("/api/reminders"), api("/api/tasks")]);
  $("#calTitle").textContent = mode === "month" ? cursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : mode === "week" ? `${from.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date(to - 1).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : cursor.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const evOn = (d) => events.filter((e) => e.all_day ? e.start <= dayKey(d) && e.end > dayKey(d) : dayKey(new Date(e.start)) === dayKey(d));
  const remOn = (d) => rem.upcoming.filter((r) => dayKey(new Date(r.due_at)) === dayKey(d));
  const dueOn = (d) => tasks.filter((t) => t.due === dayKey(d));
  const today = dayKey(new Date());
  if (mode === "month") {
    const days = Array.from({ length: 42 }, (_, i) => new Date(from.getTime() + i * 86400_000));
    el.innerHTML = `<div class="cal-grid">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="dow">${d}</div>`).join("")}${days.map((d) => `<div class="cal-cell ${dayKey(d) === today ? "today" : ""} ${d.getMonth() !== cursor.getMonth() ? "other" : ""}"><div class="d">${d.getDate()}</div>${evOn(d).slice(0, 3).map((e) => `<span class="cal-ev ${e.source}" title="${esc(e.title)}">${e.all_day ? "" : fmtTime(e.start) + " "}${esc(e.title)}</span>`).join("")}${remOn(d).length ? `<span class="cal-ev" style="background:rgba(251,191,36,.2)">⏰ ${remOn(d).length}</span>` : ""}${dueOn(d).length ? `<span class="cal-ev" style="background:rgba(248,113,113,.2)">✓ ${dueOn(d).length} due</span>` : ""}</div>`).join("")}</div>`;
  } else {
    const days = mode === "day" ? [from] : Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * 86400_000));
    el.innerHTML = days.map((d) => {
      const items = [
        ...evOn(d).map((e) => ({ t: e.all_day ? "all day" : fmtTime(e.start), sort: e.all_day ? "0" : e.start, html: `${esc(e.title)}${e.location ? ` <span class="faint">· ${esc(e.location)}</span>` : ""}`, id: e.id, src: e.source })),
        ...remOn(d).map((r) => ({ t: fmtTime(r.due_at), sort: r.due_at, html: `⏰ ${esc(r.text)}` })),
        ...dueOn(d).map((t) => ({ t: "due", sort: "1", html: `✓ ${esc(t.title)}` })),
      ].sort((a, b) => a.sort.localeCompare(b.sort));
      return `<div style="margin-bottom:12px"><div class="label" style="margin-bottom:6px;${dayKey(d) === today ? "color:var(--violet-3)" : ""}">${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</div>
        <div class="timeline">${items.length ? items.map((i) => `<div class="tl-item"><span class="t">${i.t}</span><span>${i.html}</span>${i.id ? `<span class="row"><span class="pill">${i.src}</span><button class="btn small ghost" data-move="${i.id}">Move</button><button class="x" data-del="${i.id}" aria-label="Delete">×</button></span>` : "<span></span>"}</div>`).join("") : '<div class="faint" style="font-size:13px;padding:4px 10px">Nothing scheduled</div>'}</div></div>`;
    }).join("");
    $$("[data-del]", el).forEach((b) => b.onclick = async () => {
      if (!(await confirmDialog("Delete event?", "This also removes it from Google Calendar if it came from there.", { ok: "Delete", danger: true }))) return;
      try { await api(`/api/calendar/${b.dataset.del}`, { method: "DELETE" }); loadCal(); } catch (e) { toast(e.message); }
    });
    $$("[data-move]", el).forEach((b) => b.onclick = async () => {
      const ev = events.find((e) => String(e.id) === b.dataset.move);
      const local = (x) => new Date(new Date(x).getTime() - new Date(x).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      const v = await formDialog(`Move “${ev.title}”`, [{ name: "start", label: "New start", type: "datetime-local", value: local(ev.start), required: true }]);
      if (!v) return;
      const start = new Date(v.start).toISOString(), end = new Date(Date.parse(start) + (Date.parse(ev.end) - Date.parse(ev.start))).toISOString();
      const clash = await api(`/api/calendar/conflicts?start=${start}&end=${end}&ignore=${ev.id}`);
      if (!(await confirmDialog("Confirm change", `Move “${ev.title}” to ${fmtWhen(start)}?${clash.length ? ` It will clash with ${clash.map((c) => c.title).join(", ")}.` : ""}`, { ok: "Move it" }))) return;
      try { await api(`/api/calendar/${ev.id}`, { method: "PATCH", body: { start, end } }); toast("Moved."); loadCal(); } catch (e) { toast(e.message); }
    });
  }
  const g = $("#gcal");
  g.innerHTML = google.connection ? `<span class="row"><span class="dot ${google.connection.status === "active" ? "ok" : "warn"}"></span>Google Calendar ${esc(google.connection.status)} · synced ${ago(google.connection.last_sync_at)}</span><span class="row"><button class="btn small ghost" id="gSync">Sync now</button><button class="btn small ghost" id="gOff">Disconnect</button></span>`
    : google.configured ? `<span class="muted">Showing JARVIS's own calendar.</span><button class="btn small primary" id="gOn">Connect Google Calendar</button>` : `<span class="faint">Google Calendar isn't configured on the server (GOOGLE_CLIENT_ID / SECRET). JARVIS's own calendar works meanwhile.</span>`;
  $("#gOn")?.addEventListener("click", async () => { const { url } = await api("/api/calendar/google/connect", { method: "POST" }); location.href = url; });
  $("#gSync")?.addEventListener("click", async () => { try { await api("/api/calendar/google/sync", { method: "POST" }); toast("Synced."); } catch (e) { toast(e.message); } });
  $("#gOff")?.addEventListener("click", async () => { if (await confirmDialog("Disconnect Google Calendar?", "JARVIS will forget its copy of your Google events and revoke access.", { ok: "Disconnect", danger: true })) { await api("/api/calendar/google/disconnect", { method: "POST" }); loadCal(); } });
}

async function loadTasks() {
  const el = $("#tasks"); if (!el) return;
  const tasks = await api(`/api/tasks${showDone ? "?all=1" : ""}`);
  const today = new Date().toISOString().slice(0, 10);
  el.innerHTML = tasks.length ? tasks.map((t) => `<li class="item prio-${t.priority} ${t.done ? "done" : ""}" data-id="${t.id}">
    <button class="check" data-act="toggle" aria-label="${t.done ? "Mark not done" : "Mark done"}">${t.done ? "✓" : ""}</button>
    <div class="grow"><div>${esc(t.title)}</div><div class="meta">${[t.due ? `<span style="${t.due < today && !t.done ? "color:var(--bad)" : ""}">${t.due < today && !t.done ? "Overdue · " : "Due "}${t.due}</span>` : "", t.project_title ? esc(t.project_title) : "", t.priority === 1 ? "High priority" : ""].filter(Boolean).join(" · ")}</div></div>
    <button class="x" data-act="del" aria-label="Delete">×</button></li>`).join("") : '<li class="empty">All clear, sir.</li>';
  $$("[data-act]", el).forEach((b) => b.onclick = async () => {
    const li = b.closest("[data-id]"); const id = li.dataset.id;
    if (b.dataset.act === "toggle") await api(`/api/tasks/${id}`, { method: "PATCH", body: { done: !li.classList.contains("done") } });
    else await api(`/api/tasks/${id}`, { method: "DELETE" });
    loadTasks();
  });
}

async function loadRems() {
  const el = $("#rems"); if (!el) return;
  const { upcoming, recent } = await api("/api/reminders");
  el.innerHTML = upcoming.length ? upcoming.map((r) => `<li class="item" data-id="${r.id}"><div class="grow"><div>${esc(r.text)}</div><div class="meta">${fmtWhen(r.due_at)}</div></div><button class="x" aria-label="Cancel">×</button></li>`).join("") : '<li class="empty">No reminders. Try “Remind me to call my mum at six.”</li>';
  $$(".x", el).forEach((b) => b.onclick = async () => { await api(`/api/reminders/${b.closest("[data-id]").dataset.id}`, { method: "DELETE" }); loadRems(); });
  $("#remRecent").innerHTML = recent.map((r) => `<li class="item" style="opacity:.6"><div class="grow"><div>${esc(r.text)}</div><div class="meta">${fmtWhen(r.due_at)}</div></div></li>`).join("") || '<li class="faint" style="font-size:13px">None yet.</li>';
}

async function loadPending() {
  const el = $("#pending"); if (!el) return;
  const p = await api("/api/pending");
  el.innerHTML = p.map((a) => `<div class="glass panel spread" style="margin-bottom:12px;border-color:rgba(251,191,36,.4)" data-id="${a.id}"><div><span class="label" style="color:var(--warn)">Needs your confirmation</span><div>${esc(a.summary)}</div></div><div class="row"><button class="btn small ghost" data-d="reject">Cancel</button><button class="btn small primary" data-d="confirm">Confirm</button></div></div>`).join("");
  $$("[data-d]", el).forEach((b) => b.onclick = async () => {
    try { await api(`/api/pending/${b.closest("[data-id]").dataset.id}`, { method: "POST", body: { decision: b.dataset.d } }); toast(b.dataset.d === "confirm" ? "Done, sir." : "Cancelled."); } catch (e) { toast(e.message); }
    loadPending(); loadCal();
  });
}
