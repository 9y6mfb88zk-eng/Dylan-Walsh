// JARVIS for Windows — main process.
// Tray app with close-to-tray, start with Windows, an always-on local wake-word service (hidden audio window),
// push-to-talk and mute shortcuts, crash/sleep recovery, and allowlisted computer actions.
import { app, BrowserWindow, safeStorage, utilityProcess, Tray, Menu, ipcMain, globalShortcut, shell, nativeImage, Notification, powerMonitor, session, systemPreferences, dialog, powerSaveBlocker, screen, clipboard, desktopCapturer } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createActions } from "./actions.js";
import { ServerManager, locateServer } from "./server-manager.js";
import { createSecrets } from "./secrets.js";
import * as tailscale from "./tailscale.js";
import { createAgent } from "./agent.js";
import { windowsControl, lockScreen, systemStatus } from "./windows-control.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const VERSION = app.getVersion();
const ALLOWED_AUTH_HOSTS = ["auth.monzo.com", "accounts.google.com"];
app.setAppUserModelId("com.jarvis.desktop");
// Wake-word detection must keep running while the window is hidden.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

// ---------------------------------------------------------------- Settings (persisted in %APPDATA%\JARVIS)
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
const DEFAULTS = {
  mode: "local",                 // "local" = JARVIS server runs on this laptop; "remote" = connect to a cloud server
  serverUrl: process.env.JARVIS_SERVER_URL || "",
  phoneAccess: false, phoneUrl: null,
  wakeEnabled: true, wakeJarvisAlone: true, threshold: 0.5, minFrames: 2, vadThreshold: 0.03, micDeviceId: null,
  endpointMs: 1200, noiseSuppression: true, echoCancellation: true, autoGainControl: true, calibratedAt: null,
  autoStart: true, closeToTray: true, computerEnabled: true, bookmarks: {},
  pttShortcut: "CommandOrControl+Shift+Space", muteShortcut: "CommandOrControl+Shift+M",
};
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) }; } catch {}
if (process.env.JARVIS_SERVER_URL) { settings.serverUrl = process.env.JARVIS_SERVER_URL; settings.mode = "remote"; }
const isLocal = () => settings.mode !== "remote";
function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  applySettings(patch);
  return settings;
}
let currentUrl = isLocal() ? null : settings.serverUrl;   // what the main window loads
const serverOrigin = () => { try { return new URL(currentUrl).origin; } catch { return null; } };

// ---------------------------------------------------------------- Bundled models (outside the asar so native code can read them)
function modelDir(name) {
  const packaged = path.join(process.resourcesPath || "", "models", name);
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  if (name === "asr") return process.env.JARVIS_ASR_DIR || path.join(root, "bundle", "asr");
  if (name === "tts") return process.env.JARVIS_TTS_DIR || path.join(root, "bundle", "tts");
  return path.join(root, "models", name);
}
function sherpaPath() {
  const loc = locateServer({ appRoot: root, resourcesPath: process.resourcesPath, packaged: app.isPackaged });
  return path.join(loc.dir, "node_modules", "sherpa-onnx-node");
}

// ---------------------------------------------------------------- "JARVIS" keyword spotter (utility process)
let kws = null, kwsRestarts = 0;
const INTERRUPT_WORDS = new Set(["WAIT", "HOLD_ON"]);
function startKws() {
  try {
    kws = utilityProcess.fork(path.join(here, "kws-worker.cjs"), [], {
      serviceName: "JARVIS keyword spotter", stdio: "ignore",
      env: { ...process.env, JARVIS_SHERPA_PATH: sherpaPath(), JARVIS_KWS_DIR: modelDir("kws") },
    });
  } catch (e) { status.kws = "error"; status.kwsError = e.message; return; }
  kws.on("message", (m) => {
    if (m.type === "ready") { status.kws = "ready"; status.kwsError = null; kws.postMessage({ type: "config", jarvis: settings.wakeJarvisAlone }); pushStatus(); log("keyword spotter ready"); }
    if (m.type === "error") { status.kws = "error"; status.kwsError = m.error; pushStatus(); log("keyword spotter error", m.error); }
    if (m.type === "wake") {
      // "Wait" / "Hold on" only ever interrupt JARVIS while it is speaking in a conversation; they never wake it.
      if (INTERRUPT_WORDS.has(m.keyword)) { if (voiceState === "speaking" && bargeInAllowed() && serverVoice.interruptWords !== false) onWake(`keyword:${m.keyword}`, 1, { interruptWord: m.keyword }); return; }
      onWake(`keyword:${m.keyword}`, 1);
    }
  });
  kws.on("exit", (code) => {
    kws = null; log("keyword spotter exited", code);
    if (!quitting && status.kws !== "error" && kwsRestarts++ < 5) setTimeout(startKws, 2000);
  });
}

