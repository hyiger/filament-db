import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config: { mongodbUri: string }) =>
    ipcRenderer.invoke("save-config", config),
  resetConfig: () => ipcRenderer.invoke("reset-config"),
  showMessage: (options: { type: string; title: string; message: string }) =>
    ipcRenderer.invoke("show-message", options),
});
