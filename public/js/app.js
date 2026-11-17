// JARVIS client shell: auth, 21-section navigation, system bar, command palette, notification centre, voice HUD,
// alarm overlay, live sync and the Windows-app bridge.
import { api, onAuthEvent, outboxSize } from "./api.js";
import * as sync from "./sync.js";
import { voice } from "./voice.js";
import { core, STATE_LABEL } from "./corestate.js";
import { conversation, cleanCommand } from "./conversation.js";
import { mountCore } from "./core.js";
import { mission } from "./mission.js";
import { handleUi, tryMacro } from "./commands.js";
import { beginStartup } from "./startup.js";
import { showInstallGuide, offerNotifications, isIOS } from "./iphone.js";
import { $, $$, esc, toast, icon, fmtWhen, debounce, setDisplayTz } from "./util.js";

const desktop = window.jarvisDesktop || null;           // present only inside the Windows app
const isPhone = () => matchMedia("(max-width: 900px)").matches;

// ---------------------------------------------------------------- Sections (21)
export const SECTIONS = [
  { group: "Core" },
  { id: "home", label: "Command Centre", icon: "home", load: () => import("./views/home.js") },
  { id: "talk", label: "Conversation", icon: "talk", load: () => import("./views/talk.js") },
  { id: "briefings", label: "Briefings", icon: "briefing", load: () => import("./views/briefings.js") },
  { id: "notifications", label: "Notifications", icon: "notifications", load: () => import("./views/notifications.js") },
  { group: "Time" },
  { id: "alarms", label: "Alarm Centre", icon: "alarm", load: () => import("./views/alarms.js") },
  { id: "calendar", label: "Calendar", icon: "calendar", load: () => import("./views/calendar.js") },
  { id: "tasks", label: "Tasks & Reminders", icon: "tasks", load: () => import("./views/tasks.js") },
  { id: "focus", label: "Focus", icon: "focus", load: () => import("./views/focus.js") },
  { id: "goals", label: "Goals & Habits", icon: "goals", load: () => import("./views/goals.js") },
  { group: "Work" },
  { id: "projects", label: "Projects", icon: "projects", load: () => import("./views/projects.js") },
  { id: "business", label: "Business", icon: "business", load: () => import("./views/business.js") },
  { id: "money", label: "Money", icon: "money", load: () => import("./views/money.js") },
  { group: "Knowledge" },
  { id: "intelligence", label: "Intelligence", icon: "intel", load: () => import("./views/intelligence.js") },
  { id: "documents", label: "Documents", icon: "documents", load: () => import("./views/documents.js") },
  { id: "memory", label: "Memory & Notes", icon: "memory", load: () => import("./views/memory.js") },
  { id: "world", label: "World", icon: "world", load: () => import("./views/world.js") },
  { group: "Systems" },
  { id: "automations", label: "Automations", icon: "automations", load: () => import("./views/automations.js") },
  { id: "computer", label: "Computer", icon: "computer", load: () => import("./views/computer.js") },
  { id: "smarthome", label: "Smart Home", icon: "smarthome", load: () => import("./views/smarthome.js") },
  { id: "diagnostics", label: "Diagnostics", icon: "diagnostics", load: () => import("./views/diagnostics.js") },
  { id: "settings", label: "Settings", icon: "settings", load: () => import("./views/settings.js") },
];
const VIEWS = Object.fromEntries(SECTIONS.filter((s) => s.id).map((s) => [s.id, s]));
const ALIASES = { agenda: "calendar", finance: "money", intel: "intelligence", research: "intelligence", ideas: "intelligence", reminders: "tasks", more: "home" };
const MOBILE = ["home", "talk", "alarms", "calendar"];
let current = null, currentMod = null, cleanup = null, homeCache = null, diagCache = null;
const badges = { notifications: 0, alarms: 0, talk: 0 };

export const ctx = {
  session: null, desktop, agent: null, isPhone, core, conversation, SECTIONS,
  get settings() { return ctx.session?.settings || {}; },
  go, toast, refreshBadges,
  caption: (t, user) => listeners.caption.forEach((fn) => fn(t, user)),
  onCaption: (fn) => { listeners.caption.add(fn); return () => listeners.caption.delete(fn); },
  converse: (text, opts = {}) => conversation.ask(text, { speak: opts.speak ?? shouldSpeakTyped(), viaVoice: false }),
  listen: () => startListening("tap"),
  listenOnce: () => startListening("tap"),
  home: () => homeCache,
  diag: () => diagCache,
  loc: () => null,
  current: () => current,
  handleUi: (cmd, opts) => handleUi(cmd, ctx, opts),
  tryMacro: (text, opts) => tryMacro(text, ctx, opts),
  mission,
};
const listeners = { caption: new Set() };
conversation.ctx = ctx;
const shouldSpeakTyped = () => (ctx.settings.voice?.speakReplies ?? true) && (!!desktop || !!voice.cfg.tts);

