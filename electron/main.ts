import { app, BrowserWindow, Menu, ipcMain, dialog, utilityProcess, UtilityProcess, shell, session } from "electron";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { randomBytes } from "crypto";
import Store from "electron-store";
import { NfcService } from "./nfc-service";
import {
  listLabelPrinters,
  printLabel as printLabelToDevice,
  disableBidi,
  type LabelPrinterKind,
} from "./label-printer";
import { isLoopbackHostname } from "../src/lib/loopbackHost";
import { listLanIpv4 } from "../src/lib/getLanIp";
import { isNtagSizeName, type NtagSizeName } from "../src/lib/ntagVersion";
import { startMdnsAdvertisement, stopMdnsAdvertisement } from "./mdns-service";
import { startLocalMongo, stopLocalMongo } from "./local-mongo";
import { SyncService, SyncStatus, getDbNameFromUri } from "./sync-service";
import { initAutoUpdater } from "./auto-updater";
import { assertTrustedSender, validateMongoUri } from "./ipc-security";
import { shouldApplyAppCsp } from "./csp-scope";
import { waitForServer } from "./wait-for-server";

// ── Diagnostic log ──
// Lifecycle + crash events to a file in userData so users on machines where
// the window never appears (GH #176) can attach a log. Best-effort only —
// never throws, never blocks startup. Mirrored to console.log.
const LOG_PATH = path.join(app.getPath("userData"), "logs", "main.log");
// #829: cap the log + keep one rotated backup — it mirrors all embedded Next
// server stdout/stderr, which grows without bound on a long-lived install.
const LOG_BACKUP_PATH = `${LOG_PATH}.1`;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
let logStream: fs.WriteStream | null = null;
let logBytes = 0;
let loggerDisabled = false;
function disableLogger() {
  loggerDisabled = true;
  if (logStream) {
    logStream.removeAllListeners("error");
    logStream.end();
    logStream = null;
  }
}
function openLogStream() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const stream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  // WriteStream errors (perm-denied, AV file lock, disk-full) emit
  // asynchronously; without a listener Node treats them as uncaught and
  // kills the main process. Absorb and disable further writes.
  stream.on("error", disableLogger);
  logStream = stream;
}
// Replace any prior backup with the current log and start fresh. Best-effort.
function rotateLog() {
  if (logStream) {
    logStream.removeAllListeners("error");
    logStream.end();
    logStream = null;
  }
  try {
    fs.rmSync(LOG_BACKUP_PATH, { force: true });
    fs.renameSync(LOG_PATH, LOG_BACKUP_PATH);
  } catch {
    // main.log may not exist yet, or the rename raced another process —
    // either way, just carry on with a fresh stream.
  }
  logBytes = 0;
}
function diag(message: string) {
  console.log(`[diag] ${message}`);
  if (loggerDisabled) return;
  try {
    if (!logStream) {
      // First write this process: seed the byte count from the existing file
      // so append-mode growth is bounded across restarts too, and rotate up
      // front if it's already at the cap.
      try {
        logBytes = fs.statSync(LOG_PATH).size;
      } catch {
        logBytes = 0; // ENOENT (no file yet) or stat failed
      }
      if (logBytes >= LOG_MAX_BYTES) rotateLog();
      openLogStream();
    } else if (logBytes >= LOG_MAX_BYTES) {
      // Mid-session cap reached — rotate to main.log.1 and reopen.
      rotateLog();
      openLogStream();
    }
    const line = `[${new Date().toISOString()}] ${message}\n`;
    if (logStream) {
      logStream.write(line);
      logBytes += Buffer.byteLength(line);
    }
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
/** GH #901: true while an INTENTIONAL stop+restart is in flight (save-config
 * connection change / LAN-share toggle). The crash-restart `exit` handler
 * bails when set, so a freshly-forked server failing during an intentional
 * restart doesn't ALSO burn a crash-restart attempt + schedule a respawn
 * racing the caller's own error handling. Cleared once the restart settles. */
let intentionalServerRestart = false;
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
// Prevent multiple app windows / duplicate servers on the same port. On
// Windows an upgrade can leave a previous-version process running — the new
// install then fails to get the lock; quitting silently there matched the
// GH #176 "no window appears" report, so surface the cause first.
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
    // .show() before .focus() resurfaces the window whether it was
    // minimized, hidden, or behind another window (GH #176).
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
 * window visible (GH #176: process running with no visible window on
 * Windows). If the renderer hangs, a blank interactable window beats a
 * phantom background process. Must be longer than realistic cold-startup
 * time on Windows with Defender scanning every file. */
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
    // Defer paint until ready-to-show (or the safety-net timeout) — avoids
    // an unstyled-content flash and gives GH #176 a recovery path when the
    // renderer never reaches a visible state on its own.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // GH #262: OS-level sandbox. The preload only uses contextBridge +
      // ipcRenderer (both sandbox-safe), and this contains any XSS in
      // user-supplied filament data / community DB content / TDS-extracted
      // HTML to the renderer process.
      sandbox: true,
      // GH #410: `<webview>` tags load a distinct WebContents that doesn't
      // inherit the renderer's sandbox. Unused by the app — deny so a
      // future stray <webview> can't be a privileged escape hatch.
      webviewTag: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    diag("ready-to-show — showing window");
    mainWindow?.show();
  });

  // GH #505: replay any fallback notice that fired before the window
  // existed. did-finish-load guarantees the renderer's IPC listeners are
  // registered; cleared after first delivery so a reload doesn't re-fire.
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
  initAutoUpdater(mainWindow, diag);

  // GH #902: do NOT install per-window `will-navigate` / window-open guards
  // here — the global `web-contents-created` handler above (registered at
  // module load) already covers EVERY WebContents; a per-window copy would
  // just duplicate listeners and risk the two copies drifting.

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
    // `options.hosts` is the driver's HostAddress[] (host/port optional); let
    // the element type infer rather than asserting a narrower shape (#816).
    const hosts = options.hosts.map((h) => `${h.host}:${h.port}`).join(",");

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