// ---------------------------------------------------------------- Local server (JARVIS on this laptop)
let server = null, secretsStore = null;   // secretsStore is created once Electron is ready (needs safeStorage)
function serverEnv() {
  return { ...secretsStore.env(), ...(settings.phoneAccess && settings.phoneUrl ? { PUBLIC_URL: settings.phoneUrl } : {}), JARVIS_TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, JARVIS_ASR_DIR: modelDir("asr"), JARVIS_TTS_DIR: modelDir("tts"), JARVIS_VERSION: VERSION };
}
async function startLocalServer() {
  const loc = locateServer({ appRoot: root, resourcesPath: process.resourcesPath, packaged: app.isPackaged });
  server = new ServerManager({
    ...loc, dataDir: path.join(app.getPath("userData"), "data"), logFile: path.join(app.getPath("userData"), "server.log"),
    onState: (st, detail) => { status.server = st; status.serverError = detail || null; pushStatus(); log("server", st, detail || ""); },
  });
  const ok = await server.start(serverEnv());
  currentUrl = server.url;
  return ok;
}

// ---------------------------------------------------------------- State
let win = null, audioWin = null, setupWin = null, tray = null, quitting = false;
let status = { wakeWord: "starting", mic: "unknown", muted: false, lastScore: 0, lastWake: null, error: null, version: VERSION, computer: settings.computerEnabled };
let sessionActive = false, voiceState = "idle", serverVoice = { bargeIn: true };
let listenReq = null;          // { id, resolve, timer } — a follow-up capture requested by the conversation
const startHidden = process.argv.includes("--hidden");
const log = (...a) => { try { fs.appendFileSync(path.join(app.getPath("userData"), "jarvis.log"), `${new Date().toISOString()} ${a.join(" ")}\n`); } catch {} if (process.env.JARVIS_DEBUG) console.log(...a); };

// ---------------------------------------------------------------- Single instance
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on("second-instance", (_e, argv) => {
  // Task Scheduler starts "JARVIS.exe --alarm-check" for the next alarm; if JARVIS is already running, just check alarms.
  if (argv.includes("--alarm-check")) { log("alarm check (second instance)"); agent?.check(); agent?.sync().catch(() => {}); return; }
  showMain();
});

// ---------------------------------------------------------------- Windows
function iconPath(name = "icon.png") { return path.join(root, "build", name); }

