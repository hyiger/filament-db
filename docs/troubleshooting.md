# Troubleshooting

[< Back to README](../README.md)

## "MongoServerError: bad auth" when running seed script

Your MongoDB Atlas username or password is incorrect. Double-check the credentials in `.env.local`. If your password contains special characters (`@`, `#`, `%`, etc.), URL-encode them. For example, `p@ssword` becomes `p%40ssword`.

## "MongoNetworkError: connection timed out"

Your IP address is not whitelisted in MongoDB Atlas. Go to **Security > Network Access** in the Atlas dashboard and add your current IP address.

## Seed script says "0 filament profiles parsed"

The INI file might not contain custom filament profiles, or the file path is incorrect. Verify the file contains `[filament:...]` sections by opening it in a text editor.

## Port 3456 already in use

Another process is using port 3456. Either stop that process or run on a different port:

```bash
npm run dev -- -p 3001
```

## Tests fail with "MongoMemoryServer" error

The first run may need to download the MongoDB binary. Ensure you have internet access and try again. On CI, the binary is cached after the first run.

## Desktop app: offline/hybrid mode fails on first launch without internet

The embedded local database (`mongodb-memory-server-core`) downloads the `mongod` binary on first use. This one-time download requires internet access. After the first successful launch, the binary is cached and no internet is needed for offline mode. If your first launch is in a fully offline environment, run the app once with internet access to prime the cache, then disconnect.

## "MONGODB_URI environment variable is not set" when running seed script

The seed script requires `MONGODB_URI` to be set. Either:

1. Create a `.env.local` file (see [Setup Guide](setup.md))
2. Pass it inline:
   ```bash
   MONGODB_URI="mongodb+srv://..." npx tsx scripts/seed.ts
   ```

## Filament detail page shows "Loading..." indefinitely

Check the browser console for errors. Common causes:
- MongoDB Atlas connection is down or credentials are wrong
- Network access is restricted in MongoDB Atlas

If the filament ID in the URL doesn't exist, the page will show "Filament not found" instead of loading forever.

## INI export is missing some filaments

Each filament is exported as a single `[filament:Name]` section regardless of calibrations. Calibration values (EM, pressure advance, max volumetric speed, retraction) are not baked into the INI — they are applied dynamically at print time via the `/api/filaments/{id}/calibration` endpoint (used by the PrusaSlicer fork). If a filament is missing from the export, check that it has a name and is not soft-deleted.

## "Blocked cross-origin request" in dev mode

If you access the dev server from a hostname other than `localhost` (e.g. `http://myhost.local:3456`), Next.js blocks the hot-reload WebSocket connection. Add your hostname to `ALLOWED_DEV_ORIGINS` in `.env.local`:

```
ALLOWED_DEV_ORIGINS=myhost.local
```

Multiple hostnames can be comma-separated. Restart the dev server after changing this value. This only affects development — production builds are not affected.

## Desktop app: macOS app hangs or won't open after installation

macOS Gatekeeper blocks the app because it is not notarized with an Apple Developer ID. Remove the quarantine flag by running in Terminal:

```bash
xattr -cr "/Applications/Filament DB.app"
```

You only need to do this once after installing or updating the app.

## Desktop app: setup wizard keeps appearing

The MongoDB connection string may not be saving. Check that the config directory is writable:
- **macOS**: `~/Library/Application Support/filament-db/`
- **Windows**: `%APPDATA%/filament-db/`
- **Linux**: `~/.config/filament-db/`

## Desktop app: blank screen after setup

The internal Next.js server may not have started. Try these steps:

1. Quit and reopen the app
2. Check that your MongoDB Atlas IP whitelist includes your current IP address
3. Run the app from a terminal to see error output:
   - **macOS**: `"/Applications/Filament DB.app/Contents/MacOS/Filament DB"`
   - **Linux**: run the AppImage directly from terminal
   - **Windows**: run from Command Prompt
4. If you see "Cannot find module" errors, the build may be incomplete -- download the latest release

## Desktop app: "electron:dev" fails on Windows

Make sure `concurrently` and `wait-on` are installed. Run `npm install` to ensure all dev dependencies are present. If `wait-on` hangs, try running `npm run dev` and `npx electron .` in separate terminals.

## Desktop app: how to reset the saved connection string

Delete the config file at the paths listed above, or open the developer console in the Electron window (View > Toggle Developer Tools) and run `window.electronAPI.resetConfig()`.

## Desktop app: status indicator shows "Offline" even though I have internet

In **Atlas mode**, the status indicator pings Atlas directly every 60 seconds, so it reflects actual Atlas reachability. In **hybrid mode**, the indicator tracks sync cycle results. In the **web app**, it falls back to the browser's `navigator.onLine` API, which can occasionally report false negatives (e.g., on captive portal networks). In hybrid mode, click the status pill and try **Sync Now** to manually test the Atlas connection.

## Desktop app: sync conflicts — wrong version won

Sync uses **last-write-wins** based on the `updatedAt` timestamp. If you edited the same filament on two devices, the most recent save wins. There is no per-field merge — the entire document is replaced. To avoid conflicts, try to edit a given filament on only one device at a time.

## Desktop app: "Offline — using local data" in Atlas mode

Atlas was unreachable when the app started, so it automatically fell back to an embedded local database. Your data is safe locally. Once Atlas becomes reachable, the app will sync automatically. You can also click the status pill and use **Sync Now** to trigger a manual sync.

## Desktop app: how to switch connection modes

Run `window.electronAPI.resetConfig()` in the developer console (View > Toggle Developer Tools). This returns you to the setup wizard where you can choose a different mode.