/**
 * Local print token (GH #1195).
 *
 * `POST /api/labels/print` drives physically-attached hardware, so it must
 * only answer local callers. A loopback check is not implementable — Next 16
 * exposes no socket peer address, and the `Host` header is client-supplied
 * (verified: a LAN request carrying `Host: localhost:3456` is served) — so
 * locality is proven by reading a secret only a local process can read.
 *
 * Minted once per app run, handed to the server in its spawn env, and
 * written 0600 under userData so a CLI or agent on this machine can read it.
 * A LAN attacker can reach the port but not the file.
 */
const LOCAL_PRINT_TOKEN = randomBytes(32).toString("hex");

function writeLocalPrintToken(): void {
  try {
    const target = path.join(app.getPath("userData"), "local-print-token");
    // mode on write does not apply to an existing file; chmod explicitly so a
    // token file left world-readable by an earlier run is corrected.
    fs.writeFileSync(target, LOCAL_PRINT_TOKEN, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
  } catch (err) {
    // Non-fatal: the print API simply stays unusable rather than the app
    // failing to start.
    console.error("[label-print] could not write local print token:", err);
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
      FILAMENTDB_LOCAL_PRINT_TOKEN: LOCAL_PRINT_TOKEN,
    };

    if (uri) {
      env.MONGODB_URI = uri;
    }

    serverProcess = utilityProcess.fork(serverPath, [], {
      env,
      stdio: "pipe",
      serviceName: "next-server",
    });

    // Mirror server output into the diag log — when the utility process
    // dies during module load, the stack trace lands on stderr and must be
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
      //     spawn a duplicate server, OR
      //   - GH #901: an intentional restart is in flight and THIS is the
      //     freshly-forked process that failed to start — the caller owns
      //     that failure, so we must not also crash-restart it (which would
      //     burn an attempt + schedule a background respawn racing the
      //     caller). `thisProc !== serverProcess` doesn't catch this case
      //     because the failed fork IS still the current serverProcess.
      if (isQuitting || intentionalServerRestart || thisProc !== serverProcess) return;
      if (code === 0 || code === null) return; // clean exit, not a crash

      // Stop advertising over mDNS for the entire down/restart window so a
      // mobile scan can't discover and save a dead URL — re-published only
      // after a healthy restart below (#723). Covers the backoff window, a
      // failed restart, and the retry-cap branch.
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
        // GH #315: re-check the exit handler's guard at timer-fire time —
        // during the backoff (up to 30s) an intentional restart may have
        // replaced `serverProcess`; restarting anyway would fork a
        // duplicate server (EADDRINUSE). `serverProcess !== thisProc`
        // also covers a bare stopServer() (serverProcess === null): an
        // intentional stop must not be undone by a stale crash timer.
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
function withIpcTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  label: string,
  timeoutMs: number = IPC_TIMEOUT_MS,
): Promise<T> {
  // GH #915: abort on timeout so an operation that's still QUEUED behind a stuck
  // op (e.g. an NFC write waiting on a stalled auto-read) can be dropped before
  // it runs — without this the renderer promise rejects but the queued work
  // still executes later, possibly against a different tag. Callers that don't
  // need cancellation simply ignore the signal arg.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`IPC timeout: ${label} took longer than ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([fn(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Stop the embedded server and resolve only once it has actually exited, so a
 * follow-up startProductionServer() doesn't probe a port the dying process
 * still owns — otherwise waitForServer() can be answered by the OLD server and
 * report "ready" before the replacement has bound, and the new child then
 * fails with EADDRINUSE (#718). serverProcess is nulled FIRST
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

    // Test Atlas connectivity — fall back to local if unreachable.
    // GH #1077: the client is hoisted out of the `try` and closed in a
    // `finally` — closing inside the `try` leaks a connected client (socket
    // pool, heartbeat timers, topology monitor) for the rest of the process
    // lifetime when anything throws between connect() and close(), e.g. the
    // ping failing on a reachable-but-unauthorized cluster.
    let client: import("mongodb").MongoClient | undefined;
    try {
      const { MongoClient } = await import("mongodb");
      client = new MongoClient(atlasUri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await client.connect();
      await client.db(getDbNameFromUri(atlasUri)).command({ ping: 1 });

      store.set("mongodbUri", atlasUri);
      // GH #1006 F3: pure Atlas doesn't use the embedded mongod — stop one a
      // prior offline/hybrid session started, or it idles for the session
      // (~200–300 MB RSS + a dbPath lock) serving nothing. No-op when none
      // is running; the atlas-fallback path restarts it on demand (#672).
      //
      // Guarded with its OWN try/catch (#1015): the enclosing catch means
      // "Atlas unreachable → fall back to local" — a mongod.stop() rejection
      // AFTER a successful Atlas ping must not jump the user onto
      // local-fallback (silently ignoring their reachable Atlas selection,
      // with startLocalMongo() handing back the stale mongod). A failed stop
      // just leaves the mongod idling — logged, no worse than pre-F3.
      try {
        await stopLocalMongo();
      } catch (stopErr) {
        console.warn("Failed to stop embedded MongoDB after Atlas switch (leaving it running):", stopErr);
      }
      return atlasUri;
    } catch {
      console.log("Atlas unreachable, falling back to local MongoDB...");
      const localUri = await startLocalMongo();
      store.set("mongodbUri", localUri);

      // Start sync so it'll push/pull once Atlas is reachable
      initSyncService(localUri, atlasUri);

      // GH #505: at cold-boot this runs BEFORE createWindow, so mainWindow
      // is null and the `?.` short-circuits silently — the renderer would
      // show the Atlas pill green while DB I/O targets local mongod. Stash
      // for replay on did-finish-load.
      const notice = { intended: "atlas", actual: "local-fallback" };
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send("connection-mode-fallback", notice);
      } else {
        pendingFallbackNotice = notice;
      }

      return localUri;
    } finally {
      // Runs on BOTH paths. close() is a no-op on a never-connected client;
      // swallow close errors like the sibling probes do.
      await client?.close().catch(() => {});
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
// user-supplied filament field) could read the full credential blob and
// exfiltrate it through `img-src https:`-permitted beaconing.
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
    dateFormat: store.get("dateFormat") as string,
    numberFormat: store.get("numberFormat") as string,
    ntagDefaultSize: store.get("ntagDefaultSize") as string,
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

// (#489) Whether Electron runs packaged or dev. In dev the renderer is
// served by `next dev`, which reads MONGODB_URI from .env.local, NOT
// electron-store — so the connection-mode wizard is cosmetic there and the
// embedded MongoDB is unreachable from the renderer. DevModeBanner uses
// this flag to surface that gap.
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
  dateFormat?: string;
  numberFormat?: string;
  ntagDefaultSize?: string;
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
  // Cosmetic local prefs (no server restart): label/date/number format,
  // default NTAG type (#592/#983/#973).
  if (config.labelFormat !== undefined) {
    store.set("labelFormat", config.labelFormat);
  }
  if (config.dateFormat !== undefined) {
    store.set("dateFormat", config.dateFormat);
  }
  if (config.numberFormat !== undefined) {
    store.set("numberFormat", config.numberFormat);
  }
  if (config.ntagDefaultSize !== undefined) {
    store.set("ntagDefaultSize", config.ntagDefaultSize);
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

  // Only connection-affecting fields require a server restart + navigation
  // reload — restarting on cosmetic prefs bounced the user back to / and
  // interrupted multi-step configuration (GH #177).
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
      // Restart the production server with the new URI. GH #901: flag the
      // intentional restart so a failed start doesn't trip the crash-restart
      // path on top of the error we already surface below.
      intentionalServerRestart = true;
      let serverRestarted = false;
      try {
        await stopServer();
        await startProductionServer(uri || undefined);
        serverRestarted = true;
      } catch (err) {
        console.error("Failed to start server after config save:", err);
        // GH #1006 F2: stopServer() already killed the healthy server, so
        // the app has NO embedded server (usual cause: transient EADDRINUSE
        // from the not-yet-dead old process). Clear any half-spawned process
        // and retry once on the SAME resolved uri — resolveMongoUri already
        // stood up THIS mode's mongod/sync and tore down the previous
        // mode's, so the new uri is the only coherent recovery target.
        await stopServer();
        try {
          await startProductionServer(uri || undefined);
          serverRestarted = true;
        } catch (recoveryErr) {
          console.error("Failed to restore server after config-change failure:", recoveryErr);
          // #1015: the failed recovery can leave a stray child
          // (startProductionServer rejects with the utility process still
          // alive, or `serverProcess` pointing at a dead handle). We're
          // about to report "no embedded server" — make that true, or a
          // late child squats the port.
          await stopServer();
        }
      } finally {
        intentionalServerRestart = false;
      }
      // Refresh LAN auto-discovery so a stale advert doesn't point at a server
      // that just restarted (or failed to). syncMdnsAdvertisement() no-ops when
      // exposeToLan is off; stop outright if the restart failed.
      if (serverRestarted) {
        syncMdnsAdvertisement();
      } else {
        // GH #1006 F2: recovery failed too — no embedded server. Don't
        // advertise a dead one, don't reload the window into a Chromium
        // error page (the #176 white-window class); return failure so the
        // renderer surfaces its error path instead of "Switched to <mode>"
        // over a dead server.
        stopMdnsAdvertisement();
        return { success: false };
      }
    }

    // Reload the window on a connection change so the renderer picks up the
    // new sync state. Destination: first-run /setup completes → go home
    // (src/app/setup/page.tsx awaits saveConfig and expects the main
    // process to redirect, #178); any other page → stay on /settings so the
    // user isn't bounced (GH #177).
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
    // active URI. No URI re-resolution (sync / local-mongo aren't
    // re-initialised) and no window reload (the renderer talks to localhost
    // either way). The await means this resolves only once the server is
    // back up. GH #901: flag the intentional restart (incl. recovery
    // restarts) so a failed start doesn't ALSO trip the crash-restart path;
    // the finally clears it on every exit.
    intentionalServerRestart = true;
    try {
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
          // #1015 (same hazard as the connection-change branch): clear any
          // half-spawned/stale child so "no embedded server" is actually
          // true before we report it.
          await stopServer();
        }
        // Reflect the reverted bind state in the mDNS advertisement too.
        syncMdnsAdvertisement();
        return { success: false };
      }
    } finally {
      intentionalServerRestart = false;
    }
  }

  // Sync mDNS once the server's bind has settled — but only for the
  // exposeToLan-ONLY path: the connectionChanged branch already synced/
  // stopped mDNS on its own restart outcome, and re-syncing here would
  // re-advertise a dead server after a failed restart (#723).
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

// GH #523: the `show-message` IPC handler that lived here was unguarded AND
// dead code. It rendered an OS-native dialog from renderer-controlled
// type/title/message strings — UI-spoofing / credential-phishing material if
// a sub-frame is compromised. If a future feature needs it, re-add with
// assertTrustedSender and a constrained payload allowlist.

// Sync
// GH #623: read-only, but sender-gated anyway — the sync status carries the
// last error text (which can name the Atlas DB).
ipcMain.handle("get-sync-status", (event) => {
  assertTrustedSender(event, "get-sync-status");
  return syncService?.getStatus() ?? {
    state: "idle",
    lastSyncAt: null,
    error: null,
    progress: null,
      // GH #1164: mode switches destroy the service, so the field resets
      // with it — an absent list must not read as a stale one.
      nameConflicts: [],
  };
});

// GH #432: trigger-sync opens a real MongoClient connection to Atlas — a
// compromised sub-frame could weaponise it for timing attacks or bandwidth
// abuse against the user's Atlas tier.
ipcMain.handle("trigger-sync", async (event) => {
  assertTrustedSender(event, "trigger-sync");
  if (!syncService) {
    return { error: "Sync not available in current mode" };
  }
  // GH #279: do NOT wrap sync in withIpcTimeout — abandoning the race
  // doesn't stop the engine, which keeps mutating BOTH databases while the
  // renderer is told it "timed out". Sync reports its own progress via
  // get-sync-status; let it run to completion.
  const results = await syncService.sync();
  return { results };
});

// GH #506: same sub-frame attack surface as trigger-sync — opens a real
// MongoClient to Atlas; a compromised sub-frame can weaponise it for
// connection-pool / billing exhaustion.
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
    // GH #1006 F4: src/types/electron.d.ts types `lastError` as required —
    // this null-service fallback must match the contract, or the renderer
    // receives `undefined` where it's typed `null`.
    lastError: null,
  };
});