function createMain() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 600, show: false, backgroundColor: "#01040a", title: "JARVIS",
    icon: iconPath(), autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required", additionalArguments: [`--jarvis-origin=${serverOrigin()}`, `--jarvis-version=${VERSION}`, `--jarvis-mode=${isLocal() ? "local" : "remote"}`],
    },
  });
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} JARVIS-Desktop/${VERSION}`);
  win.loadURL(currentUrl);
  win.once("ready-to-show", () => { if (!startHidden) win.show(); });
  win.on("close", (e) => { if (!quitting && settings.closeToTray) { e.preventDefault(); win.hide(); notifyOnce("JARVIS is still running", "Find me in the system tray. Say “Hey JARVIS” any time."); } });
  win.on("closed", () => { win = null; });
  // Navigation: only the JARVIS server and the bank/calendar sign-in pages stay in the app.
  const guard = (e, url) => {
    try {
      const u = new URL(url);
      if (u.origin === serverOrigin() || ALLOWED_AUTH_HOSTS.includes(u.hostname)) return;
      e.preventDefault();
      if (u.protocol === "https:") shell.openExternal(url);
    } catch { e.preventDefault(); }
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  // Recovery
  win.webContents.on("render-process-gone", (_e, d) => { log("main renderer gone", d.reason); setTimeout(() => win?.webContents.reload(), 1000); });
  win.on("unresponsive", () => { log("main window unresponsive"); setTimeout(() => win?.webContents.reload(), 5000); });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3) return; // aborted (navigation)
    log("load failed", code, desc, url);
    win.webContents.loadFile(path.join(here, "offline.html"), { query: { url: currentUrl, error: desc } });
  });
}

function createAudio() {
  audioWin = new BrowserWindow({
    show: false, width: 300, height: 200, skipTaskbar: true, title: "JARVIS audio",
    webPreferences: { preload: path.join(here, "audio", "preload-audio.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  audioWin.loadFile(path.join(here, "audio", "audio.html"));
  audioWin.webContents.on("render-process-gone", (_e, d) => { log("audio gone", d.reason); status.wakeWord = "error"; status.error = "Audio service crashed; restarting"; pushStatus(); setTimeout(restartAudio, 1500); });
  audioWin.on("closed", () => { audioWin = null; });
}
function restartAudio() { try { audioWin?.destroy(); } catch {} createAudio(); }
const bargeInAllowed = () => sessionActive && serverVoice.bargeIn !== false && voiceState !== "listening";
function audioConfig() {
  // The microphone runs while the wake word is on, or while you're in a conversation (follow-ups), never when muted.
  // Wake-word detection is off during a conversation, except to interrupt JARVIS while it's talking (barge-in).
  const micOn = !status.muted && !suspended && (settings.wakeEnabled || sessionActive || !!listenReq);
  return {
    enabled: micOn, paused: false, micOn, muted: status.muted, wakeEnabled: settings.wakeEnabled,
    detect: settings.wakeEnabled && !status.muted && (!sessionActive || bargeInAllowed()),
    threshold: settings.threshold, minFrames: settings.minFrames, micDeviceId: settings.micDeviceId, vadThreshold: settings.vadThreshold,
    endpointMs: settings.endpointMs, noiseSuppression: settings.noiseSuppression, echoCancellation: settings.echoCancellation, autoGainControl: settings.autoGainControl,
  };
}
function sendAudioConfig() { audioWin?.webContents.send("audio:config", audioConfig()); }

function createSetup() {
  setupWin = new BrowserWindow({
    width: 520, height: 560, resizable: false, backgroundColor: "#01040a", title: "Connect JARVIS", icon: iconPath(), autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, "setup-preload.cjs"), contextIsolation: true, sandbox: true },
  });
  setupWin.loadFile(path.join(here, "setup.html"), { query: { url: settings.serverUrl } });
  setupWin.on("closed", () => { setupWin = null; if (!win && !quitting) app.quit(); });
}

let keysWin = null;
function createKeys({ firstRun = false } = {}) {
  if (keysWin) return keysWin.show();
  keysWin = new BrowserWindow({
    width: 560, height: 760, backgroundColor: "#01040a", title: "JARVIS — keys", icon: iconPath(), autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, "keys-preload.cjs"), contextIsolation: true, sandbox: true },
  });
  keysWin.loadFile(path.join(here, "keys.html"), { query: { firstRun: firstRun ? "1" : "" } });
  keysWin.on("closed", () => { keysWin = null; if (firstRun && !win && !quitting) bootLocal(); });
}

function showMain() {
  if (!win) return setupWin?.show();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

// ---------------------------------------------------------------- Status, tray, notifications
function pushStatus() {
  status.computer = settings.computerEnabled;
  win?.webContents.send("jarvis:status", status);
  updateTray();
}
function trayLabel() {
  if (status.muted) return "Microphone muted";
  if (!settings.wakeEnabled) return "Wake word off";
  return { listening: "Listening for “Hey JARVIS”", starting: "Starting…", loading: "Loading wake-word model…", paused: "In conversation", conversation: "In conversation", asleep: "Paused (sleep)", error: `Problem: ${status.error || "microphone"}` }[status.wakeWord] || status.wakeWord;
}
function updateTray() {
  if (!tray) return;
  tray.setToolTip(`JARVIS — ${trayLabel()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `JARVIS ${VERSION}`, enabled: false },
    { label: trayLabel(), enabled: false },
    { type: "separator" },
    { label: "Open JARVIS", click: showMain },
    { label: "Talk now (push-to-talk)", accelerator: settings.pttShortcut, click: () => pushToTalk() },
    { label: status.muted ? "Unmute microphone" : "Mute microphone", accelerator: settings.muteShortcut, click: () => setMuted(!status.muted) },
    { label: "Listen for “Hey JARVIS”", type: "checkbox", checked: settings.wakeEnabled, click: (m) => saveSettings({ wakeEnabled: m.checked }) },
    { label: "Start with Windows", type: "checkbox", checked: settings.autoStart, click: (m) => saveSettings({ autoStart: m.checked }) },
    { label: agent?.status?.ringing ? "Dismiss the alarm" : `Alarms: ${agent?.status?.scheduled ?? 0} scheduled`, enabled: !!agent?.status?.ringing, click: () => agent?.dismiss() },
    ...(isLocal() ? [{ label: "API keys & AI model…", click: () => createKeys() }] : [{ label: "Change server…", click: () => { win?.hide(); createSetup(); } }]),
    { type: "separator" },
    { label: "Exit JARVIS", click: quitFully },
  ]));
}
let notified = false;
function notifyOnce(title, body) { if (notified) return; notified = true; notify(title, body); }
function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: false });
  n.on("click", showMain);
  n.show();
}

