const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("audioBridge", {
  getConfig: () => ipcRenderer.invoke("audio:getConfig"),
  onConfig: (fn) => ipcRenderer.on("audio:config", (_e, c) => fn(c)),
  status: (s) => ipcRenderer.send("audio:status", s),
  score: (v) => ipcRenderer.send("audio:score", v),
  wake: (v) => ipcRenderer.send("audio:wake", v),
  pcm: (int16) => ipcRenderer.send("audio:pcm", int16),
  onCapture: (fn) => ipcRenderer.on("audio:capture", () => fn()),
  captured: (wavBytes) => ipcRenderer.send("audio:captured", wavBytes),
});
