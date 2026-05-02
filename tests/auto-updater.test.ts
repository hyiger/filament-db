import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GH #154 regression guard. `initAutoUpdater()` is invoked from
 * `createWindow()` in electron/main.ts. On macOS, closing the window sets
 * `mainWindow = null` but the app stays running; clicking the dock icon
 * fires `app.on("activate")` → `createWindow()` → `initAutoUpdater()`
 * AGAIN. Before the fix, the second call hit
 *   Error: Attempted to register a second handler for 'update-get-status'
 * and crashed the app on every reopen.
 */

// Stub out the electron + electron-updater modules at the module-graph
// level — they don't load in a Node test env. Vitest hoists vi.mock so
// these run before the auto-updater import below.
const handleSpy = vi.fn();
const onSpy = vi.fn();

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {
    handle: handleSpy,
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    on: onSpy,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

interface FakeWindow {
  webContents: { send: ReturnType<typeof vi.fn> };
}
/**
 * Each fake window gets its OWN send spy. Sharing one would let a
 * regression that still emits to the previous window slip through —
 * `win2.webContents.send` and `win1.webContents.send` would be the
 * same mock and any call would satisfy either assertion.
 */
function makeWin(): FakeWindow {
  return { webContents: { send: vi.fn() } };
}

describe("initAutoUpdater — idempotency", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let initAutoUpdater: (win: any) => void;

  beforeEach(async () => {
    // Reset module cache so the `initialized` flag inside the module
    // starts false for each test. Without this, the first test's
    // initialized=true bleeds into the next test.
    vi.resetModules();
    handleSpy.mockClear();
    onSpy.mockClear();
    initAutoUpdater = (await import("../electron/auto-updater")).initAutoUpdater;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers each IPC handler exactly once across multiple calls", () => {
    const win1 = makeWin();
    const win2 = makeWin();
    const win3 = makeWin();

    initAutoUpdater(win1);
    initAutoUpdater(win2);
    initAutoUpdater(win3);

    // 4 distinct ipcMain.handle channels: get-status, check, download,
    // install, open-release-page → 5 total. Each must be registered once.
    const channels = handleSpy.mock.calls.map((c) => c[0]);
    expect(channels).toEqual([
      "update-get-status",
      "update-check",
      "update-download",
      "update-install",
      "update-open-release-page",
    ]);
    // Exactly one registration per channel — no duplicate.
    expect(handleSpy).toHaveBeenCalledTimes(5);
  });

  it("redirects future emits to the new window and stops emitting to the old one", () => {
    const win1 = makeWin();
    const win2 = makeWin();

    initAutoUpdater(win1);
    // The first init emits initial idle state into win1.
    const win1CallsAfterFirstInit = win1.webContents.send.mock.calls.length;
    expect(win1CallsAfterFirstInit).toBeGreaterThan(0);

    initAutoUpdater(win2);

    // Re-init should immediately re-emit the current state into the NEW
    // window so the renderer sees a value without waiting for the next
    // status change.
    expect(win2.webContents.send).toHaveBeenCalledWith(
      "update-status",
      expect.objectContaining({ state: "idle" }),
    );

    // And — the actual GH #154 regression guard — the old window must
    // not receive any new emits after re-init. Two distinct send spies
    // are required to verify this; with the previous shared-spy setup a
    // regression that still targeted win1 would have been invisible.
    expect(win1.webContents.send.mock.calls.length).toBe(win1CallsAfterFirstInit);
  });
});