// GH #432: nfc-read-tag can move tag state, and a sub-frame racing the
// legitimate auto-read could mask a real scan — same trusted-sender gate as
// the write/format handlers.
ipcMain.handle("nfc-read-tag", async (event) => {
  assertTrustedSender(event, "nfc-read-tag");
  if (!nfcService) throw new Error("NFC not initialized");
  return withIpcTimeout((signal) => nfcService!.readTag(signal), "nfc-read-tag");
});

// OpenTag3D write: non-mutating probe of the loaded tag so the renderer knows
// which standard to encode (OpenPrintTag for SLIX2, OpenTag3D for NTAG) and
// whether it's locked. Same trusted-sender + timeout posture as nfc-read-tag.
ipcMain.handle("nfc-detect-tag", async (event) => {
  assertTrustedSender(event, "nfc-detect-tag");
  if (!nfcService) throw new Error("NFC not initialized");
  return withIpcTimeout((signal) => nfcService!.detectTag(signal), "nfc-detect-tag");
});

ipcMain.handle("nfc-write-tag", async (event, payload: number[], standard?: unknown, productUrl?: unknown, ntagSize?: unknown) => {
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
  // OpenTag3D write: the standard discriminator picks the wrapping + which chip
  // is required. Default to openprinttag for back-compat.
  if (standard !== undefined && standard !== "openprinttag" && standard !== "opentag3d") {
    throw new Error("nfc-write-tag: standard must be 'openprinttag' or 'opentag3d'");
  }
  const writeStandard = (standard ?? "openprinttag") as "openprinttag" | "opentag3d";
  // GH #278: productUrl is written onto the tag and acted on by
  // downstream readers (the Prusa app) — only http(s) is safe. A
  // javascript:/file: URL must never be persisted to physical media.
  if (productUrl !== undefined && (typeof productUrl !== "string" || !/^https?:\/\//i.test(productUrl))) {
    throw new Error("nfc-write-tag: productUrl must be an http(s) URL");
  }
  const writeUrl = productUrl as string | undefined;
  // GH #973: optional user-declared NTAG size (the renderer's size picker) used
  // to size a blank NTAG when GET_VERSION can't auto-detect it. Validated to the
  // exact enum so an arbitrary string can't reach the writer.
  if (ntagSize !== undefined && !isNtagSizeName(ntagSize)) {
    throw new Error("nfc-write-tag: ntagSize must be 'NTAG213', 'NTAG215', or 'NTAG216'");
  }
  const writeNtagSize = ntagSize as NtagSizeName | undefined;

  await withIpcTimeout(
    (signal) =>
      nfcService!.writeTag(
        new Uint8Array(payload),
        { standard: writeStandard, productUrl: writeUrl, ntagSize: writeNtagSize },
        signal,
      ),
    "nfc-write-tag",
  );

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
  await withIpcTimeout((signal) => nfcService!.formatTag(signal), "nfc-format-tag");
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
  await withIpcTimeout((signal) => nfcService!.setReadOnly(readOnly, signal), "nfc-set-readonly");
  return { success: true };
});

// ── Label printer (Brother PT-P710BT) ──
// Transport-only; the byte stream is built in the renderer via
// src/lib/labelEncoder.ts + labelBitmap.ts. Main owns the OS print
// transport because the renderer can't shell out or open the USB printer
// device. (GH #588)

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

/**
 * The two label printers the app drives, and the electron-store key backing
 * each one's device selection.
 *
 * Registering both from ONE table is deliberate. These handlers are mirrored
 * by hand in electron/preload.ts and src/types/electron.d.ts with no
 * compile-time link between the three files, and that hand-mirroring has
 * already drifted in production once (GH #1006 F4, where preload's local
 * NfcStatus silently omitted a field). Two hand-copied ~50-line print
 * handlers would be the same trap: a validation guard tightened on one and
 * missed on the other is a security fix that only half-lands. Sharing the
 * body makes divergence impossible.
 *
 * "brother" is the PT-P710BT (24mm tape, spool labels, raster bytes).
 * "tspl" is the KNAON Y813BT (4x6 stock, dry-box labels, TSPL bytes).
 */
const LABEL_PRINTER_CHANNELS: readonly {
  kind: LabelPrinterKind;
  storeKey: string;
  channels: { get: string; set: string; print: string };
  noPrinterMessage: string;
}[] = [
  {
    kind: "brother",
    storeKey: "labelPrinterDevicePath",
    channels: {
      get: "label-printer-get-device-path",
      set: "label-printer-set-device-path",
      print: "label-printer-print",
    },
    noPrinterMessage: "No label printer selected. Open Settings → Label Printer.",
  },
  {
    kind: "tspl",
    storeKey: "tsplPrinterDevicePath",
    channels: {
      get: "tspl-printer-get-device-path",
      set: "tspl-printer-set-device-path",
      print: "tspl-printer-print",
    },
    noPrinterMessage: "No dry-box label printer selected. Open Settings → Devices.",
  },
];

/**
 * Safety cap on a single print job.
 *
 * A maxed-out 24mm × 200mm Brother label is ~270 KB and a 4x6 TSPL job is
 * ~600 bytes (or ~124 KB if it ever carries a full-page raster), so 5 MB is
 * well past any legitimate single label and ensures a misbehaving renderer
 * can't lock a printer indefinitely.
 */
const MAX_PRINT_BYTES = 5_000_000;

for (const spec of LABEL_PRINTER_CHANNELS) {
  ipcMain.handle(spec.channels.get, (event) => {
    assertTrustedSender(event, spec.channels.get);
    // Separate from get-config so the renderer doesn't read the whole
    // config object just to render a print dialog.
    return (store as unknown as Store<Record<string, unknown>>).get(spec.storeKey, null);
  });

  ipcMain.handle(spec.channels.set, (event, devicePath: string | null) => {
    assertTrustedSender(event, spec.channels.set);
    if (devicePath != null && typeof devicePath !== "string") {
      throw new Error("devicePath must be a string or null");
    }
    if (devicePath == null) {
      (store as unknown as Store<Record<string, unknown>>).delete(spec.storeKey);
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
      (store as unknown as Store<Record<string, unknown>>).set(spec.storeKey, devicePath);
    }
    return { ok: true };
  });

  ipcMain.handle(spec.channels.print, async (event, bytes: number[]) => {
    assertTrustedSender(event, spec.channels.print);
    // Validate the payload from the renderer up front — bad inputs here
    // would otherwise be handed straight to the OS print transport.
    if (!Array.isArray(bytes) || bytes.length === 0) {
      throw new Error("bytes must be a non-empty array");
    }
    if (bytes.length > MAX_PRINT_BYTES) {
      throw new Error(`bytes array too large (${bytes.length} bytes)`);
    }
    // GH #523: per-byte validation mirroring nfc-write-tag (#278). Without
    // this, `new Uint8Array(bytes)` silently coerces floats to truncated
    // ints, NaN/Infinity/strings/objects/null to 0, and out-of-range
    // values mod-256 wrap. Both wire formats are positional — Brother's
    // `ESC i z` media width / `ESC i M`/`K` mode bits / `0x1A` trailer, and
    // TSPL's CRLF framing, where a stray 0x0A splices a command boundary —
    // so a byte in the wrong slot leaves the printer in a wrong-mode or
    // chain-stuck state for the next print.
    //
    // Index loop, NOT Array.prototype.every — `every` skips sparse-array
    // holes, so a hostile renderer could send a 5MB hole-array with NO
    // actual bytes and the guard would pass; `new Uint8Array` would then
    // fill every hole with 0x00.
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (!Number.isInteger(b) || b < 0 || b > 255) {
        throw new Error("bytes must contain only integers in [0, 255]");
      }
    }
    const target = (store as unknown as Store<Record<string, unknown>>).get(
      spec.storeKey,
      null,
    ) as string | null;
    if (!target) {
      throw new Error(spec.noPrinterMessage);
    }
    await withIpcTimeout(
      () => printLabelToDevice(target, new Uint8Array(bytes), spec.kind),
      spec.channels.print,
      30_000, // give long labels + a slow spooler a generous window
    );
    return { ok: true };
  });
}

