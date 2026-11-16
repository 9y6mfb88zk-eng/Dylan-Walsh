// Bridge between the JARVIS web app (served by your backend) and the Windows app.
// Exposed only when the page comes from the configured JARVIS server.
const { contextBridge, ipcRenderer } = require("electron");

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=").slice(1).join("=");
const origin = arg("jarvis-origin");
const version = arg("jarvis-version");

if (origin && location.origin === origin) {
  const on = (channel) => (fn) => { const h = (_e, d) => fn(d); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h); };
  contextBridge.exposeInMainWorld("jarvisDesktop", {
    version, platform: process.platform,
    onWake: on("jarvis:wake"),
    onPushToTalk: on("jarvis:ptt"),
    onStatus: on("jarvis:status"),
    onResumed: on("jarvis:resumed"),
    getStatus: () => ipcRenderer.invoke("jarvis:getStatus"),
    getSettings: () => ipcRenderer.invoke("jarvis:getSettings"),
    setSettings: (patch) => ipcRenderer.invoke("jarvis:setSettings", patch),
    setMuted: (m) => ipcRenderer.invoke("jarvis:setMuted", !!m),
    setSessionActive: (a) => ipcRenderer.send("jarvis:sessionActive", !!a),
    voiceState: (s) => ipcRenderer.send("jarvis:voiceState", String(s)),
    notify: (title, body) => ipcRenderer.send("jarvis:notify", String(title), String(body || "")),
    runAction: (action, args) => ipcRenderer.invoke("jarvis:runAction", String(action), args || {}),
    signedIn: () => ipcRenderer.send("jarvis:signedIn"),
    quit: () => ipcRenderer.send("jarvis:quit"),
  });
}
