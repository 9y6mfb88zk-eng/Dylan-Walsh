const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("setup", {
  test: (url) => ipcRenderer.invoke("setup:test", url),
  save: (url) => ipcRenderer.invoke("setup:save", url),
});
