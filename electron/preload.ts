import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

interface SyncStatus {
  state: "idle" | "syncing" | "error" | "offline";
  lastSyncAt: string | null;
  error: string | null;
  progress: string | null;
}

interface ConnectionModeFallback {
  intended: string;
  actual: string;
}

interface NfcStatus {
  readerConnected: boolean;
  readerName: string | null;
  tagPresent: boolean;
  tagUid: string | null;
}

contextBridge.exposeInMainWorld("electronAPI", {
  // Config
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config: { mongodbUri?: string; connectionMode?: string; atlasUri?: string; geminiApiKey?: string; aiApiKey?: string; aiProvider?: string; currency?: string; locale?: string }) =>
    ipcRenderer.invoke("save-config", config),
  resetConfig: () => ipcRenderer.invoke("reset-config"),
  testConnection: (uri: string) => ipcRenderer.invoke("test-connection", uri),
  showMessage: (options: { type: string; title: string; message: string }) =>
    ipcRenderer.invoke("show-message", options),

  // Sync
  getSyncStatus: () => ipcRenderer.invoke("get-sync-status"),
  triggerSync: () => ipcRenderer.invoke("trigger-sync"),
  checkAtlasConnectivity: () => ipcRenderer.invoke("check-atlas-connectivity"),
  onSyncStatusChange: (callback: (status: SyncStatus) => void) => {
    const handler = (_event: IpcRendererEvent, status: SyncStatus) => callback(status);
    ipcRenderer.on("sync-status-changed", handler);
    return () => {
      ipcRenderer.removeListener("sync-status-changed", handler);
    };
  },
  onConnectionModeFallback: (callback: (info: ConnectionModeFallback) => void) => {
    const handler = (_event: IpcRendererEvent, info: ConnectionModeFallback) => callback(info);
    ipcRenderer.on("connection-mode-fallback", handler);
    return () => {
      ipcRenderer.removeListener("connection-mode-fallback", handler);
    };
  },

  // NFC
  nfcGetStatus: () => ipcRenderer.invoke("nfc-get-status"),
  nfcReadTag: () => ipcRenderer.invoke("nfc-read-tag"),
  nfcWriteTag: (payload: number[], productUrl?: string) => ipcRenderer.invoke("nfc-write-tag", payload, productUrl),
  nfcFormatTag: () => ipcRenderer.invoke("nfc-format-tag"),
  onNfcStatusChange: (callback: (status: NfcStatus) => void) => {
    const handler = (_event: IpcRendererEvent, status: NfcStatus) => callback(status);
    ipcRenderer.on("nfc-status-changed", handler);
    return () => {
      ipcRenderer.removeListener("nfc-status-changed", handler);
    };
  },
  onNfcTagRead: (callback: (data: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on("nfc-tag-detected", handler);
    return () => {
      ipcRenderer.removeListener("nfc-tag-detected", handler);
    };
  },
});
