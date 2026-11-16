// JARVIS for Windows — main process.
// Tray app with close-to-tray, start with Windows, an always-on local wake-word service (hidden audio window),
// push-to-talk and mute shortcuts, crash/sleep recovery, and allowlisted computer actions.
import { app, BrowserWindow, safeStorage, utilityProcess, Tray, Menu, ipcMain, globalShortcut, shell, nativeImage, Notification, powerMonitor, session, systemPreferences, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createActions } from "./actions.js";
import { ServerManager, locateServer } from "./server-manager.js";
import { createSecrets } from "./secrets.js";
import * as tailscale from "./tailscale.js";

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
  wakeEnabled: true, wakeJarvisAlone: true, threshold: 0.5, minFrames: 2, vadThreshold: 0.035, micDeviceId: null,
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
  return path.join(root, "models", name);
}
function sherpaPath() {
  const loc = locateServer({ appRoot: root, resourcesPath: process.resourcesPath, packaged: app.isPackaged });
  return path.join(loc.dir, "node_modules", "sherpa-onnx-node");
}

// ---------------------------------------------------------------- "JARVIS" keyword spotter (utility process)
let kws = null, kwsRestarts = 0;
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
    if (m.type === "wake") onWake(`keyword:${m.keyword}`, 1);
  });
  kws.on("exit", (code) => {
    kws = null; log("keyword spotter exited", code);
    if (!quitting && status.kws !== "error" && kwsRestarts++ < 5) setTimeout(startKws, 2000);
  });
}

// ---------------------------------------------------------------- Local server (JARVIS on this laptop)
let server = null, secretsStore = null;   // secretsStore is created once Electron is ready (needs safeStorage)
function serverEnv() {
  return { ...secretsStore.env(), ...(settings.phoneAccess && settings.phoneUrl ? { PUBLIC_URL: settings.phoneUrl } : {}), JARVIS_TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, JARVIS_ASR_DIR: modelDir("asr") };
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
let sessionActive = false;
const startHidden = process.argv.includes("--hidden");
const log = (...a) => { try { fs.appendFileSync(path.join(app.getPath("userData"), "jarvis.log"), `${new Date().toISOString()} ${a.join(" ")}\n`); } catch {} if (process.env.JARVIS_DEBUG) console.log(...a); };

// ---------------------------------------------------------------- Single instance
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on("second-instance", () => showMain());

// ---------------------------------------------------------------- Windows
function iconPath(name = "icon.png") { return path.join(root, "build", name); }

function createMain() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 600, show: false, backgroundColor: "#06030c", title: "JARVIS",
    icon: iconPath(), autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, additionalArguments: [`--jarvis-origin=${serverOrigin()}`, `--jarvis-version=${VERSION}`, `--jarvis-mode=${isLocal() ? "local" : "remote"}`],
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
function audioConfig() {
  return { enabled: settings.wakeEnabled && !status.muted, paused: sessionActive || suspended, threshold: settings.threshold, minFrames: settings.minFrames, micDeviceId: settings.micDeviceId, vadThreshold: settings.vadThreshold };
}
function sendAudioConfig() { audioWin?.webContents.send("audio:config", audioConfig()); }

function createSetup() {
  setupWin = new BrowserWindow({
    width: 520, height: 560, resizable: false, backgroundColor: "#06030c", title: "Connect JARVIS", icon: iconPath(), autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, "setup-preload.cjs"), contextIsolation: true, sandbox: true },
  });
  setupWin.loadFile(path.join(here, "setup.html"), { query: { url: settings.serverUrl } });
  setupWin.on("closed", () => { setupWin = null; if (!win && !quitting) app.quit(); });
}

let keysWin = null;
function createKeys({ firstRun = false } = {}) {
  if (keysWin) return keysWin.show();
  keysWin = new BrowserWindow({
    width: 560, height: 760, backgroundColor: "#06030c", title: "JARVIS — keys", icon: iconPath(), autoHideMenuBar: true,
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
  return { listening: "Listening for “Hey JARVIS”", starting: "Starting…", loading: "Loading wake-word model…", paused: "In conversation", asleep: "Paused (sleep)", error: `Problem: ${status.error || "microphone"}` }[status.wakeWord] || status.wakeWord;
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
  if (["wakeEnabled", "threshold", "minFrames", "micDeviceId", "vadThreshold"].some((k) => k in patch)) {
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
  log: (e) => { try { fs.appendFileSync(actionLog, JSON.stringify(e) + "\n"); } catch {} },
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
  const allowed = ["wakeEnabled", "wakeJarvisAlone", "threshold", "minFrames", "vadThreshold", "micDeviceId", "autoStart", "closeToTray", "computerEnabled", "bookmarks"];
  const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
  if (clean.threshold != null) clean.threshold = Math.min(0.99, Math.max(0.2, Number(clean.threshold)));
  if (clean.minFrames != null) clean.minFrames = Math.min(5, Math.max(1, Math.round(clean.minFrames)));
  if (clean.bookmarks) clean.bookmarks = Object.fromEntries(Object.entries(clean.bookmarks).slice(0, 50).map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 500)]));
  return saveSettings(clean);
});
ipcMain.handle("jarvis:setMuted", (_e, m) => { setMuted(m); return status; });
ipcMain.handle("jarvis:runAction", (_e, action, args) => runAction(action, args));
ipcMain.on("jarvis:sessionActive", (_e, active) => { sessionActive = !!active; sendAudioConfig(); });
ipcMain.on("jarvis:notify", (_e, title, body) => notify(String(title).slice(0, 120), String(body || "").slice(0, 300)));
ipcMain.on("jarvis:voiceState", (_e, s) => { if (s === "idle" && sessionActive) { sessionActive = false; sendAudioConfig(); } });
ipcMain.on("jarvis:quit", quitFully);
ipcMain.on("jarvis:signedIn", () => pushStatus());

