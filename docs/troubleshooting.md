# Troubleshooting

## "MongoServerError: bad auth" when running seed script

Your MongoDB Atlas username or password is incorrect. Double-check the credentials in `.env.local`. If your password contains special characters (`@`, `#`, `%`, etc.), URL-encode them. For example, `p@ssword` becomes `p%40ssword`.

## "MongoNetworkError: connection timed out"

Your IP address is not whitelisted in MongoDB Atlas. Go to **Security > Network Access** in the Atlas dashboard and add your current IP address.

## Seed script says "0 filament profiles parsed"

The INI file might not contain custom filament profiles, or the file path is incorrect. Verify the file contains `[filament:...]` sections by opening it in a text editor.

## Port 3000 already in use

Another process is using port 3000. Either stop that process or run on a different port:

```bash
npm run dev -- -p 3001
```

## Tests fail with "MongoMemoryServer" error

The first run may need to download the MongoDB binary. Ensure you have internet access and try again. On CI, the binary is cached after the first run.

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

Filaments with per-nozzle calibrations are exported as separate sections per nozzle (e.g., `[filament:Name 0.4mm]`). The original filament name without a nozzle suffix will not appear if it has calibrations. Filaments without calibrations export normally.

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
