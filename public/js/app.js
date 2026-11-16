// JARVIS client shell: auth, navigation, live sync, voice orchestration, desktop bridge, push.
import { api, onAuthEvent, send, uid, outboxSize } from "./api.js";
import * as sync from "./sync.js";
import { voice } from "./voice.js";
import { mountCore } from "./core.js";
import { $, $$, esc, toast, icon } from "./util.js";

const desktop = window.jarvisDesktop || null;           // present only inside the Windows app
const isPhone = () => matchMedia("(max-width: 900px)").matches;

export const ctx = {
  session: null, desktop, agent: null,
  get settings() { return ctx.session?.settings; },
  converse, listenOnce, go, refreshChips,
  caption: (t, user) => listeners.caption.forEach((fn) => fn(t, user)),
  onCaption: (fn) => { listeners.caption.add(fn); return () => listeners.caption.delete(fn); },
};
const listeners = { caption: new Set() };

// ---------------------------------------------------------------- Views
const VIEWS = {
  home: { label: "Home", icon: "home", load: () => import("./views/home.js") },
  talk: { label: "Talk", icon: "talk", load: () => import("./views/talk.js") },
  agenda: { label: "Agenda", icon: "agenda", load: () => import("./views/agenda.js") },
  money: { label: "Money", icon: "money", load: () => import("./views/money.js") },
  projects: { label: "Projects", icon: "projects", load: () => import("./views/projects.js") },
  intel: { label: "Research", icon: "intel", load: () => import("./views/intel.js") },
  memory: { label: "Memory", icon: "memory", load: () => import("./views/memory.js") },
  settings: { label: "Settings", icon: "settings", load: () => import("./views/settings.js") },
  more: { label: "More", icon: "more", load: () => import("./views/more.js"), phoneOnly: true },
};
const DOCK = ["home", "talk", "agenda", "money", "more"];
let current = null, currentMod = null, cleanup = null;

function buildNav() {
  $("#rail").innerHTML = Object.entries(VIEWS).filter(([, v]) => !v.phoneOnly).map(([k, v]) =>
    `${k === "settings" ? '<div class="spacer"></div>' : ""}<button class="nav-btn" data-tab="${k}">${icon(v.icon)}<span>${v.label}</span></button>`).join("");
  $("#dock").innerHTML = DOCK.map((k) => `<button data-tab="${k}">${icon(VIEWS[k].icon)}<span>${VIEWS[k].label}</span></button>`).join("");
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
}

