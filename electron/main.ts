import { app, BrowserWindow, Menu, ipcMain, dialog, utilityProcess, UtilityProcess, shell, session } from "electron";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import Store from "electron-store";
import http from "http";
import { NfcService } from "./nfc-service";
import { listLabelPrinters, printLabel as printLabelToDevice } from "./label-printer";
import { isLoopbackHostname } from "../src/lib/loopbackHost";
import { listLanIpv4 } from "../src/lib/getLanIp";
import { startMdnsAdvertisement, stopMdnsAdvertisement } from "./mdns-service";
import { startLocalMongo, stopLocalMongo } from "./local-mongo";
import { SyncService, SyncStatus, getDbNameFromUri } from "./sync-service";
import { initAutoUpdater } from "./auto-updater";
import { assertTrustedSender, validateMongoUri } from "./ipc-security";
import { shouldApplyAppCsp } from "./csp-scope";

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
    // GH #711-follow-up: when true, the embedded server binds to 0.0.0.0 so
    // other devices on the LAN (e.g. the mobile scanner app) can reach it.
    // Default false → loopback-only, the prior behaviour.
    exposeToLan: false,
  },
});

const isDev = !app.isPackaged;
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
let serverProcess: UtilityProcess | null = null;
/** GH #315: crash-restart attempt counter. Reset to 0 each time a
 * server reaches a healthy startup; capped so an immediately-crashing
 * server can't tight-loop forever. */
let serverRestartCount = 0;
const MAX_SERVER_RESTARTS = 5;
let nfcService: NfcService | null = null;
/** GH #505: when resolveMongoUri()'s Atlas-to-local fallback fires at
 *  cold-boot, mainWindow is still null (resolveMongoUri runs before
 *  createWindow), so the `mainWindow?.webContents.send(...)` short-
 *  circuits and the renderer never learns. Stash the notice so the
 *  did-finish-load handler can replay it. Cleared once delivered. */
let pendingFallbackNotice: { intended: string; actual: string } | null = null;
/** Guards initNfc() so the deferred init runs only once even though it's
 * wired to every window's "show" event (macOS dock-reopen creates a new
 * window each time). */
let nfcInitStarted = false;
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

// GH #410: per-window guards on `mainWindow.webContents` (will-navigate,
// setWindowOpenHandler) protect only the top-level frame. A new
// BrowserWindow, an embedded <iframe> whose target becomes a separate
// WebContents, or a stray <webview> tag would inherit nothing. The
// global `web-contents-created` listener applies the same http(s)-only
// filter to EVERY WebContents the app ever creates — defence in depth
// against future code paths that spin up additional browser surfaces.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const proto = new URL(url).protocol;
      if (proto === "http:" || proto === "https:") {
        shell.openExternal(url);
      } else {
        console.warn(
          `[web-contents-created] Refused external URL scheme: ${proto}`,
        );
      }
    } catch {
      console.warn(
        `[web-contents-created] Refused malformed external URL: ${url}`,
      );
    }
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    const appUrl = getAppURL();
    if (!url.startsWith(appUrl)) event.preventDefault();
  });

  // `<webview>` is denied at the BrowserWindow level via
  // `webPreferences.webviewTag: false`, but a child WebContents
  // could still try to attach one. Deny at the contents level too.
  contents.on("will-attach-webview", (event) => event.preventDefault());
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
      // GH #262: run the renderer in the OS-level sandbox. The preload
      // only uses contextBridge + ipcRenderer, both of which are
      // sandbox-safe, so nothing in the renderer path needs Node access.
      // This contains any XSS in user-supplied filament data / community
      // DB content / TDS-extracted HTML so it can't reach beyond the
      // renderer process.
      sandbox: true,
      // GH #410: explicit defence-in-depth. `<webview>` tags load a
      // distinct WebContents that doesn't inherit the renderer's
      // sandbox settings. The app doesn't use them anywhere; deny
      // them so a future stray <webview> can't be a privileged
      // escape hatch.
      webviewTag: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    diag("ready-to-show — showing window");
    mainWindow?.show();
  });

  // GH #505: replay any fallback notice that fired before the window
  // existed. did-finish-load is the right moment because the renderer's
  // IPC listeners are guaranteed registered by then (preload + bundle
  // have run). Cleared after first delivery so a window reload doesn't
  // re-fire a stale notice.
  mainWindow.webContents.once("did-finish-load", () => {
    if (pendingFallbackNotice && mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("connection-mode-fallback", pendingFallbackNotice);
      pendingFallbackNotice = null;
    }
  });

  // Kick off NFC init once the window is actually visible — never before,
  // so a stalling pcsclite() native call can't strand the user with no
  // window (GH #238). Fires from either the ready-to-show path or the
  // safety-net timeout below; initNfc() is idempotent.
  mainWindow.once("show", () => {
    void initNfc();
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
      // Bind loopback-only by default; "Share on local network" (Settings)
      // flips this to 0.0.0.0 so LAN devices (the mobile scanner) can reach
      // the embedded server. Toggling it restarts the server (see save-config).
      HOSTNAME: store.get("exposeToLan") ? "0.0.0.0" : "localhost",
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

    // Mirror server output into the diag log too — when the utility
    // process dies during module load (as it did under v1.14.2's asar
    // packaging), the stack trace lands on stderr and we want it
    // captured alongside the lifecycle events for support reports.
    serverProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        console.log("Server:", text);
        diag(`server.stdout: ${text}`);
      }
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        console.error("Server error:", text);
        diag(`server.stderr: ${text}`);
      }
    });

    // Capture the process this closure owns — `serverProcess` is
    // reassigned on every (re)start, so the crash-restart guard below
    // must compare against the module-level current process, not this.
    const thisProc = serverProcess;

    serverProcess.on("spawn", () => {
      diag("server spawned");
      // Wait for the server to respond to HTTP requests
      waitForServer(PORT)
        .then(() => {
          // GH #315: a healthy startup resets the crash counter, so a
          // server that runs fine for a while and then crashes still
          // gets a fresh set of restart attempts.
          serverRestartCount = 0;
          resolve();
        })
        .catch(reject);
    });

    serverProcess.on("exit", (code) => {
      diag(`server exit code=${code}`);
      // Startup-phase failure: reject so the caller surfaces it. Harmless
      // once the promise has already resolved (reject on a settled
      // promise is a no-op).
      if (code !== 0) {
        reject(new Error(`Server exited with code ${code}`));
      }

      // GH #315: crash-restart. Attached to EVERY spawned process (not
      // just the first), so a crash after the first restart is still
      // handled. Skipped when:
      //   - the app is quitting (intentional shutdown), or
      //   - this exited process is no longer the current one — it was
      //     replaced by an intentional stopServer() + restart (e.g. a
      //     save-config connection change), so restarting it would
      //     spawn a duplicate server.
      if (isQuitting || thisProc !== serverProcess) return;
      if (code === 0 || code === null) return; // clean exit, not a crash

      // The current server crashed unexpectedly. Stop advertising it over mDNS
      // for the entire down/restart window so a mobile scan can't discover and
      // save a dead URL — it's re-published only after a healthy restart below
      // (Codex #723). Covers both the backoff window and a failed restart;
      // the retry-cap branch inherits this too.
      stopMdnsAdvertisement();

      if (serverRestartCount >= MAX_SERVER_RESTARTS) {
        diag(`server crash-restart cap reached (${MAX_SERVER_RESTARTS})`);
        dialog.showErrorBox(
          "Server Crashed",
          `The embedded web server crashed repeatedly (${MAX_SERVER_RESTARTS} restart attempts) and has been left stopped.`,
        );
        return;
      }
      serverRestartCount++;
      // Linear backoff, capped — avoids a tight loop on a server that
      // crashes immediately every time.
      const backoffMs = Math.min(serverRestartCount * 2000, 30_000);
      diag(`server crashed (code=${code}); restart ${serverRestartCount}/${MAX_SERVER_RESTARTS} in ${backoffMs}ms`);
      setTimeout(() => {
        // GH #315 (Codex review): re-check the SAME guard the exit
        // handler used, but now at timer-fire time. Between the crash
        // and this delayed restart (backoff up to 30s) an intentional
        // restart — e.g. save-config's stopServer() + startProduction-
        // Server() — may already have replaced `serverProcess`.
        // Restarting anyway would fork a duplicate server (EADDRINUSE)
        // and leave `serverProcess` pointing at the wrong instance.
        // `serverProcess !== thisProc` also covers a bare stopServer()
        // (serverProcess === null): an intentional stop must not be
        // undone by a stale crash timer.
        if (isQuitting || serverProcess !== thisProc) return;
        startProductionServer((store.get("mongodbUri") as string) || undefined)
          .then(() => {
            diag("server restarted successfully after crash");
            // Server healthy again — re-publish mDNS (no-op if exposeToLan off).
            syncMdnsAdvertisement();
            mainWindow?.reload();
          })
          .catch((restartErr) => {
            console.error("Server restart failed:", restartErr);
            diag(`server restart failed: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`);
          });
      }, backoffMs);
    });
  });
}

