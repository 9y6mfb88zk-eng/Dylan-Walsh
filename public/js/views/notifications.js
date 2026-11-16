// Notification centre: everything JARVIS has told you, with read / snooze / dismiss and full history.
import { api } from "../api.js";
import { $, $$, esc, toast, fmtWhen } from "../util.js";

let filter = "all", showHistory = false;
const KINDS = ["all", "alarm", "reminder", "event", "briefing", "automation", "finance", "research", "focus", "habit", "system", "idea"];

export async function render(root, ctx) {
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Notifications</h2><p>Notifications reach every device: the laptop shows and can speak them; phones get them as push notifications.</p></div>
    <div class="row wrap"><button class="btn small ghost" id="readAll">Mark all read</button><button class="btn small ghost" id="clearAll">Clear all</button><button class="btn small" id="hist">History</button></div></div>
    <div class="seg" id="kinds" style="margin-bottom:14px">${KINDS.map((k) => `<button data-k="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div>
    <div class="grid cols-2"><article class="panel"><ul class="list" id="list"></ul></article>
    <article class="panel"><div class="panel-head"><span class="label">Which notifications reach your phone</span></div><div id="prefs"></div><p class="faint" style="font-size:12px">Switched-off kinds still appear here and on the laptop.</p></article></div>`;
  $$("[data-k]", root).forEach((b) => b.onclick = () => { filter = b.dataset.k; draw(ctx); });
  $("#readAll", root).onclick = () => api("/api/notifications/read-all", { method: "POST" }).then(() => draw(ctx));
  $("#clearAll", root).onclick = () => api("/api/notifications/dismiss-all", { method: "POST" }).then(() => draw(ctx));
  $("#hist", root).onclick = () => { showHistory = !showHistory; $("#hist", root).classList.toggle("primary", showHistory); draw(ctx); };
  await draw(ctx);
}
export function refresh(e, ctx) { if (e.includes("*") || e.includes("notifications") || e.includes("settings")) draw(ctx); }

async function draw(ctx) {
  $$("[data-k]").forEach((b) => b.classList.toggle("active", b.dataset.k === filter));
  const items = showHistory ? await api("/api/notifications/history?limit=500") : (await api("/api/notifications?limit=300")).items;
  const list = items.filter((n) => filter === "all" || n.kind === filter);
  const el = $("#list"); if (!el) return;
  el.innerHTML = list.length ? list.map((n) => `<li class="notif ${n.read_at ? "" : "unread"}" data-id="${n.id}"><div class="spread"><b>${esc(n.title)}</b><span class="pill">${esc(n.kind)}</span></div>${n.body ? `<div class="muted" style="font-size:13px">${esc(n.body)}</div>` : ""}
    <div class="spread"><span class="faint" style="font-size:11.5px">${esc(fmtWhen(n.created_at))}${n.dismissed_at ? " · dismissed" : ""}${n.snooze_until ? ` · snoozed until ${esc(fmtWhen(n.snooze_until))}` : ""}</span>
    ${n.dismissed_at ? "" : `<span class="acts"><button class="btn tiny ghost" data-a="10">10 min</button><button class="btn tiny ghost" data-a="60">1 h</button>${n.read_at ? "" : '<button class="btn tiny ghost" data-a="read">Read</button>'}<button class="btn tiny ghost" data-a="dismiss">Dismiss</button></span>`}</div></li>`).join("") : '<li class="empty">Nothing here.</li>';
  $$("[data-a]", el).forEach((b) => b.onclick = async () => {
    const id = b.closest("[data-id]").dataset.id, a = b.dataset.a;
    if (a === "read") await api(`/api/notifications/${id}/read`, { method: "POST" });
    else if (a === "dismiss") await api(`/api/notifications/${id}/dismiss`, { method: "POST" });
    else { await api(`/api/notifications/${id}/snooze`, { method: "POST", body: { minutes: Number(a) } }); toast(`Snoozed — it'll come back in ${a === "60" ? "an hour" : "10 minutes"}.`); }
    draw(ctx); ctx.refreshBadges();
  });
  const prefs = ctx.settings.notifications || {};
  const P = $("#prefs");
  P.innerHTML = KINDS.slice(1).map((k) => `<div class="set-row" style="padding:7px 0"><span>${k[0].toUpperCase() + k.slice(1)}</span><label class="switch"><input type="checkbox" data-pref="${k}" ${prefs[k] !== false ? "checked" : ""}><span></span></label></div>`).join("");
  $$("[data-pref]", P).forEach((c) => c.onchange = () => api("/api/settings", { method: "PATCH", body: { notifications: { [c.dataset.pref]: c.checked } } }).then(() => toast("Saved.")));
}
