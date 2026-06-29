interface ElectronAPI {
  // Config
  getConfig: () => Promise<{ mongodbUri: string; connectionMode: string; atlasUri: string; geminiApiKey?: string; aiApiKey?: string; aiProvider?: string; currency?: string; customCurrencies?: string; locale?: string; labelFormat?: string; exposeToLan?: boolean }>;
  saveConfig: (config: { mongodbUri?: string; connectionMode?: string; atlasUri?: string; geminiApiKey?: string; aiApiKey?: string; aiProvider?: string; currency?: string; customCurrencies?: string; locale?: string; labelFormat?: string; exposeToLan?: boolean }) => Promise<{ success: boolean }>;
  getLanInfo: () => Promise<{ ips: string[]; port: number }>;
  resetConfig: () => Promise<{ success: boolean }>;
  testConnection: (uri: string) => Promise<{ success: boolean; error?: string }>;

  // Sync
  getSyncStatus: () => Promise<{
    state: "idle" | "syncing" | "error" | "offline" | "partial";
    lastSyncAt: string | null;
    error: string | null;
    progress: string | null;
  }>;
  triggerSync: () => Promise<{ results?: unknown[]; error?: string }>;
  checkAtlasConnectivity: () => Promise<{ connected: boolean }>;
  // GH #369: "partial" added — at least one collection synced, at least
  // one failed. Must stay in lockstep with the getSyncStatus return type
  // above; runtime emits this state, so the callback must accept it.
  onSyncStatusChange: (cb: (status: {
    state: "idle" | "syncing" | "error" | "offline" | "partial";
    lastSyncAt: string | null;
    error: string | null;
    progress: string | null;
  }) => void) => () => void;
  onConnectionModeFallback: (cb: (info: { intended: string; actual: string }) => void) => () => void;
  /** Fires after a hybrid-mode sync cycle completes (success or no-op).
   *  Used by data-listing pages to refetch without waiting for navigation. */
  onSyncComplete: (cb: () => void) => () => void;

  // NFC
  nfcGetStatus: () => Promise<{
    readerConnected: boolean;
    readerName: string | null;
    tagPresent: boolean;
    tagUid: string | null;
    /** GH #450: classified error from the pcsclite/reader layer. `null`
     *  on a healthy reader; surfaced as a translated hint on the status
     *  pill when set. */
    lastError: {
      code: "permission" | "busy" | "no-daemon" | "generic";
      message: string;
    } | null;
  }>;
  nfcReadTag: () => Promise<unknown>;
  /** OpenTag3D write: probe the loaded tag — which standard to encode + lock state. */
  nfcDetectTag: () => Promise<{
    family: "ntag" | "slix2" | "bambu" | "unknown";
    standard: "opentag3d" | "openprinttag" | "bambu" | null;
    formatted: boolean;
    readOnly: boolean;
    ndefCapacity: number | null;
  }>;
  /** OpenTag3D write: `standard` selects the wrapping/transport (default
   *  "openprinttag"); `productUrl` rides the SLIX2/OpenPrintTag path only. */
  nfcWriteTag: (
    payload: number[],
    standard?: "openprinttag" | "opentag3d",
    productUrl?: string,
  ) => Promise<{ success: boolean }>;
  nfcFormatTag: () => Promise<{ success: boolean }>;
  nfcSetReadOnly: (readOnly: boolean) => Promise<{ success: boolean }>;
  onNfcStatusChange: (callback: (status: {
    readerConnected: boolean;
    readerName: string | null;
    tagPresent: boolean;
    tagUid: string | null;
    lastError: {
      code: "permission" | "busy" | "no-daemon" | "generic";
      message: string;
    } | null;
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

  // Brother PT-P710BT label printer (transport only — encoding lives
  // in src/lib/labelEncoder.ts so the renderer and the CLI spike
  // share one source of truth). The Uint8Array byte stream the
  // renderer builds rides through IPC as a plain number[].
  // GH #771: `probeUsb` defaults to false — a passive list of configured
  // queues that never prompts. Pass true (on an explicit Refresh) to also
  // scan for raw USB devices via `lpinfo`, which can pop the macOS admin
  // authorization dialog.
  labelPrinterListDevices: (probeUsb?: boolean) => Promise<LabelPrinterDevice[]>;
  labelPrinterGetDevicePath: () => Promise<string | null>;
  labelPrinterSetDevicePath: (devicePath: string | null) => Promise<{ ok: boolean }>;
  labelPrinterPrint: (bytes: number[]) => Promise<{ ok: boolean }>;
  /** Public base URL for URL-mode label QRs. Required for URL mode in
   *  packaged Electron because window.location.origin is localhost.
   *  null means "not configured"; the dialog then disables URL mode
   *  when in Electron (web users fall back to window.location.origin). */
  labelPrinterGetPublicUrl: () => Promise<string | null>;
  /** Throws on validation errors (bad URL shape, non-http(s) scheme,
   *  loopback host). Pass null/empty to clear. */
  labelPrinterSetPublicUrl: (url: string | null) => Promise<{ ok: boolean }>;
  /** Windows only: disable bidirectional support on the given printer queue via
   *  an elevated helper (UAC). Resolves a discriminated union — `{ ok: true }`
   *  on a confirmed disable, `{ ok: false, reason }` for the cancel + known
   *  failure cases (the renderer maps `reason` to a localized toast); rejects
   *  only on an unexpected internal error. */
  labelPrinterDisableBidi: (printerName: string) => Promise<
    | { ok: true }
    | {
        ok: false;
        reason:
          | "cancelled"
          | "not_found"
          | "ambiguous"
          | "still_enabled"
          | "elevation_unavailable"
          | "error";
        detail?: string;
      }
  >;

  /** Runtime-environment flags. Used by the DevModeBanner to warn the
   *  user when their connection-mode wizard selection has no effect on
   *  the renderer's actual data source (issue #489). */
  getRuntimeMode: () => Promise<{ isPackaged: boolean }>;
}

export interface LabelPrinterDevice {
  /** OS-assigned device path to pass to `labelPrinterSetDevicePath`. */
  path: string;
  /** Human-readable name for the picker dropdown. */
  friendlyName: string;
  /** True when the path/manufacturer/friendly name matches a PT-series
   *  printer — the picker pre-selects the obvious choice. */
  looksLikePrinter: boolean;
  /** Windows only: the queue has bidirectional support (EnableBIDI) on. Some
   *  drivers crash the Print Spooler with BiDi enabled, so the picker warns.
   *  `undefined` on macOS/Linux and when the state couldn't be read — only an
   *  explicit `true` triggers the warning. */
  bidiEnabled?: boolean;
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