function setMuted(m) {
  status.muted = !!m;
  status.wakeWord = m ? "muted" : settings.wakeEnabled ? "starting" : "disabled";
  sendAudioConfig(); pushStatus();
  log("microphone", m ? "muted" : "unmuted");
}
function pushToTalk() { showMain(); win?.webContents.send("jarvis:ptt"); }

function applySettings(patch) {
  if ("autoStart" in patch) app.setLoginItemSettings({ openAtLogin: !!settings.autoStart, args: ["--hidden"] });
  if (["noiseSuppression", "echoCancellation", "autoGainControl"].some((k) => k in patch)) audioWin?.webContents.send("audio:config", { ...audioConfig(), restartMic: true });
  if (["wakeEnabled", "threshold", "minFrames", "micDeviceId", "vadThreshold", "endpointMs"].some((k) => k in patch)) {
    if ("wakeEnabled" in patch && !settings.wakeEnabled) status.wakeWord = "disabled";
    sendAudioConfig();
  }
  if ("pttShortcut" in patch || "muteShortcut" in patch) registerShortcuts();
  if ("wakeJarvisAlone" in patch) kws?.postMessage({ type: "config", jarvis: !!settings.wakeJarvisAlone });
  pushStatus();
}
function registerShortcuts() {
  globalShortcut.unregisterAll();
  try { globalShortcut.register(settings.pttShortcut, pushToTalk); } catch (e) { log("shortcut failed", e.message); }
  try { globalShortcut.register(settings.muteShortcut, () => setMuted(!status.muted)); } catch (e) { log("shortcut failed", e.message); }
}

async function quitFully() {
  if (quitting && !server) return;
  quitting = true;
  log("exit requested");
  globalShortcut.unregisterAll();
  tray?.destroy(); tray = null;
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  try { kws?.kill(); } catch {}
  agent?.stop();
  await server?.stop();          // the local JARVIS server stops with the app — nothing keeps running secretly
  server = null;
  app.quit();
}

// ---------------------------------------------------------------- Computer actions
const actionLog = path.join(app.getPath("userData"), "actions.log");
const runAction = createActions({
  paths: Object.fromEntries(["downloads", "documents", "desktop", "pictures", "music", "videos"].map((k) => [k, app.getPath(k)])),
  openPath: (p) => shell.openPath(p),
  openExternal: (u) => shell.openExternal(u),
  settings: () => settings,
  log: (e) => { try { fs.appendFileSync(actionLog, JSON.stringify({ ...e, args: e.action === "clipboard_write" ? { text: `(${e.args?.text?.length || 0} characters)` } : e.args }) + "\n"); } catch {} },
  async screenshot() {
    const d = screen.getPrimaryDisplay();
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const [src] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    if (!src) throw new Error("Couldn't capture the screen.");
    return src.thumbnail.toPNG();
  },
  clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) },
  windows: windowsControl(),
  lock: () => lockScreen(),
  systemStatus: () => systemStatus({ displays: screen.getAllDisplays().length }),
  async launch(_key, def) {
    // Fixed executable names from the allowlist only; arguments never come from the AI.
    const opts = { detached: true, stdio: "ignore", windowsHide: true };
    if (process.platform === "win32") {
      const exe = def.win[0];
      const child = spawn("cmd.exe", ["/d", "/c", "start", "\"\"", exe], { ...opts, windowsVerbatimArguments: true });
      child.unref();
      return;
    }
    if (process.platform === "darwin") { spawn("open", ["-a", def.mac[0]], opts).unref(); return; }
    if (!def.linux[0]) throw new Error(`${def.label} isn't available on this system.`);
    spawn(def.linux[0], [], opts).on("error", () => {}).unref();
  },
});

