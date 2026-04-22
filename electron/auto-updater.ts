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

function emit(update: Partial<UpdateInfo>) {
  currentState = { ...currentState, ...update };
  mainWindow?.webContents.send("update-status", currentState);
}

export function initAutoUpdater(win: BrowserWindow) {
  mainWindow = win;

  // In dev, electron-updater throws when app.isPackaged is false. Skip there.
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

  // IPC surface for the renderer. Matches the shape used elsewhere in this
  // file — one handler per action, all argument-validated.
  ipcMain.handle("update-get-status", () => currentState);
  ipcMain.handle("update-check", async () => {
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
  ipcMain.handle("update-install", async () => {
    if (currentState.state !== "ready") {
      return { ok: false, error: "No update ready to install" };
    }
    const choice = await dialog.showMessageBox(mainWindow!, {
      type: "info",
      title: "Install update",
      message: `Install Filament DB v${currentState.version}?`,
      detail:
        "The app will restart to apply the update. Any unsaved work may be lost.",
      buttons: ["Restart & install", "Later"],
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
}
