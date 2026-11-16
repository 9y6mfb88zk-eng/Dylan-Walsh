// Computer control: the complete allowlist of laptop actions, open windows, clipboard, shortcuts and an action log.
// There is no shell. Anything that could lose work (closing a window) asks first.
import { api } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, fmtWhen } from "../util.js";

let info = null, CTX = null;

export async function render(root, ctx) {
  CTX = ctx;
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Computer</h2><p>JARVIS can only do what's listed here. No shell, no deleting files, no installing, no settings changes.</p></div><span id="deskState"></span></div>
    <div class="grid cols-3" id="acts"></div>
    <div class="grid cols-2" style="margin-top:14px"><article class="panel"><div class="panel-head"><span class="label">Open windows</span><button class="btn tiny" id="refreshW">${icon("refresh")}Refresh</button></div><ul class="list" id="wins"><li class="faint" style="font-size:13px">Press Refresh to list them.</li></ul></article>
    <article class="panel"><div class="panel-head"><span class="label">Clipboard</span></div><div class="stack"><textarea class="inp" id="clip" placeholder="Clipboard text"></textarea><div class="row end"><button class="btn small ghost" id="readClip">Read clipboard</button><button class="btn small" id="writeClip">Copy to clipboard</button></div></div></article></div>
    <article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">Action log</span></div><div class="scroll-x"><table class="tbl" id="log"></table></div></article>`;
  await load(root);
}
export function refresh(e) { if (e.includes("*") || e.includes("health")) load(document); }

async function run(action, args = {}, { confirmed = false } = {}) {
  const r = await api("/api/computer", { method: "POST", body: { action, args, confirmed } });
  if (r.needsConfirmation) {
    if (!(await confirmDialog("Are you sure?", r.error, { ok: "Yes, do it", danger: true }))) return null;
    return run(action, args, { confirmed: true });
  }
  if (!r.ok) { toast(r.error || "The laptop couldn't do that.", 6000); return null; }
  return r.result ?? {};
}

