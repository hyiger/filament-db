import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import Store from "electron-store";
import http from "http";
import { NfcService } from "./nfc-service";

const store = new Store({
  encryptionKey: "filament-db-secure-key",
  defaults: {
    mongodbUri: "",
  },
});

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let nfcService: NfcService | null = null;
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

// IPC handlers for setup wizard
ipcMain.handle("get-config", () => {
  return {
    mongodbUri: store.get("mongodbUri") as string,
  };
});

ipcMain.handle("save-config", async (_event, config: { mongodbUri: string }) => {
  store.set("mongodbUri", config.mongodbUri);
  process.env.MONGODB_URI = config.mongodbUri;

  if (!isDev) {
    // Restart the production server with the new URI
    stopServer();
    try {
      await startProductionServer(config.mongodbUri);
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

app.whenReady().then(async () => {
  const mongoUri = store.get("mongodbUri") as string;

  if (!isDev) {
    // Always start the server — even without mongoUri, the setup page needs it
    try {
      await startProductionServer(mongoUri);
    } catch (err) {
      console.error("Failed to start server:", err);
    }
  }

  // Initialize NFC service
  try {
    nfcService = new NfcService();
    let prevTagPresent = false;
    let lastAutoReadAt = 0;
    const AUTO_READ_COOLDOWN_MS = 4000; // suppress re-read during tag removal transient
    nfcService.on("statusChange", (status) => {
      mainWindow?.webContents.send("nfc-status-changed", status);

      // Auto-read when a tag is placed on the reader
      if (status.tagPresent && !prevTagPresent && nfcService) {
        const now = Date.now();
        if (now - lastAutoReadAt < AUTO_READ_COOLDOWN_MS) {
          // Skip — likely a stale "present" event from the other driver during tag removal
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

  if (!mongoUri) {
    createWindow("/setup");
  } else {
    process.env.MONGODB_URI = mongoUri;
    createWindow("/");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const uri = store.get("mongodbUri") as string;
      createWindow(uri ? "/" : "/setup");
    }
  });
});

app.on("window-all-closed", () => {
  stopServer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopServer();
  if (nfcService) {
    nfcService.destroy();
    nfcService = null;
  }
});
