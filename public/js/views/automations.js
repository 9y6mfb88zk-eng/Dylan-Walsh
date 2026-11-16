// Automations: routines made of safe steps, on a schedule — with every run's real output.
import { api } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, fmtWhen, DAYS } from "../util.js";

const SCHED = { manual: "Only when asked (command macro)", daily: "Every day", weekdays: "Weekdays", weekends: "Weekends", weekly: "Weekly", custom: "Custom days" };
const STEP_FIELDS = {
  briefing: (s) => `${s.kind || "morning"} briefing`, notify: (s) => `notify “${s.title || ""}”`, speak: (s) => `say “${s.text || ""}”`, sync: (s) => `sync ${s.target}`,
  backup: () => "back up the database", focus: (s) => `focus ${s.minutes || 25} min`, computer: (s) => `laptop: ${s.action}`, smarthome: (s) => `${s.service} ${s.entity_id}`,
  ui: (s) => (s.action === "set_mode" ? `${s.mode} mode` : s.action === "open_section" ? `open ${s.section}` : s.action.replace(/_/g, " ")), diagnostics: (s) => `${s.level || "quick"} systems check`,
};
const stepLine = (a) => a.type === "ui" ? `ui: ${a.action}${a.section ? ` ${a.section}` : ""}${a.mode ? ` ${a.mode}` : ""}` : a.type === "diagnostics" ? `diagnostics: ${a.level || "quick"}` : [a.type, a.kind || a.target || a.title || a.text || a.action || a.minutes || ""].join(": ");
const schedText = (r) => r.schedule.type === "manual" ? (r.trigger_phrase ? `Say “JARVIS, ${r.trigger_phrase}”` : "Run by hand or by voice") : `${SCHED[r.schedule.type] || r.schedule.type}${["weekly", "custom"].includes(r.schedule.type) ? ` (${r.schedule.days.map((d) => DAYS[d]).join(", ")})` : ""} at ${r.schedule.time}`;

