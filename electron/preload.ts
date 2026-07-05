import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

interface SyncStatus {
  // GH #369: "partial" means at least one collection failed while at
  // least one succeeded in the same cycle. Distinct from "error".
  state: "idle" | "syncing" | "error" | "offline" | "partial";
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

interface UpdateInstallStrings {
  title: string;
  message: string;
  detail: string;
  installButton: string;
  laterButton: string;
}

contextBridge.exposeInMainWorld("electronAPI", {
  // Config
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config: { mongodbUri?: string; connectionMode?: string; atlasUri?: string; geminiApiKey?: string; aiApiKey?: string; aiProvider?: string; currency?: string; customCurrencies?: string; locale?: string; labelFormat?: string; dateFormat?: string; numberFormat?: string; ntagDefaultSize?: string; exposeToLan?: boolean }) =>
    ipcRenderer.invoke("save-config", config),
  resetConfig: () => ipcRenderer.invoke("reset-config"),
  testConnection: (uri: string) => ipcRenderer.invoke("test-connection", uri),
  getLanInfo: () => ipcRenderer.invoke("get-lan-ip"),
  // GH #523: showMessage bridge removed — see corresponding comment in
  // electron/main.ts. Re-add only with assertTrustedSender + payload
  // allowlist if a future feature needs it.

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
  onSyncComplete: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("sync-complete", handler);
    return () => {
      ipcRenderer.removeListener("sync-complete", handler);
    };
  },

  // NFC
  nfcGetStatus: () => ipcRenderer.invoke("nfc-get-status"),
  nfcReadTag: () => ipcRenderer.invoke("nfc-read-tag"),
  // OpenTag3D write: probe the loaded chip + format.
  nfcDetectTag: () => ipcRenderer.invoke("nfc-detect-tag"),
  // OpenTag3D write: `standard` selects the wrapping/transport (defaults to
  // openprinttag for back-compat); productUrl rides on the SLIX2/OPT path only.
  nfcWriteTag: (
    payload: number[],
    standard?: "openprinttag" | "opentag3d",
    productUrl?: string,
    ntagSize?: "NTAG213" | "NTAG215" | "NTAG216",
  ) => ipcRenderer.invoke("nfc-write-tag", payload, standard, productUrl, ntagSize),
  nfcFormatTag: () => ipcRenderer.invoke("nfc-format-tag"),
  nfcSetReadOnly: (readOnly: boolean) => ipcRenderer.invoke("nfc-set-readonly", readOnly),
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

  // Auto-update (Electron only). State lifecycle:
  //   idle → checking → (available | not-available) → downloading → ready
  //                                                                ↳ error
  updateGetStatus: () => ipcRenderer.invoke("update-get-status"),
  updateCheck: () => ipcRenderer.invoke("update-check"),
  updateDownload: () => ipcRenderer.invoke("update-download"),
  updateInstall: (strings?: UpdateInstallStrings) =>
    ipcRenderer.invoke("update-install", strings),
  updateOpenReleasePage: () => ipcRenderer.invoke("update-open-release-page"),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("update-status", handler);
    return () => {
      ipcRenderer.removeListener("update-status", handler);
    };
  },

  // Brother PT-P710BT label printer (transport only; bitmap rendering
  // and encoding stay in the renderer via src/lib/labelBitmap.ts +
  // src/lib/labelEncoder.ts). The Uint8Array byte stream the renderer
  // builds gets serialized through IPC as a plain number[].
  labelPrinterListDevices: (probeUsb?: boolean) =>
    ipcRenderer.invoke("label-printer-list-devices", probeUsb === true),
  labelPrinterGetDevicePath: () => ipcRenderer.invoke("label-printer-get-device-path"),
  labelPrinterSetDevicePath: (devicePath: string | null) =>
    ipcRenderer.invoke("label-printer-set-device-path", devicePath),
  labelPrinterPrint: (bytes: number[]) =>
    ipcRenderer.invoke("label-printer-print", bytes),
  labelPrinterGetPublicUrl: () => ipcRenderer.invoke("label-printer-get-public-url"),
  labelPrinterSetPublicUrl: (url: string | null) =>
    ipcRenderer.invoke("label-printer-set-public-url", url),
  labelPrinterDisableBidi: (printerName: string) =>
    ipcRenderer.invoke("label-printer-disable-bidi", printerName),

  // Runtime mode (packaged vs dev). Used by the DevModeBanner to warn
  // when the renderer's data source (next dev's .env.local) doesn't
  // match the connection-mode wizard the user clicked through (#489).
  getRuntimeMode: () => ipcRenderer.invoke("get-runtime-mode"),
});
