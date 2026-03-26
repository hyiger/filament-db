import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import Store from "electron-store";

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

function createWindow() {
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

  const mongoUri = store.get("mongodbUri") as string;

  if (!mongoUri) {
    // Show setup wizard
    if (isDev) {
      mainWindow.loadURL(`http://localhost:3000/setup`);
    } else {
      mainWindow.loadURL(`http://localhost:${PORT}/setup`);
    }
  } else {
    // Set env var and load main app
    process.env.MONGODB_URI = mongoUri;
    if (isDev) {
      mainWindow.loadURL("http://localhost:3000");
    } else {
      mainWindow.loadURL(`http://localhost:${PORT}`);
    }
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function startProductionServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const mongoUri = store.get("mongodbUri") as string;
    const serverPath = path.join(process.resourcesPath, "standalone", "server.js");

    serverProcess = spawn(process.execPath.replace(/electron/i, "node"), [serverPath], {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOSTNAME: "localhost",
        MONGODB_URI: mongoUri,
        NODE_ENV: "production",
      },
      stdio: "pipe",
    });

    // Also try with the system node
    if (!serverProcess.pid) {
      serverProcess = spawn("node", [serverPath], {
        env: {
          ...process.env,
          PORT: String(PORT),
          HOSTNAME: "localhost",
          MONGODB_URI: mongoUri,
          NODE_ENV: "production",
        },
        stdio: "pipe",
      });
    }

    serverProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("Ready") || output.includes("started") || output.includes("localhost")) {
        resolve();
      }
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      console.error("Server stderr:", data.toString());
    });

    serverProcess.on("error", (err) => {
      reject(err);
    });

    // Timeout fallback — server should be ready within 10s
    setTimeout(resolve, 10000);
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

  // Redirect main window to home
  if (mainWindow) {
    if (isDev) {
      mainWindow.loadURL("http://localhost:3000");
    } else {
      mainWindow.loadURL(`http://localhost:${PORT}`);
    }
  }

  return { success: true };
});

ipcMain.handle("reset-config", async () => {
  store.delete("mongodbUri");
  if (mainWindow) {
    if (isDev) {
      mainWindow.loadURL("http://localhost:3000/setup");
    } else {
      mainWindow.loadURL(`http://localhost:${PORT}/setup`);
    }
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
  if (!isDev) {
    const mongoUri = store.get("mongodbUri") as string;
    if (mongoUri) {
      try {
        await startProductionServer();
      } catch (err) {
        console.error("Failed to start server:", err);
      }
    }
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
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
