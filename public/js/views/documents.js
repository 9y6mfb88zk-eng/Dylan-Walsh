// Documents: upload PDFs and text files, analyse them with JARVIS (only when you ask), ask questions about them.
import { api } from "../api.js";
import { $, $$, esc, icon, toast, confirmDialog, fmtWhen } from "../util.js";

let openId = null, folder = "";
const size = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

export async function render(root, ctx, params = {}) {
  if (params.focus) openId = Number(params.focus);
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Documents</h2><p>Uploading keeps a document on your laptop only. It's sent to the AI only when you press Analyse or ask a question.</p></div>
    <div class="row wrap"><input class="inp" id="folder" placeholder="Folder (optional)" style="width:170px"><label class="btn small primary" style="cursor:pointer">${icon("upload")}Upload<input type="file" id="file" accept=".pdf,.txt,.md,.csv,.json,.html,.htm,.xml,.yaml,.yml,.log,application/pdf,text/*" hidden multiple></label></div></div>
    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,2fr)" id="dGrid"><article class="panel"><div class="seg" id="folders" style="margin-bottom:10px"></div><ul class="list" id="docs"></ul></article><div id="detail"></div></div>`;
  if (ctx.isPhone()) $("#dGrid", root).style.gridTemplateColumns = "minmax(0,1fr)";
  $("#file", root).onchange = async (e) => {
    for (const f of e.target.files) {
      try { const d = await api(`/api/documents?name=${encodeURIComponent(f.name)}&folder=${encodeURIComponent($("#folder").value.trim() || "General")}`, { method: "POST", raw: f, headers: { "content-type": f.type || "application/octet-stream" } }); openId = d.id; toast(`Uploaded ${f.name}.`); }
      catch (er) { toast(`${f.name}: ${er.message}`, 6000); }
    }
    e.target.value = ""; load();
  };
  await load();
}
export function refresh(e) { if (e.includes("*") || e.includes("documents")) load(); }

async function load() {
  const docs = await api("/api/documents");
  const L = $("#docs"); if (!L) return;
  const folders = [...new Set(docs.map((d) => d.folder))].sort();
  $("#folders").innerHTML = `<button data-f="" class="${folder ? "" : "active"}">All</button>${folders.map((f) => `<button data-f="${esc(f)}" class="${f === folder ? "active" : ""}">${esc(f)}</button>`).join("")}`;
  $$("[data-f]").forEach((b) => b.onclick = () => { folder = b.dataset.f; load(); });
  const shown = docs.filter((d) => !folder || d.folder === folder);
  L.innerHTML = shown.map((d) => `<li class="item clickable ${d.id === openId ? "sel" : ""}" data-d="${d.id}">${icon("documents")}<div class="grow"><div class="clip">${esc(d.name)}</div><div class="meta">${esc(d.folder)} · ${size(d.size)} · ${esc(fmtWhen(d.created_at.replace(" ", "T") + "Z"))}${d.summary ? " · analysed" : ""}</div></div></li>`).join("") || '<li class="empty">No documents yet.</li>';
  $$("[data-d]", L).forEach((li) => li.onclick = () => { openId = Number(li.dataset.d); load(); });
  const el = $("#detail");
  if (!openId) { el.innerHTML = '<article class="panel"><p class="empty">Choose a document.</p></article>'; return; }
  const d = await api(`/api/documents/${openId}`).catch(() => null);
  if (!d) { openId = null; el.innerHTML = ""; return; }
  el.innerHTML = `<article class="panel"><div class="spread wrap"><h3 style="font-size:20px" class="clip">${esc(d.name)}</h3><div class="row"><a class="btn small ghost" href="/api/documents/${d.id}/file" target="_blank" rel="noopener">${icon("external")}Open</a><button class="btn small primary" id="an">${icon("bolt")}${d.summary ? "Re-analyse" : "Analyse"}</button><button class="x" id="del" aria-label="Delete">×</button></div></div>
    <div id="sum" style="margin-top:12px">${d.summary ? `<div class="label">Summary</div><p style="white-space:pre-wrap;line-height:1.6">${esc(d.summary)}</p>` : '<p class="muted">Not analysed yet.</p>'}</div>
    <form class="pill-input" id="ask" style="margin-top:10px"><input id="qq" placeholder="Ask about this document…" aria-label="Question"><button class="icon-btn" aria-label="Ask">${icon("send")}</button></form><div id="answer" style="margin-top:10px"></div>
    ${d.text ? `<details style="margin-top:12px"><summary class="faint" style="cursor:pointer;font-size:12.5px">Extracted text</summary><pre class="mono" style="white-space:pre-wrap;font-size:12px;max-height:340px;overflow:auto">${esc(d.text.slice(0, 20000))}</pre></details>` : ""}</article>`;
  $("#an").onclick = async (e) => { e.target.disabled = true; e.target.textContent = "Analysing…"; try { await api(`/api/documents/${d.id}/analyze`, { method: "POST", body: {} }); load(); } catch (er) { toast(er.message, 6000); e.target.disabled = false; } };
  $("#ask").onsubmit = async (e) => { e.preventDefault(); const q = $("#qq").value.trim(); if (!q) return; $("#answer").innerHTML = '<p class="muted">Reading…</p>'; try { const r = await api(`/api/documents/${d.id}/analyze`, { method: "POST", body: { question: q } }); $("#answer").innerHTML = `<div class="banner info" style="white-space:pre-wrap">${esc(r.text)}</div>`; } catch (er) { $("#answer").innerHTML = `<p class="error">${esc(er.message)}</p>`; } };
  $("#del").onclick = async () => { if (await confirmDialog(`Delete ${d.name}?`, "The file is removed from your laptop.", { ok: "Delete", danger: true })) { await api(`/api/documents/${d.id}`, { method: "DELETE" }); openId = null; load(); } };
}
