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
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
