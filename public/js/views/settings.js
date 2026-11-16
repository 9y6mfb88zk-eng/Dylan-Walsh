// Settings & security centre: devices/pairing, laptop voice, preferences, integrations, notifications, privacy, health.
import { api } from "../api.js";
import { voice } from "../voice.js";
import { renderMicSetup, stopLive } from "./micsetup.js";
import { $, $$, esc, toast, confirmDialog, formDialog, ago, fmtWhen } from "../util.js";

let tab = "devices";
const TABS = [["devices", "Devices & pairing"], ["voice", "Wake word & laptop"], ["prefs", "Preferences"], ["integrations", "Integrations"], ["notify", "Notifications"], ["security", "Security & privacy"], ["health", "System health"]];

export async function render(root, ctx, params = {}) {
  if (params.section) tab = params.section;
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Settings</h2></div></div><div class="tabs">${TABS.map(([k, l]) => `<button data-s="${k}">${l}</button>`).join("")}</div><div id="sv"></div>`;
  $$("[data-s]", root).forEach((b) => b.onclick = () => { tab = b.dataset.s; draw(ctx); });
  await draw(ctx);
  return () => { clearInterval(meterTimer); stopLive(); };
}
export function refresh(e, ctx) { if (e.includes("*") || (tab === "health" && e.includes("health")) || (tab === "prefs" && e.includes("settings"))) draw(ctx); }

const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><span></span></label>`;
const row = (title, sub, ctrl) => `<div class="set-row"><div><b>${title}</b>${sub ? `<div class="muted">${sub}</div>` : ""}</div>${ctrl || ""}</div>`;
let meterTimer = null;

async function draw(ctx) {
  clearInterval(meterTimer);
  $$("[data-s]").forEach((b) => b.classList.toggle("active", b.dataset.s === tab));
  const el = $("#sv"); if (!el) return;
  try { await SECTIONS[tab](el, ctx); } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

const SECTIONS = {
  async devices(el, ctx) {
    const devs = await api("/api/devices");
    const local = ctx.desktop?.mode === "local" ? await ctx.desktop.local() : null;
    el.innerHTML = `<div class="grid cols-2">
      ${local ? `<article class="panel" style="grid-column:1/-1"><div class="panel-head"><span class="label">iPhone access (free, private)</span><span id="tsBadge"></span></div><div id="ts"><p class="muted">Checking Tailscale…</p></div></article>` : ""}
      <article class="panel"><div class="panel-head"><span class="label">Pair your iPhone</span></div>
        <ol style="padding-left:18px;margin:0 0 12px;font-size:14px">${local ? "<li>Turn on <b>iPhone access</b> above first.</li>" : ""}<li>Tap <b>Show pairing code</b>.</li><li>Point your iPhone camera at the QR code and open the link in Safari.</li><li>In Safari: Share → <b>Add to Home Screen</b>, then open JARVIS from the icon and enable notifications.</li></ol>
        <button class="btn primary" id="pair" ${local && !local.phoneAccess ? "disabled" : ""}>Show pairing code</button><div id="pairOut" style="margin-top:12px"></div></article>
      <article class="panel"><div class="panel-head"><span class="label">Signed-in devices</span></div><ul class="list">${devs.map((d) => `<li class="item" style="${d.revoked_at ? "opacity:.45" : ""}"><span class="dot ${d.revoked_at ? "" : "ok"}"></span><div class="grow"><div>${esc(d.name)} ${d.current ? '<span class="pill ok">this device</span>' : ""}</div><div class="meta">${d.kind} · ${d.revoked_at ? `signed out ${ago(d.revoked_at)}` : `last seen ${ago(d.last_seen)}`}</div></div>${d.revoked_at ? "" : `<button class="btn small ghost" data-ren="${d.id}">Rename</button><button class="btn small danger" data-rev="${d.id}">Sign out</button>`}</li>`).join("")}</ul></article></div>`;
    if (local) drawTailscale(ctx, local);
    $("#pair").onclick = async () => {
      const p = await api("/api/pair/create", { method: "POST" });
      $("#pairOut").innerHTML = `<div class="row wrap" style="align-items:flex-start"><div class="qr">${p.qrSvg}</div><div><div class="label">Or type this code</div><div class="mid mono" style="letter-spacing:.1em">${esc(p.shortCode)}</div><p class="muted" style="font-size:13px">at ${esc(p.url.split("#")[0])}<br>Expires ${fmtWhen(p.expiresAt)}. Works once.</p></div></div>`;
    };
    $$("[data-rev]", el).forEach((b) => b.onclick = async () => { if (await confirmDialog("Sign this device out?", "It will lose access immediately and must be paired again.", { ok: "Sign out", danger: true })) { await api(`/api/devices/${b.dataset.rev}`, { method: "DELETE" }); draw(ctx); } });
    $$("[data-ren]", el).forEach((b) => b.onclick = async () => { const v = await formDialog("Rename device", [{ name: "name", label: "Name", required: true }]); if (v) { await api(`/api/devices/${b.dataset.ren}`, { method: "PATCH", body: v }); draw(ctx); } });
  },

  async voice(el, ctx) {
    const d = ctx.desktop;
    const mics = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || []).filter((x) => x.kind === "audioinput");
    if (!d) {
      el.innerHTML = `<article class="panel">${row("Voice output", ctx.session.tts ? `Neural British voice (${ctx.session.tts})` : "Browser voice — add ELEVENLABS_API_KEY or OPENAI_API_KEY on the server for the natural butler voice", '<button class="btn small" id="test">Test</button>')}
        ${row("Voice input on this device", voice.sttMode() === "server" ? (ctx.session.sttLocal ? "Whisper on your laptop (free, private)" : "OpenAI Whisper transcription") : voice.sttMode() === "webspeech" ? "Browser speech recognition" : "Unavailable — type instead", "")}
        ${row("Microphone", "Used only while you hold a conversation", `<select class="inp" id="mic" style="max-width:240px"><option value="">System default</option>${mics.map((m) => `<option value="${esc(m.deviceId)}" ${voice.micDeviceId === m.deviceId ? "selected" : ""}>${esc(m.label || "Microphone")}</option>`).join("")}</select>`)}
        ${row("Wake word", "“Hey JARVIS” runs on your Windows laptop app. iPhone apps can't listen in the background, so on the phone tap the core or mic instead.", "")}</article>`;
      $("#test").onclick = () => { voice.ensureAudio(); voice.speak("Good evening, sir. All systems are operational."); };
      $("#mic").onchange = (e) => { voice.micDeviceId = e.target.value || null; try { localStorage.setItem("jarvis.mic", voice.micDeviceId || ""); } catch {} };
      return;
    }
    const s = await d.getSettings(), st = await d.getStatus();
    el.innerHTML = `<div class="grid cols-2">
      <article class="panel"><div class="panel-head"><span class="label">Hey JARVIS (local wake word)</span><span class="pill ${st.wakeWord === "listening" ? "ok" : st.wakeWord === "error" ? "bad" : ""}">${esc(st.wakeWord)}</span></div>
        <p class="muted" style="font-size:13px;margin-top:0">Detection runs entirely on this laptop with the openWakeWord “hey_jarvis” model. No audio leaves the computer until the phrase is heard; then only your command is sent for transcription.</p>
        ${row("Listen for “Hey JARVIS”", "", sw("wake", s.wakeEnabled))}
        ${row("Also wake on just “JARVIS”", st.kws === "ready" ? "Second on-device detector for the single word" : st.kws === "error" ? `Unavailable: ${esc(st.kwsError || "")}` : "Starting…", sw("wakeAlone", s.wakeJarvisAlone))}
        ${row("Mute microphone", "Stops all listening immediately (also in the tray menu and Ctrl+Shift+M)", sw("mute", st.muted))}
        ${row("Microphone", st.micDevice ? esc(st.micDevice) : "", `<select class="inp" id="mic" style="max-width:220px"><option value="">System default</option>${mics.map((m) => `<option value="${esc(m.deviceId)}" ${s.micDeviceId === m.deviceId ? "selected" : ""}>${esc(m.label || "Microphone")}</option>`).join("")}</select>`)}
        ${row("Detection threshold", "Higher = fewer false triggers, may need clearer speech", `<input type="range" id="thr" min="0.3" max="0.95" step="0.05" value="${s.threshold}"><span class="mono" id="thrV" style="width:36px">${s.threshold}</span>`)}
        ${row("Consecutive frames required", "False-trigger protection (each frame is 80 ms)", `<select class="inp" id="frames" style="width:auto">${[1, 2, 3, 4].map((n) => `<option ${n === s.minFrames ? "selected" : ""}>${n}</option>`).join("")}</select>`)}
        ${row("Speech sensitivity", "How loud speech must be to count (after the wake word)", `<input type="range" id="vad" min="0.01" max="0.12" step="0.005" value="${s.vadThreshold}">`)}
        <div style="margin-top:10px"><div class="spread" style="font-size:13px"><span class="muted">Live wake-word score</span><span class="mono" id="score">0.00</span></div><div class="meter" style="margin-top:6px"><i id="meter" style="width:0"></i></div><p class="faint" style="font-size:12px">Say “Hey JARVIS” to see it peak. Last detection: <span id="lastWake">${st.lastWake ? fmtWhen(st.lastWake) : "none yet"}</span></p>
        ${st.error ? `<p class="error">${esc(st.error)}</p>` : ""}</div>
      </article>
      <article class="panel"><div class="panel-head"><span class="label">Windows app</span><span class="faint" style="font-size:12px">v${esc(d.version)}</span></div>
        ${row("Start with Windows", "JARVIS starts in the tray when you sign in", sw("autostart", s.autoStart))}
        ${row("Close to tray", "Closing the window keeps JARVIS running. Use Exit JARVIS in the tray to quit.", sw("tray", s.closeToTray))}
        ${row("Push-to-talk shortcut", "Works from any app", `<span class="mono">${esc(s.pttShortcut)}</span>`)}
        ${row("Computer control", "Let JARVIS open allowlisted apps, folders and documents", sw("computer", s.computerEnabled))}
        ${d.mode === "local" ? row("API keys & AI model", "JARVIS runs on this laptop; keys are stored encrypted by Windows", '<button class="btn small" id="keys">Open</button>') : ""}
        ${row("Voice output", ctx.session.tts ? `Neural (${ctx.session.tts})` : "Windows voice (add a TTS key on the server for the butler voice)", '<button class="btn small" id="test">Test</button>')}
        <div class="label" style="margin-top:12px">Named shortcuts</div><p class="muted" style="font-size:13px;margin:4px 0 8px">“Open my JARVIS project” opens the shortcut called “JARVIS project”.</p>
        <ul class="list" id="bm">${Object.entries(s.bookmarks || {}).map(([k, v]) => `<li class="item"><div class="grow"><div>${esc(k)}</div><div class="meta mono">${esc(v)}</div></div><button class="x" data-bm="${esc(k)}" aria-label="Remove">×</button></li>`).join("") || '<li class="faint" style="font-size:13px">None yet.</li>'}</ul>
        <button class="btn small" id="addBm" style="margin-top:8px">+ Add shortcut</button>
        <div class="row" style="margin-top:14px"><button class="btn danger small" id="exit">Exit JARVIS</button></div>
      </article></div>`;
    const set = (patch) => d.setSettings(patch);
    $("#wake").onchange = (e) => set({ wakeEnabled: e.target.checked });
    $("#wakeAlone").onchange = (e) => set({ wakeJarvisAlone: e.target.checked });
    $("#mute").onchange = (e) => d.setMuted(e.target.checked);
    $("#mic").onchange = (e) => set({ micDeviceId: e.target.value || null });
    $("#thr").oninput = (e) => { $("#thrV").textContent = e.target.value; };
    $("#thr").onchange = (e) => set({ threshold: Number(e.target.value) });
    $("#frames").onchange = (e) => set({ minFrames: Number(e.target.value) });
    $("#vad").onchange = (e) => { set({ vadThreshold: Number(e.target.value) }); voice.vadThreshold = Number(e.target.value); };
    $("#autostart").onchange = (e) => set({ autoStart: e.target.checked });
    $("#tray").onchange = (e) => set({ closeToTray: e.target.checked });
    $("#computer").onchange = (e) => set({ computerEnabled: e.target.checked });
    $("#test").onclick = () => { voice.ensureAudio(); voice.speak("Good evening, sir. I'm online, and all available systems are operational."); };
    $("#keys")?.addEventListener("click", () => d.openKeys());
    $("#exit").onclick = async () => { if (await confirmDialog("Exit JARVIS?", "The wake word and background services on this laptop will stop until you start JARVIS again.", { ok: "Exit", danger: true })) d.quit(); };
    $("#addBm").onclick = async () => {
      const v = await formDialog("New shortcut", [{ name: "name", label: "Name (what you'll say)", required: true, placeholder: "JARVIS project" }, { name: "target", label: "Folder, file or https link", required: true, placeholder: "C:\\Users\\you\\Projects\\jarvis" }]);
      if (v) { await set({ bookmarks: { ...(s.bookmarks || {}), [v.name]: v.target } }); draw(ctx); }
    };
    $$("[data-bm]", el).forEach((b) => b.onclick = async () => { const bm = { ...(s.bookmarks || {}) }; delete bm[b.dataset.bm]; await set({ bookmarks: bm }); draw(ctx); });
    meterTimer = setInterval(async () => {
      const x = await d.getStatus().catch(() => null); if (!x || !$("#meter")) return;
      $("#meter").style.width = `${Math.round((x.lastScore || 0) * 100)}%`;
      $("#score").textContent = (x.lastScore || 0).toFixed(2);
      if (x.lastWake) $("#lastWake").textContent = fmtWhen(x.lastWake);
    }, 120);
  },

  async prefs(el, ctx) {
    const s = await api("/api/settings");
    el.innerHTML = `<div class="grid cols-2">
      <article class="panel"><div class="panel-head"><span class="label">Location & units</span></div>
        ${row("Home location", esc(s.home.place), '<button class="btn small" id="loc">Change</button>')}
        ${row("Use my current location", "Sets home from this device's GPS", '<button class="btn small" id="gps">Use GPS</button>')}
        ${row("Units", "", `<select class="inp" id="units" style="width:auto"><option value="metric" ${s.units === "metric" ? "selected" : ""}>°C, km/h</option><option value="imperial" ${s.units === "imperial" ? "selected" : ""}>°F, mph</option></select>`)}
        ${row("Time zone", "Used for reminders, briefings and month boundaries", `<input class="inp" id="tz" value="${esc(s.timezone)}" style="max-width:200px">`)}
      </article>
      <article class="panel"><div class="panel-head"><span class="label">Daily briefing</span></div>
        ${row("Deliver a morning briefing", "Push notification + spoken on tap", sw("bOn", s.briefing.enabled))}
        ${row("Time", "", `<input class="inp" type="time" id="bTime" value="${esc(s.briefing.time)}" style="width:auto">`)}
        ${Object.entries({ weather: "Weather", calendar: "Calendar", tasks: "Tasks & reminders", finance: "Financial overview", projects: "Project progress", news: "Relevant news (web search)" }).map(([k, l]) => row(l, "", sw(`bs_${k}`, s.briefing.sections[k]))).join("")}
      </article>
      <article class="panel"><div class="panel-head"><span class="label">Intelligence</span></div>
        ${row("Background idea engine", `A new business idea every ${s.ideas.everyMinutes} minutes`, sw("ideas", s.ideas.enabled))}
        ${row("Let JARVIS save memories automatically", "Sensitive ones still need your approval", sw("memAuto", s.memory.autoSave))}
        ${row("Computer control", "Allow actions on your laptop", sw("comp", s.computer.enabled))}
      </article>
      <article class="panel"><div class="panel-head"><span class="label">Finance</span></div>
        ${row("Include finances in JARVIS answers & briefings", "", sw("fin", s.finance.enabled))}
        ${row("Safety buffer", "Kept aside in “can I afford it?” answers", `<input class="inp" type="number" id="buf" value="${(s.finance.buffer / 100).toFixed(0)}" style="width:100px"> £`)}
      </article></div>`;
    const patch = (p) => api("/api/settings", { method: "PATCH", body: p }).then(() => toast("Saved.")).catch((e) => toast(e.message));
    $("#units").onchange = (e) => patch({ units: e.target.value });
    $("#tz").onchange = (e) => patch({ timezone: e.target.value.trim() });
    $("#bOn").onchange = (e) => patch({ briefing: { enabled: e.target.checked } });
    $("#bTime").onchange = (e) => patch({ briefing: { time: e.target.value } });
    for (const k of ["weather", "calendar", "tasks", "finance", "projects", "news"]) $(`#bs_${k}`).onchange = (e) => patch({ briefing: { sections: { [k]: e.target.checked } } });
    $("#ideas").onchange = (e) => patch({ ideas: { enabled: e.target.checked } });
    $("#memAuto").onchange = (e) => patch({ memory: { autoSave: e.target.checked } });
    $("#comp").onchange = (e) => patch({ computer: { enabled: e.target.checked } });
    $("#fin").onchange = (e) => patch({ finance: { enabled: e.target.checked } });
    $("#buf").onchange = (e) => patch({ finance: { buffer: Math.round(Number(e.target.value) * 100) } });
    $("#loc").onclick = async () => {
      const v = await formDialog("Find a place", [{ name: "q", label: "Town or city", required: true }]);
      if (!v) return;
      const res = await api(`/api/geocode?q=${encodeURIComponent(v.q)}`);
      if (!res.length) return toast("No match found.");
      const pick = await formDialog("Choose", [{ name: "i", label: "Place", type: "select", value: "0", options: res.map((r, i) => [String(i), r.name]) }]);
      if (!pick) return;
      const r = res[Number(pick.i)];
      await patch({ home: { lat: r.lat, lon: r.lon, place: r.name }, ...(r.timezone ? { timezone: r.timezone } : {}) });
      draw(ctx);
    };
    $("#gps").onclick = () => navigator.geolocation?.getCurrentPosition(async (p) => {
      await patch({ home: { lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4), place: "Current location" } }); draw(ctx);
    }, () => toast("Location permission was declined."), { timeout: 10000 });
  },

  async integrations(el, ctx) {
    const h = await api("/api/health");
    const i = h.integrations;
    const localMode = ctx.desktop?.mode === "local";
    const item = (name, ok, detail, how) => `<li class="item"><span class="dot ${ok === true ? "ok" : ok === "warn" ? "warn" : "bad"}"></span><div class="grow"><div><b>${name}</b></div><div class="meta">${detail}</div>${how ? `<div class="meta faint">${how}</div>` : ""}</div></li>`;
    el.innerHTML = `<article class="panel">${localMode ? '<div class="spread" style="margin-bottom:10px"><span class="muted">JARVIS runs on this laptop. Add or change keys in the keys window.</span><button class="btn small primary" id="openKeys">API keys & AI model</button></div>' : ""}<ul class="list">
      ${item("AI (Claude)", i.ai.configured, i.ai.configured ? `Model ${esc(i.ai.model)}` : "Not configured", i.ai.configured ? "" : "Server needs ANTHROPIC_API_KEY.")}
      ${item("Web research", i.webSearch && i.ai.configured, i.webSearch ? "Claude web search with citations" : "Disabled (JARVIS_WEB_SEARCH=false)")}
      ${item("Voice output", i.voice.tts ? true : "warn", i.voice.tts ? `Neural voice via ${i.voice.tts}` : "Browser voices only", i.voice.tts ? "" : "Add ELEVENLABS_API_KEY (recommended) or OPENAI_API_KEY.")}
      ${item("Voice input", i.voice.stt ? true : "warn", i.voice.sttLocal?.available ? "Whisper on this laptop — free and private" : i.voice.stt ? "OpenAI Whisper" : "Not available", i.voice.stt ? "" : "Install the Windows app (built-in speech recognition) or add an OpenAI API key.")}
      ${item("Monzo", i.monzo.connection?.status === "active" ? true : i.monzo.configured ? "warn" : false, i.monzo.connection ? `Connection ${esc(i.monzo.connection.status)} · synced ${ago(i.monzo.connection.last_sync_at)}` : i.monzo.configured ? "Configured — connect from Money" : "Not configured", i.monzo.configured ? "" : "Create a confidential client at developers.monzo.com and add MONZO_CLIENT_ID / MONZO_CLIENT_SECRET.")}
      ${item("Google Calendar", i.google.connection ? true : i.google.configured ? "warn" : false, i.google.connection ? `Connected · synced ${ago(i.google.connection.last_sync_at)}` : i.google.configured ? "Configured — connect from Agenda" : "Not configured (JARVIS's own calendar works)", i.google.configured ? "" : "Create an OAuth client in Google Cloud and add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.")}
      ${item("Weather", true, "Open-Meteo (no key required)")}
    </ul></article>`;
    $("#openKeys")?.addEventListener("click", () => ctx.desktop.openKeys());
  },

  async notify(el, ctx) {
    const supported = "serviceWorker" in navigator && "PushManager" in window;
    const isIOS = /iPhone|iPad/.test(navigator.userAgent);
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    let sub = null; if (supported) { const reg = await navigator.serviceWorker.ready; sub = await reg.pushManager.getSubscription(); }
    el.innerHTML = `<article class="panel">
      ${ctx.desktop ? row("Windows notifications", "The Windows app shows native notifications and speaks reminders aloud while it's running.", '<span class="pill ok">on</span>') : ""}
      ${!ctx.desktop ? row("Push notifications on this device", !supported ? (isIOS && !standalone ? "On iPhone: open in Safari → Share → Add to Home Screen, then open JARVIS from the icon." : "Not supported in this browser.") : sub ? "On" : Notification.permission === "denied" ? "Blocked in system settings" : "Off", supported ? `<button class="btn small ${sub ? "" : "primary"}" id="push">${sub ? "Turn off" : "Turn on"}</button>` : "") : ""}
      ${row("Send a test notification", "To every subscribed device", '<button class="btn small" id="test">Send</button>')}
      <p class="faint" style="font-size:13px">Reminders, the daily briefing, research results and new ideas are sent from the server, so they arrive even when every app is closed.</p></article>`;
    $("#test").onclick = async () => { const r = await api("/api/push/test", { method: "POST" }); toast(r.sent ? `Sent to ${r.sent} device(s).` : "No phones subscribed yet; open apps were notified live."); };
    $("#push")?.addEventListener("click", async () => {
      const reg = await navigator.serviceWorker.ready;
      if (sub) { await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); return draw(ctx); }
      if ((await Notification.requestPermission()) !== "granted") return toast("Notifications weren't allowed.");
      const key = ctx.session.vapidPublicKey; const pad = "=".repeat((4 - (key.length % 4)) % 4);
      const bytes = Uint8Array.from(atob((key + pad).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      await api("/api/push/subscribe", { method: "POST", body: s.toJSON() }); toast("Notifications on, sir."); draw(ctx);
    });
  },

  async security(el, ctx) {
    const audit = await api("/api/audit?limit=60");
    el.innerHTML = `<div class="grid cols-2">
      <article class="panel"><div class="panel-head"><span class="label">Account</span></div>
        ${row("Change password", "Signs out every other device", '<button class="btn small" id="pw">Change</button>')}
        ${row("Sign out of this device", "", '<button class="btn small" id="logout">Sign out</button>')}
        ${row("Export memories", "Download everything JARVIS remembers", '<a class="btn small" href="/api/memories/export" download>Export</a>')}
        ${row("Delete conversation history", "Removes every conversation on every device", '<button class="btn small danger" id="wipeConv">Delete</button>')}
        <div class="label" style="margin-top:14px">How your data is protected</div>
        <ul style="font-size:13px;padding-left:18px" class="muted"><li>All traffic is HTTPS; sessions are random tokens stored only as hashes, rotated daily and expiring after inactivity.</li><li>Every device is individually authorised and can be signed out instantly.</li><li>Bank and calendar tokens are encrypted on the server (AES-256-GCM) and never sent to your devices. JARVIS never sees your bank password.</li><li>Finance access is read-only. Calendar changes and clashing bookings need your confirmation.</li><li>The wake word runs locally on your laptop; idle microphone audio is never uploaded.</li><li>Computer control is limited to an allowlist: no shell, no deleting, installing or changing settings.</li></ul>
      </article>
      <article class="panel"><div class="panel-head"><span class="label">Audit log</span></div><div class="scroll-x" style="max-height:480px;overflow-y:auto"><table class="tbl"><tbody>${audit.map((a) => `<tr><td class="mono faint" style="white-space:nowrap">${fmtWhen(a.at)}</td><td>${esc(a.action)}</td><td class="muted">${esc(a.device_name || "")}${a.detail?.action ? ` · ${esc(a.detail.action)}` : ""}${a.ip ? ` · ${esc(a.ip)}` : ""}</td></tr>`).join("")}</tbody></table></div></article></div>`;
    $("#pw").onclick = async () => {
      const v = await formDialog("Change password", [{ name: "current", label: "Current password", type: "password", required: true }, { name: "next", label: "New password (10+ characters)", type: "password", required: true }]);
      if (!v) return;
      try { await api("/api/password", { method: "POST", body: v }); toast("Password changed. Other devices were signed out."); } catch (e) { toast(e.message); }
    };
    $("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); location.reload(); };
    $("#wipeConv").onclick = async () => {
      if (!(await confirmDialog("Delete all conversations?", "This can't be undone.", { ok: "Delete", danger: true }))) return;
      const { list } = await api("/api/conversations");
      for (const c of list) await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      toast("Conversation history deleted.");
    };
  },

  async health(el) {
    const h = await api("/api/health");
    const label = { ok: ["Running", "ok"], waiting: ["Waiting for first run", "warn"], error: ["Error", "bad"], stale: ["Not running on schedule", "bad"], disabled: ["Switched off", ""], not_configured: ["Not configured", ""] };
    el.innerHTML = `<div class="grid cols-2">
      <article class="panel"><div class="panel-head"><span class="label">Background services (server)</span><span class="faint" style="font-size:12px">up ${Math.round(h.server.uptime / 60)} min · Node ${esc(h.server.node)}</span></div>
        ${h.services.map((s) => `<div class="svc"><span class="dot ${label[s.state][1]}"></span><div><b>${esc(s.label)}</b><div class="muted" style="font-size:12px">${label[s.state][0]}${s.lastOk ? ` · last success ${ago(s.lastOk)}` : ""}${s.lastError ? ` · <span style="color:var(--bad)">${esc(s.lastError)}</span>` : ""}${s.note ? `<br>${esc(s.note)}` : ""}</div></div></div>`).join("")}
        <p class="faint" style="font-size:12px">Last backup: ${h.backup ? `${esc(h.backup.file)} (${ago(h.backup.at)})` : "none yet"}</p></article>
      <article class="panel"><div class="panel-head"><span class="label">Laptop (wake word & computer control)</span></div>
        ${h.desktops.length ? h.desktops.map((d) => `<div class="svc"><span class="dot ${d.online ? (d.status?.wakeWord === "listening" ? "live" : "warn") : ""}"></span><div><b>${esc(d.deviceName)}</b><div class="muted" style="font-size:12px">${d.online ? `Online · wake word ${esc(d.status?.wakeWord || "unknown")}${d.status?.muted ? " · microphone muted" : ""}${d.status?.error ? ` · ${esc(d.status.error)}` : ""}` : `Offline since ${ago(d.offlineAt || d.at)} — asleep, shut down, or JARVIS exited`}</div></div></div>`).join("")
          : '<p class="muted">The Windows app hasn\'t connected yet. Install it and sign in; its status appears here.</p>'}
        <p class="faint" style="font-size:12px">While the laptop sleeps or is offline, the wake word is unavailable. Reminders and briefings still arrive on your phone from the server.</p></article></div>`;
  },
};

async function drawTailscale(ctx, local) {
  const el = $("#ts"); if (!el) return;
  const d = ctx.desktop;
  const st = await d.tailscaleStatus();
  const badge = $("#tsBadge");
  if (local.phoneAccess && st.serving) {
    badge.innerHTML = '<span class="pill ok">on</span>';
    el.innerHTML = `<p style="margin-top:0">Your iPhone reaches JARVIS at <b class="mono">${esc(local.phoneUrl)}</b> through Tailscale. Only devices signed in to your Tailscale account can open it.</p>
      <ol style="padding-left:18px;font-size:14px"><li>On the iPhone, install <b>Tailscale</b> from the App Store and sign in with the same account. Leave it connected.</li><li>Below, tap <b>Show pairing code</b> and scan it with the iPhone camera.</li></ol>
      <p class="faint" style="font-size:13px">When this laptop is off or asleep, the phone can't reach JARVIS; reminders wait until it's back.</p>
      <button class="btn small ghost" id="tsOff">Turn off iPhone access</button>`;
    $("#tsOff").onclick = async () => { await d.tailscaleDisable(); toast("iPhone access turned off."); };
    return;
  }
  badge.innerHTML = '<span class="pill">off</span>';
  const steps = !st.installed
    ? `<p style="margin-top:0">To use JARVIS on your iPhone for free, install <b>Tailscale</b> (a free private network) on this laptop and your iPhone. Nothing is opened to the public internet.</p><div class="row wrap"><button class="btn small primary" id="tsGet">Download Tailscale for Windows</button><button class="btn small" id="tsCheck">I've installed it</button></div>`
    : !st.running
      ? `<p style="margin-top:0">Tailscale is installed. Open it from the system tray and <b>sign in</b> (a free personal account is fine), then:</p><button class="btn small" id="tsCheck">Check again</button>`
      : `<p style="margin-top:0">Tailscale is connected as <b class="mono">${esc(st.dnsName)}</b>. Turn on iPhone access to give your own devices a private HTTPS address for JARVIS.</p><button class="btn small primary" id="tsOn">Turn on iPhone access</button><p class="error" id="tsErr"></p>`;
  el.innerHTML = steps;
  $("#tsGet")?.addEventListener("click", () => d.tailscaleOpen("https://tailscale.com/download/windows"));
  $("#tsCheck")?.addEventListener("click", () => drawTailscale(ctx, local));
  $("#tsOn")?.addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Turning on…";
    const r = await d.tailscaleEnable();
    if (r.ok) { toast("iPhone access is on."); return; }   // app reloads with the new address
    $("#tsErr").innerHTML = `${esc(r.error)}${r.enableUrl ? ' <button class="btn small" id="tsLink">Open approval page</button>' : ""}`;
    $("#tsLink")?.addEventListener("click", () => d.tailscaleOpen(r.enableUrl));
    e.target.disabled = false; e.target.textContent = "Try again";
  });
}