async function load(root) {
  info = await api("/api/computer");
  const desk = info.desktops.find((d) => d.online);
  const st = $("#deskState", root); if (!st) return;
  st.innerHTML = desk ? `<span class="chip"><span class="dot ok"></span>${esc(desk.deviceName || "Laptop")} connected${desk.status?.computer === false ? " · control switched off" : ""}</span>` : '<span class="chip"><span class="dot bad"></span>Laptop not connected</span>';
  const apps = Object.entries(info.apps);
  $("#acts", root).innerHTML = `
    <article class="panel"><div class="panel-head"><span class="label">Open an app</span></div><div class="row wrap">${apps.map(([k, l]) => `<button class="btn small ghost" data-app="${k}">${esc(l)}</button>`).join("")}</div></article>
    <article class="panel"><div class="panel-head"><span class="label">Folders</span></div><div class="row wrap">${info.folders.map((f) => `<button class="btn small ghost" data-folder="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}</div><div class="row wrap" style="margin-top:10px"><button class="btn small" id="newFolder">${icon("plus")}New folder</button></div></article>
    <article class="panel"><div class="panel-head"><span class="label">Web & files</span></div><div class="stack" style="gap:8px"><form class="row" id="urlF"><input class="inp" id="url" placeholder="https://…" type="url"><button class="btn small">Open</button></form><form class="row" id="findF"><input class="inp" id="find" placeholder="Find files named…"><button class="btn small">Search</button></form><ul class="list" id="found"></ul></div></article>
    <article class="panel"><div class="panel-head"><span class="label">Screen & system</span></div><div class="row wrap"><button class="btn small" id="shot">${icon("download")}Screenshot</button><button class="btn small ghost" id="status">System status</button><button class="btn small ghost" id="lock">${icon("shield")}Lock laptop</button><button class="btn small ghost" id="doc">${icon("documents")}New document</button></div><p class="faint" id="sysOut" style="font-size:12.5px;margin:8px 0 0"></p></article>
    <article class="panel"><div class="panel-head"><span class="label">Your shortcuts</span><button class="btn tiny ghost" id="editBm">Edit</button></div><div class="row wrap" id="bms"><span class="faint" style="font-size:13px">${CTX.desktop ? "Loading…" : "Shortcuts are set in the Windows app."}</span></div></article>`;
  $$("[data-app]", root).forEach((b) => b.onclick = () => run("open_app", { app: b.dataset.app }).then((r) => r && toast(`${r.opened || "Opened"}.`)));
  $$("[data-folder]", root).forEach((b) => b.onclick = () => run("open_folder", { folder: b.dataset.folder }));
  $("#newFolder", root).onclick = async () => { const v = await formDialog("New folder", [{ name: "name", label: "Folder name", required: true }, { name: "parent", label: "Inside", type: "select", value: "documents", options: info.folders.map((f) => [f, f[0].toUpperCase() + f.slice(1)]) }]); if (v) { const r = await run("create_folder", v); if (r) toast(r.existed ? `That folder already exists: ${r.path}` : `Created ${r.path}`); } };
  $("#urlF", root).onsubmit = (e) => { e.preventDefault(); run("open_url", { url: $("#url", root).value.trim() }); };
  $("#findF", root).onsubmit = async (e) => {
    e.preventDefault();
    const r = await run("search_files", { query: $("#find", root).value.trim() });
    $("#found", root).innerHTML = r ? (r.results || []).map((m) => `<li class="item"><div class="grow clip">${esc(m.name)}<div class="meta">${esc(m.folder)} · ${esc(fmtWhen(m.modified))}</div></div><button class="btn tiny" data-open="${esc(m.path)}">Open</button></li>`).join("") || '<li class="empty">No matches.</li>' : "";
    $$("[data-open]", root).forEach((b) => b.onclick = () => run("open_file", { path: b.dataset.open }));
  };
  $("#shot", root).onclick = async () => { const r = await run("screenshot"); if (r) $("#sysOut", root).textContent = `Saved ${r.file}`; };
  $("#status", root).onclick = async () => { const r = await run("system_status"); if (r) $("#sysOut", root).textContent = [r.battery != null ? `Battery ${r.battery}%${r.charging ? " (charging)" : ""}` : "No battery", r.uptime ? `up ${r.uptime}` : "", r.displays ? `${r.displays} display(s)` : ""].filter(Boolean).join(" · "); };
  $("#lock", root).onclick = async () => { if (await confirmDialog("Lock the laptop?", "You'll need your Windows PIN or password to get back in.", { ok: "Lock" })) run("lock_screen"); };
  $("#doc", root).onclick = async () => { const v = await formDialog("New document", [{ name: "title", label: "Title", required: true }, { name: "content", label: "Content", type: "textarea" }, { name: "format", label: "Format", type: "select", value: "md", options: [["md", "Markdown"], ["txt", "Plain text"]] }]); if (v) { const r = await run("create_document", v); if (r) toast(`Created ${r.created}`); } };
  $("#refreshW", root).onclick = async () => {
    const r = await run("list_windows");
    $("#wins", root).innerHTML = r ? (r.windows || []).map((w) => `<li class="item"><div class="grow"><div class="clip">${esc(w.title)}</div><div class="meta">${esc(w.app)}</div></div><button class="btn tiny" data-focus="${esc(w.app)}">Show</button><button class="btn tiny ghost" data-min="${esc(w.app)}">Minimise</button><button class="btn tiny danger" data-close="${esc(w.app)}">Close</button></li>`).join("") || '<li class="empty">No windows.</li>' : "";
    $$("[data-focus]", root).forEach((b) => b.onclick = () => run("focus_window", { target: b.dataset.focus }));
    $$("[data-min]", root).forEach((b) => b.onclick = () => run("minimize_window", { target: b.dataset.min }));
    $$("[data-close]", root).forEach((b) => b.onclick = () => run("close_window", { target: b.dataset.close }).then((x) => x && $("#refreshW", root).click()));
  };
  $("#readClip", root).onclick = async () => { const r = await run("clipboard_read"); if (r) $("#clip", root).value = r.text || ""; };
  $("#writeClip", root).onclick = async () => { const r = await run("clipboard_write", { text: $("#clip", root).value }); if (r) toast("Copied."); };
  if (CTX.desktop) {
    const s = await CTX.desktop.getSettings().catch(() => ({}));
    const bms = s.bookmarks || {};
    $("#bms", root).innerHTML = Object.keys(bms).map((k) => `<button class="btn small ghost" data-bm="${esc(k)}">${esc(k)}</button>`).join("") || '<span class="faint" style="font-size:13px">None yet — e.g. “project folder” → C:\\Users\\you\\Projects.</span>';
    $$("[data-bm]", root).forEach((b) => b.onclick = () => run("open_bookmark", { name: b.dataset.bm }));
    $("#editBm", root).onclick = async () => {
      const v = await formDialog("Shortcuts (one per line: name = folder, file or https link)", [{ name: "lines", label: "Shortcuts", type: "textarea", value: Object.entries(bms).map(([k, x]) => `${k} = ${x}`).join("\n") }]);
      if (!v) return;
      const next = Object.fromEntries(v.lines.split("\n").map((l) => l.split("=")).filter((p) => p.length >= 2 && p[0].trim()).map(([k, ...x]) => [k.trim(), x.join("=").trim()]));
      await CTX.desktop.setSettings({ bookmarks: next }); toast("Shortcuts saved."); load(document);
    };
  } else $("#editBm", root).hidden = true;
  const audit = await api("/api/audit?limit=200").catch(() => []);
  const rows = audit.filter((a) => a.action === "computer.action").slice(0, 40);
  $("#log", root).innerHTML = `<thead><tr><th>When</th><th>Action</th><th>Result</th></tr></thead><tbody>${rows.map((a) => `<tr><td class="mono faint">${esc(fmtWhen(a.created_at || a.at))}</td><td>${esc(a.detail.action)}</td><td>${a.detail.ok ? '<span class="pill ok">done</span>' : `<span class="pill bad">failed</span> <span class="faint">${esc(a.detail.error || "")}</span>`}</td></tr>`).join("") || '<tr><td colspan="3" class="empty">No laptop actions yet.</td></tr>'}</tbody>`;
}
