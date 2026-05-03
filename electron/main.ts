import { app, BrowserWindow, Menu, ipcMain, dialog, utilityProcess, UtilityProcess, shell, session } from "electron";
import path from "path";
import fs from "fs";
import Store from "electron-store";
import http from "http";
import { NfcService } from "./nfc-service";
import { startLocalMongo, stopLocalMongo } from "./local-mongo";
import { SyncService, SyncStatus, getDbNameFromUri } from "./sync-service";
import { initAutoUpdater } from "./auto-updater";

// ── Diagnostic log ──
// Writes lifecycle and crash events to a file in userData so users on
// machines where the window never appears (GH #176) can attach a log
// instead of guessing at console output they can't see. Best-effort only —
// never throws, never blocks startup. Entries are also mirrored to
// console.log for the dev workflow.
const LOG_PATH = path.join(app.getPath("userData"), "logs", "main.log");
let logStream: fs.WriteStream | null = null;
let loggerDisabled = false;
function disableLogger() {
  loggerDisabled = true;
  if (logStream) {
    logStream.removeAllListeners("error");
    logStream.end();
    logStream = null;
  }
}
function diag(message: string) {
  console.log(`[diag] ${message}`);
  if (loggerDisabled) return;
  try {
    if (!logStream) {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      const stream = fs.createWriteStream(LOG_PATH, { flags: "a" });
      // WriteStream errors (perm-denied on roaming profile, AV file lock,
      // disk-full mid-write) emit asynchronously on the stream; without a
      // listener Node treats them as uncaught and would kill the main
      // process — exactly the failure mode the logger is supposed to
      // help debug, not cause. Absorb and disable further writes.
      stream.on("error", disableLogger);
      logStream = stream;
    }
    logStream.write(`[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Sync errors (mkdirSync, createWriteStream throwing on bad path,
    // write() back-pressure rejection) — same policy: stop trying.
    disableLogger();
  }
}
diag(`startup: pid=${process.pid} platform=${process.platform} version=${app.getVersion()} packaged=${app.isPackaged}`);

export type ConnectionMode = "atlas" | "offline" | "hybrid";

const store = new Store({
  // NOTE: This key is embedded in the binary and provides no real security,
  // but it cannot be removed without breaking existing installations whose
  // config files were encrypted with it. A future migration to OS-level
  // credential storage (safeStorage) would replace this.
  encryptionKey: "filament-db-secure-key",
  defaults: {
    mongodbUri: "",
    connectionMode: "" as ConnectionMode, // empty = not yet configured
    atlasUri: "",
    geminiApiKey: "",
    aiApiKey: "",
    aiProvider: "gemini",
    locale: "en",
  },
});

const isDev = !app.isPackaged;
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
let serverProcess: UtilityProcess | null = null;
let nfcService: NfcService | null = null;
let syncService: SyncService | null = null;
const PORT = parseInt(process.env.PORT || "3456", 10);

// ── Single-instance lock ──
// Prevent multiple app windows / duplicate servers on the same port.
//
// On Windows in particular, an upgrade can leave a previous-version
// process running in the background — the new install then fails to get
// the lock and used to silently `app.quit()` with no window and no
// notification, exactly matching the GH #176 report. Surface the cause
// before quitting so the user knows why nothing appeared.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  diag("single-instance lock denied — another instance owns it; quitting");
  // showErrorBox is synchronous and works before app.whenReady, unlike
  // the regular dialog.show APIs. Keep the message short — the user
  // hasn't even seen a window yet.
  dialog.showErrorBox(
    "Filament DB is already running",
    "Another instance is already running. Look for it in your taskbar / system tray, " +
      "or end the existing process via Task Manager (Windows) / Activity Monitor (macOS) " +
      "and try again.",
  );
  app.quit();
} else {
  diag("single-instance lock acquired");

app.on("second-instance", () => {
  if (mainWindow) {
    // The first instance might be hidden (some upgrade paths leave the
    // window state stuck off-screen); calling .show() before .focus()
    // resurfaces it whether it was minimized, hidden, or just behind
    // another window — covers the GH #176 case where the app process
    // exists but no window is visible.
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function getAppURL(urlPath = "/") {
  return `http://localhost:${PORT}${urlPath}`;
}

/** Hard cap on how long we'll wait for `ready-to-show` before forcing the
 * window visible. The point of the safety net is GH #176: users on Windows
 * with KB5083631 / strict Defender / SAC report the process running with
 * no visible window. If the renderer hangs (load blocked, GPU process
 * crashed mid-paint, server slow to respond), we'd rather show a blank
 * window the user can interact with than leave a phantom background
 * process. Must be longer than the realistic startup time on a cold
 * Windows install with Defender scanning every file. */
const WINDOW_SHOW_TIMEOUT_MS = 20_000;

function createWindow(urlPath = "/") {
  diag(`createWindow: urlPath=${urlPath}`);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Filament DB",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    // Defer paint until the renderer reports ready-to-show (or the
    // safety-net timeout fires). Without this, a window flash of unstyled
    // content can occur on slow first loads, AND — more importantly for
    // GH #176 — there's no path to recover if the renderer never reaches
    // a visible state on its own.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    diag("ready-to-show — showing window");
    mainWindow?.show();
  });

  // Safety-net: if ready-to-show never fires (renderer hung, did-fail-load,
  // GPU crash mid-paint), force the window visible so the user can at
  // least see and report the failure instead of seeing nothing. GH #176.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      diag(`window-show timeout (${WINDOW_SHOW_TIMEOUT_MS}ms) — forcing show`);
      mainWindow.show();
    }
  }, WINDOW_SHOW_TIMEOUT_MS);

  // Surface renderer / load failures into the diagnostic log. Without
  // these, a renderer that crashes during navigation leaves a process in
  // Task Manager with no UI and no console anyone can read.
  mainWindow.webContents.on("did-fail-load", (_evt, errorCode, errorDescription, validatedURL) => {
    diag(`did-fail-load url=${validatedURL} code=${errorCode} desc=${errorDescription}`);
  });
  mainWindow.webContents.on("render-process-gone", (_evt, details) => {
    diag(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on("unresponsive", () => {
    diag("renderer unresponsive");
  });

  mainWindow.loadURL(getAppURL(urlPath));

  // Start the auto-updater bound to this window. No-ops in dev.
  initAutoUpdater(mainWindow);

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const appUrl = getAppURL();
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only forward http(s) targets to the OS shell. Anything else
    // (file:, javascript:, data:, custom protocol handlers) could be
    // used by injected/imported content to launch local apps or
    // exfiltrate data via a registered handler.
    try {
      const proto = new URL(url).protocol;
      if (proto === "http:" || proto === "https:") {
        shell.openExternal(url);
      } else {
        console.warn(`Refused to open external URL with disallowed scheme: ${proto}`);
      }
    } catch {
      console.warn(`Refused to open malformed external URL: ${url}`);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Application menu with zoom shortcuts (required for Windows/Linux)
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "forceReload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        ...(isMac ? [
          { type: "separator" as const },
          { role: "front" as const },
        ] : [
          { role: "close" as const },
        ]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function waitForServer(port: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      const req = http.get(`http://localhost:${port}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error("Server startup timed out"));
        } else {
          setTimeout(check, 500);
        }
      });
      req.end();
    }
    check();
  });
}

/**
 * Resolve a mongodb+srv:// URI to a standard mongodb:// URI.
 * The standalone Next.js server's bundled mongodb driver cannot do DNS SRV
 * resolution, so we resolve it here in the main process and pass the
 * standard URI to the child process.
 */
async function resolveSrvUri(uri: string): Promise<string> {
  if (!uri.startsWith("mongodb+srv://")) return uri;

  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });

  try {
    await client.connect();
    // Extract the resolved topology from the client's options
    const options = client.options;
    const hosts = options.hosts.map((h: { host: string; port: number }) =>
      `${h.host}:${h.port}`
    ).join(",");

    // Parse the original URI to preserve credentials and options
    const parsed = new URL(uri.replace("mongodb+srv://", "http://"));
    const auth = parsed.username
      ? `${parsed.username}:${parsed.password}@`
      : "";
    const db = parsed.pathname || "/";
    const params = parsed.search || "";

    // Build standard mongodb:// URI with tls=true (SRV implies TLS)
    const searchParams = new URLSearchParams(params.replace("?", ""));
    if (!searchParams.has("tls") && !searchParams.has("ssl")) {
      searchParams.set("tls", "true");
    }
    // authSource is typically "admin" for Atlas
    if (!searchParams.has("authSource")) {
      searchParams.set("authSource", "admin");
    }

    const resolvedUri = `mongodb://${auth}${hosts}${db}?${searchParams.toString()}`;
    return resolvedUri;
  } finally {
    await client.close().catch(() => {});
  }
}

async function startProductionServer(mongoUri?: string): Promise<void> {
  let uri = mongoUri || (store.get("mongodbUri") as string);

  // Log the URI scheme for debugging (never log full URI)
  if (uri) {
    const scheme = uri.startsWith("mongodb+srv://") ? "mongodb+srv" : "mongodb";
    console.log(`Starting production server with ${scheme}:// URI`);
  } else {
    console.log("Starting production server without MongoDB URI");
  }

  // Resolve mongodb+srv:// to standard mongodb:// for the standalone server
  if (uri) {
    try {
      uri = await resolveSrvUri(uri);
      console.log("SRV resolution completed, URI scheme:", uri.substring(0, 10));
    } catch (err) {
      console.error("Failed to resolve SRV URI, using original:", err);
    }
  }

  return new Promise((resolve, reject) => {
    const appPath = path.join(__dirname, "..");
    const serverPath = path.join(appPath, "standalone", "server.js");

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(PORT),
      HOSTNAME: "localhost",
      NODE_ENV: "production",
    };

    if (uri) {
      env.MONGODB_URI = uri;
    }

    serverProcess = utilityProcess.fork(serverPath, [], {
      env,
      stdio: "pipe",
      serviceName: "next-server",
    });

    serverProcess.stdout?.on("data", (data: Buffer) => {
      console.log("Server:", data.toString().trim());
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      console.error("Server error:", data.toString().trim());
    });

    serverProcess.on("spawn", () => {
      // Wait for the server to respond to HTTP requests
      waitForServer(PORT).then(resolve).catch(reject);
    });

    serverProcess.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}

/** Maximum wait time (ms) for IPC calls before they're considered timed out. */
const IPC_TIMEOUT_MS = 15_000;

/**
 * Wraps an async IPC handler with a timeout to prevent hanging calls
 * when the server becomes unresponsive.
 */
function withIpcTimeout<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`IPC timeout: ${label} took longer than ${IPC_TIMEOUT_MS}ms`)), IPC_TIMEOUT_MS)
    ),
  ]);
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

