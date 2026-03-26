# Desktop App

Filament DB can be packaged as an installable desktop application for macOS, Windows, and Linux using Electron.

## Installing

Download the latest release for your platform from [GitHub Releases](https://github.com/hyiger/filament-db/releases):

| Platform | File | Notes |
|----------|------|-------|
| macOS (Apple Silicon) | `FilamentDB-x.x.x-mac-arm64.dmg` | For M1/M2/M3/M4 Macs |
| macOS (Intel) | `FilamentDB-x.x.x-mac-x64.dmg` | For older Intel Macs |
| Windows | `FilamentDB-x.x.x-windows-x64-setup.exe` | NSIS installer, allows custom install directory |
| Linux | `FilamentDB-x.x.x-linux-x64.AppImage` | Universal, no installation needed -- just make executable and run |
| Linux | `FilamentDB-x.x.x-linux-amd64.deb` | For Ubuntu/Debian -- install with `sudo dpkg -i` |

## First Launch

On first launch, the app shows a setup wizard asking for your MongoDB Atlas connection string. Enter it and click **Connect** -- the app validates the connection before saving.

Your connection string is stored encrypted on your local machine:
- **macOS**: `~/Library/Application Support/filament-db/config.json`
- **Windows**: `%APPDATA%/filament-db/config.json`
- **Linux**: `~/.config/filament-db/config.json`

## Building from Source

### Development

Run the desktop app in development mode with hot-reload:

```bash
npm run electron:dev
```

This starts the Next.js dev server and Electron concurrently. The app loads `http://localhost:3000`.

### Production Build

Build an installer for your current platform:

```bash
npm run electron:build
```

This runs four steps:
1. `npm run build` -- builds Next.js in standalone mode
2. `npm run electron:fixlinks` -- resolves symlinks in the standalone output and copies it with static assets
3. `npm run electron:compile` -- bundles Electron TypeScript with esbuild
4. `npm run electron:pack` -- packages everything with electron-builder

The output installer will be in `dist-electron/`.

## Automated Releases via GitHub Actions

A GitHub Actions workflow (`.github/workflows/release.yml`) builds installers for all three platforms automatically when you push a version tag:

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

Then create a release on GitHub:

```bash
gh release create v0.2.0 --title "v0.2.0" --generate-notes
```

The workflow runs `npm run electron:build` on macOS, Windows, and Ubuntu runners in parallel. Each platform's installers are uploaded to the GitHub Release automatically.

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
│  │   via ELECTRON_RUN_AS_NODE=1          │  │
│  │ - Encrypted config storage            │  │
│  │ - IPC handlers (save/load config)     │  │
│  │ - HTTP polling for server readiness   │  │
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
│  │   resetConfig, showMessage            │  │
│  └───────────────────────────────────────┘  │
│                                             │
└─────────────────────────────────────────────┘
         │
         ▼
   MongoDB Atlas (cloud)
```

In **development mode**: Electron loads `http://localhost:3000` (Next.js dev server).

In **production mode**: Electron uses `ELECTRON_RUN_AS_NODE=1` to run the standalone Next.js server as a child process on `http://localhost:3456`, then loads it in the BrowserWindow.

## Resetting Configuration

To reconfigure the MongoDB connection, delete the config file at the path listed above, or use the developer tools console in the Electron window to call `window.electronAPI.resetConfig()`.