export async function render(root) {
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Automations</h2><p>Routines run on the server on schedule, even when no app is open. Missed by more than two hours (laptop off) → skipped and logged.</p></div><button class="btn small primary" id="add">${icon("plus")}Routine</button></div>
    <div class="grid cols-2"><div class="stack" id="list"></div><article class="panel"><div class="panel-head"><span class="label">Run history</span></div><ul class="list" id="runs"></ul></article></div>`;
  $("#add", root).onclick = () => edit();
  await load();
}
export function refresh(e) { if (e.includes("*") || e.includes("routines")) load(); }

let D = null;
async function load() {
  D = await api("/api/routines");
  const L = $("#list"); if (!L) return;
  L.innerHTML = D.routines.map((r) => `<article class="panel tilt" style="${r.enabled ? "" : "opacity:.6"}"><div class="spread"><div><b style="font-size:16px">${esc(r.name)}</b> ${r.builtin ? '<span class="pill">built in</span>' : ""}<div class="meta muted" style="font-size:12.5px">${esc(schedText(r))}${r.enabled && r.next_local ? ` · next ${esc(r.next_local)}` : ""}</div></div><label class="switch"><input type="checkbox" data-en="${r.id}" ${r.enabled ? "checked" : ""}><span></span></label></div>
      ${r.description ? `<p class="muted" style="font-size:13px;margin:8px 0">${esc(r.description)}</p>` : ""}
      <div class="row wrap" style="margin-top:6px">${r.actions.map((a) => `<span class="pill info">${esc(STEP_FIELDS[a.type]?.(a) || a.type)}</span>`).join("")}</div>
      <div class="spread" style="margin-top:10px"><span class="faint" style="font-size:12px">${r.lastRun ? `last run ${esc(fmtWhen(r.lastRun.started_at))} · ${esc(r.lastRun.status)}` : "never run"}</span><div class="row"><button class="btn tiny" data-run="${r.id}">${icon("play")}Run now</button><button class="btn tiny ghost" data-edit="${r.id}">${icon("edit")}</button></div></div></article>`).join("");
  $$("[data-en]", L).forEach((c) => c.onchange = () => api(`/api/routines/${c.dataset.en}`, { method: "PATCH", body: { enabled: c.checked } }));
  $$("[data-run]", L).forEach((b) => b.onclick = async () => { b.disabled = true; b.textContent = "Running…"; try { const r = await api(`/api/routines/${b.dataset.run}/run`, { method: "POST" }); toast(r.status === "ok" ? "Routine ran — all steps OK." : `Routine finished with problems: ${(r.output || []).filter((l) => l.startsWith("✗")).join(" ")}`, 7000); } catch (e) { toast(e.message); } load(); });
  $$("[data-edit]", L).forEach((b) => b.onclick = () => edit(D.routines.find((r) => String(r.id) === b.dataset.edit)));
  $("#runs").innerHTML = D.runs.map((r) => `<li class="item" style="display:grid;gap:4px"><div class="spread"><b>${esc(r.name)}</b><span class="pill ${r.status === "ok" ? "ok" : r.status === "running" ? "live" : r.status === "skipped" ? "" : "bad"}">${esc(r.status)}</span></div><div class="meta">${esc(fmtWhen(r.started_at))} · ${esc(r.trigger)}</div>${r.output ? `<pre class="mono" style="white-space:pre-wrap;font-size:11.5px;margin:0;color:var(--muted)">${esc(r.output)}</pre>` : ""}</li>`).join("") || '<li class="empty">No runs yet.</li>';
}

async function edit(r = null) {
  const steps = (r?.actions || [{ type: "notify", title: "", body: "" }]).map(stepLine).join("\n");
  const v = await formDialog(r ? `Edit “${r.name}”` : "New routine", [
    { name: "name", label: "Name", value: r?.name || "", required: true },
    { name: "description", label: "Description", value: r?.description || "" },
    { name: "type", label: "When", type: "select", value: r?.schedule.type || "daily", options: Object.entries(SCHED) },
    { name: "trigger_phrase", label: "Voice trigger (macros) — e.g. “start my working session”", value: r?.trigger_phrase || "" },
    { name: "time", label: "Time (scheduled routines)", type: "time", value: r?.schedule.time || "08:00" },
    { name: "days", label: "Days (weekly / custom)", type: "days", value: r?.schedule.days || [] },
    { name: "steps", label: "Steps — one per line: briefing: morning|evening|weekly · notify: text · speak: text · sync: finance|calendar|weather · backup · focus: minutes · diagnostics: quick · ui: open_section projects | set_mode focus | mission_control_on. Laptop and smart-home steps ask for a spoken yes when started by voice.", type: "textarea", value: steps },
    ...(r && !r.builtin ? [{ name: "remove", label: "Delete this routine", type: "checkbox", value: false }] : []),
  ]);
  if (!v) return;
  if (r && v.remove) { if (await confirmDialog(`Delete “${r.name}”?`, "Its history is kept.", { ok: "Delete", danger: true })) api(`/api/routines/${r.id}`, { method: "DELETE" }).catch((e) => toast(e.message)); return; }
  const actions = v.steps.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [type, ...rest] = l.split(":"); const arg = rest.join(":").trim(); const t = type.trim().toLowerCase();
    if (t === "briefing") return { type: t, kind: arg || "morning" };
    if (t === "notify") return { type: t, title: arg || v.name, body: "" };
    if (t === "speak") return { type: t, text: arg };
    if (t === "sync") return { type: t, target: arg || "weather" };
    if (t === "focus") return { type: t, minutes: Number(arg) || 25 };
    if (t === "diagnostics") return { type: t, level: arg || "quick" };
    if (t === "ui") { const [action, x] = arg.split(/\s+/); return { type: t, action, ...(action === "set_mode" ? { mode: x } : action === "open_section" ? { section: x } : {}) }; }
    // Laptop / smart-home steps keep their saved details (they're created by JARVIS or the API, not typed here).
    const orig = (r?.actions || []).find((a) => a.type === t && (a.action || a.service || "") === (arg.split(" ")[0] || a.action || a.service || ""));
    return orig || { type: t };
  });
  const body = { name: v.name, description: v.description, trigger_phrase: v.trigger_phrase, schedule: { type: v.type, time: v.time, days: v.days }, actions };
  try { r ? await api(`/api/routines/${r.id}`, { method: "PATCH", body }) : await api("/api/routines", { method: "POST", body }); toast("Saved."); } catch (e) { toast(e.message, 6000); }
}
