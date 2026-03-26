import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import Store from "electron-store";
import http from "http";

const store = new Store({
  encryptionKey: "filament-db-secure-key",
  defaults: {
    mongodbUri: "",
  },
});

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
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
    const serverPath = path.join(process.resourcesPath, "standalone", "server.js");

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
});
