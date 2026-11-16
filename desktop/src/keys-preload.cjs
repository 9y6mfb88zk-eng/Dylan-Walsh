const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("keys", {
  get: () => ipcRenderer.invoke("keys:get"),
  save: (patch) => ipcRenderer.invoke("keys:save", patch),
  open: (url) => ipcRenderer.invoke("keys:open", url),
  close: () => ipcRenderer.send("keys:close"),
});