// From the hidden audio window
ipcMain.handle("audio:getConfig", () => audioConfig());
ipcMain.on("audio:status", (_e, s) => {
  Object.assign(status, { wakeWord: status.muted ? "muted" : s.wakeWord, mic: s.mic, micDevice: s.micDevice, lastScore: s.lastScore ?? status.lastScore, error: s.error || null, threshold: settings.threshold });
  if (s.mic === "denied") status.error = "Microphone access is blocked. Allow it in Windows Settings → Privacy & security → Microphone.";
  pushStatus();
});
ipcMain.on("audio:score", (_e, score) => { status.lastScore = score; });
ipcMain.on("audio:wake", (_e, score) => onWake("hey_jarvis_model", score));
ipcMain.on("audio:pcm", (_e, pcm) => { if (kws && !capturing && !status.muted && settings.wakeEnabled && !sessionActive && !suspended) kws.postMessage({ type: "pcm", pcm }); });
let lastWakeAt = 0, capturing = false;
// The command recorded by the audio service after a wake word: pause wake detection while JARVIS thinks and speaks.
ipcMain.on("audio:captured", (_e, wav) => {
  capturing = false;
  if (wav) { sessionActive = true; sendAudioConfig(); }
  win?.webContents.send("jarvis:wakeAudio", wav || null);
  log("command captured", wav ? `${wav.length} bytes` : "(no speech)");
});
function onWake(source, score) {
  if (status.muted || !settings.wakeEnabled || sessionActive || suspended || capturing) return;
  if (Date.now() - lastWakeAt < 2500) return;          // both detectors may fire for one phrase
  lastWakeAt = Date.now();
  status.lastWake = new Date().toISOString();
  status.lastWakeSource = source;
  log("wake word detected", source, Number(score).toFixed(3));
  capturing = true;
  audioWin?.webContents.send("audio:capture");      // the always-on stream records the command immediately
  setTimeout(() => { if (capturing) { capturing = false; win?.webContents.send("jarvis:wakeAudio", null); } }, 20_000);
  showMain();
  win?.webContents.send("jarvis:wake", { score, source, capture: true });
  setTimeout(() => { if (sessionActive) { sessionActive = false; sendAudioConfig(); } }, 60_000);   // safety: never stay paused
  kws?.postMessage({ type: "reset" });
  pushStatus();
}

// Laptop-hosted server: keys, setup code, Tailscale
ipcMain.handle("keys:get", () => secretsStore.view());
ipcMain.handle("keys:save", async (_e, patch) => {
  secretsStore.update(patch);
  log("keys updated", Object.keys(patch || {}).filter((k) => patch[k]).join(","));
  if (server && win) { await server.restart(serverEnv()); win.webContents.reload(); }
  return secretsStore.view();
});
ipcMain.handle("keys:open", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on("keys:close", () => keysWin?.close());
ipcMain.on("jarvis:openKeys", () => createKeys());
ipcMain.handle("jarvis:setupCode", () => (isLocal() ? secretsStore.get("JARVIS_SETUP_TOKEN") : null));
ipcMain.handle("jarvis:local", () => ({ local: isLocal(), url: currentUrl, port: server?.port, phoneAccess: settings.phoneAccess, phoneUrl: settings.phoneUrl, server: status.server, encrypted: secretsStore?.encrypted() }));
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

// ---------------------------------------------------------------- Permissions (never bypass the OS)
function configurePermissions() {
  const isTrusted = (wc, url) => wc === audioWin?.webContents || (url && serverOrigin() && url.startsWith(serverOrigin()));
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
  } else if (!settings.serverUrl) createSetup(); else createMain();

  powerMonitor.on("suspend", () => { suspended = true; status.wakeWord = "asleep"; sendAudioConfig(); pushStatus(); log("suspend"); });
  powerMonitor.on("resume", () => {
    suspended = false; log("resume");
    sendAudioConfig();
    setTimeout(() => { if (status.wakeWord !== "listening" && settings.wakeEnabled && !status.muted) restartAudio(); }, 4000);
    win?.webContents.send("jarvis:resumed");
  });
});
app.on("window-all-closed", (e) => { if (!quitting) e.preventDefault?.(); });
app.on("before-quit", () => { quitting = true; });
process.on("uncaughtException", (e) => { log("uncaught", e.stack || e.message); });
process.on("unhandledRejection", (e) => { log("unhandled", e?.stack || e); });
void dialog;
