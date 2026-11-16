// Inspect, edit, export and delete everything JARVIS remembers.
import { api } from "../api.js";
import { $, $$, esc, toast, confirmDialog, formDialog, ago } from "../util.js";

const CATS = ["preference", "goal", "project", "date", "idea", "decision", "fact", "summary"];

export async function render(root) {
  root.innerHTML = `<div class="spread" style="margin-bottom:12px"><h2 class="title">Memory</h2><div class="row"><button class="btn small" id="add">+ Add</button><a class="btn small" href="/api/memories/export" download>Export</a><button class="btn small danger" id="wipe">Delete all</button></div></div>
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
export function refresh(e) { if (e.includes("*") || e.includes("memories")) load(); }

async function load() {
  const el = $("#mems"); if (!el) return;
  const q = $("#q").value.trim(), cat = $("#cat").value;
  let items = q ? await api(`/api/memories/search?q=${encodeURIComponent(q)}`) : await api("/api/memories");
  const pending = items.filter((m) => m.status === "pending");
  items = items.filter((m) => m.status !== "pending" && (!cat || m.category === cat));
  $("#pendingMem").innerHTML = pending.map((m) => `<div class="glass panel spread" style="margin-bottom:10px;border-color:rgba(251,191,36,.4)" data-id="${m.id}"><div><span class="label" style="color:var(--warn)">Sensitive — keep this?</span><div>${esc(m.fact)}</div></div><div class="row"><button class="btn small ghost" data-no>Forget</button><button class="btn small primary" data-yes>Keep</button></div></div>`).join("");
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