// ---------------------------------------------------------------- IPC
ipcMain.handle("jarvis:getStatus", () => status);
ipcMain.handle("jarvis:getSettings", () => settings);
ipcMain.handle("jarvis:setSettings", (_e, patch) => {
  const allowed = ["wakeEnabled", "wakeJarvisAlone", "threshold", "minFrames", "vadThreshold", "micDeviceId", "autoStart", "closeToTray", "computerEnabled", "bookmarks", "endpointMs", "noiseSuppression", "echoCancellation", "autoGainControl", "calibratedAt"];
  const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
  if (clean.threshold != null) clean.threshold = Math.min(0.99, Math.max(0.2, Number(clean.threshold)));
  if (clean.minFrames != null) clean.minFrames = Math.min(5, Math.max(1, Math.round(clean.minFrames)));
  if (clean.vadThreshold != null) clean.vadThreshold = Math.min(0.2, Math.max(0.004, Number(clean.vadThreshold) || 0.03));
  if (clean.endpointMs != null) clean.endpointMs = Math.min(3000, Math.max(500, Math.round(Number(clean.endpointMs) || 1200)));
  for (const k of ["noiseSuppression", "echoCancellation", "autoGainControl"]) if (k in clean) clean[k] = !!clean[k];
  if (clean.bookmarks) clean.bookmarks = Object.fromEntries(Object.entries(clean.bookmarks).slice(0, 50).map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 500)]));
  return saveSettings(clean);
});
ipcMain.handle("jarvis:setMuted", (_e, m) => { setMuted(m); return status; });
ipcMain.handle("jarvis:runAction", (_e, action, args) => runAction(action, args));
ipcMain.on("jarvis:sessionActive", (_e, active) => { sessionActive = !!active; sendAudioConfig(); pushStatus(); });
// Follow-up listening in a conversation: record one utterance from the always-on stream (no wake word needed).
ipcMain.handle("jarvis:listen", (_e, opts = {}) => {
  if (status.muted) return null;
  if (!audioWin) return null;
  if (listenReq) { listenReq.resolve(null); clearTimeout(listenReq.timer); }
  const id = `l${Date.now().toString(36)}`;
  const noSpeechMs = Math.max(1500, Math.min(900_000, Number(opts.noSpeechMs) || 8000)), maxMs = Math.max(3000, Math.min(60_000, Number(opts.maxMs) || 20_000));
  return new Promise((resolve) => {
    listenReq = { id, resolve, timer: setTimeout(() => { if (listenReq?.id === id) { listenReq = null; resolve(null); sendAudioConfig(); } }, noSpeechMs + maxMs + 5000) };
    sendAudioConfig();
    capturing = true;
    audioWin.webContents.send("audio:capture", { id, preRoll: false, noSpeechMs, maxMs });
  });
});
ipcMain.on("jarvis:cancelListen", () => { audioWin?.webContents.send("audio:cancel"); });
ipcMain.handle("jarvis:alarmStatus", () => agent?.status || null);
ipcMain.on("jarvis:notify", (_e, title, body) => notify(String(title).slice(0, 120), String(body || "").slice(0, 300)));
ipcMain.on("jarvis:voiceState", (_e, s) => { voiceState = String(s); sendAudioConfig(); });
ipcMain.on("jarvis:quit", quitFully);
ipcMain.on("jarvis:signedIn", () => { pushStatus(); agent?.reconnect(); });