export async function go(tab, params = {}) {
  if (!VIEWS[tab]) tab = "home";
  if (tab === "more" && !isPhone()) tab = "settings";
  cleanup?.(); cleanup = null;
  current = tab;
  $$("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab || (b.dataset.tab === "more" && ["projects", "intel", "memory", "settings"].includes(tab))));
  const root = $("#view");
  root.innerHTML = '<p class="empty">Loading…</p>';
  root.style.animation = "none"; void root.offsetWidth; root.style.animation = "";
  try {
    currentMod = await VIEWS[tab].load();
    if (current !== tab) return;
    cleanup = (await currentMod.render(root, ctx, params)) || null;
  } catch (e) {
    root.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
  updateHud();
  scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- Voice orchestration
async function converse(text, { speak = true } = {}) {
  text = String(text || "").trim();
  if (!text) return;
  voice.stop();
  voice.setState("thinking");
  ctx.caption(`“${text}”`, true);
  try {
    const r = await send("/api/chat", { text, clientId: uid() });
    if (r.queued) { voice.setState("idle"); ctx.caption("You're offline, sir. I'll send that as soon as we're reconnected."); return; }
    ctx.caption(r.reply);
    if (speak) await voice.speak(r.reply); else voice.setState("idle");
  } catch (e) {
    voice.setState("idle");
    ctx.caption(`Something went awry: ${e.message}`);
  }
}
async function listenOnce({ chime = false } = {}) {
  voice.ensureAudio();
  if (chime) voice.chime();
  if (voice.state === "listening") { voice.stopListening(false); return; }
  voice.stop();
  desktop?.setSessionActive?.(true);          // pause wake-word detection while a session runs
  try {
    const text = await voice.listen({ onPartial: (t) => ctx.caption(t || "Listening…", true) });
    if (text) await converse(text);
    else { voice.setState("idle"); ctx.caption(""); }
  } catch (e) {
    voice.setState("idle"); toast(e.message);
  } finally { desktop?.setSessionActive?.(false); }
}

// Persistent HUD when talking from any screen other than Home.
voice.onState((s) => { updateHud(); desktop?.voiceState?.(s); refreshChips(); });
function updateHud() {
  const hud = $("#hud");
  const show = voice.state !== "idle" && current !== "home";
  hud.hidden = !show;
  $("#hudState").textContent = { listening: "Listening", thinking: "Thinking", speaking: "Speaking" }[voice.state] || "";
}
ctx.onCaption((t) => { $("#hudCaption").textContent = t || ""; });
$("#hudStop").addEventListener("click", () => { voice.stop(); voice.stopListening(true); });

// ---------------------------------------------------------------- Status chips
export function refreshChips() {
  const chips = [];
  chips.push(`<span class="chip"><span class="dot ${sync.status.online ? "ok" : "bad"}"></span>${sync.status.online ? "Online" : "Offline"}${outboxSize() ? ` · ${outboxSize()} queued` : ""}</span>`);
  if (ctx.session && !ctx.session.brain) chips.push('<span class="chip"><span class="dot warn"></span>AI not configured</span>');
  if (desktop && ctx.agent) {
    const a = ctx.agent;
    chips.push(`<button class="chip ${a.muted ? "muted-mic" : ""}" id="chipMic" title="Mute / unmute the microphone"><span class="dot ${a.muted ? "bad" : a.wakeWord === "listening" ? "live" : a.wakeWord === "error" ? "bad" : "warn"}"></span>${a.muted ? "Mic muted" : a.wakeWord === "listening" ? "Hey JARVIS ready" : a.wakeWord === "disabled" ? "Wake word off" : a.wakeWord === "error" ? "Mic problem" : "Starting mic…"}</button>`);
  } else if (ctx.desktopOnline !== undefined) {
    chips.push(`<span class="chip opt"><span class="dot ${ctx.desktopOnline ? "ok" : ""}"></span>Laptop ${ctx.desktopOnline ? "online" : "offline"}</span>`);
  }
  if (voice.state !== "idle") chips.push(`<span class="chip"><span class="dot live"></span>${voice.state}</span>`);
  $("#chips").innerHTML = chips.join("");
  $("#chipMic")?.addEventListener("click", () => desktop.setMuted(!ctx.agent.muted));
}
sync.on("status", refreshChips);

// ---------------------------------------------------------------- Live events
sync.on("changed", (m) => { currentMod?.refresh?.(m.entities, ctx); if (m.entities.includes("health")) loadDesktopPresence(); if (m.entities.includes("settings")) reloadSession(); });
sync.on("reconnected", () => { currentMod?.refresh?.(["*"], ctx); loadDesktopPresence(); });
sync.on("message", (m) => currentMod?.onMessage?.(m.message, ctx));
sync.on("pending", (m) => toast(`Waiting for your confirmation: ${m.action.summary}`, 5000));
sync.on("notify", (m) => {
  const n = m.notification;
  if (desktop) {
    desktop.notify(n.title, n.body || "");
    if (n.kind === "reminder" && voice.state === "idle") voice.speak(n.speak || `${n.title}. ${n.body}`);   // the laptop says reminders aloud
  } else if (document.visibilityState === "visible") toast(`${n.title}${n.body ? ` — ${n.body}` : ""}`, 6000);
});
// Allowlisted computer actions: the backend asks, the Windows app validates again and executes.
sync.on("computer.request", async (m) => {
  if (!desktop) return sync.sendWs({ type: "computer.result", id: m.id, ok: false, error: "This device cannot run computer actions." });
  try { const result = await desktop.runAction(m.action, m.args); sync.sendWs({ type: "computer.result", id: m.id, ok: true, result }); }
  catch (e) { sync.sendWs({ type: "computer.result", id: m.id, ok: false, error: e.message }); }
});

async function loadDesktopPresence() {
  if (desktop) return;
  try { const h = await api("/api/health"); ctx.desktopOnline = h.desktops.some((d) => d.online); refreshChips(); } catch {}
}

// ---------------------------------------------------------------- Desktop bridge
function wireDesktop() {
  if (!desktop) return;
  desktop.onStatus((s) => {
    ctx.agent = s;
    sync.sendWs({ type: "agent.status", status: s });
    refreshChips();
  });
  desktop.onWake(() => { go(current === "talk" ? "talk" : "home"); listenOnce({ chime: true }); });
  desktop.onPushToTalk(() => listenOnce({ chime: true }));
  desktop.onNavigate?.((tab) => go(tab));
  sync.on("reconnected", () => desktop.getStatus().then((s) => { ctx.agent = s; sync.sendWs({ type: "agent.status", status: s }); refreshChips(); }));
  desktop.signedIn?.(true);
}

// ---------------------------------------------------------------- Push (iPhone home-screen app, browsers)
export async function ensurePushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) api("/api/push/subscribe", { method: "POST", body: sub.toJSON() }).catch(() => {});
}

// ---------------------------------------------------------------- Auth screens
let authMode = "login";
function showAuth(mode, { pairCode } = {}) {
  authMode = mode;
  $("#app").hidden = true; $("#hud").hidden = true; $("#auth").hidden = false;
  const titles = { setup: ["Welcome, sir", "First-time setup. Enter the setup code shown in the server log, then choose a password."], login: ["JARVIS", "Sign in to continue."], pair: ["Pair this device", "Scan the QR code on a signed-in device, or type its pairing code."] };
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
  // JARVIS running on this laptop: the app knows the setup code, so nothing to copy.
  if (mode === "setup" && desktop?.mode === "local") {
    desktop.setupCode().then((c) => { if (c) { $("#authCode").value = c; $("#codeField").hidden = true; $("#authLead").textContent = "JARVIS runs on this laptop. Choose a password to protect it (you'll use it if you ever sign in from a browser)."; } });
  }
  if (pairCode) $("#authPair").dataset.full = pairCode;
  if (!$("#authCore").dataset.mounted) { mountCore($("#authCore")); $("#authCore").dataset.mounted = "1"; }
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
  try { ctx.session = await api("/api/session"); voice.cfg = { tts: ctx.session.tts, stt: ctx.session.stt }; } catch {}
}

// ---------------------------------------------------------------- Boot
async function start() {
  await reloadSession();
  if (!ctx.session?.signedIn) return boot();
  $("#auth").hidden = true; $("#app").hidden = false;
  buildNav();
  sync.connect();
  wireDesktop();
  refreshChips();
  ensurePushSubscription().catch(() => {});
  loadDesktopPresence();
  const u = new URL(location.href);
  const tab = u.searchParams.get("tab") || "home";
  const params = Object.fromEntries(u.searchParams);
  history.replaceState(null, "", "/");
  await go(tab, params);
  if (u.searchParams.get("briefing")) currentMod?.briefingReady?.();
}

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
    if (e.data?.type === "navigate") { const u = new URL(e.data.url); go(u.searchParams.get("tab") || "home", Object.fromEntries(u.searchParams)); if (u.searchParams.get("briefing")) currentMod?.briefingReady?.(); }
  });
}
// Offline is an expected state, not an error: keep refresh failures quiet and show the chip instead.
addEventListener("unhandledrejection", (e) => { if (e.reason?.status === 0) { e.preventDefault(); refreshChips(); } });
addEventListener("resize", () => { if (current === "more" && !isPhone()) go("settings"); });
boot();
