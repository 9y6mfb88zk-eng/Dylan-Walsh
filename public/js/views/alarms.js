// Alarm Centre: one-off and recurring alarms, sounds (with your own uploads), testing, history and reliability.
import { api } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, fmtWhen, fmtRel, DAYS } from "../util.js";

let data = null, CTX = null, preview = null;
const REPEAT = { once: "Once", daily: "Every day", weekdays: "Weekdays", weekends: "Weekends", custom: "Custom" };
const repeatText = (a) => (a.repeat === "custom" ? a.days.map((d) => DAYS[d]).join(", ") : a.repeat === "once" ? (a.date ? new Date(a.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "Once") : REPEAT[a.repeat]);

export async function render(root, ctx, params = {}) {
  CTX = ctx;
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Alarm Centre</h2><p id="nextLine">…</p></div>
    <div class="row wrap"><button class="btn small" id="test">${icon("volume")}Test alarm</button><button class="btn small primary" id="add">${icon("plus")}New alarm</button></div></div>
    <div id="ringing"></div>
    <div class="grid cols-2"><article class="panel"><div class="panel-head"><span class="label">Alarms</span></div><ul class="list" id="list"></ul></article>
      <div class="stack"><article class="panel"><div class="panel-head"><span class="label">Sounds</span><label class="btn small" style="cursor:pointer">${icon("upload")}Upload<input type="file" id="upload" accept="audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/x-m4a,audio/aac" hidden></label></div><ul class="list" id="sounds"></ul></article>
      <article class="panel"><div class="panel-head"><span class="label">Reliability</span></div><div id="rel"></div></article></div></div>
    <article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">History</span></div><div class="scroll-x"><table class="tbl" id="hist"></table></div></article>`;
  $("#add", root).onclick = () => edit();
  $("#test", root).onclick = async () => { const r = await api("/api/alarms/test", { method: "POST", body: {} }); toast(!r.sent ? "This device isn't connected live — reload and try again." : ctx.desktop ? "Test alarm ringing on this laptop." : "Test alarm ringing on this device."); };
  $("#upload", root).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { await api(`/api/alarms/sounds?name=${encodeURIComponent(f.name.replace(/\.[^.]+$/, "").slice(0, 60))}`, { method: "POST", raw: f, headers: { "content-type": f.type || "audio/mpeg" } }); toast("Sound added."); }
    catch (er) { toast(er.message); }
    e.target.value = "";
  };
  await load();
  if (params.new) edit();
  const t = setInterval(() => $$("[data-count]").forEach((el) => { el.textContent = fmtRel(el.dataset.count); }), 15_000);
  return () => { clearInterval(t); preview?.pause(); };
}
export function refresh(e) { if (e.includes("*") || e.includes("alarms") || e.includes("health")) load(); }

