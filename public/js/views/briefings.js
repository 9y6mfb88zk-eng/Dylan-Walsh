// Briefings: morning, afternoon, evening and weekly — generated from real data, with history and schedule.
import { api } from "../api.js";
import { voice } from "../voice.js";
import { $, $$, esc, icon, toast, fmtWhen } from "../util.js";

const KINDS = [["morning", "Morning briefing", "Weather, today's schedule, priorities, money, projects and habits."], ["afternoon", "Afternoon update", "The rest of today, progress so far and what still needs doing."], ["evening", "Evening review", "What got done, tomorrow's schedule and weather, and your alarm."], ["weekly", "Weekly review", "Your week in numbers and the week ahead."]];

export async function render(root, ctx, params = {}) {
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Briefings</h2><p>Built only from your real data. Scheduled ones run as routines in Automations.</p></div></div>
    <div class="grid cols-4" id="kinds">${KINDS.map(([k, l, d]) => `<article class="panel tilt"><div class="panel-head"><span class="label">${l}</span></div><p class="muted" style="font-size:13px;min-height:40px">${d}</p><div class="row wrap"><button class="btn small primary" data-run="${k}">${icon("play")}Brief me</button><button class="btn small ghost" data-read="${k}">Read only</button></div><p class="faint" style="font-size:12px;margin:8px 0 0" data-sched="${k}"></p></article>`).join("")}</div>
    <div class="grid cols-2" style="margin-top:14px"><article class="panel" id="latest"><div class="panel-head"><span class="label">Latest</span></div><div class="body"><p class="empty">…</p></div></article>
    <article class="panel"><div class="panel-head"><span class="label">History</span></div><ul class="list" id="hist"></ul></article></div>
    <article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">Morning briefing contents</span><button class="btn small ghost" data-go="settings">Briefing time</button></div><div class="row wrap" id="secs"></div></article>`;
  $$("[data-run]", root).forEach((b) => b.onclick = () => run(ctx, b.dataset.run, true, b));
  $$("[data-read]", root).forEach((b) => b.onclick = () => run(ctx, b.dataset.read, false, b));
  root.querySelector("[data-go]").onclick = () => ctx.go("settings", { section: "voice" });
  await load(ctx);
  if (params.run) run(ctx, params.run, true);
}
export function refresh(e, ctx) { if (e.includes("*") || e.includes("briefing") || e.includes("routines") || e.includes("settings")) load(ctx); }

async function load(ctx) {
  const [hist, r] = await Promise.all([api("/api/briefings?limit=30"), api("/api/routines")]);
  for (const [k] of KINDS) {
    const rt = r.routines.find((x) => x.builtin === k || x.actions.some((a) => a.type === "briefing" && (a.kind || "morning") === k));
    const el = document.querySelector(`[data-sched="${k}"]`);
    if (el) el.textContent = rt ? `${rt.enabled ? "Scheduled" : "Off"} · ${rt.schedule.type} ${rt.schedule.time}${rt.next_local && rt.enabled ? ` · next ${rt.next_local}` : ""}` : "Not scheduled — add it in Automations.";
  }
  const latest = hist[0];
  const L = document.querySelector("#latest .body");
  if (L) L.innerHTML = latest ? `<div class="spread"><span class="pill info">${esc(latest.kind)}</span><span class="faint" style="font-size:12px">${esc(fmtWhen(latest.created_at))}</span></div><p style="white-space:pre-wrap;line-height:1.6">${esc(latest.text)}</p>${latest.sources.length ? `<div class="sources">${latest.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join("")}</div>` : ""}
    <details><summary class="faint" style="cursor:pointer;font-size:12.5px">The facts it was built from</summary><ul class="muted" style="font-size:12.5px">${latest.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>` : '<p class="muted">No briefings yet. Press “Brief me”.</p>';
  const H = document.querySelector("#hist");
  if (H) {
    H.innerHTML = hist.map((b) => `<li class="item clickable" data-b="${b.id}"><div class="grow"><div>${esc(b.text.split(/(?<=[.!?])\s/)[0])}</div><div class="meta">${esc(b.kind)} · ${esc(fmtWhen(b.created_at))}</div></div><button class="btn tiny ghost" data-say="${b.id}">${icon("volume")}</button></li>`).join("") || '<li class="empty">Nothing yet.</li>';
    $$("[data-say]", H).forEach((x) => x.onclick = (e) => { e.stopPropagation(); const b = hist.find((y) => String(y.id) === x.dataset.say); speak(b.text); });
  }
  const sec = ctx.settings.briefing?.sections || {};
  const S = document.querySelector("#secs");
  if (S) {
    S.innerHTML = ["weather", "calendar", "tasks", "finance", "projects", "news"].map((k) => `<label class="chip" style="cursor:pointer"><input type="checkbox" data-sec="${k}" ${sec[k] !== false && !(k === "news" && !sec.news) ? "checked" : ""}> ${k === "news" ? "News (web search)" : k[0].toUpperCase() + k.slice(1)}</label>`).join("");
    $$("[data-sec]", S).forEach((c) => c.onchange = () => api("/api/settings", { method: "PATCH", body: { briefing: { sections: { [c.dataset.sec]: c.checked } } } }).then(() => toast("Saved.")));
  }
}
async function speak(text) { voice.ensureAudio(); const sp = voice.createSpeaker(); sp.push(text); sp.finish(); await sp.done; }
async function run(ctx, kind, aloud, btn) {
  if (btn) btn.disabled = true;
  voice.ensureAudio();
  ctx.core.set("thinking", true);
  try {
    const b = await api(`/api/briefings/${kind}`, { method: "POST", body: { speak: false } });
    ctx.core.set("thinking", false);
    ctx.caption(b.text);
    if (aloud) await speak(b.text);
  } catch (e) { ctx.core.set("thinking", false); toast(e.message, 6000); }
  finally { if (btn) btn.disabled = false; }
}