/** Maximum wait time (ms) for IPC calls before they're considered timed out. */
const IPC_TIMEOUT_MS = 15_000;

/** Upper bound on a renderer-supplied NFC write payload (GH #278). The
 * largest tag this app targets (SLIX2) holds ~320 bytes; 4 KB is a
 * generous ceiling that still rejects a memory-pressure payload before
 * any allocation happens. */
const MAX_NFC_PAYLOAD_BYTES = 4096;

/**
 * Wraps an async IPC handler with a timeout to prevent hanging calls
 * when the server becomes unresponsive.
 *
 * GH #279: the timeout only *rejects the promise* — it does not cancel
 * the underlying operation. Use it ONLY for genuinely bounded calls
 * (NFC read/write/format, where exceeding 15s means the reader is
 * stuck). Do NOT use it for inherently long-running work such as sync,
 * which keeps mutating data after the race is lost; long-running
 * operations should report progress through their own status channel
 * instead.
 */
function withIpcTimeout<T>(fn: () => Promise<T>, label: string, timeoutMs: number = IPC_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`IPC timeout: ${label} took longer than ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Stop the embedded server and resolve only once it has actually exited, so a
 * follow-up startProductionServer() doesn't probe a port the dying process
 * still owns — otherwise waitForServer() can be answered by the OLD server and
 * report "ready" before the replacement has bound, and the new child then
 * fails with EADDRINUSE (Codex P2 on PR #718). serverProcess is nulled FIRST
 * so the GH #315 crash-restart guard (thisProc !== serverProcess) suppresses a
 * respawn of the process we're intentionally killing.
 */
function stopServer(): Promise<void> {
  const proc = serverProcess;
  if (!proc) return Promise.resolve();
  serverProcess = null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    proc.once("exit", finish);
    proc.kill();
    // Safety net: never hang the caller if "exit" doesn't fire (already-dead
    // handle, etc.). In practice the utility process exits within a few ms.
    setTimeout(finish, 5000);
  });
}

/**
 * Advertise (or stop advertising) the embedded server over mDNS so the mobile
 * app can auto-discover it on the LAN. Only when packaged AND "Share on local
 * network" is enabled — in dev the renderer is served by a separate `next dev`,
 * and when exposeToLan is off the server is loopback-only (nothing to reach).
 * Idempotent; call it after the server's bind state settles.
 */
function syncMdnsAdvertisement(): void {
  if (!isDev && store.get("exposeToLan")) {
    startMdnsAdvertisement(PORT, app.getVersion());
  } else {
    stopMdnsAdvertisement();
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

    // Switching to pure Atlas — stop any sync engine left over from a prior
    // hybrid (or atlas-fallback) session. Without this the atlas-success path
    // below returns without ever tearing down the old SyncService, so it keeps
    // its 5-minute interval last-write-wins syncing a now-abandoned local
    // mongod against Atlas — a timer leak and a data-integrity hazard (#672).
    // The fallback path re-creates sync via initSyncService when Atlas is
    // unreachable.
    if (syncService) {
      syncService.destroy();
      syncService = null;
    }

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

      // Notify renderer of the fallback. GH #505: at cold-boot this
      // runs BEFORE createWindow, so mainWindow is null and the `?.`
      // short-circuits silently — leaving the renderer to render the
      // Atlas pill green while DB I/O actually targets local mongod.
      // Stash for replay on did-finish-load.
      const notice = { intended: "atlas", actual: "local-fallback" };
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send("connection-mode-fallback", notice);
      } else {
        pendingFallbackNotice = notice;
      }

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
//
// GH #409: returns the Atlas URI + AI API keys + Mongo URI. Without a
// sender guard, a sub-frame (embedded TDS, an XSS payload in a
// user-supplied filament field) could read the full credential blob
// and exfiltrate it through `img-src https:`-permitted beaconing.
// The siblings (`save-config`, `test-connection`, `reset-config`) all
// gate on `assertTrustedSender` already — this read path was the
// asymmetric hole.
ipcMain.handle("get-config", (event) => {
  assertTrustedSender(event, "get-config");
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
    labelFormat: store.get("labelFormat") as string,
    exposeToLan: store.get("exposeToLan") as boolean,
  };
});

// "Share on local network" needs to tell the user which URL to point a phone
// at. Returns the machine's LAN IPv4 candidates (private ranges first) + the
// server port. Empty `ips` → no usable LAN interface (e.g. Wi-Fi is off).
ipcMain.handle("get-lan-ip", (event) => {
  assertTrustedSender(event, "get-lan-ip");
  return { ips: listLanIpv4(), port: PORT };
});

// (#489) Expose whether Electron is running packaged or in dev mode.
// In dev mode the renderer is served by `next dev` (separate process)
// which reads MONGODB_URI from .env.local, NOT from electron-store.
// So the connection-mode wizard setting is purely cosmetic in dev —
// the embedded MongoDB Electron starts is unreachable from the
// renderer. The DevModeBanner uses this flag to surface the gap so
// users don't think they're working "offline" when writes actually
// hit whatever .env.local points to.
ipcMain.handle("get-runtime-mode", (event) => {
  assertTrustedSender(event, "get-runtime-mode");
  return { isPackaged: app.isPackaged };
});

ipcMain.handle("save-config", async (event, config: {
  mongodbUri?: string;
  connectionMode?: ConnectionMode;
  atlasUri?: string;
  geminiApiKey?: string;
  aiApiKey?: string;
  aiProvider?: string;
  currency?: string;
  customCurrencies?: string;
  locale?: string;
  labelFormat?: string;
  exposeToLan?: boolean;
}) => {
  assertTrustedSender(event, "save-config");

  // GH #300: any connection string reaching the store / child-process
  // env must be a real mongodb URI with no local-file TLS options.
  for (const candidate of [config.atlasUri, config.mongodbUri]) {
    if (candidate !== undefined) {
      const reason = validateMongoUri(candidate);
      if (reason) return { success: false, error: reason };
    }
  }

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
  // GH #592: the label format (a cosmetic pref like currency/locale; does
  // not affect the DB connection so it never triggers a server restart).
  if (config.labelFormat !== undefined) {
    store.set("labelFormat", config.labelFormat);
  }

  // "Share on local network": flips the embedded server's bind address
  // (localhost ⇄ 0.0.0.0). Only a real change needs a server respawn; record
  // it before writing so we can decide below.
  let exposeToLanChanged = false;
  if (config.exposeToLan !== undefined) {
    if ((store.get("exposeToLan") as boolean) !== config.exposeToLan) {
      exposeToLanChanged = true;
    }
    store.set("exposeToLan", config.exposeToLan);
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
      await stopServer();
      let serverRestarted = false;
      try {
        await startProductionServer(uri || undefined);
        serverRestarted = true;
      } catch (err) {
        console.error("Failed to start server after config save:", err);
      }
      // Refresh LAN auto-discovery so a stale advert doesn't point at a server
      // that just restarted (or failed to). syncMdnsAdvertisement() no-ops when
      // exposeToLan is off; stop outright if the restart failed.
      if (serverRestarted) syncMdnsAdvertisement();
      else stopMdnsAdvertisement();
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
  } else if (exposeToLanChanged && !isDev) {
    // LAN-share toggled with no connection change: respawn the embedded
    // server so it rebinds to the new HOSTNAME, reusing the already-resolved
    // active URI (store.mongodbUri — the same source the crash-restart path
    // uses). No URI re-resolution (so sync / local-mongo aren't
    // re-initialised) and no window reload (the renderer talks to localhost
    // either way). The await means this resolves only once the server is back
    // up, so the renderer's "applying…" state reflects real readiness.
    await stopServer();
    try {
      await startProductionServer((store.get("mongodbUri") as string) || undefined);
    } catch (err) {
      console.error("Failed to restart server after LAN-share toggle:", err);
      // The new bind failed and stopServer() already tore the old server
      // down, so the app currently has NO embedded server. Revert the
      // persisted flag (keep the store consistent with the actual bind) and
      // try to bring the server back on the previous binding so the user
      // isn't left with a dead window. Either way return failure so the
      // renderer's error path fires and the toggle doesn't show as applied.
      store.set("exposeToLan", !config.exposeToLan);
      // Clear any half-spawned/failed process before the recovery start so it
      // doesn't collide with the retry.
      await stopServer();
      try {
        await startProductionServer((store.get("mongodbUri") as string) || undefined);
      } catch (recoveryErr) {
        console.error("Failed to restore server after LAN-share toggle failure:", recoveryErr);
      }
      // Reflect the reverted bind state in the mDNS advertisement too.
      syncMdnsAdvertisement();
      return { success: false };
    }
  }

  // Start/stop LAN auto-discovery to match the new "Share on local network"
  // state once the server's bind has settled. Only for the exposeToLan-ONLY
  // path: when connectionChanged ran it already synced/stopped mDNS based on
  // its own restart outcome, so re-syncing here would re-advertise a dead
  // server if that restart failed while turning LAN sharing on (Codex #723).
  if (exposeToLanChanged && !connectionChanged) syncMdnsAdvertisement();
  return { success: true };
});

ipcMain.handle("reset-config", async (event) => {
  assertTrustedSender(event, "reset-config");
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

ipcMain.handle("test-connection", async (event, uri: string) => {
  assertTrustedSender(event, "test-connection");
  // GH #300: refuse non-mongodb schemes and local-file TLS options
  // before handing the string to the driver — otherwise a compromised
  // renderer could pivot through the main process (SSRF / file read).
  const reason = validateMongoUri(uri);
  if (reason) return { success: false, error: reason };

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

// GH #523: the `show-message` IPC handler that lived here was unguarded
// (no assertTrustedSender) AND dead code (zero renderer callers — see
// `grep -rn showMessage\|show-message src electron` before reintroducing).
// It rendered an OS-native dialog parented to the main window from
// renderer-controlled type/title/message strings — perfect material for
// UI-spoofing / credential-phishing prompts if a sub-frame is ever
// compromised. If a future feature needs it, re-add with
// assertTrustedSender and a constrained payload allowlist.

// Sync
// GH #623: read-only, but gate on the trusted sender anyway — the sync
// status carries the last error text (which can name the Atlas DB), and
// leaving the getter open was an undocumented asymmetry vs. every other
// handler's "contain XSS to the renderer" posture.
ipcMain.handle("get-sync-status", (event) => {
  assertTrustedSender(event, "get-sync-status");
  return syncService?.getStatus() ?? {
    state: "idle",
    lastSyncAt: null,
    error: null,
    progress: null,
  };
});

// GH #432: trigger-sync was reachable from any sub-frame. The
// `this.syncing` guard in SyncService makes the SECOND call cheap
// but the FIRST opens a real MongoClient connection to Atlas, which
// a compromised sub-frame could weaponise for timing attacks or
// bandwidth abuse against the user's Atlas tier.
ipcMain.handle("trigger-sync", async (event) => {
  assertTrustedSender(event, "trigger-sync");
  if (!syncService) {
    return { error: "Sync not available in current mode" };
  }
  // GH #279: do NOT wrap sync in withIpcTimeout. A 15s race that
  // abandons an in-flight sync doesn't stop it — the engine keeps
  // mutating BOTH databases while the renderer is told it "timed out".
  // Sync is inherently long-running and reports its own progress via
  // get-sync-status, which the renderer already polls; let it run to
  // completion.
  const results = await syncService.sync();
  return { results };
});

// GH #506: same sub-frame attack surface as #432's trigger-sync — this
// handler opens a real MongoClient to Atlas (per call when syncService
// is null; per-cycle thereafter) and is polled by SyncStatusIndicator.
// A compromised sub-frame can weaponise it for connection-pool / billing
// exhaustion against the user's Atlas tier.
ipcMain.handle("check-atlas-connectivity", async (event) => {
  assertTrustedSender(event, "check-atlas-connectivity");
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
// GH #623: read-only, but the status discloses the reader name + tagUid —
// same trusted-sender gate as the read/write/format handlers.
ipcMain.handle("nfc-get-status", (event) => {
  assertTrustedSender(event, "nfc-get-status");
  return nfcService?.getStatus() ?? {
    readerConnected: false,
    readerName: null,
    tagPresent: false,
    tagUid: null,
  };
});

// GH #432 follow-up: nfc-read-tag can move tag state (reads consume
// a slot in the reader's pipeline) and a sub-frame racing the
// legitimate auto-read could mask a real scan. Gate on the same
// trusted-sender check the write/format handlers already use.
ipcMain.handle("nfc-read-tag", async (event) => {
  assertTrustedSender(event, "nfc-read-tag");
  if (!nfcService) throw new Error("NFC not initialized");
  return withIpcTimeout(() => nfcService!.readTag(), "nfc-read-tag");
});

ipcMain.handle("nfc-write-tag", async (event, payload: number[], productUrl?: string) => {
  assertTrustedSender(event, "nfc-write-tag");
  if (!nfcService) throw new Error("NFC not initialized");

  // GH #278: the payload is a renderer-supplied number[] that gets
  // encoded onto a physical tag. Validate it BEFORE allocating — cap
  // the length, and confirm every element is a 0-255 byte.
  if (!Array.isArray(payload)) {
    throw new Error("nfc-write-tag: payload must be an array");
  }
  if (payload.length > MAX_NFC_PAYLOAD_BYTES) {
    throw new Error(
      `nfc-write-tag: payload too large (${payload.length} > ${MAX_NFC_PAYLOAD_BYTES} bytes)`,
    );
  }
  if (!payload.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error("nfc-write-tag: payload must contain only 0-255 integers");
  }
  // GH #278: productUrl is written onto the tag and acted on by
  // downstream readers (the Prusa app) — only http(s) is safe. A
  // javascript:/file: URL must never be persisted to physical media.
  if (productUrl !== undefined && !/^https?:\/\//i.test(productUrl)) {
    throw new Error("nfc-write-tag: productUrl must be an http(s) URL");
  }

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

ipcMain.handle("nfc-format-tag", async (event) => {
  assertTrustedSender(event, "nfc-format-tag");
  if (!nfcService) throw new Error("NFC not initialized");
  await withIpcTimeout(() => nfcService!.formatTag(), "nfc-format-tag");
  return { success: true };
});

// GH #583: set/clear the soft read-only flag on an OpenPrintTag (reversible —
// CC byte write-access bits, cleared by Erase or by setReadOnly(false)).
ipcMain.handle("nfc-set-readonly", async (event, readOnly: unknown) => {
  assertTrustedSender(event, "nfc-set-readonly");
  if (!nfcService) throw new Error("NFC not initialized");
  if (typeof readOnly !== "boolean") {
    throw new Error("nfc-set-readonly: readOnly must be a boolean");
  }
  await withIpcTimeout(() => nfcService!.setReadOnly(readOnly), "nfc-set-readonly");
  return { success: true };
});

// ── Label printer (Brother PT-P710BT) ──
// Transport-only; the byte stream is built in the renderer via
// src/lib/labelEncoder.ts + labelBitmap.ts. Main owns the print transport
// (the OS print system — CUPS / Windows spooler) because the renderer
// can't shell out or open the USB printer device. (GH #588)

ipcMain.handle("label-printer-list-devices", async (event, probeUsb) => {
  assertTrustedSender(event, "label-printer-list-devices");
  // GH #771: only probe for raw USB devices (which can pop the macOS admin
  // prompt via `lpinfo`) when the renderer explicitly asks — i.e. the user
  // clicked Refresh. The mount-time call passes nothing, so it stays a
  // passive, prompt-free read of already-configured queues.
  return await withIpcTimeout(
    () => listLabelPrinters({ probeUsb: probeUsb === true }),
    "label-printer-list-devices",
  );
});

ipcMain.handle("label-printer-get-device-path", (event) => {
  assertTrustedSender(event, "label-printer-get-device-path");
  // The picker's chosen device path lives in the same electron-store
  // the rest of the app uses — see the get-config handler above. Kept
  // as a separate handler so the renderer doesn't have to read the
  // whole config object just to render the Print Label dialog.
  return (store as Store<Record<string, unknown>>).get("labelPrinterDevicePath", null);
});

ipcMain.handle("label-printer-set-device-path", (event, devicePath: string | null) => {
  assertTrustedSender(event, "label-printer-set-device-path");
  if (devicePath != null && typeof devicePath !== "string") {
    throw new Error("devicePath must be a string or null");
  }
  if (devicePath == null) {
    (store as Store<Record<string, unknown>>).delete("labelPrinterDevicePath");
  } else {
    // GH #623: only accept the shapes listLabelPrinters ever surfaces —
    // a `usb://…` device URI (the one scheme the CUPS lister emits) or an
    // installed queue / Windows printer name. Anything else (ipp://,
    // file://, a path with slashes) could otherwise be persisted by a
    // compromised renderer and later handed to `lpadmin -v` by printCups,
    // binding the managed queue to an attacker-chosen device URI.
    const isUsbUri = /^usb:\/\//i.test(devicePath);
    const isQueueName =
      !devicePath.includes("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(devicePath);
    if (!isUsbUri && !isQueueName) {
      throw new Error(
        "devicePath must be a usb:// device URI or an installed printer/queue name",
      );
    }
    (store as Store<Record<string, unknown>>).set("labelPrinterDevicePath", devicePath);
  }
  return { ok: true };
});