try { voice.micDeviceId = localStorage.getItem("jarvis.mic") || null; } catch {}

// ---------------------------------------------------------------- Ultimate upgrade sections
const P = (p) => api("/api/settings", { method: "PATCH", body: p }).then(() => toast("Saved.")).catch((e) => toast(e.message));
Object.assign(SECTIONS, {
  async profile(el) {
    const s = await api("/api/settings");
    const pr = s.profile || {}, pe = s.personality || {};
    el.innerHTML = `<div class="grid cols-2"><article class="panel"><div class="panel-head"><span class="label">About you</span></div>
      <div class="stack"><label class="field"><span>Your name</span><input class="inp" id="pName" value="${esc(pr.name || "")}" placeholder="Dylan"></label>
      <label class="field"><span>How JARVIS addresses you</span><input class="inp" id="pTitle" value="${esc(pr.title || "Sir")}" placeholder="Sir"><span class="hint">“Good morning, ${esc(pr.title || "Sir")}.”</span></label>
      <div class="grid cols-2"><label class="field"><span>City</span><input class="inp" id="pCity" value="${esc(pr.city || "")}"></label><label class="field"><span>Country</span><input class="inp" id="pCountry" value="${esc(pr.country || "")}"></label></div>
      <div class="row end"><button class="btn small primary" id="pSave">Save</button></div></div></article>
      <article class="panel"><div class="panel-head"><span class="label">Personality</span></div>
        ${row("Reply length", "Spoken replies are kept short either way", `<select class="inp" id="verb" style="width:auto"><option value="brief" ${pe.verbosity !== "detailed" ? "selected" : ""}>Brief</option><option value="detailed" ${pe.verbosity === "detailed" ? "selected" : ""}>More detail</option></select>`)}
        ${row("Humour", "Dry, understated wit", `<select class="inp" id="hum" style="width:auto"><option value="dry" ${pe.humour !== "none" ? "selected" : ""}>Dry wit</option><option value="none" ${pe.humour === "none" ? "selected" : ""}>Strictly business</option></select>`)}
        <p class="faint" style="font-size:12.5px">Whatever the setting, JARVIS only states facts from your data or cited sources, and only confirms an action once it has actually been done.</p></article></div>`;
    $("#pSave").onclick = () => P({ profile: { name: $("#pName").value, title: $("#pTitle").value, city: $("#pCity").value, country: $("#pCountry").value } });
    $("#verb").onchange = (e) => P({ personality: { verbosity: e.target.value } });
    $("#hum").onchange = (e) => P({ personality: { humour: e.target.value } });
  },
  async conversation(el, ctx) {
    const s = await api("/api/settings");
    const v = s.voice || {};
    const voices = "speechSynthesis" in window ? speechSynthesis.getVoices().filter((x) => x.lang?.startsWith("en")) : [];
    el.innerHTML = `<div class="grid cols-2"><article class="panel"><div class="panel-head"><span class="label">Continuous conversation</span></div>
      ${row("Keep listening after each answer", "After “Hey JARVIS”, ask follow-ups without the wake word. Ends on silence, “End conversation” or “Stop listening”.", sw("cont", v.continuous !== false))}
      ${row("Silence before standby", "How long JARVIS waits for a follow-up", `<input class="inp" type="number" id="tout" min="3" max="60" value="${v.timeoutSec || 8}" style="width:80px"> s`)}
      ${row("“Stay with me” keeps listening for", "", `<input class="inp" type="number" id="stay" min="30" max="900" value="${v.stayWithMeSec || 120}" style="width:90px"> s`)}
      ${row("Interrupt by saying “JARVIS”", "Stops JARVIS mid-sentence (barge-in)", sw("barge", v.bargeIn !== false))}
      ${row("Listening chime", "", sw("chime", v.chime !== false))}
      <p class="faint" style="font-size:12.5px">The microphone only records after the wake word, a key press or a tap — never while idle — and audio is only processed on this laptop unless you use a cloud speech service.</p></article>
      <article class="panel"><div class="panel-head"><span class="label">Speaking</span></div>
      ${row("Speak replies to typed messages", "", sw("spk", v.speakReplies !== false))}
      ${row("Read briefings aloud", "", sw("spkB", v.speakBriefings !== false))}
      ${row("Say reminders and alerts aloud", "On the laptop", sw("spkN", v.speakNotifications !== false))}
      ${row("Speech rate", "Built-in Windows voice", `<input type="range" id="rate" min="0.6" max="1.6" step="0.05" value="${v.rate || 1}" style="width:140px"> <span id="rateV" class="mono">${(v.rate || 1).toFixed(2)}×</span>`)}
      ${row("Voice", ctx.session?.tts ? `Premium voice in use (${esc(ctx.session.tts)}). This choice is the fallback.` : "Built-in voices on this device", `<select class="inp" id="vname" style="max-width:230px"><option value="">Automatic (British)</option>${voices.map((x) => `<option ${x.name === v.voiceName ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`)}
      ${row("Test the voice", "", '<button class="btn small" id="vtest">Speak</button>')}</article></div>`;
    const b = (id, key) => $(`#${id}`).onchange = (e) => P({ voice: { [key]: e.target.checked } });
    b("cont", "continuous"); b("barge", "bargeIn"); b("chime", "chime"); b("spk", "speakReplies"); b("spkB", "speakBriefings"); b("spkN", "speakNotifications");
    $("#tout").onchange = (e) => P({ voice: { timeoutSec: Number(e.target.value) } });
    $("#stay").onchange = (e) => P({ voice: { stayWithMeSec: Number(e.target.value) } });
    $("#rate").oninput = (e) => { $("#rateV").textContent = `${Number(e.target.value).toFixed(2)}×`; voice.cfg.rate = Number(e.target.value); };
    $("#rate").onchange = (e) => P({ voice: { rate: Number(e.target.value) } });
    $("#vname").onchange = (e) => { voice.cfg.voiceName = e.target.value; P({ voice: { voiceName: e.target.value } }); };
    $("#vtest").onclick = () => { voice.ensureAudio(); const sp = voice.createSpeaker(); sp.push(`Good ${new Date().getHours() < 12 ? "morning" : "afternoon"}, ${s.profile?.title || "Sir"}. All systems are at your disposal.`); sp.finish(); };
  },
  async appearance(el) {
    const s = await api("/api/settings");
    const a = s.appearance || {};
    el.innerHTML = `<article class="panel" style="max-width:760px"><div class="panel-head"><span class="label">Appearance</span></div>
      ${row("Animation", "Reduced slows the core and turns off parallax; Off shows a still core", `<div class="seg" id="anim">${["full", "reduced", "off"].map((k) => `<button data-a="${k}" class="${(a.animation || "full") === k ? "active" : ""}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div>`)}
      ${row("3D core quality", "Automatic drops to light mode on slower laptops", `<div class="seg" id="qual">${[["auto", "Auto"], ["high", "High"], ["low", "Light"], ["2d", "2D"]].map(([k, l]) => `<button data-q="${k}" class="${(a.quality || "auto") === k ? "active" : ""}">${l}</button>`).join("")}</div>`)}
      ${row("Sidebar", "", `<div class="seg" id="side"><button data-sb="expanded">Expanded</button><button data-sb="collapsed">Collapsed</button></div>`)}
      <p class="faint" style="font-size:12.5px">Your system's “reduce motion” setting is always respected.</p></article>`;
    $$("[data-a]", el).forEach((x) => x.onclick = async () => { await P({ appearance: { animation: x.dataset.a } }); location.reload(); });
    $$("[data-q]", el).forEach((x) => x.onclick = async () => { await P({ appearance: { quality: x.dataset.q } }); $$("[data-q]", el).forEach((y) => y.classList.toggle("active", y === x)); });
    $$("[data-sb]", el).forEach((x) => x.onclick = () => { document.getElementById("app").classList.toggle("collapsed", x.dataset.sb === "collapsed"); try { localStorage.setItem("jarvis.sidebar", x.dataset.sb); } catch {} });
  },
  async alarmprefs(el) {
    const s = await api("/api/settings");
    const a = s.alarms || {}, f = s.focus || {};
    const sounds = await api("/api/alarms/sounds");
    el.innerHTML = `<div class="grid cols-2"><article class="panel"><div class="panel-head"><span class="label">Alarm defaults</span></div>
      ${row("Sound", "", `<select class="inp" id="aSound" style="width:auto">${sounds.map((x) => `<option value="${esc(x.id)}" ${x.id === a.defaultSound ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`)}
      ${row("Volume", "", `<input type="range" id="aVol" min="5" max="100" value="${a.defaultVolume ?? 80}" style="width:140px">`)}
      ${row("Start quietly and get louder", "Over the first 30 seconds", sw("aGrad", a.gradual !== false))}
      ${row("Snooze length", "", `<input class="inp" type="number" id="aSnz" min="1" max="60" value="${a.snoozeMinutes || 10}" style="width:80px"> min`)}
      ${row("Speak the time and a greeting", "“Good morning, Sir. It is 7 AM.”", sw("aSpeak", a.speak !== false))}
      ${row("Wake the laptop from sleep for alarms", "Uses a Windows scheduled wake-up", sw("aWake", a.wakeComputer !== false))}</article>
      <article class="panel"><div class="panel-head"><span class="label">Focus</span></div>
      ${row("Focus session", "", `<input class="inp" type="number" id="fW" min="5" max="240" value="${f.workMinutes || 25}" style="width:80px"> min`)}
      ${row("Break", "", `<input class="inp" type="number" id="fB" min="1" max="60" value="${f.breakMinutes || 5}" style="width:80px"> min`)}</article></div>`;
    $("#aSound").onchange = (e) => P({ alarms: { defaultSound: e.target.value } });
    $("#aVol").onchange = (e) => P({ alarms: { defaultVolume: Number(e.target.value) } });
    $("#aGrad").onchange = (e) => P({ alarms: { gradual: e.target.checked } });
    $("#aSnz").onchange = (e) => P({ alarms: { snoozeMinutes: Number(e.target.value) } });
    $("#aSpeak").onchange = (e) => P({ alarms: { speak: e.target.checked } });
    $("#aWake").onchange = (e) => P({ alarms: { wakeComputer: e.target.checked } });
    $("#fW").onchange = (e) => P({ focus: { workMinutes: Number(e.target.value) } });
    $("#fB").onchange = (e) => P({ focus: { breakMinutes: Number(e.target.value) } });
  },
  async data(el) {
    const SCOPES = [["conversations", "Conversations"], ["memories", "Memories"], ["notes", "Notes"], ["documents", "Documents"], ["research", "Research & ideas"], ["tasks", "Tasks & reminders"], ["alarms", "Alarms & history"], ["money", "Hand-entered money, goals & debts"], ["business", "Clients, proposals & invoices"], ["productivity", "Goals, habits & focus"], ["activity", "Notifications & activity"]];
    el.innerHTML = `<div class="grid cols-2"><article class="panel"><div class="panel-head"><span class="label">Export</span></div><p class="muted" style="margin-top:0">A JSON file with everything you've stored in JARVIS (never your passwords or bank tokens).</p><a class="btn primary" href="/api/export" download>${"Download my data"}</a></article>
      <article class="panel"><div class="panel-head"><span class="label">Delete</span></div><p class="muted" style="margin-top:0">A backup copy of the database is made before anything is deleted (kept in the backups folder).</p>
      <ul class="list">${SCOPES.map(([k, l]) => `<li class="item"><div class="grow">${l}</div><button class="btn tiny danger" data-wipe="${k}">Delete</button></li>`).join("")}</ul>
      <div class="row end" style="margin-top:10px"><button class="btn danger" data-wipe="everything">Delete everything</button></div></article></div>`;
    $$("[data-wipe]", el).forEach((b) => b.onclick = async () => {
      const scope = b.dataset.wipe, label = SCOPES.find((s) => s[0] === scope)?.[1] || "everything";
      const v = await formDialog(`Delete ${label.toLowerCase()}?`, [{ name: "confirm", label: "Type DELETE to confirm", required: true }], { ok: "Delete" });
      if (!v || v.confirm.trim().toUpperCase() !== "DELETE") return v && toast("Not deleted — you didn't type DELETE.");
      try { const r = await api("/api/data/wipe", { method: "POST", body: { scope, confirm: "DELETE" } }); toast(`Deleted (${r.rows} rows). Backup: ${r.backup}`, 7000); } catch (e) { toast(e.message); }
    });
  },
});
TABS.splice(1, 0, ["profile", "Profile & personality"], ["microphone", "Microphone & speech"], ["conversation", "Voice & conversation"]);
SECTIONS.microphone = (el, ctx) => renderMicSetup(el, ctx);
TABS.splice(TABS.findIndex((t) => t[0] === "integrations"), 0, ["appearance", "Appearance"], ["alarmprefs", "Alarms & focus"]);
TABS.splice(TABS.findIndex((t) => t[0] === "health"), 1, ["data", "Your data"]);
