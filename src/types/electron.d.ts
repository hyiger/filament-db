interface ElectronAPI {
  // Config
  getConfig: () => Promise<{ mongodbUri: string; connectionMode: string; atlasUri: string; geminiApiKey?: string; aiApiKey?: string; aiProvider?: string; currency?: string; locale?: string }>;
  saveConfig: (config: { mongodbUri?: string; connectionMode?: string; atlasUri?: string; geminiApiKey?: string; aiApiKey?: string; aiProvider?: string; currency?: string; locale?: string }) => Promise<{ success: boolean }>;
  resetConfig: () => Promise<{ success: boolean }>;
  testConnection: (uri: string) => Promise<{ success: boolean; error?: string }>;
  showMessage: (options: { type: string; title: string; message: string }) => Promise<void>;

  // Sync
  getSyncStatus: () => Promise<{
    state: "idle" | "syncing" | "error" | "offline";
    lastSyncAt: string | null;
    error: string | null;
    progress: string | null;
  }>;
  triggerSync: () => Promise<{ results?: unknown[]; error?: string }>;
  checkAtlasConnectivity: () => Promise<{ connected: boolean }>;
  onSyncStatusChange: (cb: (status: {
    state: "idle" | "syncing" | "error" | "offline";
    lastSyncAt: string | null;
    error: string | null;
    progress: string | null;
  }) => void) => () => void;
  onConnectionModeFallback: (cb: (info: { intended: string; actual: string }) => void) => () => void;

  // NFC
  nfcGetStatus: () => Promise<{
    readerConnected: boolean;
    readerName: string | null;
    tagPresent: boolean;
    tagUid: string | null;
  }>;
  nfcReadTag: () => Promise<unknown>;
  nfcWriteTag: (payload: number[], productUrl?: string) => Promise<{ success: boolean }>;
  nfcFormatTag: () => Promise<{ success: boolean }>;
  onNfcStatusChange: (callback: (status: {
    readerConnected: boolean;
    readerName: string | null;
    tagPresent: boolean;
    tagUid: string | null;
  }) => void) => () => void;
  onNfcTagRead: (callback: (data: unknown) => void) => () => void;

  // Auto-update
  updateGetStatus: () => Promise<UpdateStatus>;
  updateCheck: () => Promise<{ ok: boolean; error?: string }>;
  updateDownload: () => Promise<{ ok: boolean; error?: string }>;
  /**
   * Triggers the confirm dialog + install. Optional `strings` lets the
   * renderer pass translated strings for the OS-native dialog (renderer
   * holds the i18n catalog; main process doesn't). Omit for English.
   */
  updateInstall: (strings?: UpdateInstallStrings) => Promise<{ ok: boolean; error?: string }>;
  updateOpenReleasePage: () => Promise<{ ok: boolean }>;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
}

export interface UpdateStatus {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "not-available";
  version?: string;
  releaseNotes?: string;
  progress?: { percent: number; bytesPerSecond: number };
  error?: string;
}

export interface UpdateInstallStrings {
  title: string;
  /** Use `{version}` as a placeholder for the update version. */
  message: string;
  detail: string;
  installButton: string;
  laterButton: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
