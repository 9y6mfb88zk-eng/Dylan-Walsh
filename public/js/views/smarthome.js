// Smart home (Home Assistant): JARVIS only touches devices you allow; locks and doors need a yes every time;
// the state shown after a command is read back from Home Assistant.
import { api } from "../api.js";
import { $, $$, esc, icon, toast, confirmDialog, ago } from "../util.js";

export async function render(root, ctx) {
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Smart Home</h2><p>Optional. Works with Home Assistant on your network.</p></div><div class="row"><button class="btn small" id="disc">${icon("refresh")}Find devices</button><button class="btn small ghost" id="test">Test connection</button></div></div><div id="sh"></div>`;
  $("#disc", root).onclick = async () => { try { const r = await api("/api/smarthome/discover", { method: "POST" }); toast(`${r.devices} devices (${r.added} new — new ones start blocked).`); } catch (e) { toast(e.message, 7000); } };
  $("#test", root).onclick = async () => { const r = await api("/api/diagnostics/test/smarthome", { method: "POST" }); toast(r.ok ? r.detail : `Failed: ${r.detail}`, 7000); load(); };
  await load(ctx);
}
export function refresh(e) { if (e.includes("*") || e.includes("smarthome")) load(); }

async function load(ctx) {
  const d = await api("/api/smarthome");
  const el = $("#sh"); if (!el) return;
  if (!d.configured) {
    el.innerHTML = `<article class="panel" style="max-width:720px"><div class="panel-head"><span class="label">Not set up</span></div><ol class="muted" style="font-size:14px;line-height:1.7"><li>In Home Assistant, open your profile → Security → <b>Long-lived access tokens</b> → Create token.</li><li>${ctx?.desktop ? '<a href="#" id="keys">Open API keys</a>' : "In the Windows app open the tray icon → API keys"} and fill in <b>Home Assistant address</b> (e.g. http://homeassistant.local:8123) and <b>token</b>.</li><li>Come back here and press <b>Find devices</b>, then allow the ones JARVIS may control.</li></ol></article>`;
    $("#keys", el)?.addEventListener("click", (e) => { e.preventDefault(); ctx.desktop.openKeys(); });
    return;
  }
  const allowed = d.devices.filter((x) => x.allowed), blocked = d.devices.filter((x) => !x.allowed);
  el.innerHTML = `<div class="row" style="margin-bottom:12px">${d.status ? `<span class="chip"><span class="dot ${d.status.ok ? "ok" : "bad"}"></span>${d.status.ok ? "Connected" : `Problem: ${esc(d.status.error)}`} · checked ${esc(ago(d.status.at))}</span>` : '<span class="chip"><span class="dot unknown"></span>Not checked yet</span>'}</div>
    <div class="grid cols-3">${allowed.map(card).join("") || '<article class="panel"><p class="empty">No devices allowed yet. Allow some below.</p></article>'}</div>
    <article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">All devices — allowlist</span></div><ul class="list">${d.devices.map((x) => `<li class="item"><div class="grow"><b>${esc(x.name)}</b><div class="meta">${esc(x.entity_id)} · ${esc(x.state)}${x.sensitive ? " · security device (asks every time)" : ""}</div></div><label class="switch" title="Allow JARVIS to control"><input type="checkbox" data-allow="${esc(x.entity_id)}" ${x.allowed ? "checked" : ""}><span></span></label></li>`).join("") || '<li class="empty">Press Find devices.</li>'}</ul></article>`;
  $$("[data-allow]", el).forEach((c) => c.onchange = () => api(`/api/smarthome/${encodeURIComponent(c.dataset.allow)}`, { method: "PATCH", body: { allowed: c.checked } }));
  $$("[data-svc]", el).forEach((b) => b.onclick = async () => {
    const [entity, service] = b.dataset.svc.split("|");
    const dev = d.devices.find((x) => x.entity_id === entity);
    let confirmed = false;
    if (dev.sensitive || service === "unlock" || /garage|gate|door/i.test(entity)) { if (!(await confirmDialog(`${service.replace(/_/g, " ")} ${dev.name}?`, "This is a security device.", { ok: "Yes", danger: true }))) return; confirmed = true; }
    try { const r = await api(`/api/smarthome/${encodeURIComponent(entity)}/control`, { method: "POST", body: { service, confirmed } }); toast(`${r.device}: now ${r.state} (confirmed by Home Assistant).`); } catch (e) { toast(e.message, 7000); }
  });
  void blocked;
}
function card(x) {
  const svc = x.services.filter((s) => !["volume_set", "set_temperature"].includes(s));
  return `<article class="panel tilt"><div class="spread"><b>${esc(x.name)}</b><span class="pill ${["on", "open", "unlocked", "playing"].includes(x.state) ? "live" : ""}">${esc(x.state)}</span></div><div class="faint" style="font-size:12px">${esc(x.domain)}</div><div class="row wrap" style="margin-top:10px">${svc.map((s) => `<button class="btn tiny ${s === "unlock" || s === "open_cover" ? "danger" : ""}" data-svc="${esc(x.entity_id)}|${s}">${esc(s.replace(/_/g, " "))}</button>`).join("")}</div></article>`;
}
