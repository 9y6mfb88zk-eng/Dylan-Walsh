// Memory & Notes: everything JARVIS remembers (inspect, edit, export, delete), your notes, and conversation history.
import { api } from "../api.js";
import { $, $$, esc, toast, confirmDialog, formDialog, ago, icon, fmtWhen, debounce } from "../util.js";
let tab = "memory";

const CATS = ["preference", "goal", "project", "date", "idea", "decision", "fact", "summary"];

export async function render(root, ctx, params = {}) {
  if (params.note) tab = "notes";
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Memory & Notes</h2></div><div class="seg">${[["memory", "Memory"], ["notes", "Notes"], ["history", "Conversations"]].map(([k, l]) => `<button data-t="${k}">${l}</button>`).join("")}</div></div><div id="mBody"></div>`;
  $$("[data-t]", root).forEach((b) => b.onclick = () => { tab = b.dataset.t; draw(root); });
  await draw(root);
  if (params.note) editNote();
}
async function draw(root) {
  $$("[data-t]", root).forEach((b) => b.classList.toggle("active", b.dataset.t === tab));
  const el = $("#mBody", root);
  if (tab === "notes") return notesView(el);
  if (tab === "history") return historyView(el);
  return memoryView(el);
}
async function memoryView(root) {
  root.innerHTML = `<div class="spread" style="margin-bottom:12px"><span></span><div class="row"><button class="btn small" id="add">+ Add</button><a class="btn small" href="/api/memories/export" download>Export</a><button class="btn small danger" id="wipe">Delete all</button></div></div>
    <p class="muted" style="margin-top:0">JARVIS keeps lasting facts, not every conversation. Sensitive facts are only kept after you approve them; passwords, PINs and card numbers are never stored.</p>
    <div class="row" style="margin-bottom:12px"><input class="inp" id="q" placeholder="Search memory…" aria-label="Search memory"><select class="inp" id="cat" style="max-width:180px" aria-label="Category"><option value="">All categories</option>${CATS.map((c) => `<option>${c}</option>`).join("")}</select></div>
    <div id="pendingMem"></div><ul class="list" id="mems"></ul>`;
  $("#add", root).onclick = async () => {
    const v = await formDialog("Remember", [{ name: "fact", label: "What should I remember?", type: "textarea", required: true }, { name: "category", label: "Category", type: "select", value: "fact", options: CATS.map((c) => [c, c]) }]);
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

async function load() {
  const el = $("#mems"); if (!el) return;
  const q = $("#q").value.trim(), cat = $("#cat").value;
  let items = q ? await api(`/api/memories/search?q=${encodeURIComponent(q)}`) : await api("/api/memories");
  const pending = items.filter((m) => m.status === "pending");
  items = items.filter((m) => m.status !== "pending" && (!cat || m.category === cat));
  $("#pendingMem").innerHTML = pending.map((m) => `<div class="panel spread" style="margin-bottom:10px;border-color:rgba(251,191,36,.4)" data-id="${m.id}"><div><span class="label" style="color:var(--warn)">Sensitive — keep this?</span><div>${esc(m.fact)}</div></div><div class="row"><button class="btn small ghost" data-no>Forget</button><button class="btn small primary" data-yes>Keep</button></div></div>`).join("");
  $$("[data-yes]").forEach((b) => b.onclick = async () => { await api(`/api/memories/${b.closest("[data-id]").dataset.id}/approve`, { method: "POST" }); load(); });
  $$("[data-no]").forEach((b) => b.onclick = async () => { await api(`/api/memories/${b.closest("[data-id]").dataset.id}`, { method: "DELETE" }); load(); });
  el.innerHTML = items.length ? items.map((m) => `<li class="item" data-id="${m.id}"><span class="pill">${m.category}</span><div class="grow"><div>${esc(m.fact)}</div><div class="meta">${m.source} · ${ago(m.created_at)}${m.sensitive ? " · sensitive" : ""}${m.score != null ? ` · relevance ${m.score}` : ""}</div></div><button class="btn small ghost" data-edit>Edit</button><button class="x" data-del aria-label="Delete">×</button></li>`).join("") : '<li class="empty">Nothing here yet.</li>';
  $$("[data-edit]", el).forEach((b) => b.onclick = async () => {
    const m = items.find((x) => String(x.id) === b.closest("[data-id]").dataset.id);
    const v = await formDialog("Edit memory", [{ name: "fact", label: "Fact", type: "textarea", value: m.fact, required: true }, { name: "category", label: "Category", type: "select", value: m.category, options: CATS.map((c) => [c, c]) }]);
    if (v) { await api(`/api/memories/${m.id}`, { method: "PATCH", body: v }); load(); }
  });
  $$("[data-del]", el).forEach((b) => b.onclick = async () => { await api(`/api/memories/${b.closest("[data-id]").dataset.id}`, { method: "DELETE" }); load(); });
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
