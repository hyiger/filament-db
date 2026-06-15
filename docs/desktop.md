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

> **macOS Gatekeeper:** Since v1.39.1 the release DMGs are Developer ID-signed **and** notarized, so they open without any Gatekeeper warning and auto-update normally — no manual steps required. The first launch after a notarized install can take a while as macOS verifies the app (the first notarization itself runs ~40 minutes during the release, not a hang). If you built an **unsigned** DMG yourself, macOS may block it; clear the quarantine flag with:
>
> ```bash
> xattr -cr "/Applications/Filament DB.app"
> ```
>
> You only need that for a self-built unsigned app, and only once after installation.

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

## Share on Local Network *(v1.45.0)*

By default the embedded Next.js server binds to `localhost`, so it's reachable only from the same machine. **Settings → Share on local network** (an `electron-store` toggle, `exposeToLan`, off by default) rebinds the server to `0.0.0.0` so other devices on your LAN can reach it. When it's on, the **`get-lan-ip` IPC** surfaces the LAN URL to use (e.g. `http://192.168.1.20:3456`), which pairs with the companion mobile scanner app.

Since v1.47.0 the desktop also advertises itself over **mDNS** (`_filamentdb._tcp`, via `electron/mdns-service.ts` / `bonjour-service`) **only while "Share on local network" is on**, so the mobile app's **Find on your network** scan can auto-discover it without typing a URL.

> **Securing a LAN-exposed instance:** set the `FILAMENTDB_API_KEY` environment variable to require a bearer token on every `/api/*` request (`src/lib/apiAuth.ts`). Leaving it unset keeps the API unauthenticated (the default).

## Auto-Update *(v1.11)*

The packaged app polls GitHub Releases for new versions and surfaces a banner at the top of the window when an update is available. The lifecycle:

1. **available** — the banner offers **Download** (fetches in the background) and **View release** (opens the GitHub release page).
2. **downloading** — the banner shows a progress bar.
3. **ready** — the banner offers **Restart & install**. Clicking brings up a native confirmation dialog whose strings are passed from the renderer so they honour your current locale.
4. **error** — the banner switches to amber and exposes a **View release** link as a manual fallback.

**Platform-specific behaviour:**
- **macOS**: signed + notarized builds (v1.39.1+) auto-update cleanly through Gatekeeper. The `mac.target` is `[dmg, zip]` because electron-updater can't auto-update from a DMG, and the updater downloads the matching-arch ZIP. The "view release page" fallback still appears on the **error** state.
- **Windows**: unsigned NSIS installers auto-install fine. The user sees a SmartScreen warning the next time the app launches.
- **Linux**: AppImage updates work when the app was launched via AppImageLauncher or a similar integration. `.deb` builds are not auto-updated — use your package manager instead.

**How it finds updates:** the release workflow produces the `electron-updater` manifests on every `v*` tag — `latest.yml` (Windows, **x64-only** by design, see below), `latest-mac.yml` (macOS, a **merged multi-arch** manifest listing both `-mac-arm64.zip` and `-mac-x64.zip`), and `latest-linux.yml` / `latest-linux-arm64.yml` (Linux). `electron-updater` reads those manifests from the GitHub release on startup (with a 20-second delay so the UI has time to mount) and every 6 hours while the app is running. On macOS its `MacUpdater` filters the multi-arch manifest down to the running architecture, so Apple Silicon pulls the arm64 ZIP and Intel pulls the x64 ZIP.

**Multi-arch auto-update:** both the macOS and Windows multi-arch builds are handled so every architecture stays on a working update channel.
> - **macOS** — both arch build jobs run with `--publish never`, and a dedicated `merge-mac-metadata` CI job combines their two single-arch `latest-mac.yml` files into one multi-arch manifest (the sole writer of that asset). `MacUpdater` then filters it to the running arch, so Apple Silicon auto-updates to arm64 and Intel to x64.
> - **Windows** — x64 is the **single** update channel by design (#586). The arm64 cross job runs with `--publish never` and deletes its `latest.yml` so only the x64 manifest ships. arm64 Windows auto-updates to the emulated x64 build (which runs fine via the OS emulation layer); a native arm64 installer stays on the release for manual download.
> - **Linux** is unaffected — electron-builder appends an arch suffix there (`latest-linux.yml` / `latest-linux-arm64.yml`).

**In dev:** the IPC handlers are always registered but short-circuit to `{ ok: false, error: "dev-mode" }` for mutating actions so the banner never triggers in a packaged-false run.

## Building from Source

### Development

Run the desktop app in development mode with hot-reload:

```bash
npm run electron:dev
```

This starts the Next.js dev server on port 3456 and Electron concurrently. The app loads `http://localhost:3456`.

> **Note:** In dev mode, Electron connects to the `next dev` server on port 3456. Connection-mode changes (offline/hybrid/atlas) made through the setup wizard will save to the config store and reconfigure the Electron main process (local MongoDB, sync service), but the Next.js backend still uses whatever `MONGODB_URI` is in your `.env.local`. To fully test connection modes, use a production build (`npm run electron:build`). Since v1.34.1 the desktop app also surfaces this in dev mode via a dismissable amber banner at the top of the renderer so the gap is obvious before you click anything destructive.

### Production Build

Build an installer for your current platform:

```bash
npm run electron:build
```

This runs five steps:
1. `npm run build` -- builds Next.js in standalone mode
2. `npm run electron:fixlinks` -- resolves symlinks in the standalone output and copies it with static assets
3. `npm run electron:rebuild` -- rebuilds the native module for Electron's Node.js ABI: `@pokusew/pcsclite` (PC/SC, for NFC). The Brother label printer no longer needs a native module (since v1.34.9 it prints through the OS print system over USB, not `serialport`)
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

The workflow runs builds on macOS, Windows, and Ubuntu runners in parallel — six jobs in total, since macOS (arm64 + x64), Windows (x64 + arm64), and Linux (x64 + arm64) each build both architectures (the second arch cross-compiled). Each platform's installers are uploaded to the GitHub Release automatically.

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
│  │ - External link guard: only http(s)   │  │
│  │   URLs reach shell.openExternal       │  │
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
│  │   resetConfig, getRuntimeMode,        │  │
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