// ---------------------------------------------------------------- Navigation
function buildNav() {
  $("#nav").innerHTML = SECTIONS.map((s) => s.group ? `<div class="nav-group">${s.group}</div>`
    : `<button class="nav-btn" data-tab="${s.id}" title="${esc(s.label)}">${icon(s.icon)}<span>${esc(s.label)}</span><i class="badge" data-badge="${s.id}" hidden></i></button>`).join("");
  $("#mobileNav").innerHTML = MOBILE.map((id) => `<button data-tab="${id}">${icon(VIEWS[id].icon)}<span>${id === "home" ? "Home" : id === "talk" ? "Talk" : VIEWS[id].label.split(" ")[0]}</span><i class="badge" data-badge="${id}" hidden></i></button>`).join("")
    + `<button id="moreBtn">${icon("menu")}<span>More</span><i class="badge" data-badge="more" hidden></i></button>`;
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
  $("#moreBtn").addEventListener("click", () => openPalette({ sectionsOnly: true }));
  $("#collapse").innerHTML = icon("sidebar");
  $("#collapse").onclick = () => { $("#app").classList.toggle("collapsed"); try { localStorage.setItem("jarvis.sidebar", $("#app").classList.contains("collapsed") ? "collapsed" : "expanded"); } catch {} };
  try { if (localStorage.getItem("jarvis.sidebar") === "collapsed") $("#app").classList.add("collapsed"); } catch {}
  const ver = ctx.session?.version || desktop?.version || "";
  $("#version").textContent = ver ? `JARVIS v${String(ver).replace(/^(\d+\.\d+)\.0$/, "$1")}` : "";
}