// Public base URL used for URL-mode label QR payloads (e.g.
// "https://filament-db.lan" or "https://my-instance.example.com").
// Required for URL mode in packaged Electron because the renderer's
// window.location.origin is `http://localhost:<port>` — labels encoded
// with that URL are unscannable from any other device. Web users
// (renderer running in a regular browser) usually have a real origin
// already and don't need this setting; the dialog uses it as an
// override when set, falling back to `window.location.origin`
// otherwise. (Codex P2 on PR #487.)
ipcMain.handle("label-printer-get-public-url", (event) => {
  assertTrustedSender(event, "label-printer-get-public-url");
  return (store as Store<Record<string, unknown>>).get("labelPrinterPublicUrl", null);
});

ipcMain.handle("label-printer-set-public-url", (event, url: string | null) => {
  assertTrustedSender(event, "label-printer-set-public-url");
  if (url != null && typeof url !== "string") {
    throw new Error("url must be a string or null");
  }
  if (url == null || url.trim() === "") {
    (store as Store<Record<string, unknown>>).delete("labelPrinterPublicUrl");
    return { ok: true };
  }
  // Validate shape: must parse + must be http(s) + must not be the
  // loopback host (which defeats the whole point of this setting).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }
  if (isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      "URL points to localhost — labels encoded with this URL would be unscannable from other devices.",
    );
  }
  // (Query + fragment rejection moved below to the raw-input check
  // which also catches bare `?` / `#` delimiters that URL parses as
  // empty search/hash — Codex P2 round 9 on PR #487.)
  // Reject bare delimiters too: `https://example.com?` parses with
  // `parsed.search === ""` (falsy), so the structured check above lets
  // it through and the original raw string gets stored. Concatenating
  // `/filaments/<id>` onto that produces `...?/filaments/<id>` which
  // routes the scan to the wrong place. URL-path `?` and `#` characters
  // are always delimiters per RFC 3986 — literal versions must be
  // percent-encoded as `%3F` / `%23` — so checking the raw input is
  // valid. (Codex P2 round 9 on PR #487.)
  if (url.includes("?")) {
    throw new Error("URL must not contain a query string (?...)");
  }
  if (url.includes("#")) {
    throw new Error("URL must not contain a fragment (#...)");
  }
  // Strip trailing slash so callers can safely concat `${url}/filaments/...`
  // without producing double slashes.
  const normalized = url.replace(/\/+$/, "");
  (store as Store<Record<string, unknown>>).set("labelPrinterPublicUrl", normalized);
  return { ok: true };
});