/**
 * Resolve which MongoDB URI to use based on connection mode.
 * For offline/hybrid, starts local MongoDB.
 * For hybrid, also initializes sync service.
 * Returns the URI to pass to the Next.js server.
 */
async function resolveMongoUri(): Promise<string | null> {
  const mode = store.get("connectionMode") as ConnectionMode;
  const atlasUri = store.get("atlasUri") as string;

  if (mode === "offline") {
    // Pure local mode — tear down any active sync
    if (syncService) {
      syncService.destroy();
      syncService = null;
    }
    const localUri = await startLocalMongo();
    store.set("mongodbUri", localUri);
    return localUri;
  }

  if (mode === "hybrid") {
    // Start local, sync with Atlas when available
    const localUri = await startLocalMongo();
    store.set("mongodbUri", localUri);

    if (atlasUri) {
      initSyncService(localUri, atlasUri);
    }

    return localUri;
  }

  if (mode === "atlas") {
    if (!atlasUri) return null;

    // Test Atlas connectivity — fall back to local if unreachable
    try {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(atlasUri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await client.connect();
      await client.db(getDbNameFromUri(atlasUri)).command({ ping: 1 });
      await client.close();

      store.set("mongodbUri", atlasUri);
      return atlasUri;
    } catch {
      console.log("Atlas unreachable, falling back to local MongoDB...");
      const localUri = await startLocalMongo();
      store.set("mongodbUri", localUri);

      // Start sync so it'll push/pull once Atlas is reachable
      initSyncService(localUri, atlasUri);

      // Notify renderer of the fallback
      mainWindow?.webContents.send("connection-mode-fallback", {
        intended: "atlas",
        actual: "local-fallback",
      });

      return localUri;
    }
  }

  // Not configured yet
  return store.get("mongodbUri") as string || null;
}

function initSyncService(localUri: string, atlasUri: string) {
  if (syncService) {
    syncService.destroy();
  }

  syncService = new SyncService(localUri, atlasUri);

  syncService.on("statusChange", (status: SyncStatus) => {
    mainWindow?.webContents.send("sync-status-changed", status);
  });

  syncService.on("syncComplete", () => {
    console.log("Sync completed");
    // Tell the renderer so it can refresh data that may have changed
    // (filaments list, dashboard, etc.) — without waiting for the next
    // user-triggered route change. GH #127.
    mainWindow?.webContents.send("sync-complete");
  });

  syncService.on("syncError", (err: string) => {
    console.error("Sync error:", err);
  });

  // Start periodic sync (every 5 minutes)
  syncService.startPeriodicSync();
}

// ── IPC handlers ──

// Config
ipcMain.handle("get-config", () => {
  return {
    mongodbUri: store.get("mongodbUri") as string,
    connectionMode: store.get("connectionMode") as string,
    atlasUri: store.get("atlasUri") as string,
    geminiApiKey: store.get("geminiApiKey") as string,
    aiApiKey: store.get("aiApiKey") as string,
    aiProvider: store.get("aiProvider") as string,
    currency: store.get("currency") as string,
    customCurrencies: store.get("customCurrencies") as string,
    locale: store.get("locale") as string,
  };
});

ipcMain.handle("save-config", async (_event, config: {
  mongodbUri?: string;
  connectionMode?: ConnectionMode;
  atlasUri?: string;
  geminiApiKey?: string;
  aiApiKey?: string;
  aiProvider?: string;
  currency?: string;
  customCurrencies?: string;
  locale?: string;
}) => {
  // Update individual fields
  if (config.connectionMode !== undefined) {
    store.set("connectionMode", config.connectionMode);
  }
  if (config.atlasUri !== undefined) {
    store.set("atlasUri", config.atlasUri);
  }
  if (config.geminiApiKey !== undefined) {
    store.set("geminiApiKey", config.geminiApiKey);
  }
  if (config.aiApiKey !== undefined) {
    store.set("aiApiKey", config.aiApiKey);
  }
  if (config.aiProvider !== undefined) {
    store.set("aiProvider", config.aiProvider);
  }
  if (config.currency !== undefined) {
    store.set("currency", config.currency);
  }
  if (config.customCurrencies !== undefined) {
    store.set("customCurrencies", config.customCurrencies);
  }
  if (config.locale !== undefined) {
    store.set("locale", config.locale);
  }

  // Legacy: if only mongodbUri is sent (old atlas-only flow)
  if (config.mongodbUri && !config.connectionMode) {
    store.set("mongodbUri", config.mongodbUri);
    store.set("connectionMode", "atlas");
    store.set("atlasUri", config.mongodbUri);
  }

  // Only the connection-affecting fields require a server restart and a
  // navigation reload. Saving cosmetic prefs like currency / locale / AI
  // keys / customCurrencies used to bounce the user back to /, which made
  // Settings feel unstable and interrupted multi-step configuration (GH
  // #177). Detect whether the connection actually changed before doing
  // any of the heavy lifting.
  const connectionChanged =
    config.connectionMode !== undefined ||
    config.atlasUri !== undefined ||
    config.mongodbUri !== undefined;

  if (connectionChanged) {
    const uri = await resolveMongoUri();
    if (uri) {
      process.env.MONGODB_URI = uri;
    }

    if (!isDev) {
      // Restart the production server with the new URI
      stopServer();
      try {
        await startProductionServer(uri || undefined);
      } catch (err) {
        console.error("Failed to start server after config save:", err);
      }
    }

    // Reload the window on a connection change so the renderer picks up
    // the new sync state. Destination depends on where the save came from:
    //   - first-run /setup completes → go home (the existing setup flow
    //     contract — src/app/setup/page.tsx awaits saveConfig and expects
    //     the main process to redirect; Codex review on PR #178)
    //   - any other page (Settings) → stay on /settings so the user can
    //     keep tuning without being bounced (GH #177)
    if (mainWindow) {
      const currentPath = (() => {
        try {
          return new URL(mainWindow.webContents.getURL()).pathname;
        } catch {
          return "/";
        }
      })();
      const isSetupCompletion = currentPath === "/setup";
      mainWindow.loadURL(getAppURL(isSetupCompletion ? "/" : "/settings"));
    }
  }

  return { success: true };
});

ipcMain.handle("reset-config", async () => {
  store.delete("mongodbUri");
  store.delete("connectionMode");
  store.delete("atlasUri");

  if (syncService) {
    syncService.destroy();
    syncService = null;
  }

  if (mainWindow) {
    mainWindow.loadURL(getAppURL("/setup"));
  }
  return { success: true };
});

ipcMain.handle("test-connection", async (_event, uri: string) => {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    const safe = message.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "mongodb://***");
    return { success: false, error: safe };
  } finally {
    await client.close().catch(() => {});
  }
});

