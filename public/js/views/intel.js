// Research reports (sourced) and the background idea engine.
import { api } from "../api.js";
import { $, $$, esc, toast, ago } from "../util.js";

let tab = "research", openId = null;

export async function render(root, ctx, params = {}) {
  if (params.tab === "ideas" || params.idea) tab = "ideas";
  if (params.id) { tab = "research"; openId = Number(params.id); }
  root.innerHTML = `<div class="spread" style="margin-bottom:12px"><h2 class="title">Research</h2></div>
    <div class="tabs"><button data-t="research">Research reports</button><button data-t="ideas">Business ideas</button></div><div id="intel"></div>`;
  $$("[data-t]", root).forEach((b) => b.onclick = () => { tab = b.dataset.t; draw(); });
  await draw(params.idea);
}
export function refresh(e) { if (e.includes("*") || e.includes("research") || e.includes("ideas")) draw(); }

async function draw(focusIdea) {
  $$("[data-t]").forEach((b) => b.classList.toggle("active", b.dataset.t === tab));
  const el = $("#intel"); if (!el) return;
  if (tab === "research") {
    const rs = await api("/api/research");
    el.innerHTML = `<form class="composer" id="rf" style="width:100%;margin:0 0 14px"><div class="pill-input glass"><input id="rq" placeholder="What should I research? e.g. best low-cost businesses to start in Larnaca" aria-label="Research topic"><button class="icon-btn" aria-label="Start">→</button></div></form>
      <p class="faint" style="font-size:13px;margin-top:-6px">JARVIS searches the web, compares sources and cites every claim. Reports run in the background; you'll get a notification.</p>
      <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,2fr)" id="rGrid"><div class="stack">${rs.map((r) => `<button class="glass panel" style="text-align:left;${r.id === openId ? "border-color:var(--violet-2)" : ""}" data-r="${r.id}"><div>${esc(r.query)}</div><div class="meta muted" style="font-size:12px">${r.status === "running" ? '<span class="dot live" style="display:inline-block"></span> researching…' : r.status === "failed" ? `<span style="color:var(--bad)">failed: ${esc(r.error || "")}</span>` : `${r.sources.length} sources · ${ago(r.created_at)}`}</div></button>`).join("") || '<p class="empty">No reports yet.</p>'}</div><div id="rDetail"></div></div>`;
    if (matchMedia("(max-width: 900px)").matches) $("#rGrid").style.gridTemplateColumns = "minmax(0,1fr)";
    $("#rf").onsubmit = async (e) => { e.preventDefault(); const q = $("#rq").value.trim(); if (!q) return; try { const r = await api("/api/research", { method: "POST", body: { query: q } }); openId = r.id; toast("Researching, sir. I'll let you know."); draw(); } catch (err) { toast(err.message); } };
    $$("[data-r]").forEach((b) => b.onclick = () => { openId = Number(b.dataset.r); draw(); });
    const r = rs.find((x) => x.id === openId) || rs.find((x) => x.status === "done");
    if (r) $("#rDetail").innerHTML = `<article class="glass panel"><div class="spread"><h3>${esc(r.query)}</h3><button class="x" id="rDel" aria-label="Delete">×</button></div>
      ${r.status === "done" ? `<div class="report" style="margin-top:10px">${esc(r.report)}</div><div class="label" style="margin-top:14px">Sources</div><ol style="font-size:13px">${r.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span class="faint">${esc(new URL(s.url).hostname)}</span></li>`).join("") || "<li class='faint'>No sources were returned.</li>"}</ol>` : `<p class="muted">${r.status === "running" ? "Still researching…" : esc(r.error || "")}</p>`}</article>`;
    $("#rDel")?.addEventListener("click", async () => { await api(`/api/research/${r.id}`, { method: "DELETE" }); openId = null; draw(); });
    return;
  }
  const { ideas, lastRun, settings } = await api("/api/ideas");
  el.innerHTML = `<div class="spread" style="margin-bottom:10px"><p class="muted" style="margin:0">${settings.enabled ? `A fresh idea every ${settings.everyMinutes} minutes · last run ${lastRun ? ago(new Date(lastRun).toISOString()) : "never"}` : "The idea engine is switched off in Settings."}</p><button class="btn small primary" id="gen">New idea now</button></div>
    <div class="cards">${ideas.map((i) => `<article class="glass card" id="idea-${i.id}"><div class="faint" style="font-size:12px">${ago(i.created_at)}${i.budget ? ` · ${esc(i.budget)}` : ""}</div><h3 style="margin:4px 0 6px">${esc(i.title)}</h3><p style="margin:4px 0">${esc(i.pitch)}</p>${i.why_now ? `<p class="muted" style="margin:4px 0;font-size:14px">${esc(i.why_now)}</p>` : ""}<ol>${i.mvp.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div class="callout"><b>First move this week</b>${esc(i.first_move)}</div><div class="spread" style="margin-top:10px"><button class="btn small" data-task="${i.id}" ${i.added_to_tasks ? "disabled" : ""}>${i.added_to_tasks ? "Added to tasks" : "Add first move to tasks"}</button><button class="x" data-del="${i.id}" aria-label="Dismiss">×</button></div></article>`).join("") || '<p class="empty">No ideas yet.</p>'}</div>`;
  $("#gen").onclick = async (e) => { e.target.disabled = true; e.target.textContent = "Thinking…"; try { await api("/api/ideas/generate", { method: "POST" }); } catch (err) { toast(err.message); } draw(); };
  $$("[data-task]").forEach((b) => b.onclick = async () => { await api(`/api/ideas/${b.dataset.task}/task`, { method: "POST" }); toast("Added to your tasks, sir."); draw(); });
  $$("[data-del]").forEach((b) => b.onclick = async () => { await api(`/api/ideas/${b.dataset.del}`, { method: "DELETE" }); draw(); });
  if (focusIdea) document.getElementById(`idea-${focusIdea}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}