async function load() {
  const [d, hist] = await Promise.all([api("/api/alarms"), api("/api/alarms/history?limit=60")]);
  data = d;
  const L = $("#list"); if (!L) return;
  const next = d.alarms.filter((a) => a.enabled && a.effective_next).sort((a, b) => a.effective_next.localeCompare(b.effective_next))[0];
  $("#nextLine").innerHTML = next ? `Next: <b>${esc(next.label)}</b> ${esc(next.next_local)} · <span data-count="${esc(next.effective_next)}">${esc(fmtRel(next.effective_next))}</span>` : "No alarm is scheduled.";
  $("#ringing").innerHTML = d.ringing.map((r) => `<div class="banner" style="display:flex;align-items:center;gap:10px;justify-content:space-between">⏰ <b>${esc(r.label)}</b> is ringing <span class="row"><button class="btn small" data-snz="${r.alarm_id}">Snooze</button><button class="btn small primary" data-dis="${r.alarm_id}">Dismiss</button></span></div>`).join("");
  L.innerHTML = d.alarms.length ? d.alarms.map((a) => `<li class="item" style="${a.enabled ? "" : "opacity:.55"}">
    <div class="mono" style="font-size:26px;color:var(--white);min-width:84px">${esc(a.time)}</div>
    <div class="grow"><div><b>${esc(a.label)}</b> <span class="pill">${esc(repeatText(a))}</span>${a.snoozed_until ? ' <span class="pill warn">snoozed</span>' : ""}</div>
      <div class="meta">${a.enabled && a.effective_next ? `${esc(a.next_local)} · <span data-count="${esc(a.effective_next)}">${esc(fmtRel(a.effective_next))}</span>` : a.enabled ? "not scheduled" : "off"} · ${esc(a.sound_name)} · ${a.volume}%${a.gradual ? " rising" : ""}</div></div>
    <label class="switch" title="On/off"><input type="checkbox" data-en="${a.id}" ${a.enabled ? "checked" : ""}><span></span></label>
    <button class="btn tiny ghost" data-edit="${a.id}">${icon("edit")}</button><button class="x" data-del="${a.id}" aria-label="Delete">×</button></li>`).join("") : '<li class="empty">No alarms yet. Tell JARVIS “Wake me at seven”, or press New alarm.</li>';
  $$("[data-en]").forEach((c) => c.onchange = () => api(`/api/alarms/${c.dataset.en}`, { method: "PATCH", body: { enabled: c.checked } }).catch((e) => toast(e.message)));
  $$("[data-edit]").forEach((b) => b.onclick = () => edit(d.alarms.find((a) => String(a.id) === b.dataset.edit)));
  $$("[data-del]").forEach((b) => b.onclick = async () => { if (await confirmDialog("Delete this alarm?", "It won't ring again.", { ok: "Delete", danger: true })) api(`/api/alarms/${b.dataset.del}`, { method: "DELETE" }); });
  $$("[data-snz]").forEach((b) => b.onclick = () => api(`/api/alarms/${b.dataset.snz}/snooze`, { method: "POST", body: {} }));
  $$("[data-dis]").forEach((b) => b.onclick = () => api(`/api/alarms/${b.dataset.dis}/dismiss`, { method: "POST" }));
  $("#sounds").innerHTML = d.sounds.map((s) => `<li class="item"><button class="btn tiny" data-play="${esc(s.url)}">${icon("play")}</button><div class="grow">${esc(s.name)} ${s.builtin ? '<span class="pill">built in</span>' : '<span class="pill info">yours</span>'}</div>${s.builtin ? "" : `<button class="x" data-delsound="${esc(s.id.slice(7))}" aria-label="Delete">×</button>`}</li>`).join("");
  $$("[data-play]").forEach((b) => b.onclick = () => { if (preview && !preview.paused) { preview.pause(); preview = null; return; } preview = new Audio(b.dataset.play); preview.volume = 0.7; preview.play().catch((e) => toast(e.message)); });
  $$("[data-delsound]").forEach((b) => b.onclick = async () => { if (await confirmDialog("Delete this sound?", "Alarms using it will switch to Chime.", { ok: "Delete", danger: true })) api(`/api/alarms/sounds/${b.dataset.delsound}`, { method: "DELETE" }); });
  const ag = CTX.agent?.alarms;
  $("#rel").innerHTML = `<div class="stack" style="gap:8px;font-size:13.5px">
    ${CTX.desktop ? `<div class="row">${ag?.ready ? '<span class="dot ok"></span>' : '<span class="dot warn"></span>'}<span>${ag?.ready ? `This laptop's alarm agent has ${ag.scheduled} alarm${ag.scheduled === 1 ? "" : "s"} loaded${ag.lastSync ? ` (synced ${esc(fmtRel(ag.lastSync))})` : ""}.` : "This laptop's alarm agent is starting…"}</span></div>
      <div class="row">${ag?.wakeTask === "ok" ? '<span class="dot ok"></span>' : ag?.wakeTask === "error" ? '<span class="dot bad"></span>' : '<span class="dot unknown"></span>'}<span>${ag?.wakeTask === "ok" ? `Windows will wake the laptop for the next alarm${ag.wakeAt ? ` (${esc(fmtWhen(ag.wakeAt))})` : ""}.` : ag?.wakeTask === "error" ? `Couldn't schedule the wake-up: ${esc(ag.wakeError || "unknown error")}` : "Wake-from-sleep scheduling not reported yet."}</span></div>
      <div class="row">${ag?.audioVerifiedAt ? '<span class="dot ok"></span>' : '<span class="dot unknown"></span>'}<span>${ag?.audioVerifiedAt ? `Alarm audio verified playing ${esc(fmtRel(ag.audioVerifiedAt))}.` : "Press Test alarm to verify the speakers."}</span></div>`
    : '<div class="row"><span class="dot warn"></span><span>On this device alarms ring while JARVIS is open, and arrive as notifications otherwise. For guaranteed alarms keep the Windows app installed on your laptop.</span></div>'}
    <details><summary class="faint" style="cursor:pointer">What works when</summary><ul class="muted" style="font-size:12.5px;padding-left:18px">
      <li><b>Window closed:</b> alarms still ring — JARVIS keeps running in the tray.</li>
      <li><b>Laptop asleep:</b> Windows wakes the laptop for the alarm (needs “Allow wake timers” on in Power Options, which is the default when plugged in).</li>
      <li><b>Laptop off or hibernating, or battery dead:</b> no software alarm can ring. Your phone still gets the notification if it's connected.</li>
      <li><b>JARVIS quit from the tray:</b> the scheduled wake-up still starts JARVIS for the next alarm.</li>
      <li>If JARVIS was off and an alarm is more than 15 minutes late, it's logged as missed instead of ringing late.</li></ul></details></div>`;
  const ev = { rang: ["rang", "info"], snoozed: ["snoozed", "warn"], dismissed: ["dismissed", "ok"], missed: ["missed", "bad"], test: ["test", ""], audio_verified: ["audio verified", "ok"], audio_failed: ["audio failed", "bad"], spoken: ["spoken", ""] };
  $("#hist").innerHTML = `<thead><tr><th>When</th><th>Alarm</th><th>Event</th><th>Device</th><th>Detail</th></tr></thead><tbody>${hist.map((h) => `<tr><td class="mono faint">${esc(fmtWhen(h.at))}</td><td>${esc(h.label || "")}</td><td><span class="pill ${ev[h.event]?.[1] || ""}">${esc(ev[h.event]?.[0] || h.event)}</span></td><td class="faint">${esc(h.device_id === "server" ? "server" : h.device_id ? "laptop/phone" : "")}</td><td class="faint">${esc(h.detail || "")}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">No alarm activity yet.</td></tr>'}</tbody>`;
}

