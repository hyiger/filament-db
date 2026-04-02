import { app, BrowserWindow, ipcMain, dialog, utilityProcess, UtilityProcess } from "electron";
import path from "path";
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
    geminiApiKey: "",
    aiApiKey: "",
    aiProvider: "gemini",
  },
});

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let serverProcess: UtilityProcess | null = null;
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
    const appPath = isDev
      ? path.join(__dirname, "..")
      : path.join(__dirname, "..");
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
    geminiApiKey: store.get("geminiApiKey") as string,
    aiApiKey: store.get("aiApiKey") as string,
    aiProvider: store.get("aiProvider") as string,
  };
});

ipcMain.handle("save-config", async (_event, config: {
  mongodbUri?: string;
  connectionMode?: ConnectionMode;
  atlasUri?: string;
  geminiApiKey?: string;
  aiApiKey?: string;
  aiProvider?: string;
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
  return { success: true };
});

ipcMain.handle("nfc-format-tag", async () => {
  if (!nfcService) throw new Error("NFC not initialized");
  await withIpcTimeout(() => nfcService!.formatTag(), "nfc-format-tag");
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

      // Watch for unexpected server crashes after successful startup
      if (serverProcess) {
        serverProcess.on("exit", (code) => {
          if (code !== null && code !== 0) {
            console.error(`Server crashed with exit code ${code}, attempting restart...`);
            startProductionServer(mongoUri || undefined)
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
            // Blank/erased tags have no NDEF data — silently ignore
            if (err.message?.includes("No NDEF TLV") || err.message?.includes("No NDEF record")) {
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
