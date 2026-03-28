import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // Config
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config: { mongodbUri?: string; connectionMode?: string; atlasUri?: string }) =>
    ipcRenderer.invoke("save-config", config),
  resetConfig: () => ipcRenderer.invoke("reset-config"),
  showMessage: (options: { type: string; title: string; message: string }) =>
    ipcRenderer.invoke("show-message", options),

  // Sync
  getSyncStatus: () => ipcRenderer.invoke("get-sync-status"),
  triggerSync: () => ipcRenderer.invoke("trigger-sync"),
  checkAtlasConnectivity: () => ipcRenderer.invoke("check-atlas-connectivity"),
  onSyncStatusChange: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on("sync-status-changed", handler);
    return () => {
      ipcRenderer.removeListener("sync-status-changed", handler);
    };
  },
  onConnectionModeFallback: (callback: (info: any) => void) => {
    const handler = (_event: any, info: any) => callback(info);
    ipcRenderer.on("connection-mode-fallback", handler);
    return () => {
      ipcRenderer.removeListener("connection-mode-fallback", handler);
    };
  },

  // NFC
  nfcGetStatus: () => ipcRenderer.invoke("nfc-get-status"),
  nfcReadTag: () => ipcRenderer.invoke("nfc-read-tag"),
  nfcWriteTag: (payload: number[]) => ipcRenderer.invoke("nfc-write-tag", payload),
  onNfcStatusChange: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on("nfc-status-changed", handler);
    return () => {
      ipcRenderer.removeListener("nfc-status-changed", handler);
    };
  },
  onNfcTagRead: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("nfc-tag-detected", handler);
    return () => {
      ipcRenderer.removeListener("nfc-tag-detected", handler);
    };
  },
});