ipcMain.handle("label-printer-print", async (event, bytes: number[]) => {
  assertTrustedSender(event, "label-printer-print");
  // Validate the payload from the renderer up front — bad inputs here
  // would otherwise be handed straight to the OS print transport.
  if (!Array.isArray(bytes) || bytes.length === 0) {
    throw new Error("bytes must be a non-empty array");
  }
  if (bytes.length > 5_000_000) {
    // Safety cap. A maxed-out 24mm × 200mm label is ~270 KB, so 5 MB
    // is well past any legitimate single-label print and ensures a
    // misbehaving renderer can't lock the printer indefinitely.
    throw new Error(`bytes array too large (${bytes.length} bytes)`);
  }
  // GH #523: per-byte validation mirroring nfc-write-tag (#278). Without
  // this, `new Uint8Array(bytes)` silently coerces floats to truncated
  // ints, NaN/Infinity/strings/objects/null to 0, and out-of-range
  // values mod-256 wrap. Brother's raster protocol is positional —
  // `ESC i z` media width, `ESC i M`/`K` mode bits, `0x1A`/`0x0C`
  // trailer — and a stray byte in the wrong slot leaves the printer
  // in a wrong-mode / chain-stuck state for the next print.
  //
  // Codex P2 round 1: use an index loop, not Array.prototype.every —
  // `every` skips sparse-array holes (`new Array(100)` or
  // `delete arr[5]`), so a hostile renderer could send a 5MB array
  // with NO actual bytes and the guard would pass. `new Uint8Array`
  // would then convert every hole to 0x00, reintroducing the silent
  // coercion this hardening is meant to block.
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (!Number.isInteger(b) || b < 0 || b > 255) {
      throw new Error("bytes must contain only integers in [0, 255]");
    }
  }
  const target = (store as Store<Record<string, unknown>>).get(
    "labelPrinterDevicePath",
    null,
  ) as string | null;
  if (!target) {
    throw new Error(
      "No label printer selected. Open Settings → Label Printer.",
    );
  }
  await withIpcTimeout(
    () => printLabelToDevice(target, new Uint8Array(bytes)),
    "label-printer-print",
    30_000, // give long labels + a slow spooler a generous window
  );
  return { ok: true };
});