ipcMain.handle("show-message", async (_event, options: { type: string; title: string; message: string }) => {
  if (mainWindow) {
    await dialog.showMessageBox(mainWindow, {
      type: options.type as "info" | "error" | "warning",
      title: options.title,
      message: options.message,
    });
  }
});

// Sync
ipcMain.handle("get-sync-status", () => {
  return syncService?.getStatus() ?? {
    state: "idle",
    lastSyncAt: null,
    error: null,
    progress: null,
  };
});

ipcMain.handle("trigger-sync", async () => {
  if (!syncService) {
    return { error: "Sync not available in current mode" };
  }
  const results = await withIpcTimeout(() => syncService!.sync(), "trigger-sync");
  return { results };
});

ipcMain.handle("check-atlas-connectivity", async () => {
  if (!syncService) {
    // Try a direct check
    const atlasUri = store.get("atlasUri") as string;
    if (!atlasUri) return { connected: false };
    const tempSync = new SyncService("", atlasUri);
    try {
      const connected = await tempSync.checkAtlasConnectivity();
      return { connected };
    } finally {
      tempSync.destroy();
    }
  }
  const connected = await syncService.checkAtlasConnectivity();
  return { connected };
});

// NFC IPC handlers
ipcMain.handle("nfc-get-status", () => {
  return nfcService?.getStatus() ?? {
    readerConnected: false,
    readerName: null,
    tagPresent: false,
    tagUid: null,
  };
});