// From the hidden audio window
ipcMain.handle("audio:getConfig", () => audioConfig());
ipcMain.on("audio:status", (_e, s) => {
  Object.assign(status, { wakeWord: status.muted ? "muted" : s.wakeWord, mic: s.mic, micDevice: s.micDevice, lastScore: s.lastScore ?? status.lastScore, error: s.error || null, threshold: settings.threshold });
  if (s.mic === "denied") status.error = "Microphone access is blocked. Allow it in Windows Settings → Privacy & security → Microphone.";
  pushStatus();
});
ipcMain.on("audio:score", (_e, score) => { status.lastScore = score; });
ipcMain.on("audio:wake", (_e, score) => onWake("hey_jarvis_model", score));
ipcMain.on("audio:pcm", (_e, pcm) => { if (kws && !capturing && !status.muted && settings.wakeEnabled && (!sessionActive || bargeInAllowed()) && !suspended) kws.postMessage({ type: "pcm", pcm }); });
ipcMain.on("audio:progress", (_e, wav) => win?.webContents.send("jarvis:captureProgress", wav));
ipcMain.on("audio:level", (_e, l) => win?.webContents.send("jarvis:level", Number(l) || 0));
let lastWakeAt = 0, capturing = false;
// The command recorded by the audio service after a wake word: pause wake detection while JARVIS thinks and speaks.
ipcMain.on("audio:captured", (_e, wav, id) => {
  capturing = false;
  if (listenReq && id === listenReq.id) {           // a follow-up the conversation asked for
    const r = listenReq; listenReq = null; clearTimeout(r.timer);
    r.resolve(wav || null); sendAudioConfig();
    log("follow-up captured", wav ? `${wav.length} bytes` : "(silence)");
    return;
  }
  if (wav) { sessionActive = true; sendAudioConfig(); }
  win?.webContents.send("jarvis:wakeAudio", wav || null);
  log("command captured", wav ? `${wav.length} bytes` : "(no speech)");
});
function onWake(source, score, { interruptWord = null } = {}) {
  if (status.muted || !settings.wakeEnabled || suspended || capturing) return;
  if (sessionActive && !bargeInAllowed()) return;    // in a conversation: only "JARVIS" to interrupt while it talks
  if (Date.now() - lastWakeAt < 2500) return;          // both detectors may fire for one phrase
  lastWakeAt = Date.now();
  status.lastWake = new Date().toISOString();
  status.lastWakeSource = source;
  log("wake word detected", source, Number(score).toFixed(3));
  capturing = true;
  if (source !== "hey_jarvis_model") audioWin?.webContents.send("audio:capture", { id: "wake", preRoll: true });   // the openWakeWord detector starts its own capture
  setTimeout(() => { if (capturing) { capturing = false; win?.webContents.send("jarvis:wakeAudio", null); } }, 20_000);
  showMain();
  win?.webContents.send("jarvis:wake", { score, source, capture: true, interruptWord });

  kws?.postMessage({ type: "reset" });
  pushStatus();
}

