// Bridge for the full-screen alarm window.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("alarmBridge", {
  get: () => ipcRenderer.invoke("alarm:get"),
  snooze: (minutes) => ipcRenderer.send("alarm:snooze", minutes),
  dismiss: () => ipcRenderer.send("alarm:dismiss"),
  audio: (ok, detail) => ipcRenderer.send("alarm:audio", !!ok, String(detail || "")),
  onClose: (fn) => ipcRenderer.on("alarm:close", () => fn()),
});