ipcMain.handle("nfc-read-tag", async () => {
  if (!nfcService) throw new Error("NFC not initialized");
  return withIpcTimeout(() => nfcService!.readTag(), "nfc-read-tag");
});

ipcMain.handle("nfc-write-tag", async (_event, payload: number[], productUrl?: string) => {
  if (!nfcService) throw new Error("NFC not initialized");
  await withIpcTimeout(() => nfcService!.writeTag(new Uint8Array(payload), productUrl), "nfc-write-tag");

  // After a successful write, schedule a delayed read-back so the UI shows
  // the updated tag data. We delay to let the disconnect settle — reading
  // immediately after disconnect can leave pcscd in a bad state on Linux.
  setTimeout(() => {
    if (!nfcService) return;
    nfcService.readTag()
      .then((data) => {
        mainWindow?.webContents.send("nfc-tag-detected", { data });
      })
      .catch(() => { /* best-effort */ });
  }, 2000);

  return { success: true };
});

ipcMain.handle("nfc-format-tag", async () => {
  if (!nfcService) throw new Error("NFC not initialized");
  await withIpcTimeout(() => nfcService!.formatTag(), "nfc-format-tag");
  return { success: true };
});

// ── App lifecycle ──

// `child-process-gone` covers GPU, utility, and any other Chromium child
// processes — useful when the new Windows graphics stack (KB5083631 era)
// kills the GPU process and the renderer is left half-painted. Logging
// it gives users on GH #176 something concrete to attach.
app.on("child-process-gone", (_evt, details) => {
  diag(`child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

app.whenReady().then(async () => {
  diag("app ready");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": ["default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://localhost:* http://localhost:*; font-src 'self' data:;"],
      },
    });
  });

  const connectionMode = store.get("connectionMode") as ConnectionMode;

  let mongoUri: string | null = null;

  if (connectionMode) {
    // Already configured — resolve URI based on mode
    try {
      mongoUri = await resolveMongoUri();
    } catch (err) {
      console.error("Failed to resolve MongoDB URI:", err);
    }
  } else {
    // Check legacy config (pre-offline-mode)
    const legacyUri = store.get("mongodbUri") as string;
    if (legacyUri) {
      // Migrate: treat existing config as atlas mode
      store.set("connectionMode", "atlas");
      store.set("atlasUri", legacyUri);
      try {
        mongoUri = await resolveMongoUri();
      } catch (err) {
        console.error("Failed to resolve MongoDB URI:", err);
        mongoUri = legacyUri;
      }
    }
  }

  if (!isDev) {
    // Always start the server — even without mongoUri, the setup page needs it
    try {
      await startProductionServer(mongoUri || undefined);

      // Watch for unexpected server crashes after successful startup
      if (serverProcess) {
        serverProcess.on("exit", (code) => {
          if (code !== null && code !== 0) {
            console.error(`Server crashed with exit code ${code}, attempting restart...`);
            startProductionServer((store.get("mongodbUri") as string) || undefined)
              .then(() => {
                console.log("Server restarted successfully after crash");
                mainWindow?.reload();
              })
              .catch((restartErr) => {
                console.error("Server restart failed:", restartErr);
                dialog.showErrorBox(
                  "Server Crashed",
                  `The embedded web server crashed and could not be restarted.\n\n${restartErr instanceof Error ? restartErr.message : String(restartErr)}`,
                );
              });
          }
        });
      }
    } catch (err) {
      console.error("Failed to start server:", err);
      dialog.showErrorBox(
        "Server Startup Failed",
        `The embedded web server failed to start. The app may not work correctly.\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Initialize NFC service
  try {
    nfcService = new NfcService();
    let prevTagPresent = false;
    let lastAutoReadAt = 0;
    const AUTO_READ_COOLDOWN_MS = 4000;
    nfcService.on("statusChange", (status) => {
      mainWindow?.webContents.send("nfc-status-changed", status);

      if (status.tagPresent && !prevTagPresent && nfcService) {
        const now = Date.now();
        if (now - lastAutoReadAt < AUTO_READ_COOLDOWN_MS) {
          prevTagPresent = status.tagPresent;
          return;
        }
        // Set timestamp BEFORE async read to prevent concurrent triggers
        lastAutoReadAt = now;
        nfcService.readTag()
          .then((data) => {
            mainWindow?.webContents.send("nfc-tag-detected", { data });
          })
          .catch((err) => {
            // Blank/erased tags have no NDEF data — tell the renderer so it
            // can show an "empty tag" indication instead of silently ignoring.
            if (err.message?.includes("No NDEF TLV") || err.message?.includes("No NDEF record")) {
              mainWindow?.webContents.send("nfc-tag-detected", { empty: true });
              return;
            }
            mainWindow?.webContents.send("nfc-tag-detected", { error: err.message });
          });
      }
      prevTagPresent = status.tagPresent;
    });
    nfcService.on("error", (err) => {
      console.error("NFC error:", err.message);
    });
  } catch (err) {
    console.error("NFC initialization failed (reader may not be available):", err);
  }

  if (!connectionMode && !store.get("mongodbUri")) {
    createWindow("/setup");
  } else {
    if (mongoUri) {
      process.env.MONGODB_URI = mongoUri;
    }
    createWindow("/");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const mode = store.get("connectionMode") as string;
      createWindow(mode ? "/" : "/setup");
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopServer();
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  stopServer();
  if (syncService) syncService.destroy();
  if (nfcService) nfcService.destroy();
  stopLocalMongo().finally(() => app.quit());
});

} // end single-instance lock else block