// Laptop-hosted server: keys, setup code, Tailscale
ipcMain.handle("keys:get", () => ({ ...secretsStore.view(), port: server?.port || 47823 }));
ipcMain.handle("keys:save", async (_e, patch) => {
  secretsStore.update(patch);
  log("keys updated", Object.keys(patch || {}).filter((k) => patch[k]).join(","));
  if (server && win) { await server.restart(serverEnv()); win.webContents.reload(); agent?.reconnect(); }
  return secretsStore.view();
});
ipcMain.handle("keys:open", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on("keys:close", () => keysWin?.close());
ipcMain.on("jarvis:openKeys", () => createKeys());
ipcMain.handle("jarvis:setupCode", () => (isLocal() ? secretsStore.get("JARVIS_SETUP_TOKEN") : null));
ipcMain.handle("jarvis:local", () => ({ local: isLocal(), url: currentUrl, port: server?.port, redirectBase: server ? `http://localhost:${server.port}` : null, phoneAccess: settings.phoneAccess, phoneUrl: settings.phoneUrl, server: status.server, encrypted: secretsStore?.encrypted() }));
ipcMain.handle("tailscale:status", () => (server ? tailscale.status(server.port) : { installed: false }));
ipcMain.handle("tailscale:enable", async () => {
  if (!server) return { ok: false, error: "Only available when JARVIS runs on this laptop." };
  const r = await tailscale.enable(server.port);
  if (r.ok) { saveSettings({ phoneAccess: true, phoneUrl: r.url }); await server.restart(serverEnv()); win?.webContents.reload(); log("iPhone access on", r.url); }
  return r;
});
ipcMain.handle("tailscale:disable", async () => {
  const r = await tailscale.disable();
  saveSettings({ phoneAccess: false });
  if (server) { await server.restart(serverEnv()); win?.webContents.reload(); }
  return r;
});
ipcMain.handle("tailscale:openLink", (_e, url) => { if (/^https:\/\/(login\.)?tailscale\.com\//.test(url)) shell.openExternal(url); });

// Setup window
ipcMain.handle("setup:test", async (_e, url) => {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) return { ok: false, error: "Use the https:// address of your JARVIS server." };
    const r = await fetch(new URL("/api/health/ping", u), { signal: AbortSignal.timeout(8000) });
    return r.ok ? { ok: true } : { ok: false, error: `Server answered ${r.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("setup:save", (_e, url) => {
  saveSettings({ serverUrl: new URL(url).origin, mode: "remote" });
  currentUrl = settings.serverUrl;
  setupWin?.removeAllListeners("closed"); setupWin?.close(); setupWin = null;
  if (win) { win.destroy(); win = null; }
  createMain(); showMain();
  return true;
});

// ---------------------------------------------------------------- Background agent + full-screen alarm window
let agent = null, alarmWin = null, ringingAlarm = null, alarmBlocker = null;
async function sessionCookie() {
  const base = serverOrigin(); if (!base) return null;
  const c = await session.defaultSession.cookies.get({ url: base, name: "jarvis_session" });
  return c[0]?.value || null;
}
function startAgent() {
  if (agent) return;
  agent = createAgent({
    getBase: serverOrigin, getCookie: sessionCookie, userAgent: `JARVIS-Desktop/${VERSION} (Windows agent)`,
    runAction: (action, args) => (settings.computerEnabled ? runAction(action, args) : Promise.reject(new Error("Computer control is switched off in the desktop app."))),
    onRing: showAlarm, onStopRing: closeAlarm,
    onStatus: (s) => { status.alarms = s; pushStatus(); win?.webContents.send("jarvis:alarm", { ringing: !!s.ringing }); },
    onSettings: (st) => { serverVoice = st.voice || {}; sendAudioConfig(); },
    log, dataDir: app.getPath("userData"), exePath: process.execPath,
  });
  agent.start();
}
function showAlarm(a) {
  ringingAlarm = { ...a, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  if (!alarmBlocker) alarmBlocker = powerSaveBlocker.start("prevent-display-sleep");
  if (alarmWin) { alarmWin.webContents.reload(); alarmWin.show(); alarmWin.focus(); return; }
  const d = screen.getPrimaryDisplay();
  alarmWin = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, fullscreen: true, frame: false, alwaysOnTop: true, skipTaskbar: false,
    backgroundColor: "#01040a", title: "JARVIS — Alarm", icon: iconPath(), show: true, focusable: true,
    webPreferences: { preload: path.join(here, "alarm", "preload-alarm.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" },
  });
  alarmWin.setAlwaysOnTop(true, "screen-saver");
  alarmWin.setVisibleOnAllWorkspaces(true);
  alarmWin.loadFile(path.join(here, "alarm", "alarm.html"));
  alarmWin.once("ready-to-show", () => { alarmWin?.show(); alarmWin?.focus(); });
  alarmWin.on("closed", () => { alarmWin = null; });
  alarmWin.webContents.on("render-process-gone", () => { log("alarm window crashed — reopening"); alarmWin?.destroy(); alarmWin = null; if (ringingAlarm) showAlarm(ringingAlarm); });
  notify(`⏰ ${a.label || "Alarm"}`, a.message || "Your alarm is ringing.");
}
function closeAlarm() {
  ringingAlarm = null;
  if (alarmBlocker != null) { try { powerSaveBlocker.stop(alarmBlocker); } catch {} alarmBlocker = null; }
  if (alarmWin) { alarmWin.webContents.send("alarm:close"); const w = alarmWin; setTimeout(() => w.destroy(), 150); alarmWin = null; }
}
ipcMain.handle("alarm:get", () => {
  if (!ringingAlarm) return null;
  // Hand the sound to the alarm window as bytes: built-in sounds ship with the app, custom ones were cached by the agent.
  let audio = null;
  try { audio = fs.readFileSync(ringingAlarm.file || path.join(here, "alarm", "sounds", `${/^[a-z]+$/.test(ringingAlarm.builtin || "") ? ringingAlarm.builtin : "chime"}.wav`)); }
  catch { try { audio = fs.readFileSync(path.join(here, "alarm", "sounds", "chime.wav")); } catch {} }
  return { ...ringingAlarm, audio };
});
ipcMain.on("alarm:snooze", (_e, minutes) => agent?.snooze(minutes));
ipcMain.on("alarm:dismiss", () => agent?.dismiss());
ipcMain.on("alarm:audio", (_e, ok, detail) => { agent?.audioResult(ok, detail); log("alarm audio", ok ? "verified" : "FAILED", detail); });

// ---------------------------------------------------------------- Permissions (never bypass the OS)
function configurePermissions() {
  const isTrusted = (wc, url) => wc === audioWin?.webContents || (url && serverOrigin() && url.startsWith(serverOrigin()));
  // Notifications from the alarm window are allowed; it never gets the microphone.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission === "media") return cb(isTrusted(wc, details.requestingUrl) && (details.mediaTypes || ["audio"]).every((t) => t === "audio"));
    if (["notifications", "clipboard-sanitized-write"].includes(permission)) return cb(isTrusted(wc, details.requestingUrl));
    cb(false);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => (["media", "notifications"].includes(permission) ? isTrusted(wc, origin) : false));
  if (process.platform === "win32" || process.platform === "darwin") {
    const st = systemPreferences.getMediaAccessStatus("microphone");
    if (st === "denied" || st === "restricted") { status.mic = "denied"; status.error = "Microphone access is blocked. Allow it in Windows Settings → Privacy & security → Microphone."; }
  }
}

// ---------------------------------------------------------------- Lifecycle
let suspended = false;
let booting = false;
async function bootLocal() {
  if (booting || win) return; booting = true;
  const ok = await startLocalServer();
  if (!ok) log("local server failed to start; see server.log");
  createMain();
  startAgent();
  booting = false;
}
app.whenReady().then(() => {
  configurePermissions();
  tray = new Tray(nativeImage.createFromPath(iconPath("tray.png")));
  tray.on("click", showMain);
  updateTray();
  registerShortcuts();
  app.setLoginItemSettings({ openAtLogin: !!settings.autoStart, args: ["--hidden"] });
  createAudio();
  startKws();
  if (isLocal()) {
    secretsStore = createSecrets(path.join(app.getPath("userData"), "secrets.json"), safeStorage);
    if (!secretsStore.get("ANTHROPIC_API_KEY") && !process.env.ANTHROPIC_API_KEY) createKeys({ firstRun: true });
    else bootLocal();
  } else if (!settings.serverUrl) createSetup(); else { createMain(); startAgent(); }
  if (process.argv.includes("--alarm-check")) log("started by the alarm wake task");

  powerMonitor.on("suspend", () => { suspended = true; status.wakeWord = "asleep"; sendAudioConfig(); pushStatus(); log("suspend"); });
  powerMonitor.on("resume", () => {
    suspended = false; log("resume");
    sendAudioConfig();
    setTimeout(() => { if (status.wakeWord !== "listening" && settings.wakeEnabled && !status.muted) restartAudio(); }, 4000);
    win?.webContents.send("jarvis:resumed");
    agent?.check(); agent?.reconnect();                // ring anything that came due while asleep (up to 15 minutes late)
  });
});
app.on("window-all-closed", (e) => { if (!quitting) e.preventDefault?.(); });
app.on("before-quit", () => { quitting = true; });
process.on("uncaughtException", (e) => { log("uncaught", e.stack || e.message); });
process.on("unhandledRejection", (e) => { log("unhandled", e?.stack || e); });
void dialog;
