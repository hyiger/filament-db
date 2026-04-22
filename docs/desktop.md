# Desktop App

[< Back to README](../README.md)

Filament DB can be packaged as an installable desktop application for macOS, Windows, and Linux using Electron.

## Installing

Download the latest release for your platform from [GitHub Releases](https://github.com/hyiger/filament-db/releases):

| Platform | File | Notes |
|----------|------|-------|
| macOS (Apple Silicon) | `FilamentDB-x.x.x-mac-arm64.dmg` | For M1/M2/M3/M4 Macs |
| macOS (Intel) | `FilamentDB-x.x.x-mac-x64.dmg` | For older Intel Macs |
| Windows | `FilamentDB-x.x.x-windows-x64-setup.exe` | NSIS installer, allows custom install directory |
| Linux x64 | `FilamentDB-x.x.x-linux-x86_64.AppImage` | Universal, no installation needed -- just make executable and run |
| Linux x64 | `FilamentDB-x.x.x-linux-amd64.deb` | For Ubuntu/Debian -- install with `sudo dpkg -i` |
| Linux arm64 | `FilamentDB-x.x.x-linux-arm64.AppImage` | For Raspberry Pi 5 and other arm64 boards |
| Linux arm64 | `FilamentDB-x.x.x-linux-arm64.deb` | For arm64 Ubuntu/Debian -- install with `sudo dpkg -i` |

> **macOS Gatekeeper:** The app is not notarized with an Apple Developer ID. After installing, macOS may block the app from opening. To fix this, run the following command in Terminal:
>
> ```bash
> xattr -cr "/Applications/Filament DB.app"
> ```
>
> This removes the quarantine flag that macOS applies to downloaded apps. You only need to do this once after installation.

## First Launch

On first launch, the app shows a setup wizard where you choose a connection mode:

- **MongoDB Atlas (Cloud)** — connect to a cloud database (requires internet)
- **Hybrid (Local + Cloud Sync)** — data stored locally, synced to Atlas when connected (recommended)
- **Local Only (Offline)** — all data stored locally, no cloud account needed

For Atlas and Hybrid modes, you'll be asked for a MongoDB Atlas connection string. Enter it and click **Connect** -- the app validates the connection before saving.

Your configuration is stored in an encrypted local file (using `electron-store` with AES encryption). This includes your MongoDB connection settings, AI provider API key, and connection mode.
- **macOS**: `~/Library/Application Support/filament-db/config.json`
- **Windows**: `%APPDATA%/filament-db/config.json`
- **Linux**: `~/.config/filament-db/config.json`

In offline and hybrid modes, the local database files are stored under the same directory in a `mongodb-data/` subfolder.

## Auto-Update *(v1.11)*

The packaged app polls GitHub Releases for new versions and surfaces a banner at the top of the window when an update is available. The lifecycle:

1. **available** — the banner offers **Download** (fetches in the background) and **View release** (opens the GitHub release page).
2. **downloading** — the banner shows a progress bar.
3. **ready** — the banner offers **Restart & install**. Clicking brings up a native confirmation dialog whose strings are passed from the renderer so they honour your current locale.
4. **error** — the banner switches to amber and exposes a **View release** link as a manual fallback.

**Platform-specific behaviour:**
- **macOS**: unsigned builds cannot auto-install through Gatekeeper; the app surfaces the "view release page" fallback so you can download the new DMG manually. Signed builds install cleanly.
- **Windows**: unsigned NSIS installers auto-install fine. The user sees a SmartScreen warning the next time the app launches.
- **Linux**: AppImage updates work when the app was launched via AppImageLauncher or a similar integration. `.deb` builds are not auto-updated — use your package manager instead.

**How it finds updates:** the release workflow produces `latest-mac.yml`, `latest-linux.yml`, and `latest-linux-arm64.yml` on every `v*` tag. `electron-updater` reads those manifests from the GitHub release on startup (with a 20-second delay so the UI has time to mount) and every 6 hours while the app is running.

**In dev:** the IPC handlers are always registered but short-circuit to `{ ok: false, error: "dev-mode" }` for mutating actions so the banner never triggers in a packaged-false run.

## Building from Source

### Development

Run the desktop app in development mode with hot-reload:

```bash
npm run electron:dev
```

This starts the Next.js dev server on port 3456 and Electron concurrently. The app loads `http://localhost:3456`.

> **Note:** In dev mode, Electron connects to the `next dev` server on port 3456. Connection-mode changes (offline/hybrid/atlas) made through the setup wizard will save to the config store and reconfigure the Electron main process (local MongoDB, sync service), but the Next.js backend still uses whatever `MONGODB_URI` is in your `.env.local`. To fully test connection modes, use a production build (`npm run electron:build`).

### Production Build

Build an installer for your current platform:

```bash
npm run electron:build
```

This runs five steps:
1. `npm run build` -- builds Next.js in standalone mode
2. `npm run electron:fixlinks` -- resolves symlinks in the standalone output and copies it with static assets
3. `npm run electron:rebuild` -- rebuilds native modules (PC/SC) for Electron's Node.js
4. `npm run electron:compile` -- bundles Electron TypeScript with esbuild
5. `npm run electron:pack` -- packages everything with electron-builder

The output installer will be in `dist-electron/`.

## Automated Releases via GitHub Actions

A GitHub Actions workflow (`.github/workflows/release.yml`) builds installers for all platforms automatically when you push a version tag:

```bash
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

Then create a release on GitHub:

```bash
gh release create v1.0.0 --title "v1.0.0" --generate-notes
```

The workflow runs builds on macOS, Windows, and Ubuntu runners in parallel (Linux builds both x64 and arm64 via cross-compilation). Each platform's installers are uploaded to the GitHub Release automatically.

### What the workflow does:
1. Checks out the code
2. Installs dependencies
3. Runs tests
4. Runs `npm run electron:build` (builds Next.js, resolves symlinks, bundles Electron, packages installer)
5. Uploads installers to GitHub Releases

## Architecture

The desktop app wraps the Next.js application in Electron:

```
┌─ Electron Shell ────────────────────────────┐
│                                             │
│  ┌─ Main Process ────────────────────────┐  │
│  │ electron/main.ts (bundled by esbuild) │  │
│  │ - App lifecycle                       │  │
│  │ - BrowserWindow management            │  │
│  │ - Spawns Next.js standalone server    │  │
│  │   via Electron utilityProcess        │  │
│  │ - Encrypted config storage            │  │
│  │   (MongoDB URI, AI API key, etc.)    │  │
│  │ - IPC handlers (save/load config)     │  │
│  │ - HTTP polling for server readiness   │  │
│  │ - NFC reader/writer service (PC/SC)   │  │
│  │   via @pokusew/pcsclite               │  │
│  │ - Embedded local MongoDB (mongod)     │  │
│  │ - Bidirectional Atlas sync service    │  │
│  │ - Server crash auto-recovery         │  │
│  │ - IPC timeout protection (15s)       │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ Renderer (BrowserWindow) ────────────┐  │
│  │ Next.js App                           │  │
│  │ - All web UI pages                    │  │
│  │ - API routes (filaments, nozzles)     │  │
│  │ - Setup wizard (/setup)               │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ Preload Script ─────────────────────┐   │
│  │ electron/preload.ts                   │  │
│  │ - Secure IPC bridge (contextBridge)   │  │
│  │ - Exposes: getConfig, saveConfig,     │  │
│  │   resetConfig, showMessage,           │  │
│  │   nfcGetStatus, nfcReadTag,           │  │
│  │   nfcWriteTag, sync status/trigger,   │  │
│  │   event listeners                     │  │
│  └───────────────────────────────────────┘  │
│                                             │
└─────────────────────────────────────────────┘
         │
         ▼
   Local MongoDB (embedded) ←→ MongoDB Atlas (cloud, optional)
```

In **development mode**: Electron loads `http://localhost:3456` (Next.js dev server).

In **production mode**: Electron uses `utilityProcess.fork()` to run the standalone Next.js server on `http://localhost:3456`, then loads it in the BrowserWindow. If the server crashes unexpectedly, the app automatically attempts to restart it and reload the window. If restart fails, an error dialog is shown.

IPC calls to NFC operations and sync have a 15-second timeout to prevent the UI from hanging if an operation becomes unresponsive.

## Resetting Configuration

To reconfigure the MongoDB connection, delete the config file at the path listed above, or use the developer tools console in the Electron window to call `window.electronAPI.resetConfig()`.