async function edit(a = null) {
  const d = data?.defaults || {};
  const v = await formDialog(a ? "Edit alarm" : "New alarm", [
    { name: "time", label: "Time", type: "time", value: a?.time || "07:00", required: true },
    { name: "label", label: "Label", value: a?.label || "Wake up" },
    { name: "repeat", label: "Repeat", type: "select", value: a?.repeat || "once", options: Object.entries(REPEAT) },
    { name: "days", label: "Custom days (when Repeat is Custom)", type: "days", value: a?.days || [] },
    { name: "date", label: "Date (one-off; blank = next time it comes round)", type: "date", value: a?.repeat === "once" ? a?.date || "" : "" },
    { name: "sound", label: "Sound", type: "select", value: a?.sound || d.defaultSound || "chime", options: (data?.sounds || []).map((s) => [s.id, s.name]) },
    { name: "volume", label: "Volume (%)", type: "range", value: a?.volume ?? d.defaultVolume ?? 80, min: 5, max: 100 },
    { name: "gradual", label: "Start quietly and get louder", type: "checkbox", value: a ? a.gradual : d.gradual !== false },
    { name: "snooze_minutes", label: "Snooze length (minutes)", type: "number", value: a?.snooze_minutes ?? d.snoozeMinutes ?? 10, min: 1, max: 60 },
    { name: "message", label: "Spoken message (optional)", value: a?.message || "", placeholder: "Time to wake up." },
  ], { ok: a ? "Save" : "Set alarm" });
  if (!v) return;
  const body = { ...v, volume: Number(v.volume), snooze_minutes: Number(v.snooze_minutes), date: v.repeat === "once" ? v.date || null : null };
  try { const r = a ? await api(`/api/alarms/${a.id}`, { method: "PATCH", body }) : await api("/api/alarms", { method: "POST", body }); toast(r.enabled && r.next_local ? `Alarm set for ${r.next_local}.` : "Saved."); }
  catch (e) { toast(e.message, 6000); }
}