export async function go(tab, params = {}, { push = true } = {}) {
  if (mission.open) await mission.hide({ instant: true });
  tab = ALIASES[tab] || tab;
  if (!VIEWS[tab]) tab = "home";
  cleanup?.(); cleanup = null;
  current = tab;
  $$("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#pageTitle").textContent = VIEWS[tab].label;
  document.title = tab === "home" ? "JARVIS" : `${VIEWS[tab].label} · JARVIS`;
  if (push) { const u = new URL(location.href); u.search = tab === "home" ? "" : `?tab=${tab}`; history.pushState({ tab }, "", u); }
  const root = $("#view");
  root.innerHTML = '<p class="empty">Loading…</p>';
  root.style.animation = "none"; void root.offsetWidth; root.style.animation = "";
  try {
    currentMod = await VIEWS[tab].load();
    if (current !== tab) return;
    cleanup = (await currentMod.render(root, ctx, params)) || null;
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="panel"><p class="error">${esc(e.message)}</p></div>`;
  }
  closeDrawer();
  updateHud();
  scrollTo({ top: 0 });
}
addEventListener("popstate", (e) => { if (!ctx.session?.signedIn) return; const t = e.state?.tab || new URL(location.href).searchParams.get("tab") || "home"; go(t, {}, { push: false }); });

// ---------------------------------------------------------------- System bar
function tickClock() {
  const tz = ctx.settings.timezone || undefined;
  const now = new Date();
  const t = now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  $("#clockTime").innerHTML = `${t.slice(0, 5)}<i>:${t.slice(6, 8)}</i>`;
  $("#clockDate").textContent = now.toLocaleDateString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
}
function renderSysbar() {
  const h = homeCache, d = diagCache;
  const w = h?.weather;
  $("#locChip").innerHTML = `${icon("world")}<span>${esc((h?.location?.place || ctx.settings.home?.place || "").split(",")[0])}${w ? ` · ${w.current.temp}${w.unitTemp}` : ""}</span>`;
  const ai = d?.checks?.find((c) => c.name === "ai");
  const aiState = !ctx.session?.brain ? "off" : ai?.status || "unknown";
  $("#aiChip").innerHTML = `<span class="dot ${aiState === "error" ? "bad" : aiState}"></span>AI ${aiState === "ok" ? "online" : aiState === "off" ? "not set up" : aiState === "error" ? "fault" : aiState === "warn" ? "degraded" : "standby"}`;
  const online = sync.status.online;
  const overall = !online ? "error" : d?.overall || "unknown";
  const issues = d ? (d.counts.error || 0) + (d.counts.warn || 0) : 0;
  $("#sysChip").innerHTML = `<span class="dot ${overall === "error" ? "bad" : overall}"></span>${!online ? `Offline${outboxSize() ? ` · ${outboxSize()} queued` : ""}` : !d ? "Checking…" : issues ? `${issues} to check` : "All systems"}`;
  const mb = $("#muteBtn");
  if (desktop && ctx.agent) { mb.hidden = false; mb.innerHTML = icon(ctx.agent.muted ? "micoff" : "mic"); mb.classList.toggle("on", !ctx.agent.muted && ctx.agent.wakeWord === "listening"); mb.title = ctx.agent.muted ? "Microphone muted — click to unmute" : `Mute microphone (${ctx.agent.wakeWord === "listening" ? "“Hey JARVIS” ready" : ctx.agent.wakeWord || "starting"})`; }
}
async function loadHomeCache() { try { homeCache = await api("/api/home"); renderSysbar(); return homeCache; } catch { return homeCache; } }
async function loadDiag() { try { diagCache = await api("/api/diagnostics"); renderSysbar(); } catch {} return diagCache; }

export async function refreshBadges() {
  try {
    const n = await api("/api/notifications?limit=40");
    badges.notifications = n.unread;
    renderNotifList(n.items);
  } catch {}
  for (const [k, v] of Object.entries({ ...badges, more: badges.notifications + badges.alarms })) {
    $$(`[data-badge="${k}"]`).forEach((b) => { b.hidden = !v; b.textContent = v > 99 ? "99+" : v; });
  }
  const bell = $("#bellBtn");
  bell.innerHTML = icon("notifications") + (badges.notifications ? `<i class="badge">${badges.notifications > 99 ? "99+" : badges.notifications}</i>` : "");
}

// ---------------------------------------------------------------- Notification centre
function openDrawer() { $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false"); $("#scrim").hidden = false; refreshBadges(); }
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); $("#scrim").hidden = true; }
function renderNotifList(items) {
  const el = $("#notifList");
  el.innerHTML = items.length ? items.map((n) => `<li class="notif ${n.read_at ? "" : "unread"}" data-id="${n.id}">
    <div class="spread"><b>${esc(n.title)}</b><span class="pill">${esc(n.kind)}</span></div>
    ${n.body ? `<div class="muted" style="font-size:13px">${esc(n.body)}</div>` : ""}
    <div class="spread"><span class="faint" style="font-size:11.5px">${esc(fmtWhen(n.created_at))}${n.snooze_until ? ` · snoozed until ${esc(fmtWhen(n.snooze_until))}` : ""}</span>
    <span class="acts">${n.url && n.url !== "/" ? '<button class="btn tiny" data-a="open">Open</button>' : ""}${n.read_at ? "" : '<button class="btn tiny ghost" data-a="read">Read</button>'}<button class="btn tiny ghost" data-a="snooze">Snooze</button><button class="btn tiny ghost" data-a="dismiss">Dismiss</button></span></div></li>`).join("")
    : '<li class="empty">No notifications. All quiet, Sir.</li>';
  el.querySelectorAll("[data-a]").forEach((b) => b.onclick = async () => {
    const li = b.closest("[data-id]"), id = li.dataset.id, n = items.find((x) => String(x.id) === id);
    if (b.dataset.a === "open") { await api(`/api/notifications/${id}/read`, { method: "POST" }); const u = new URL(n.url, location.origin); go(u.searchParams.get("tab") || "home", Object.fromEntries(u.searchParams)); }
    if (b.dataset.a === "read") await api(`/api/notifications/${id}/read`, { method: "POST" });
    if (b.dataset.a === "dismiss") await api(`/api/notifications/${id}/dismiss`, { method: "POST" });
    if (b.dataset.a === "snooze") { await api(`/api/notifications/${id}/snooze`, { method: "POST", body: { minutes: 30 } }); toast("Snoozed for 30 minutes."); }
    refreshBadges();
  });
}
$("#bellBtn").addEventListener("click", () => ($("#drawer").classList.contains("open") ? closeDrawer() : openDrawer()));
$("#drawerClose").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
$("#readAll").addEventListener("click", async () => { await api("/api/notifications/read-all", { method: "POST" }); refreshBadges(); });
$("#dismissAll").addEventListener("click", async () => { await api("/api/notifications/dismiss-all", { method: "POST" }); refreshBadges(); });
$("#notifHistory").addEventListener("click", () => go("notifications"));

// ---------------------------------------------------------------- Command palette (Ctrl+K)
const ACTIONS = [
  { label: "Morning briefing", icon: "briefing", run: () => go("briefings", { run: "morning" }) },
  { label: "Set an alarm", icon: "alarm", run: () => go("alarms", { new: "1" }) },
  { label: "Test the alarm", icon: "alarm", run: () => api("/api/alarms/test", { method: "POST", body: {} }).then(() => toast("Test alarm sent to your laptop.")) },
  { label: "Start a 25-minute focus session", icon: "focus", run: () => api("/api/focus/start", { method: "POST", body: { minutes: 25 } }).then(() => go("focus")) },
  { label: "Add a task", icon: "tasks", run: () => go("tasks", { new: "1" }) },
  { label: "Record spending", icon: "money", run: () => go("money", { record: "1" }) },
  { label: "New note", icon: "memory", run: () => go("memory", { note: "1" }) },
  { label: "Session history", icon: "memory", run: () => go("memory", { history: "1" }) },
  { label: "Set up JARVIS on my iPhone", icon: "mic", run: () => (isIOS() && !desktop ? showInstallGuide({ force: true }) : go("settings", { section: "devices" })) },
  { label: "Personal profile (what JARVIS knows about you)", icon: "memory", run: () => go("memory") },
  { label: "Run diagnostics", icon: "diagnostics", run: () => go("diagnostics") },
  { label: "Run full system diagnostics (spoken)", icon: "diagnostics", run: () => ctx.handleUi({ kind: "diagnostics", level: "full" }, { speak: shouldSpeakTyped() }) },
  { label: "Mission Control", icon: "cpu", run: () => ctx.handleUi({ kind: "mission", on: !mission.open }, { speak: shouldSpeakTyped() }) },
  { label: "Talk to JARVIS", icon: "mic", run: () => startListening("palette") },
  { label: "Stop speaking", icon: "stop", run: () => { conversation.interrupt(); conversation.endSession(); } },
];
let palItems = [], palSel = 0, palSectionsOnly = false;
function openPalette({ sectionsOnly = false } = {}) {
  palSectionsOnly = sectionsOnly;
  $("#palInput").value = "";
  drawPalette([]);
  $("#palette").showModal();
  $("#palInput").focus();
}
function drawPalette(remote) {
  const q = $("#palInput").value.trim().toLowerCase();
  const sec = SECTIONS.filter((s) => s.id && (!q || s.label.toLowerCase().includes(q))).map((s) => ({ label: s.label, icon: s.icon, k: "Section", run: () => go(s.id) }));
  const acts = palSectionsOnly && !q ? [] : ACTIONS.filter((a) => !q || a.label.toLowerCase().includes(q)).map((a) => ({ ...a, k: "Action" }));
  const found = remote.map((r) => ({ label: r.title, icon: { task: "tasks", note: "memory", project: "projects", client: "business", event: "calendar", memory: "memory", research: "intel", alarm: "alarm" }[r.type] || "search", k: r.sub, run: () => go(r.tab, { focus: r.id }) }));
  palItems = [...(q ? found : []), ...sec, ...acts];
  if (q.length > 1) palItems.push({ label: `Ask JARVIS: “${$("#palInput").value.trim()}”`, icon: "talk", k: "Enter", run: () => { go("home"); ctx.converse($("#palInput").value.trim()); } });
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  $("#palList").innerHTML = palItems.map((it, i) => `<li role="option" class="${i === palSel ? "sel" : ""}" data-i="${i}">${icon(it.icon)}<span>${esc(it.label)}</span><span class="k">${esc(it.k || "")}</span></li>`).join("") || '<li class="empty">Nothing found.</li>';
  $$("#palList [data-i]").forEach((li) => li.onclick = () => runPal(Number(li.dataset.i)));
}
function runPal(i) { const it = palItems[i]; if (!it) return; $("#palette").close(); it.run(); }
const searchRemote = debounce(async () => {
  const q = $("#palInput").value.trim();
  if (q.length < 2) return drawPalette([]);
  try { drawPalette(await api(`/api/search?q=${encodeURIComponent(q)}`)); } catch { drawPalette([]); }
}, 180);
$("#palInput").addEventListener("input", () => { palSel = 0; drawPalette([]); searchRemote(); });
$("#palInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); drawPalette([]); searchRemote(); }
  if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(0, palSel - 1); drawPalette([]); searchRemote(); }
  if (e.key === "Enter") { e.preventDefault(); runPal(palSel); }
});
$("#searchBtn").addEventListener("click", () => openPalette());
// Mission Control button (also: "JARVIS, activate Mission Control").
$("#mcBtn").innerHTML = `${icon("cpu")}<span class="hide-m">Mission Control</span>`;
$("#mcBtn").addEventListener("click", () => { if (mission.phase === "activating" || mission.phase === "deactivating") return; ctx.handleUi({ kind: "mission", on: !mission.open }, { speak: shouldSpeakTyped() }); });
$("#searchBtn").innerHTML = icon("search");
$("#gearBtn").innerHTML = icon("settings");
$("#gearBtn").addEventListener("click", () => go("settings"));
$("#sysChip").addEventListener("click", () => go("diagnostics"));
$("#aiChip").addEventListener("click", () => go("diagnostics"));
$("#muteBtn").addEventListener("click", () => desktop?.setMuted(!ctx.agent?.muted));
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (!$("#app").hidden) openPalette(); }
  if (e.key === "Escape") { closeDrawer(); if (voice.state === "speaking") conversation.interrupt(); else if (mission.open && !document.querySelector("dialog[open]")) ctx.handleUi({ kind: "mission", on: false }, { speak: false }); }
});

// ---------------------------------------------------------------- Voice: HUD + core state
let hudCore = null;
voice.onState((s) => { updateHud(); desktop?.voiceState?.(s); });
core.on((s) => { updateHud(); document.documentElement.dataset.core = s; });
function updateHud() {
  const hud = $("#hud");
  const show = (voice.state !== "idle" || core.state === "thinking" || core.state === "executing" || core.state === "researching") && current !== "home" && current !== "talk" && !mission.open && !$("#app").hidden;
  hud.hidden = !show;
  if (show && !hudCore) hudCore = mountCore($("#hudCore"), { animation: ctx.settings.appearance?.animation });
  $("#hudState").textContent = STATE_LABEL[core.state] || "";
}
ctx.onCaption((t) => { $("#hudCaption").textContent = t || ""; });
$("#hudStop").addEventListener("click", () => { conversation.interrupt(); conversation.endSession(); });

async function startListening(source) {
  voice.ensureAudio();
  if (voice.state === "speaking" || conversation.session) { conversation.interrupt(); if (conversation.session) return; }
  try { await conversation.startSession({ source }); } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- Alarm overlay (browsers/phones; the Windows app rings in its own window)
let ringing = null, alarmAudio = null;
function showAlarm(alarm, speech) {
  if (desktop?.agentRingsAlarms) { core.set("alarm", true); return; }      // the Windows agent has its own full-screen alarm window
  ringing = alarm;
  core.set("alarm", true);
  $("#alarmTime").textContent = new Date().toLocaleTimeString("en-GB", { timeZone: ctx.settings.timezone, hour: "2-digit", minute: "2-digit" });
  $("#alarmLabel").textContent = alarm.label || "Alarm";
  $("#alarmMsg").textContent = speech || alarm.message || "";
  $("#alarmOverlay").hidden = false;
  try {
    alarmAudio = new Audio(String(alarm.sound || "chime").startsWith("custom:") ? `/api/alarms/sounds/${alarm.sound.slice(7)}/file` : `/sounds/${alarm.sound || "chime"}.wav`);
    alarmAudio.loop = true; alarmAudio.volume = Math.min(1, (alarm.volume ?? 80) / 100);
    alarmAudio.play().catch(() => toast("Tap Dismiss or Snooze — the browser blocked the alarm sound until you interact with the page."));
  } catch {}
  navigator.vibrate?.([400, 200, 400, 200, 800]);
  if (speech) setTimeout(() => { if (ringing) voice.speakShort(speech); }, 2500);
}
function hideAlarm() { ringing = null; alarmAudio?.pause(); alarmAudio = null; $("#alarmOverlay").hidden = true; core.set("alarm", false); voice.stop(); }
$("#alarmSnooze").addEventListener("click", async () => { const a = ringing; hideAlarm(); if (a?.id || a?.alarmId) await api(`/api/alarms/${a.id || a.alarmId}/snooze`, { method: "POST", body: {} }).catch(() => {}); });
$("#alarmDismiss").addEventListener("click", async () => { const a = ringing; hideAlarm(); if (a?.id || a?.alarmId) await api(`/api/alarms/${a.id || a.alarmId}/dismiss`, { method: "POST" }).catch(() => {}); });

// ---------------------------------------------------------------- Live events
sync.on("status", () => { core.set("offline", !sync.status.online); renderSysbar(); });
sync.on("changed", (m) => {
  currentMod?.refresh?.(m.entities, ctx);
  mission.refresh(m.entities);
  if (m.entities.some((e) => ["notifications", "alarms"].includes(e))) refreshBadges();
  if (m.entities.includes("settings")) reloadSession();
  if (m.entities.includes("health")) loadDiag();
});
sync.on("reconnected", () => { currentMod?.refresh?.(["*"], ctx); refreshBadges(); loadDiag(); loadHomeCache(); });
sync.on("message", (m) => currentMod?.onMessage?.(m.message, ctx));
sync.on("pending", (m) => { toast(`Waiting for your confirmation: ${m.action.summary}`, 6000); refreshBadges(); });
sync.on("notify", (m) => {
  const n = m.notification;
  refreshBadges();
  if (n.kind === "alarm") return;                       // alarms have their own full-screen treatment
  // Focus voice mode: only reminders, events and system faults interrupt; everything else waits in the notification centre.
  if (ctx.settings.personality?.mode === "focus" && !["reminder", "event", "system"].includes(n.kind)) return;
  if (desktop) {
    desktop.notify(n.title, n.body || "");
    const v = ctx.settings.voice || {};
    const speakIt = n.speak && voice.state === "idle" && !conversation.session && (n.kind === "briefing" ? v.speakBriefings !== false : v.speakNotifications !== false);
    if (speakIt && ["reminder", "briefing", "focus", "event", "automation", "habit", "system"].includes(n.kind)) voice.speakShort(n.speak);
  } else if (document.visibilityState === "visible") toast(`${n.title}${n.body ? ` — ${n.body}` : ""}`, 6000);
});
// Interface requests from the AI or a macro, for this device only.
sync.on("ui", (m) => {
  if (m.action === "mission_control_on") mission.show(ctx);
  else if (m.action === "mission_control_off") mission.hide();
  else if (m.action === "open_section" && m.section) { if (mission.open) mission.hide().then(() => go(m.section)); else go(m.section); }
});
sync.on("alarm.ringing", (m) => showAlarm(m.alarm, m.speech));
sync.on("alarm.test", (m) => showAlarm({ ...m.alarm, label: "Test alarm" }, m.speech));
sync.on("alarm.snoozed", (m) => { if (!ringing || (ringing.id || ringing.alarmId) === m.id) hideAlarm(); });
sync.on("alarm.dismissed", (m) => { if (!ringing || (ringing.id || ringing.alarmId) === m.id || ringing.test) hideAlarm(); });
// Allowlisted computer actions. Newer Windows apps run these in their background agent; older ones here.
sync.on("computer.request", async (m) => {
  if (desktop?.agentHandlesComputer) return;
  if (!desktop) return;
  try { const result = await desktop.runAction(m.action, m.args); sync.sendWs({ type: "computer.result", id: m.id, ok: true, result }); }
  catch (e) { sync.sendWs({ type: "computer.result", id: m.id, ok: false, error: e.message }); }
});

// ---------------------------------------------------------------- Dimensional UI: parallax background + tilting panels
let raf = 0, lastPtr = null;
addEventListener("pointermove", (e) => {
  lastPtr = e;
  if (raf || document.documentElement.classList.contains("reduce-motion")) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const x = (lastPtr.clientX / innerWidth - 0.5) * 2, y = (lastPtr.clientY / innerHeight - 0.5) * 2;
    document.documentElement.style.setProperty("--px", (-x).toFixed(3));
    document.documentElement.style.setProperty("--py", (-y).toFixed(3));
    const t = lastPtr.target.closest?.(".tilt");
    $$(".tilt[style*='--rx']").forEach((el) => { if (el !== t) { el.style.removeProperty("--rx"); el.style.removeProperty("--ry"); } });
    if (t) { const r = t.getBoundingClientRect(); t.style.setProperty("--ry", (((lastPtr.clientX - r.left) / r.width - 0.5) * 5).toFixed(2)); t.style.setProperty("--rx", ((0.5 - (lastPtr.clientY - r.top) / r.height) * 5).toFixed(2)); }
  });
}, { passive: true });
// Idle mode: after 15 s without input (or 3 s after switching to another window) while JARVIS is idle, decorative
// animations pause — every animated frame re-composites all the blurred glass panels. Any activity resumes them.
let idleTimer = 0;
function wake() {
  document.documentElement.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(goIdle, document.hasFocus() ? 15_000 : 3000);
}
function goIdle() {
  if (voice.state !== "idle" || core.state !== "idle" || conversation.session) return wake();
  document.documentElement.classList.add("idle");
}
for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"]) addEventListener(ev, wake, { passive: true });
addEventListener("blur", () => { clearTimeout(idleTimer); idleTimer = setTimeout(goIdle, 3000); });
core.on(() => { if (core.state !== "idle") wake(); });
wake();
function applyAppearance() {
  const a = ctx.settings.appearance || {};
  document.documentElement.classList.toggle("reduce-motion", a.animation === "off" || a.animation === "reduced" || !!a.reduceMotion);
}

// ---------------------------------------------------------------- Desktop bridge
function wireDesktop() {
  if (!desktop) return;
  desktop.onStatus((s) => { ctx.agent = s; sync.sendWs({ type: "agent.status", status: s }); renderSysbar(); });
  // Wake word heard. If the laptop is already recording the command (it always is in newer versions), just show it.
  desktop.onWake((w) => {
    if (current !== "talk") go("home");
    if (!w?.capture) return startListening("wake");
    if (voice.state === "speaking" || conversation.session) conversation.interrupt();    // barge-in
    voice.chime(); voice.setState("listening"); ctx.caption("Listening…", true);
  });
  desktop.onWakeAudio?.(async (wav) => {
    if (!wav) { if (!conversation.session) { voice.setState("idle"); ctx.caption(""); } return; }
    try {
      const command = await conversation.transcribe(wav);
      if (!command) { ctx.caption(`Yes, ${ctx.settings.profile?.title || "Sir"}?`); if (!conversation.session) conversation.startSession({ source: "wake" }); return; }
      if (conversation.session) conversation.inject(command);
      else conversation.startSession({ source: "wake", first: command });
    } catch (e) { voice.setState("idle"); ctx.caption(e.message); toast(e.message, 6000); }
  });
  desktop.onCaptureProgress?.(async (wav) => {
    if (voice.state !== "listening" || partialBusy) return;
    partialBusy = true;
    try { const { text } = await api("/api/transcribe", { method: "POST", raw: new Blob([wav], { type: "audio/wav" }), headers: { "content-type": "audio/wav", "x-partial": "1" } }); const t = cleanCommand(text); if (t && voice.state === "listening") ctx.caption(t, true); } catch {}
    partialBusy = false;
  });
  desktop.onLevel?.((l) => core.pushExternalLevel(l));
  desktop.onPushToTalk(() => startListening("ptt"));
  desktop.onNavigate?.((tab) => go(tab));
  desktop.onAlarm?.((a) => { core.set("alarm", !!a?.ringing); });
  sync.on("reconnected", () => desktop.getStatus().then((s) => { ctx.agent = s; sync.sendWs({ type: "agent.status", status: s }); renderSysbar(); }));
  desktop.signedIn?.(true);
}
let partialBusy = false;

// ---------------------------------------------------------------- Push (iPhone home-screen app, browsers)
export async function ensurePushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) api("/api/push/subscribe", { method: "POST", body: sub.toJSON() }).catch(() => {});
}

// ---------------------------------------------------------------- Auth screens
let authMode = "login", authCore = null;
function showAuth(mode, { pairCode } = {}) {
  authMode = mode;
  $("#app").hidden = true; $("#hud").hidden = true; $("#auth").hidden = false;
  const titles = { setup: ["Welcome, Sir", "First-time setup. Enter the setup code shown in the server log, then choose a password."], login: ["JARVIS", "Sign in to continue."], pair: ["Pair this device", "Scan the QR code on a signed-in device, or type its pairing code."] };
  $("#authTitle").textContent = titles[mode][0];
  $("#authLead").textContent = titles[mode][1];
  $("#codeField").hidden = mode !== "setup";
  $("#pairField").hidden = mode !== "pair";
  $("#pwField").hidden = mode === "pair";
  $("#pw2Field").hidden = mode !== "setup";
  $("#authPw").autocomplete = mode === "setup" ? "new-password" : "current-password";
  $("#authSubmit").textContent = { setup: "Create account", login: "Sign in", pair: "Pair device" }[mode];
  $("#authPairToggle").hidden = mode === "setup";
  $("#authPairToggle").textContent = mode === "pair" ? "Sign in with password instead" : "Pair with a code instead";
  if (desktop && !$("#authDevice").value) $("#authDevice").value = "Windows laptop";
  if (mode === "setup" && desktop?.mode === "local") {
    desktop.setupCode().then((c) => { if (c) { $("#authCode").value = c; $("#codeField").hidden = true; $("#authLead").textContent = "JARVIS runs on this laptop. Choose a password to protect it (you'll use it if you ever sign in from a browser)."; } });
  }
  if (pairCode) $("#authPair").dataset.full = pairCode;
  if (!authCore) authCore = mountCore($("#authCore"));
}
$("#authPairToggle").addEventListener("click", () => showAuth(authMode === "pair" ? "login" : "pair"));
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#authErr").textContent = "";
  const deviceName = $("#authDevice").value.trim() || undefined;
  try {
    if (authMode === "setup") {
      if ($("#authPw").value !== $("#authPw2").value) throw new Error("The passwords don't match.");
      await api("/api/setup", { method: "POST", body: { code: $("#authCode").value.trim(), password: $("#authPw").value, deviceName } });
    } else if (authMode === "pair") {
      const full = $("#authPair").dataset.full;
      await api("/api/pair/redeem", { method: "POST", body: full ? { code: full, deviceName } : { shortCode: $("#authPair").value, deviceName } });
      history.replaceState(null, "", "/");
    } else {
      await api("/api/login", { method: "POST", body: { password: $("#authPw").value, deviceName } });
    }
    $("#authPw").value = $("#authPw2").value = "";
    await start();
  } catch (err) { $("#authErr").textContent = err.message; }
});
onAuthEvent((ev) => { if (ev === "unauthorized") { sync.disconnect(); desktop?.signedIn?.(false); boot(); } });

async function reloadSession() {
  try {
    ctx.session = await api("/api/session");
    setDisplayTz(ctx.session.settings?.timezone);
    const v = ctx.session.settings?.voice || {};
    voice.cfg = { tts: ctx.session.tts, stt: ctx.session.stt, rate: v.rate || 1, voiceName: v.voiceName || "" };
    applyAppearance();
  } catch {}
}

// ---------------------------------------------------------------- Boot
async function start() {
  await reloadSession();
  if (!ctx.session?.signedIn) return boot();
  authCore?.destroy?.(); authCore = null;
  // Cinematic start-up (once per window): each line is a real step finishing, with its real timing or error.
  let firstBoot = false;
  try { firstBoot = !sessionStorage.getItem("jarvis.booted"); sessionStorage.setItem("jarvis.booted", "1"); } catch {}
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const boot = firstBoot && !reduce && (ctx.settings.appearance?.startup || "cinematic") === "cinematic" ? beginStartup({ greeting: `All systems online. Good ${partOfDayLocal()}, ${ctx.settings.profile?.title || "Sir"}.` }) : null;
  boot?.step("Secure session", Promise.resolve(ctx.session.device?.name || "signed in"));
  $("#auth").hidden = true; $("#app").hidden = false;
  buildNav();
  core.set("offline", false);
  sync.connect();
  boot?.step("Live link to JARVIS server", new Promise((res, rej) => { if (sync.status.online) return res("connected"); const off = sync.on("status", (st) => { if (st.online) { off(); res("connected"); } }); setTimeout(() => { off(); rej(new Error("not connected yet — working offline")); }, 6000); }));
  wireDesktop();
  tickClock(); setInterval(tickClock, 1000);
  ensurePushSubscription().catch(() => {});
  const diagP = loadDiag();
  boot?.step("System diagnostics", diagP.then((d) => { if (!d) throw new Error("couldn't run checks"); const n = (d.counts.error || 0) + (d.counts.warn || 0); return n ? `${d.checks.length} checks · ${n} need${n === 1 ? "s" : ""} attention` : `${d.checks.length} checks · all operational`; }));
  boot?.step("AI core", diagP.then((d) => { const a = d?.checks.find((c) => c.name === "ai"); if (!a || a.status === "off") throw new Error(a?.detail || "not set up"); if (a.status === "error") throw new Error(a.detail); return a.status === "ok" ? "online" : { warn: a.status === "unknown" ? "configured · not verified yet" : a.detail }; }));
  boot?.step("Voice systems", desktop ? desktop.getStatus().then((st) => { if (st.muted) return "microphone muted"; return st.wakeWord === "listening" ? "“Hey JARVIS” ready" : `wake word ${st.wakeWord || "starting"}`; }) : Promise.resolve(voice.cfg.stt ? "tap the core to talk" : "typing only on this device"));
  if ((ctx.settings.memory?.mode || "ask") !== "off") boot?.step("Personal profile", api("/api/memories/profile").then((p) => `${Object.values(p).flat().length} facts`));
  loadHomeCache(); refreshBadges();
  setInterval(loadHomeCache, 10 * 60_000);
  setInterval(loadDiag, 60_000);
  const u = new URL(location.href);
  const tab = u.searchParams.get("tab") || "home";
  const params = Object.fromEntries(u.searchParams);
  history.replaceState({ tab }, "", tab === "home" ? "/" : `/?tab=${ALIASES[tab] || tab}`);
  const view = go(tab, params, { push: false });
  boot?.step("Command centre", view.then(() => ""));
  boot?.finish();
  await view;
  // iPhone: guide the Home Screen install in Safari; once installed, offer notifications (a tap is required).
  if (!desktop && isIOS()) setTimeout(() => { showInstallGuide() || offerNotifications(ctx); }, boot ? 2600 : 900);
}
function partOfDayLocal() { const h = Number(new Date().toLocaleString("en-GB", { timeZone: ctx.settings.timezone, hour: "2-digit", hour12: false })); return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"; }

async function boot() {
  let s;
  try { s = await api("/api/session"); }
  catch (e) { document.body.insertAdjacentHTML("beforeend", `<p class="error" style="position:fixed;top:20px;left:20px;z-index:99">Can't reach JARVIS: ${esc(e.message)}</p>`); return; }
  ctx.session = s;
  if (location.pathname === "/pair" && location.hash.length > 10 && !s.signedIn) {
    showAuth("pair", { pairCode: location.hash.slice(1) });
    $("#authPair").value = "From QR code";
    $("#authPair").readOnly = true;
    return;
  }
  if (!s.setupComplete) return showAuth("setup");
  if (!s.signedIn) return showAuth("login");
  return start();
}

if ("serviceWorker" in navigator && !desktop) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "navigate") { const u = new URL(e.data.url); go(u.searchParams.get("tab") || "home", Object.fromEntries(u.searchParams)); }
  });
}
// Offline is an expected state, not an error: keep refresh failures quiet and show the status instead.
addEventListener("unhandledrejection", (e) => { if (e.reason?.status === 0) { e.preventDefault(); renderSysbar(); } });
boot();
