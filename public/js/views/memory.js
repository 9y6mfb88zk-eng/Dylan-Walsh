// Memory & Notes: everything JARVIS remembers (inspect, edit, export, delete), your notes, and conversation history.
import { api } from "../api.js";
import { $, $$, esc, toast, confirmDialog, formDialog, ago, icon, fmtWhen, debounce } from "../util.js";
let tab = "memory";

// Categories match the server (services/memory.js). Older categories are still shown under their own heading.
const LABELS = { profile: "Personal profile", career: "Career", ambition: "Ambitions", interest: "Interests", hobby: "Hobbies", business: "Businesses",
  creative: "Creative projects", date: "Important dates", preference: "Preferences", routine: "Routines", task: "Ongoing tasks", decision: "Previous decisions",
  topic: "Frequently discussed", goal: "Goals", project: "Projects", idea: "Ideas", fact: "General", summary: "Conversation summaries" };
const CATS = Object.keys(LABELS).filter((c) => c !== "summary");
const catOptions = CATS.map((c) => [c, LABELS[c]]);
let view = "profile";

export async function render(root, ctx, params = {}) {
  if (params.note) tab = "notes";
  if (params.history) tab = "timeline";
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Memory & Notes</h2></div><div class="seg">${[["memory", "Memory"], ["notes", "Notes"], ["timeline", "Session history"], ["history", "Conversations"]].map(([k, l]) => `<button data-t="${k}">${l}</button>`).join("")}</div></div><div id="mBody"></div>`;
  $$("[data-t]", root).forEach((b) => b.onclick = () => { tab = b.dataset.t; draw(root); });
  await draw(root);
  if (params.note) editNote();
}
async function draw(root) {
  $$("[data-t]", root).forEach((b) => b.classList.toggle("active", b.dataset.t === tab));
  const el = $("#mBody", root);
  if (tab === "notes") return notesView(el);
  if (tab === "history") return historyView(el);
  if (tab === "timeline") return timelineView(el);
  return memoryView(el);
}
async function memoryView(root) {
  const settings = await api("/api/settings");
  const mode = settings.memory?.mode || "ask";
  root.innerHTML = `<div class="spread wrap" style="margin-bottom:12px;gap:10px">
      <div class="seg" id="mview">${[["profile", "Profile"], ["recent", "Recent updates"], ["all", "Everything"]].map(([k, l]) => `<button data-v="${k}" class="${view === k ? "active" : ""}">${l}</button>`).join("")}</div>
      <div class="row wrap"><label class="row" style="gap:6px"><span class="label" style="margin:0">Memory</span><select class="inp" id="mmode" style="width:auto" aria-label="Memory mode">
        <option value="ask"${mode === "ask" ? " selected" : ""}>Ask before remembering</option><option value="auto"${mode === "auto" ? " selected" : ""}>Remember automatically</option><option value="off"${mode === "off" ? " selected" : ""}>Off</option></select></label>
        <button class="btn small" id="add">${icon("plus")}Add</button><a class="btn small" href="/api/memories/export" download>Export</a><button class="btn small danger" id="wipe">Delete all</button></div></div>
    <p class="muted" style="margin-top:0">This is what JARVIS knows about you — only what you've told it or agreed to keep. ${mode === "off" ? "<b>Memory is off:</b> nothing is used or saved." : "Correct anything that's out of date; JARVIS uses this to give personal answers."} Passwords, PINs and bank details are never stored. Pinned facts (📌) are always available to JARVIS.</p>
    <div class="row" style="margin-bottom:12px"><input class="inp" id="q" placeholder="Search memory…" aria-label="Search memory"><select class="inp" id="cat" style="max-width:200px" aria-label="Category"><option value="">All categories</option>${catOptions.map(([c, l]) => `<option value="${c}">${l}</option>`).join("")}</select></div>
    <div id="pendingMem"></div><div id="mems"></div>`;
  $$("[data-v]", root).forEach((b) => b.onclick = () => { view = b.dataset.v; $$("[data-v]", root).forEach((x) => x.classList.toggle("active", x === b)); load(); });
  $("#mmode", root).onchange = async (e) => {
    await api("/api/settings", { method: "PATCH", body: { memory: { mode: e.target.value, autoSave: e.target.value !== "off" } } });
    toast({ ask: "I'll ask before remembering anything new.", auto: "I'll remember lasting facts automatically (never sensitive ones without asking).", off: "Memory is off. Nothing will be used or saved." }[e.target.value]);
    memoryView(root);
  };
  $("#add", root).onclick = async () => {
    const v = await formDialog("Remember", [{ name: "fact", label: "What should I remember?", type: "textarea", required: true }, { name: "category", label: "Category", type: "select", value: "profile", options: catOptions }, { name: "pinned", label: "Pin (always available to JARVIS)", type: "checkbox", value: false }]);
    if (!v) return;
    const r = await api("/api/memories", { method: "POST", body: v });
    toast(r.refused ? r.reason : "Remembered."); load();
  };
  $("#wipe", root).onclick = async () => { if (await confirmDialog("Delete every memory?", "This cannot be undone. Export first if you want a copy.", { ok: "Delete all", danger: true })) { await api("/api/memories", { method: "DELETE" }); load(); } };
  let t; $("#q", root).oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  $("#cat", root).onchange = load;
  await load();
}
export function refresh(e) { if (tab === "memory" && (e.includes("*") || e.includes("memories"))) load(); if (tab === "notes" && (e.includes("*") || e.includes("notes"))) loadNotes(); }

const row = (m) => `<li class="item" data-id="${m.id}">${view !== "profile" ? `<span class="pill">${esc(LABELS[m.category] || m.category)}</span>` : ""}<div class="grow"><div>${m.pinned ? "📌 " : ""}${esc(m.fact)}</div><div class="meta">${m.source === "profile" ? "starting profile" : esc(m.source)} · ${m.updated_at && m.updated_at.slice(0, 19) !== String(m.created_at).slice(0, 19) ? `updated ${esc(ago(m.updated_at))}` : esc(ago(m.created_at))}${m.sensitive ? " · sensitive" : ""}${m.score != null ? ` · relevance ${m.score}` : ""}</div></div><button class="btn small ghost" data-edit>Edit</button><button class="x" data-del aria-label="Delete">×</button></li>`;
async function load() {
  const el = $("#mems"); if (!el) return;
  const q = $("#q").value.trim(), cat = $("#cat").value;
  let items = q ? await api(`/api/memories/search?q=${encodeURIComponent(q)}`) : view === "recent" ? await api("/api/memories/recent?limit=30") : await api("/api/memories");
  const pending = items.filter((m) => m.status === "pending");
  items = items.filter((m) => m.status !== "pending" && (!cat || m.category === cat) && (view === "all" || q || m.category !== "summary"));
  $("#pendingMem").innerHTML = pending.map((m) => `<div class="panel spread" style="margin-bottom:10px;border-color:rgba(251,191,36,.4)" data-id="${m.id}"><div><span class="label" style="color:var(--warn)">Sensitive — keep this?</span><div>${esc(m.fact)}</div></div><div class="row"><button class="btn small ghost" data-no>Forget</button><button class="btn small primary" data-yes>Keep</button></div></div>`).join("");
  $$("[data-yes]").forEach((b) => b.onclick = async () => { await api(`/api/memories/${b.closest("[data-id]").dataset.id}/approve`, { method: "POST" }); load(); });
  $$("[data-no]").forEach((b) => b.onclick = async () => { await api(`/api/memories/${b.closest("[data-id]").dataset.id}`, { method: "DELETE" }); load(); });
  if (!items.length) el.innerHTML = '<p class="empty">Nothing here yet. Tell JARVIS about yourself, or press Add.</p>';
  else if (view === "profile" && !q) {
    const groups = {};
    for (const m of items) (groups[m.category] ||= []).push(m);
    const order = [...CATS, "summary"].filter((c) => groups[c]);
    el.innerHTML = `<div class="grid cols-2">${order.map((c) => `<article class="panel"><div class="panel-head"><h3>${esc(LABELS[c] || c)}</h3><span class="faint">${groups[c].length}</span></div><ul class="list">${groups[c].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).map(row).join("")}</ul></article>`).join("")}</div>`;
  } else el.innerHTML = `<article class="panel"><ul class="list">${items.map(row).join("")}</ul></article>`;
  $$("[data-edit]", el).forEach((b) => b.onclick = async () => {
    const m = items.find((x) => String(x.id) === b.closest("[data-id]").dataset.id);
    const v = await formDialog("Edit memory", [{ name: "fact", label: "Fact", type: "textarea", value: m.fact, required: true }, { name: "category", label: "Category", type: "select", value: m.category, options: catOptions }, { name: "pinned", label: "Pin (always available to JARVIS)", type: "checkbox", value: !!m.pinned }]);
    if (v) { try { await api(`/api/memories/${m.id}`, { method: "PATCH", body: v }); toast("Updated."); load(); } catch (e) { toast(e.message); } }
  });
  $$("[data-del]", el).forEach((b) => b.onclick = async () => { await api(`/api/memories/${b.closest("[data-id]").dataset.id}`, { method: "DELETE" }); toast("Forgotten."); load(); });
}

// ---------------------------------------------------------------- Notes
async function notesView(el) {
  el.innerHTML = `<div class="spread" style="margin-bottom:12px"><input class="inp" id="nq" placeholder="Search notes…" style="max-width:320px"><button class="btn small primary" id="addN">${icon("plus")}Note</button></div><div class="grid cols-3" id="notes"></div>`;
  $("#addN", el).onclick = () => editNote();
  $("#nq", el).oninput = debounce(loadNotes, 250);
  await loadNotes();
}
async function loadNotes() {
  const box = $("#notes"); if (!box) return;
  const q = $("#nq")?.value.trim();
  const notes = q ? await api(`/api/notes/search?q=${encodeURIComponent(q)}`) : await api("/api/notes");
  box.innerHTML = notes.map((n) => `<article class="panel tilt clickable" data-n="${n.id}"><div class="spread"><b class="clip">${n.pinned ? "📌 " : ""}${esc(n.title || "Untitled")}</b><span class="faint" style="font-size:11px">${esc(fmtWhen(n.updated_at.replace(" ", "T") + "Z"))}</span></div><p class="muted" style="font-size:13px;white-space:pre-wrap;max-height:120px;overflow:hidden;margin:8px 0 0">${esc(n.body.slice(0, 400))}</p>${n.tags ? `<div class="row wrap" style="margin-top:8px">${n.tags.split(",").map((t) => `<span class="pill">${esc(t.trim())}</span>`).join("")}</div>` : ""}</article>`).join("") || '<p class="empty">No notes yet. Say “Take a note: …” or press Note.</p>';
  $$("[data-n]", box).forEach((c) => c.onclick = () => editNote(notes.find((n) => String(n.id) === c.dataset.n)));
}
async function editNote(n = null) {
  const v = await formDialog(n ? "Edit note" : "New note", [
    { name: "title", label: "Title", value: n?.title || "" }, { name: "body", label: "Note", type: "textarea", value: n?.body || "" },
    { name: "tags", label: "Tags (comma separated)", value: n?.tags || "" }, { name: "pinned", label: "Pin to top", type: "checkbox", value: !!n?.pinned },
    ...(n ? [{ name: "remove", label: "Delete this note", type: "checkbox", value: false }] : []),
  ]);
  if (!v) return;
  if (n && v.remove) { if (await confirmDialog("Delete this note?", "", { ok: "Delete", danger: true })) await api(`/api/notes/${n.id}`, { method: "DELETE" }); return loadNotes(); }
  const body = { title: v.title, body: v.body, tags: v.tags, pinned: v.pinned };
  try { n ? await api(`/api/notes/${n.id}`, { method: "PATCH", body }) : await api("/api/notes", { method: "POST", body }); toast("Saved."); loadNotes(); } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- Conversation history
async function historyView(el) {
  const { list, current } = await api("/api/conversations");
  el.innerHTML = `<article class="panel"><ul class="list">${list.map((c) => `<li class="item"><div class="grow"><b>${esc(c.title)}</b>${c.id === current ? ' <span class="pill info">current</span>' : ""}<div class="meta">${c.count} messages · ${esc(ago(c.updated_at || c.created_at))}</div></div><button class="btn tiny" data-open="${c.id}">Open</button><button class="x" data-rm="${c.id}" aria-label="Delete">×</button></li>`).join("") || '<li class="empty">No conversations yet.</li>'}</ul></article>`;
  $$("[data-open]", el).forEach((b) => b.onclick = async () => { await api(`/api/conversations/${b.dataset.open}/current`, { method: "POST" }); location.search = "?tab=talk"; });
  $$("[data-rm]", el).forEach((b) => b.onclick = async () => { if (await confirmDialog("Delete this conversation?", "Its messages are removed from every device. Saved memories stay.", { ok: "Delete", danger: true })) { await api(`/api/conversations/${b.dataset.rm}`, { method: "DELETE" }); historyView(el); } });
}

// ---------------------------------------------------------------- Session history (one timeline)
const KIND_LABEL = { conversation: "Conversations", command: "Voice commands", task: "Tasks completed", diagnostic: "Diagnostics", error: "Errors", automation: "Automations", decision: "Decisions" };
const KIND_ICON = { conversation: "talk", command: "mic", task: "tasks", diagnostic: "diagnostics", error: "shield", automation: "automations", decision: "memory" };
let hKind = "";
async function timelineView(el) {
  el.innerHTML = `<div class="row wrap" style="margin-bottom:12px"><input class="inp" id="hq" placeholder="Search history…" aria-label="Search history" style="max-width:320px">
      <select class="inp" id="hk" style="max-width:200px" aria-label="Filter"><option value="">Everything</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}" ${hKind === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      <span class="grow"></span><button class="btn small ghost" id="hclear" hidden>Clear these records</button></div>
    <p class="muted" style="margin-top:0;font-size:13px">Built from what JARVIS already records on this laptop — nothing extra is tracked or sent anywhere. Conversations, tasks and memories are deleted from their own pages; command, diagnostic, error and automation logs can be cleared here.</p>
    <article class="panel"><ul class="list" id="hl"><li class="empty">Loading…</li></ul></article>`;
  const load = async () => {
    const q = $("#hq").value.trim(); hKind = $("#hk").value;
    $("#hclear").hidden = !["command", "diagnostic", "error", "automation"].includes(hKind);
    const { items } = await api(`/api/history?limit=150&q=${encodeURIComponent(q)}&kind=${hKind}`);
    let day = "";
    $("#hl").innerHTML = items.map((x) => {
      const d = new Date(x.at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
      const head = d !== day ? `<li class="label" style="margin-top:8px">${esc(d)}</li>` : ""; day = d;
      return `${head}<li class="item">${icon(KIND_ICON[x.kind] || "memory")}<div class="grow"><div>${x.status && x.status !== "ok" ? statusDotLocal(x.status) : ""}${esc(x.title)}</div>${x.detail ? `<div class="meta">${esc(x.detail)}</div>` : ""}</div><span class="faint" style="font-size:12px;white-space:nowrap">${esc(new Date(x.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }))}</span></li>`;
    }).join("") || '<li class="empty">Nothing recorded yet.</li>';
  };
  $("#hq").oninput = debounce(load, 250);
  $("#hk").onchange = load;
  $("#hclear").onclick = async () => {
    if (!(await confirmDialog(`Clear all ${KIND_LABEL[hKind].toLowerCase()} records?`, "This can't be undone.", { ok: "Clear", danger: true }))) return;
    const r = await api(`/api/history/${hKind}`, { method: "DELETE" }); toast(`Cleared ${r.deleted} record${r.deleted === 1 ? "" : "s"}.`); load();
  };
  await load();
}
const statusDotLocal = (s) => `<span class="dot ${s === "error" ? "bad" : s}" style="margin-right:6px"></span>`;