// ── App lifecycle ──

// `child-process-gone` covers GPU, utility, and any other Chromium child
// processes — useful when the new Windows graphics stack (KB5083631 era)
// kills the GPU process and the renderer is left half-painted. Logging
// it gives users on GH #176 something concrete to attach.
app.on("child-process-gone", (_evt, details) => {
  diag(`child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

/**
 * Probe whether Windows' Smart Card service (SCardSvr) is in the RUNNING
 * state. On Windows ARM64 the service ships as Manual + Stopped by default
 * and `pcsclite()` makes a synchronous SCardEstablishContext call that
 * blocks the V8 event loop indefinitely in this state — the symptom users
 * see is "process appears in Task Manager but no window ever opens" (GH
 * #176). The probe shells out to `sc.exe query` (async, fast, immune to the
 * sync trap) so the NFC init can be skipped cleanly on hosts where
 * pcsclite would otherwise wedge the main process.
 *
 * Returns `true` on non-Windows platforms — Linux/macOS use pcscd /
 * CryptoTokenKit and have no equivalent failure mode.
 */
function isSmartCardServiceRunning(timeoutMs = 5000): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(true);
  // Resolve sc.exe via SystemRoot rather than the bare command name. Windows'
  // default executable search order checks the app / current-working
  // directory before System32, so a `sc.exe` planted next to a portable run
  // would be picked up first and turn this probe into an arbitrary-code-
  // execution sink. Anchor to an absolute path to close that.
  const scPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "sc.exe");
  return new Promise((resolve) => {
    execFile(
      scPath,
      ["query", "SCardSvr"],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        // sc.exe state codes: 1 STOPPED, 2 START_PENDING, 3 STOP_PENDING,
        // 4 RUNNING, 5 CONTINUE_PENDING, 6 PAUSE_PENDING, 7 PAUSED.
        resolve(/STATE\s*:\s*4\s*RUNNING/.test(stdout));
      },
    );
  });
}

/**
 * GH #609: on Linux, @pokusew/pcsclite's synchronous `pcsclite()` call
 * establishes a PC/SC context that blocks/spins the main thread when the
 * pcscd daemon isn't running — the same event-loop wedge as the Windows
 * SCardSvr case (GH #176). With the event loop stuck right after the window
 * is shown, the renderer never presents: on Wayland no window appears at all,
 * on X11 the WM maps a blank "Not Responding" frame. pcscd exposes a Unix
 * socket while running, so its absence is a fast, non-blocking signal that NFC
 * init would hang — skip it in that case. Honours PCSCLITE_CSOCK_NAME for
 * non-default socket locations.
 */
function isPcscdRunning(): boolean {
  const custom = process.env.PCSCLITE_CSOCK_NAME;
  if (custom) return fs.existsSync(custom);
  return (
    fs.existsSync("/run/pcscd/pcscd.comm") ||
    fs.existsSync("/var/run/pcscd/pcscd.comm")
  );
}

/**
 * Initialize the NFC service. Deferred until the main window is visible
 * (wired to the window's "show" event) — `new NfcService()` calls
 * `pcsclite()`, whose native constructor runs a synchronous
 * `SCardEstablishContext`. On some hosts (Windows ARM64 with SCardSvr
 * stopped, and apparently some Raspberry Pi OS setups — GH #238) that
 * call can stall the main thread. Running it only after the window has
 * painted means a misbehaving PC/SC stack can never be the reason the
 * user is left staring at a phantom background process (GH #176/#238).
 *
 * Idempotent via the `nfcInitStarted` guard — every createWindow() wires
 * a "show" listener, but the service is created only once per process.
 */
async function initNfc(): Promise<void> {
  if (nfcInitStarted) return;
  nfcInitStarted = true;

  // Skipped when the platform's smart-card service isn't available, because
  // pcsclite()'s synchronous SCardEstablishContext blocks/spins the main
  // thread there: Windows when SCardSvr is stopped (GH #176), and Linux when
  // pcscd isn't running (GH #609 — the blank / "Not Responding" window). macOS
  // uses CryptoTokenKit and has no equivalent wedge, so it's attempted as before.
  const skipNfcReason =
    process.platform === "win32" && !(await isSmartCardServiceRunning())
      ? "Smart Card service (SCardSvr) is not running on this Windows host"
      : process.platform === "linux" && !isPcscdRunning()
        ? "pcscd (PC/SC smart-card daemon) is not running on this Linux host"
        : null;
  if (skipNfcReason) {
    diag(`skipping NFC init: ${skipNfcReason}`);
    return;
  }

  try {
    nfcService = new NfcService();
    let prevTagPresent = false;
    let lastAutoReadAt = 0;
    const AUTO_READ_COOLDOWN_MS = 4000;
    // GH #572: small settle before the connect-time verification read so the
    // reader/native layer is past its initial status burst.
    const PRESENT_AT_CONNECT_VERIFY_MS = 700;

    // Read the tag and route the result to the renderer. `silentOnError`
    // suppresses the generic error path (used by the #572 connect-time
    // verification, which must stay quiet when the reader is empty / holds a
    // card the user didn't deliberately tap). Cooldown-guarded so a real
    // placement and the verification can't double-read.
    const triggerAutoRead = (silentOnError: boolean) => {
      if (!nfcService) return;
      const now = Date.now();
      if (now - lastAutoReadAt < AUTO_READ_COOLDOWN_MS) return;
      // Stamp BEFORE the async read to prevent concurrent triggers.
      lastAutoReadAt = now;
      nfcService.readTag()
        .then((data) => {
          mainWindow?.webContents.send("nfc-tag-detected", { data });
        })
        .catch((err) => {
          // Phantom-present recovery: PC/SC said `isPresent=true` but
          // the connect retries (up to ~6s) all failed — the present
          // bit was a driver/SCARD_STATE_CHANGED artifact, not a real
          // tag. Without this corrective clear, the renderer pill is
          // stuck at "Tag detected" indefinitely (the reason behind
          // this fix). The service handles the actual state mutation;
          // we don't emit a separate nfc-tag-detected here because
          // there is no tag to report on.
          if (err.message?.includes("Cannot connect to tag")) {
            nfcService?.clearPhantomPresence();
            return;
          }
          // Blank/erased tags have no NDEF data — tell the renderer so it
          // can show an "empty tag" indication instead of silently ignoring.
          // Covers an erased NDEF-formatted tag (No NDEF TLV/record) and a
          // never-formatted blank tag whose all-zero memory has no CC byte
          // (#556) — both are the friendly "write me to initialize" case,
          // not a raw error worth surfacing.
          if (
            err.message?.includes("No NDEF TLV") ||
            err.message?.includes("No NDEF record") ||
            err.message?.includes("Blank or unformatted")
          ) {
            mainWindow?.webContents.send("nfc-tag-detected", { empty: true });
            return;
          }
          // #572: the connect-time verification must not surface an
          // unexpected error (e.g. a non-OpenPrintTag card already sitting on
          // the reader); only a deliberate present-edge read does.
          if (silentOnError) return;
          mainWindow?.webContents.send("nfc-tag-detected", { error: err.message });
        });
    };

    nfcService.on("statusChange", (status) => {
      mainWindow?.webContents.send("nfc-status-changed", status);
      if (status.tagPresent && !prevTagPresent) {
        triggerAutoRead(false);
      }
      prevTagPresent = status.tagPresent;
    });

    // GH #572: a tag already resting on the reader at connect time only
    // produces the first (skipped) status event, so the present-edge path
    // above never fires. The service emits `presentAtConnect` when that first
    // event reported present — do a one-shot, silent verification read. A
    // real tag connects and reads (its connect emits an INUSE status event
    // that flips tagPresent), and the cooldown stops that from double-reading;
    // an empty reader / phantom fails the connect and stays quiet. Gated on no
    // tag already detected (a real placement during the settle wins).
    nfcService.on("presentAtConnect", () => {
      setTimeout(() => {
        if (
          nfcService?.getStatus().readerConnected &&
          !nfcService.getStatus().tagPresent
        ) {
          triggerAutoRead(true);
        }
      }, PRESENT_AT_CONNECT_VERIFY_MS);
    });

    nfcService.on("error", (err) => {
      console.error("NFC error:", err.message);
    });
  } catch (err) {
    console.error("NFC initialization failed (reader may not be available):", err);
  }
}

app.whenReady().then(async () => {
  diag("app ready");
  // GH #344: React's RSC client uses `eval()` in dev mode for
  // callstack reconstruction. `next.config.ts` already gates
  // `'unsafe-eval'` on `NODE_ENV !== "production"`, but the Electron
  // renderer applies the CSP below INSTEAD of (not in addition to) the
  // web CSP — `next dev`'s header on its own is overwritten by the
  // value we set here. So mirror the same dev-only gate, keyed on
  // `app.isPackaged` (the source of truth for "this is a release
  // build"). Production builds still get the tight, no-eval policy
  // from #262.
  const scriptSrc = app.isPackaged
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  // CSP header rewrite, scoped to the embedded Next app's own
  // responses. Codex flagged a P1 on PR #462: an unfiltered handler
  // would also rewrite the CSP on the vendor TDS document loaded
  // inside the `<iframe>` (the `frame-src https:` flow), and setting
  // `frame-ancestors 'none'` on the vendor doc's response tells
  // Chromium it can't be embedded by ANY parent — Chromium would
  // block the frame even though the vendor's own CSP allowed it.
  // Gate on the response URL's origin matching the app origin.
  const APP_ORIGIN = `http://localhost:${PORT}`;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Critical: shouldApplyAppCsp returns false for vendor TDS iframe
    // responses (origin !== APP_ORIGIN). Without that early-out, the
    // `frame-ancestors 'none'` directive below would land on the
    // vendor document and Chromium would refuse to embed it. See
    // `electron/csp-scope.ts` for the rationale and the dedicated
    // unit test that pins this contract.
    if (!shouldApplyAppCsp(details.url, APP_ORIGIN)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        // GH #262: `'unsafe-eval'` dropped from the PACKAGED build — the
        // compiled Next.js bundle doesn't need runtime eval(); allowing
        // it there only weakened CSP for no benefit.
        // `'unsafe-inline'` on script-src is still required because
        // Next.js streams the RSC payload via inline <script> tags and
        // the theme-init bootstrap is inline; migrating those to a
        // per-request nonce is tracked separately in #225.
        // GH #250: `frame-src https:` lets the filament detail page embed
        // an embeddable vendor TDS document in an <iframe>; without it the
        // load falls back to default-src 'self' and is blocked even after
        // /api/embed-check confirms the vendor allows framing.
        // GH #371: `img-src 'self' data: blob: https:` matches the web CSP
        // in `next.config.ts`. Spool photos are `data:` and previews are
        // `blob:`, but any external HTTPS image (vendor thumbnails, TDS-
        // derived images, OpenPrintTag remote previews) needs `https:` here
        // too — Electron's `onHeadersReceived` REPLACES the Next-sent CSP,
        // so anything missing on this side is silently dropped in desktop.
        // `connect-src` intentionally diverges: Electron adds localhost
        // ws/http for the embedded Next server; everything else mirrors web.
        //
        // GH #408: four hardening directives the web CSP has been carrying
        // were silently absent on desktop — `frame-ancestors 'none'`
        // (prevents clickjacking by blocking framing of the renderer),
        // `base-uri 'self'` (prevents <base href> injection redirecting all
        // relative URLs), `form-action 'self'` (blocks credential-stealing
        // form exfil), `object-src 'none'` (blocks plugin-based code
        // execution). Drop-in addition since the Electron CSP REPLACES the
        // Next-sent header, every directive on the web side has to be
        // mirrored explicitly here.
        "Content-Security-Policy": [`default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws://localhost:* http://localhost:*; font-src 'self' data:; frame-src https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';`],
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
    // Always start the server — even without mongoUri, the setup page needs it.
    // Crash-restart is handled inside startProductionServer (GH #315), so
    // every spawned process — including restarts — gets the handler.
    let serverStarted = false;
    try {
      await startProductionServer(mongoUri || undefined);
      serverStarted = true;
    } catch (err) {
      console.error("Failed to start server:", err);
      dialog.showErrorBox(
        "Server Startup Failed",
        `The embedded web server failed to start. The app may not work correctly.\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Advertise over mDNS (if "Share on local network" is on) only when the
    // server actually came up — otherwise the phone would discover a server it
    // can't reach. The catch above SWALLOWS the error, so a plain post-try call
    // would advertise regardless; the flag is load-bearing.
    if (serverStarted) syncMdnsAdvertisement();
    else stopMdnsAdvertisement();
  }

  // Create the window. NFC init is deferred to the window's "show" event
  // (see initNfc + createWindow) so a stalling PC/SC stack can't keep the
  // window from ever appearing (GH #176/#238).
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
    void stopServer();
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  void stopServer();
  stopMdnsAdvertisement();
  if (syncService) syncService.destroy();
  if (nfcService) nfcService.destroy();

  // GH #316: never let a hung mongod.stop() strand the app. Race the
  // local-Mongo shutdown against a hard timeout — whichever finishes
  // first re-triggers the quit.
  //
  // GH #315 (Codex P1): use `app.quit()`, NOT `app.exit(0)`. The
  // `isQuitting` guard at the top of this handler already stops a
  // second before-quit from re-preventDefault-ing, so the original
  // reason for forcing `app.exit` doesn't hold — and `app.exit(0)`
  // hard-skips the rest of the quit lifecycle: renderer `beforeunload`
  // handlers (the unsaved-changes prompt) never fire, and the
  // auto-updater's install-on-quit never runs. `app.quit()` preserves
  // both.
  const QUIT_TIMEOUT_MS = 5000;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    app.quit();
  };
  stopLocalMongo().finally(finish);
  setTimeout(finish, QUIT_TIMEOUT_MS);
});

} // end single-instance lock else block
