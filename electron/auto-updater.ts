import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * Thin wrapper around electron-updater that ships silently while the app is
 * running and surfaces a download-and-restart prompt when an update is ready.
 *
 * Notes on signing:
 * - On macOS, unsigned apps cannot auto-install. We still detect that an
 *   update exists and prompt the user to download the new DMG manually via
 *   the GitHub release page.
 * - On Windows, unsigned NSIS installers work fine with auto-update (the
 *   user just sees an SmartScreen warning on launch).
 * - On Linux, AppImage updates work when the app was launched via
 *   AppImageLauncher or a similar integration. deb updates are NOT handled
 *   here — package managers should be used.
 *
 * The release workflow already produces `latest-mac.yml`, `latest-linux.yml`,
 * `latest-linux-arm64.yml` for each v* tag, which is what electron-updater
 * reads from the GitHub release.
 */

interface UpdateInfo {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "not-available";
  version?: string;
  releaseNotes?: string;
  progress?: { percent: number; bytesPerSecond: number };
  error?: string;
}

let mainWindow: BrowserWindow | null = null;
let currentState: UpdateInfo = { state: "idle" };
/** Tracks whether initAutoUpdater has done its one-time setup (IPC handlers,
 * autoUpdater listeners, periodic-check timers) for this process. The
 * function is called from `createWindow()` in electron/main.ts, which on
 * macOS runs every time the user clicks the dock icon after closing the
 * window. Without this guard the second call hits
 * `Error: Attempted to register a second handler for 'update-get-status'`
 * and crashes the app on reopen (GH #154). */
let initialized = false;

function emit(update: Partial<UpdateInfo>) {
  currentState = { ...currentState, ...update };
  mainWindow?.webContents.send("update-status", currentState);
}

export function initAutoUpdater(win: BrowserWindow) {
  // Always refresh the window reference — the previous window may have
  // been closed and the renderer for the new window needs to receive
  // future status events.
  mainWindow = win;

  if (initialized) {
    // Re-emit the current state into the new window so the renderer's
    // initial getSyncStatus() / status listener attaches to a fresh value
    // instead of waiting for the next tick.
    emit({});
    return;
  }
  initialized = true;

  // IPC surface is registered unconditionally so the dev-mode renderer can
  // still call update-get-status (and friends) without crashing with
  // "No handler registered". In dev, the mutating handlers short-circuit
  // with a "dev-mode" error instead of touching the real updater, which
  // electron-updater refuses to run when app.isPackaged is false.
  ipcMain.handle("update-get-status", () => currentState);

  ipcMain.handle("update-check", async () => {
    if (!app.isPackaged) return { ok: false, error: "dev-mode" };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ state: "error", error: message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle("update-download", async () => {
    if (!app.isPackaged) return { ok: false, error: "dev-mode" };
    if (currentState.state !== "available") return { ok: false, error: "No update available" };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ state: "error", error: message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle("update-install", async (_evt, strings?: {
    title?: string;
    message?: string;
    detail?: string;
    installButton?: string;
    laterButton?: string;
  }) => {
    if (!app.isPackaged) return { ok: false, error: "dev-mode" };
    if (currentState.state !== "ready") {
      return { ok: false, error: "No update ready to install" };
    }
    // Strings are optionally passed from the renderer so the OS-native
    // dialog can honour the user's current locale. The renderer owns the
    // i18n catalog; this module has no access to it. English defaults
    // apply when no strings are provided (unit tests, older renderers).
    const version = currentState.version ?? "";
    const message = (strings?.message ?? `Install Filament DB v{version}?`).replace(
      "{version}",
      version,
    );
    const choice = await dialog.showMessageBox(mainWindow!, {
      type: "info",
      title: strings?.title ?? "Install update",
      message,
      detail:
        strings?.detail ??
        "The app will restart to apply the update. Any unsaved work may be lost.",
      buttons: [
        strings?.installButton ?? "Restart & install",
        strings?.laterButton ?? "Later",
      ],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
    return { ok: true };
  });

  // Opens the GitHub release page — useful for macOS where unsigned auto-
  // install is blocked by Gatekeeper and the user has to download manually.
  ipcMain.handle("update-open-release-page", async () => {
    const version = currentState.version;
    const url = version
      ? `https://github.com/hyiger/filament-db/releases/tag/v${version}`
      : "https://github.com/hyiger/filament-db/releases/latest";
    await shell.openExternal(url);
    return { ok: true };
  });

  // In dev, electron-updater throws when app.isPackaged is false. Skip the
  // listener + polling setup; the stub handlers above keep the renderer
  // happy without touching the real updater.
  if (!app.isPackaged) {
    emit({ state: "idle" });
    return;
  }

  autoUpdater.autoDownload = false; // prompt the user before eating bandwidth
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => emit({ state: "checking" }));
  autoUpdater.on("update-available", (info) => {
    emit({
      state: "available",
      version: info.version,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : (info as any).releaseName,
    });
  });
  autoUpdater.on("update-not-available", () => emit({ state: "not-available" }));
  autoUpdater.on("download-progress", (p) =>
    emit({
      state: "downloading",
      progress: { percent: p.percent, bytesPerSecond: p.bytesPerSecond },
    }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    emit({ state: "ready", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    emit({ state: "error", error: err.message });
  });

  // Check once shortly after startup, then every 6 hours while running.
  // A short initial delay avoids hammering the API while the window is still
  // mounting and lets the user see the app first.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 20 * 1000);
  setInterval(
    () => autoUpdater.checkForUpdates().catch(() => {}),
    6 * 60 * 60 * 1000,
  );
}
