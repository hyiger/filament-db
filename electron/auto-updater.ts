import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { assertTrustedSender } from "./ipc-security";
import {
  classifyUpdateError,
  type UpdateErrorKind,
} from "../src/lib/updateErrorMessage";

/**
 * Thin wrapper around electron-updater that ships silently while the app is
 * running and surfaces a download-and-restart prompt when an update is ready.
 *
 * Signing / channel notes:
 * - macOS: works because builds are Developer ID-signed + notarized (v1.39.1+)
 *   AND the release ships per-arch `.zip` artifacts with a merged multi-arch
 *   `latest-mac.yml` (release.yml's merge-mac-metadata job): electron-updater
 *   requires a `.zip` (throws "ZIP file not provided" for a dmg-only release)
 *   and filters the yml's `files` by the running arch.
 * - Windows: unsigned NSIS installers auto-update fine (SmartScreen warning
 *   on launch only). The update channel is x64-only (`latest.yml`, GH #586).
 * - Linux: AppImage updates only, and only when launched via an integration
 *   like AppImageLauncher; deb goes through the package manager.
 */

interface UpdateInfo {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "not-available";
  version?: string;
  releaseNotes?: string;
  progress?: { percent: number; bytesPerSecond: number };
  /** Short, stack-free detail — NOT the raw multi-line electron-updater blob.
   *  The renderer shows a localized message keyed off `errorKind` (GH #946). */
  error?: string;
  /** Cause of the failure, mapped to a localized banner message. */
  errorKind?: UpdateErrorKind;
}

let mainWindow: BrowserWindow | null = null;
let currentState: UpdateInfo = { state: "idle" };
/** main.ts's `diag`, injected via initAutoUpdater so update errors reach
 *  main.log — a plain console.* in the main process is NOT mirrored to
 *  main.log (only the embedded server's stdout is). Falls back to
 *  console.error when absent. */
let diagLog: ((message: string) => void) | null = null;
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
  // The window may have been closed since this reference was captured —
  // on macOS the app keeps running and the periodic check still fires.
  // Touching `webContents` on a destroyed window throws "Object has been
  // destroyed" (GH #239), so verify the window is still alive first.
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send("update-status", currentState);
  }
}

/**
 * Emit an error state with a mapped `errorKind` + short stack-free `detail`;
 * the FULL raw error goes to main.log (GH #946). Returns the detail for the
 * IPC handlers to pass back.
 */
function emitError(err: unknown): string {
  const { kind, detail } = classifyUpdateError(err);
  const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
  (diagLog ?? ((m: string) => console.error(m)))(
    `[auto-updater] update error [${kind}]: ${raw}`,
  );
  emit({ state: "error", errorKind: kind, error: detail });
  return detail;
}

export function initAutoUpdater(
  win: BrowserWindow,
  log?: (message: string) => void,
) {
  // Always refresh the window reference — the previous window may have
  // been closed and the new window needs future status events.
  mainWindow = win;
  if (log) diagLog = log;

  if (initialized) {
    // Re-emit current state into the new window so its renderer doesn't
    // wait for the next tick.
    emit({});
    return;
  }
  initialized = true;

  // IPC surface is registered unconditionally so the dev-mode renderer can
  // still call update-get-status (and friends) without "No handler
  // registered". In dev, the mutating handlers short-circuit with a
  // "dev-mode" error — electron-updater refuses to run when app.isPackaged
  // is false. Read-only, but sender-gated like its siblings (GH #623).
  ipcMain.handle("update-get-status", (event) => {
    assertTrustedSender(event, "update-get-status");
    return currentState;
  });

  // GH #434: a sub-frame must not drive check/download — `update-download`
  // pulls the full installer payload (bandwidth abuse against the user).
  // Trust only the top-level app frame, same as the install handler.
  ipcMain.handle("update-check", async (event) => {
    assertTrustedSender(event, "update-check");
    if (!app.isPackaged) return { ok: false, error: "dev-mode" };
    // GH #433: don't re-check while downloading or ready —
    // `checkForUpdates()` re-emits `update-available` /
    // `update-not-available`, overwriting the in-progress state and
    // blowing away the progress UI.
    if (currentState.state === "downloading" || currentState.state === "ready") {
      return { ok: true, skipped: currentState.state };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: emitError(err) };
    }
  });

  ipcMain.handle("update-download", async (event) => {
    assertTrustedSender(event, "update-download");
    if (!app.isPackaged) return { ok: false, error: "dev-mode" };
    if (currentState.state !== "available") return { ok: false, error: "No update available" };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: emitError(err) };
    }
  });

  ipcMain.handle("update-install", async (evt, strings?: {
    title?: string;
    message?: string;
    detail?: string;
    installButton?: string;
    laterButton?: string;
  }) => {
    // update-install restarts the app — only the app's own top-level
    // frame may invoke it (GH #299).
    assertTrustedSender(evt, "update-install");
    if (!app.isPackaged) return { ok: false, error: "dev-mode" };
    if (currentState.state !== "ready") {
      return { ok: false, error: "No update ready to install" };
    }
    // Strings come from the renderer (which owns the i18n catalog) so the
    // OS-native dialog honours the user's locale; English defaults apply
    // when absent.
    const version = currentState.version ?? "";
    const message = (strings?.message ?? `Install Filament DB v{version}?`).replace(
      "{version}",
      version,
    );
    const dialogOptions = {
      type: "info" as const,
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
    };
    // Parent the dialog to the window only if it's still alive; a destroyed
    // window throws "Object has been destroyed" (GH #239).
    const liveWindow =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const choice = liveWindow
      ? await dialog.showMessageBox(liveWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);
    if (choice.response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
    return { ok: true };
  });

  // Opens the GitHub release page (manual-download fallback). A sub-frame
  // triggering browser tab opens is a phishing surface — gate on the
  // top-level frame (GH #434).
  ipcMain.handle("update-open-release-page", async (event) => {
    assertTrustedSender(event, "update-open-release-page");
    const version = currentState.version;
    const url = version
      ? `https://github.com/hyiger/filament-db/releases/tag/v${version}`
      : "https://github.com/hyiger/filament-db/releases/latest";
    await shell.openExternal(url);
    return { ok: true };
  });

  // In dev, electron-updater throws when app.isPackaged is false — skip the
  // listener + polling setup; the stub handlers above cover the renderer.
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
    emitError(err);
  });

  // Check once shortly after startup, then every 6 hours. Skip while
  // downloading/ready — same GH #433 guard as the IPC handler.
  const checkUnlessBusy = () => {
    if (currentState.state === "downloading" || currentState.state === "ready") {
      return;
    }
    autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(checkUnlessBusy, 20 * 1000);
  setInterval(checkUnlessBusy, 6 * 60 * 60 * 1000);
}
