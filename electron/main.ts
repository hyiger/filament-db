import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import Store from "electron-store";
import http from "http";
import { NfcService } from "./nfc-service";
import { startLocalMongo, stopLocalMongo } from "./local-mongo";
import { SyncService, SyncStatus } from "./sync-service";

export type ConnectionMode = "atlas" | "offline" | "hybrid";

const store = new Store({
  encryptionKey: "filament-db-secure-key",
  defaults: {
    mongodbUri: "",
    connectionMode: "" as ConnectionMode, // empty = not yet configured
    atlasUri: "",
  },
});

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let nfcService: NfcService | null = null;
let syncService: SyncService | null = null;
const PORT = 3456;

function getAppURL(urlPath = "/") {
  if (isDev) {
    return `http://localhost:3000${urlPath}`;
  }
  return `http://localhost:${PORT}${urlPath}`;
}

function createWindow(urlPath = "/") {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Filament DB",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(getAppURL(urlPath));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
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

function startProductionServer(mongoUri?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const uri = mongoUri || (store.get("mongodbUri") as string);
    const appPath = isDev
      ? path.join(__dirname, "..")
      : path.join(__dirname, "..");
    const serverPath = path.join(appPath, "standalone", "server.js");

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(PORT),
      HOSTNAME: "localhost",
      NODE_ENV: "production",
      ELECTRON_RUN_AS_NODE: "1",
    };

    if (uri) {
      env.MONGODB_URI = uri;
    }

    serverProcess = spawn(process.execPath, [serverPath], {
      env,
      stdio: "pipe",
    });

    serverProcess.stdout?.on("data", (data: Buffer) => {
      console.log("Server:", data.toString().trim());
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      console.error("Server error:", data.toString().trim());
    });

    serverProcess.on("error", (err) => {
      console.error("Failed to spawn server:", err);
      reject(err);
    });

    // Wait for the server to respond to HTTP requests
    waitForServer(PORT).then(resolve).catch(reject);
  });
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
    // Pure local mode
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
      await client.db("filament-db").command({ ping: 1 });
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
  };
});

ipcMain.handle("save-config", async (_event, config: {
  mongodbUri?: string;
  connectionMode?: ConnectionMode;
  atlasUri?: string;
}) => {
  // Update individual fields
  if (config.connectionMode !== undefined) {
    store.set("connectionMode", config.connectionMode);
  }
  if (config.atlasUri !== undefined) {
    store.set("atlasUri", config.atlasUri);
  }

  // Legacy: if only mongodbUri is sent (old atlas-only flow)
  if (config.mongodbUri && !config.connectionMode) {
    store.set("mongodbUri", config.mongodbUri);
    store.set("connectionMode", "atlas");
    store.set("atlasUri", config.mongodbUri);
  }

  // Resolve the actual URI based on mode
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

  // Redirect main window to home
  if (mainWindow) {
    mainWindow.loadURL(getAppURL("/"));
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
  const results = await syncService.sync();
  return { results };
});

ipcMain.handle("check-atlas-connectivity", async () => {
  if (!syncService) {
    // Try a direct check
    const atlasUri = store.get("atlasUri") as string;
    if (!atlasUri) return { connected: false };
    const tempSync = new SyncService("", atlasUri);
    const connected = await tempSync.checkAtlasConnectivity();
    tempSync.destroy();
    return { connected };
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
  return nfcService.readTag();
});

ipcMain.handle("nfc-write-tag", async (_event, payload: number[]) => {
  if (!nfcService) throw new Error("NFC not initialized");
  await nfcService.writeTag(new Uint8Array(payload));
  return { success: true };
});

// ── App lifecycle ──

app.whenReady().then(async () => {
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
    } catch (err) {
      console.error("Failed to start server:", err);
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
        lastAutoReadAt = now;
        nfcService.readTag()
          .then((data) => {
            mainWindow?.webContents.send("nfc-tag-detected", { data });
          })
          .catch((err) => {
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
  stopServer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  stopServer();

  if (syncService) {
    syncService.destroy();
    syncService = null;
  }

  if (nfcService) {
    nfcService.destroy();
    nfcService = null;
  }

  await stopLocalMongo();
});
