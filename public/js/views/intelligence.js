// Intelligence Centre: sourced research reports in folders, comparisons, saved sources and the idea engine.
import { api } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, ago } from "../util.js";

let tab = "research", openId = null, folder = "";

export async function render(root, ctx, params = {}) {
  if (params.tab === "ideas" || params.idea) tab = "ideas";
  if (params.id || params.focus) { tab = "research"; openId = Number(params.id || params.focus); }
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Intelligence</h2><p>Every claim is cited. Research runs in the background and notifies you when it's ready.</p></div></div>
    <div class="tabs">${[["research", "Research"], ["compare", "Compare"], ["sources", "Saved sources"], ["ideas", "Business ideas"]].map(([k, l]) => `<button data-t="${k}">${l}</button>`).join("")}</div><div id="intel"></div>`;
  $$("[data-t]", root).forEach((b) => b.onclick = () => { tab = b.dataset.t; draw(); });
  await draw(params.idea);
}
export function refresh(e) { if (e.includes("*") || e.includes("research") || e.includes("ideas")) draw(); }

async function draw(focusIdea) {
  $$("[data-t]").forEach((b) => b.classList.toggle("active", b.dataset.t === tab));
  const el = $("#intel"); if (!el) return;
  if (tab === "research") {
    const rs = await api("/api/research");
    const folders = [...new Set(rs.map((r) => r.folder || "General"))].sort();
    const shown = rs.filter((r) => !folder || (r.folder || "General") === folder);
    el.innerHTML = `<form class="composer" id="rf" style="width:100%;margin:0 0 12px"><div class="pill-input"><input id="rq" placeholder="What should I research? e.g. best low-cost businesses to start in Larnaca" aria-label="Research topic"><button class="icon-btn" aria-label="Start">${icon("send")}</button></div></form>
      <div class="seg" style="margin-bottom:12px"><button data-f="" class="${folder ? "" : "active"}">All</button>${folders.map((f) => `<button data-f="${esc(f)}" class="${f === folder ? "active" : ""}">${esc(f)}</button>`).join("")}</div>
      <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,2fr)" id="rGrid"><div class="stack">${shown.map((r) => `<button class="panel tilt" style="text-align:left;${r.id === openId ? "border-color:var(--edge-2);box-shadow:var(--glow)" : ""}" data-r="${r.id}"><div>${esc(r.query.replace(/^Compare /, "⚖ "))}</div><div class="meta muted" style="font-size:12px">${r.status === "running" ? '<span class="dot live"></span> researching…' : r.status === "failed" ? `<span style="color:var(--bad)">failed: ${esc(r.error || "")}</span>` : `${r.sources.length} sources · ${ago(r.created_at)}`} · ${esc(r.folder || "General")}</div></button>`).join("") || '<p class="empty">No reports yet.</p>'}</div><div id="rDetail"></div></div>`;
    if (matchMedia("(max-width: 900px)").matches) $("#rGrid").style.gridTemplateColumns = "minmax(0,1fr)";
    $$("[data-f]", el).forEach((b) => b.onclick = () => { folder = b.dataset.f; draw(); });
    $("#rf").onsubmit = async (e) => { e.preventDefault(); const q = $("#rq").value.trim(); if (!q) return; try { const r = await api("/api/research", { method: "POST", body: { query: q } }); openId = r.id; toast("Researching. I'll let you know when it's ready."); draw(); } catch (err) { toast(err.message); } };
    $$("[data-r]").forEach((b) => b.onclick = () => { openId = Number(b.dataset.r); draw(); });
    const r = rs.find((x) => x.id === openId) || shown.find((x) => x.status === "done");
    if (r) {
      $("#rDetail").innerHTML = `<article class="panel"><div class="spread"><h3 style="font-size:20px">${esc(r.query)}</h3><div class="row"><button class="btn tiny ghost" id="rMove">${icon("projects")}${esc(r.folder || "General")}</button><button class="x" id="rDel" aria-label="Delete">×</button></div></div>
        ${r.status === "done" ? `<div style="margin-top:10px;white-space:pre-wrap;line-height:1.6">${esc(r.report)}</div><div class="label" style="margin-top:14px">Sources</div><ol style="font-size:13px">${r.sources.map((s, i) => `<li style="margin:4px 0"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span class="faint">${esc(new URL(s.url).hostname)}</span> <button class="btn tiny ghost" data-save="${i}">Save</button></li>`).join("") || "<li class='faint'>No sources were returned.</li>"}</ol>` : `<p class="muted">${r.status === "running" ? "Still researching…" : esc(r.error || "")}</p>`}</article>`;
      $("#rDel").onclick = async () => { if (await confirmDialog("Delete this report?", "", { ok: "Delete", danger: true })) { await api(`/api/research/${r.id}`, { method: "DELETE" }); openId = null; draw(); } };
      $("#rMove").onclick = async () => { const v = await formDialog("Move to folder", [{ name: "folder", label: "Folder", value: r.folder || "General", required: true }]); if (v) api(`/api/research/${r.id}`, { method: "PATCH", body: { folder: v.folder } }); };
      $$("[data-save]").forEach((b) => b.onclick = async () => { const s = r.sources[Number(b.dataset.save)]; await api("/api/sources", { method: "POST", body: { url: s.url, title: s.title, folder: r.folder || "General", research_id: r.id } }); b.textContent = "Saved"; b.disabled = true; });
    }
    return;
  }
  if (tab === "compare") {
    el.innerHTML = `<article class="panel" style="max-width:760px"><div class="panel-head"><span class="label">Compare options</span></div><p class="muted" style="margin-top:0">JARVIS researches each option with web search and gives you a sourced comparison and a recommendation.</p>
      <form class="stack" id="cf"><label class="field"><span>Options (one per line, 2–5)</span><textarea class="inp" id="items" placeholder="iPhone 17 Pro\nPixel 11 Pro\nGalaxy S26"></textarea></label><label class="field"><span>What matters to you (optional)</span><input class="inp" id="crit" placeholder="battery life, camera, price in Cyprus"></label><div class="row end"><button class="btn primary">Compare</button></div></form></article>`;
    $("#cf").onsubmit = async (e) => { e.preventDefault(); try { const r = await api("/api/research/compare", { method: "POST", body: { items: $("#items").value.split("\n"), criteria: $("#crit").value } }); openId = r.id; tab = "research"; folder = ""; toast("Comparing. I'll let you know when it's ready."); draw(); } catch (err) { toast(err.message); } };
    return;
  }
  if (tab === "sources") {
    const ss = await api("/api/sources");
    el.innerHTML = `<div class="row end" style="margin-bottom:10px"><button class="btn small" id="addS">${icon("plus")}Source</button></div><article class="panel"><ul class="list">${ss.map((s) => `<li class="item"><div class="grow"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a><div class="meta">${esc(new URL(s.url).hostname)} · ${esc(s.folder)}${s.note ? ` · ${esc(s.note)}` : ""}</div></div><button class="x" data-dels="${s.id}" aria-label="Delete">×</button></li>`).join("") || '<li class="empty">Save sources from research reports, or add your own.</li>'}</ul></article>`;
    $("#addS").onclick = async () => { const v = await formDialog("Save a source", [{ name: "url", label: "Web address", type: "url", required: true }, { name: "title", label: "Title" }, { name: "folder", label: "Folder", value: "General" }, { name: "note", label: "Note" }]); if (v) { try { await api("/api/sources", { method: "POST", body: v }); draw(); } catch (e) { toast(e.message); } } };
    $$("[data-dels]").forEach((b) => b.onclick = async () => { await api(`/api/sources/${b.dataset.dels}`, { method: "DELETE" }); draw(); });
    return;
  }
  const { ideas, lastRun, settings } = await api("/api/ideas");
  el.innerHTML = `<div class="spread wrap" style="margin-bottom:10px"><p class="muted" style="margin:0">${settings.enabled ? `A fresh idea every ${settings.everyMinutes} minutes · last run ${lastRun ? ago(new Date(lastRun).toISOString()) : "never"}` : "The idea engine is switched off in Settings."}</p><button class="btn small primary" id="gen">New idea now</button></div>
    <div class="grid cols-2">${ideas.map((i) => `<article class="panel tilt" id="idea-${i.id}"><div class="faint" style="font-size:12px">${ago(i.created_at)}${i.budget ? ` · ${esc(i.budget)}` : ""}</div><h3 style="margin:4px 0 6px;font-size:20px">${esc(i.title)}</h3><p style="margin:4px 0">${esc(i.pitch)}</p>${i.why_now ? `<p class="muted" style="margin:4px 0;font-size:14px">${esc(i.why_now)}</p>` : ""}<ol style="font-size:14px">${i.mvp.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div class="banner info" style="margin:8px 0"><b>First move this week:</b> ${esc(i.first_move)}</div><div class="spread"><button class="btn small" data-task="${i.id}" ${i.added_to_tasks ? "disabled" : ""}>${i.added_to_tasks ? "Added to tasks" : "Add first move to tasks"}</button><button class="x" data-del="${i.id}" aria-label="Dismiss">×</button></div></article>`).join("") || '<p class="empty">No ideas yet.</p>'}</div>`;
  $("#gen").onclick = async (e) => { e.target.disabled = true; e.target.textContent = "Thinking…"; try { await api("/api/ideas/generate", { method: "POST" }); } catch (err) { toast(err.message); } draw(); };
  $$("[data-task]").forEach((b) => b.onclick = async () => { await api(`/api/ideas/${b.dataset.task}/task`, { method: "POST" }); toast("Added to your tasks."); draw(); });
  $$("[data-del]").forEach((b) => b.onclick = async () => { await api(`/api/ideas/${b.dataset.del}`, { method: "DELETE" }); draw(); });
  if (focusIdea) document.getElementById(`idea-${focusIdea}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}
