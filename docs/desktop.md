# Desktop App

Filament DB can be packaged as an installable desktop application for macOS, Windows, and Linux using Electron.

## Installing

Download the latest release for your platform from [GitHub Releases](https://github.com/hyiger/filament-db/releases):

| Platform | File | Notes |
|----------|------|-------|
| macOS | `.dmg` | Universal binary (Intel + Apple Silicon) |
| Windows | `.exe` | NSIS installer, allows custom install directory |
| Linux | `.AppImage` | Universal, no installation needed -- just make executable and run |
| Linux | `.deb` | For Ubuntu/Debian -- install with `sudo dpkg -i` |

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

This starts Next.js dev server and Electron concurrently.

### Production Build

Build an installer for your current platform:

```bash
npm run electron:build
```

This runs three steps:
1. `npm run build` -- builds Next.js in standalone mode
2. `npm run electron:compile` -- compiles Electron TypeScript to JavaScript
3. `npm run electron:pack` -- packages everything with electron-builder

The output installer will be in `dist-electron/`.

## Automated Releases via GitHub Actions

A GitHub Actions workflow (`.github/workflows/release.yml`) builds installers for all three platforms automatically when you push a version tag:

```bash
# Create a release
git tag v0.1.0
git push --tags
```

This triggers parallel builds on macOS, Windows, and Ubuntu runners. The resulting installers are uploaded to a GitHub Release automatically.

### What the workflow does:
1. Checks out the code
2. Installs dependencies
3. Runs tests
4. Builds Next.js (standalone output)
5. Compiles Electron TypeScript
6. Packages with electron-builder
7. Uploads installers to GitHub Releases

## Architecture

The desktop app wraps the Next.js application in Electron:

```
┌─ Electron Shell ────────────────────────────┐
│                                             │
│  ┌─ Main Process ────────────────────────┐  │
│  │ electron/main.ts                      │  │
│  │ - App lifecycle                       │  │
│  │ - BrowserWindow management            │  │
│  │ - Spawns Next.js standalone server    │  │
│  │ - Encrypted config storage            │  │
│  │ - IPC handlers (save/load config)     │  │
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

In **production mode**: Electron spawns the standalone Next.js server from bundled resources and loads `http://localhost:3456`.

## Resetting Configuration

To reconfigure the MongoDB connection, delete the config file at the path listed above, or use the developer tools console in the Electron window to call `window.electronAPI.resetConfig()`.