// Public base URL for URL-mode label QR payloads. Required in packaged
// Electron because window.location.origin is `http://localhost:<port>` —
// labels encoded with that are unscannable from any other device. The
// dialog uses it as an override when set, else window.location.origin.
ipcMain.handle("label-printer-get-public-url", (event) => {
  assertTrustedSender(event, "label-printer-get-public-url");
  return (store as unknown as Store<Record<string, unknown>>).get("labelPrinterPublicUrl", null);
});

ipcMain.handle("label-printer-set-public-url", (event, url: string | null) => {
  assertTrustedSender(event, "label-printer-set-public-url");
  if (url != null && typeof url !== "string") {
    throw new Error("url must be a string or null");
  }
  if (url == null || url.trim() === "") {
    (store as unknown as Store<Record<string, unknown>>).delete("labelPrinterPublicUrl");
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
  // Query/fragment rejection checks the RAW input: a bare
  // `https://example.com?` parses with `parsed.search === ""` (falsy), so a
  // structured check would let it through — and concatenating
  // `/filaments/<id>` onto it produces `...?/filaments/<id>`. `?` and `#`
  // are always delimiters per RFC 3986 (literals must be %3F / %23), so a
  // raw-substring check is valid.
  if (url.includes("?")) {
    throw new Error("URL must not contain a query string (?...)");
  }
  if (url.includes("#")) {
    throw new Error("URL must not contain a fragment (#...)");
  }
  // Strip trailing slash so callers can safely concat `${url}/filaments/...`
  // without producing double slashes.
  const normalized = url.replace(/\/+$/, "");
  (store as unknown as Store<Record<string, unknown>>).set("labelPrinterPublicUrl", normalized);
  return { ok: true };
});


// Disable bidirectional support on a Windows printer queue via an elevated
// helper (UAC). Some drivers (Brother PT-P710BT) crash the Print Spooler with
// BiDi on; turning it off is a system-level write the unelevated app can't do
// in-process. Returns a structured { ok, reason } the renderer maps to a
// localized toast (main-process strings can't cross into the Next renderer).
ipcMain.handle("label-printer-disable-bidi", async (event, printerName: string) => {
  assertTrustedSender(event, "label-printer-disable-bidi");
  // Platform first, so non-Windows callers get the clear message rather than a
  // name-shape error. (BiDi is a Win32_Printer queue property — Windows only.)
  if (process.platform !== "win32") {
    throw new Error("Disabling bidirectional support is only supported on Windows.");
  }
  if (typeof printerName !== "string" || printerName.length === 0) {
    throw new Error("printerName must be a non-empty string");
  }
  // Narrower than label-printer-set-device-path's rule: an installed Windows
  // printer/queue NAME only (no slash, no scheme) — never a usb:// URI.
  const isQueueName =
    !printerName.includes("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(printerName);
  if (!isQueueName) {
    throw new Error("printerName must be an installed printer/queue name");
  }
  // MANDATORY: the name must match a printer the user was actually shown — an
  // installed queue currently reporting BiDi on. This binds the elevated action
  // to a real, visible printer so a same-origin XSS / compromised renderer
  // can't pop a UAC prompt for an arbitrary name (consent-fatigue / wrong
  // printer). listLabelPrinters needs no elevation.
  const devices = await listLabelPrinters();
  const match = devices.find(
    (d) => d.path === printerName && d.bidiEnabled === true,
  );
  if (!match) {
    throw new Error("Printer not found, or bidirectional support is already off.");
  }
  // No withIpcTimeout: UAC waits on a human, disableBidi bounds the subprocess
  // itself (DISABLE_BIDI_TIMEOUT_MS), and a withIpcTimeout reject wouldn't
  // cancel the elevation anyway (GH #279).
  return await disableBidi(printerName);
});

// ── App lifecycle ──

// `child-process-gone` covers GPU, utility, and other Chromium children —
// useful when the GPU process is killed and the renderer is left
// half-painted; gives GH #176 reports something concrete to attach.
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
    // suppresses the generic error path (the #572 connect-time verification
    // must stay quiet when the reader is empty / holds a card the user
    // didn't deliberately tap). Cooldown-guarded against double-reads.
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
          // Phantom-present recovery: PC/SC said `isPresent=true` but the
          // connect retries (up to ~6s) all failed — the present bit was a
          // driver/SCARD_STATE_CHANGED artifact, not a real tag. Without
          // this corrective clear the renderer pill sticks at "Tag
          // detected" indefinitely. No nfc-tag-detected is emitted —
          // there's no tag to report on.
          if (err.message?.includes("Cannot connect to tag")) {
            nfcService?.clearPhantomPresence();
            return;
          }
          // Blank/erased tags have no NDEF data — surface as "empty tag".
          // Covers an erased NDEF-formatted tag (No NDEF TLV/record) and a
          // never-formatted blank tag with no CC byte (#556) — both the
          // friendly "write me to initialize" case, not a raw error.
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
    // above never fires. On `presentAtConnect`, do a one-shot silent
    // verification read: a real tag connects and reads (its connect emits an
    // INUSE status event that flips tagPresent; the cooldown stops a
    // double-read); an empty reader / phantom fails the connect and stays
    // quiet. Gated on no tag already detected.
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
  // GH #1195: mint/refresh the local print token file before the server
  // spawns, so a local CLI can read it as soon as the app is up.
  writeLocalPrintToken();
  diag("app ready");
  // GH #344: React's RSC client uses `eval()` in dev mode. next.config.ts
  // gates `'unsafe-eval'` on NODE_ENV, but the Electron renderer applies
  // the CSP below INSTEAD of (not merged with) the web CSP — so mirror the
  // dev-only gate here, keyed on `app.isPackaged` (the source of truth for
  // "release build", NOT NODE_ENV, which isn't reliably set in the main
  // process). Packaged builds keep the tight no-eval policy (#262).
  const scriptSrc = app.isPackaged
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  // CSP header rewrite, scoped to the embedded Next app's own responses.
  const APP_ORIGIN = `http://localhost:${PORT}`;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Critical: shouldApplyAppCsp returns false for vendor TDS iframe
    // responses (origin !== APP_ORIGIN). Without that early-out, the
    // `frame-ancestors 'none'` directive below would land on the vendor
    // document and Chromium would refuse to embed it — see
    // electron/csp-scope.ts for the rationale + the unit test pinning it.
    if (!shouldApplyAppCsp(details.url, APP_ORIGIN)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        // This value REPLACES the Next-sent CSP (it does not merge), so
        // every directive on the web side (next.config.ts) must be mirrored
        // explicitly here — keep the two in sync (tests/csp-parity.test.ts
        // pins it). The ONE intentional asymmetry is `connect-src`:
        // Electron adds localhost ws/http for the embedded Next server.
        // Notes per directive:
        // - `'unsafe-eval'` dropped from PACKAGED builds (GH #262);
        //   `'unsafe-inline'` still required for Next's inline RSC <script>
        //   streaming + the theme-init bootstrap (nonce migration: #225).
        // - `frame-src https:` embeds vendor TDS docs (GH #250).
        // - `img-src ... https:` — external HTTPS images break on desktop
        //   without it (GH #371).
        // - `frame-ancestors 'none'` / `base-uri 'self'` /
        //   `form-action 'self'` / `object-src 'none'` mirror the web
        //   hardening set (GH #408).
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

  // GH #316: never let a hung mongod.stop() strand the app — race the
  // local-Mongo shutdown against a hard timeout; whichever finishes first
  // re-triggers the quit.
  //
  // GH #315: use `app.quit()`, NOT `app.exit(0)` — the `isQuitting` guard
  // above already stops a second before-quit from re-preventDefault-ing,
  // and `app.exit(0)` hard-skips the quit lifecycle: renderer
  // `beforeunload` (the unsaved-changes prompt) never fires and the
  // auto-updater's install-on-quit never runs.
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
