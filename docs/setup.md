# Setup Guide

[< Back to README](../README.md)

## Option 1: Desktop App (easiest)

Download the latest installer for your platform from [GitHub Releases](https://github.com/hyiger/filament-db/releases):

- **macOS (Apple Silicon)**: `FilamentDB-x.x.x-mac-arm64.dmg`
- **macOS (Intel)**: `FilamentDB-x.x.x-mac-x64.dmg`
- **Windows**: `FilamentDB-x.x.x-windows-x64-setup.exe`
- **Linux x64**: `FilamentDB-x.x.x-linux-x86_64.AppImage` or `FilamentDB-x.x.x-linux-amd64.deb`
- **Linux arm64** (Raspberry Pi 5): `FilamentDB-x.x.x-linux-arm64.AppImage` or `FilamentDB-x.x.x-linux-arm64.deb`

On first launch, you'll be prompted to choose a connection mode:

- **MongoDB Atlas (Cloud)** — connect to a cloud database. Requires a MongoDB Atlas account and internet connection.
- **Hybrid (Local + Cloud Sync)** — store data locally with automatic background sync to Atlas. Works offline and syncs when internet is available. *Recommended for most users.*
- **Local Only (Offline)** — all data stored on your computer. No cloud account or internet needed. You can switch to hybrid mode later.

For Atlas and Hybrid modes, you'll need a MongoDB Atlas connection string. See [Setting Up MongoDB Atlas](#setting-up-mongodb-atlas-free-tier) below if you don't have an account yet.

## Option 2: Docker

Run Filament DB as a Docker container. The image is ~72MB, built on `node:22-alpine`, and supports both `linux/amd64` and `linux/arm64` (Raspberry Pi).

> **Note:** The Docker image runs the web app only. NFC tag reading/writing (OpenPrintTag, Bambu, and OpenTag3D) requires the [desktop app](#option-1-desktop-app-easiest) for direct USB hardware access.

### Quick Start

```bash
docker run -p 127.0.0.1:3456:3000 \
  -e MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/filament-db" \
  ghcr.io/hyiger/filament-db
```

Open http://localhost:3456.

> **Security:** the `127.0.0.1:` prefix binds the port to **this machine only**. A bare `-p 3456:3000` publishes on **all** host interfaces, exposing Filament DB's API to your whole LAN — and the API is **unauthenticated by default**. Only drop the `127.0.0.1:` prefix if you intend to reach it from other devices, and read [Securing a network-exposed instance](#securing-a-network-exposed-instance) first.

### Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  filament-db:
    image: ghcr.io/hyiger/filament-db
    ports:
      # Loopback-only — reachable from this host. To reach it from other
      # devices, use "3456:3000" and read "Securing a network-exposed instance".
      - "127.0.0.1:3456:3000"
    environment:
      - MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/filament-db
      # Optional: AI provider for TDS extraction (choose one)
      # - GEMINI_API_KEY=your-key
      # - ANTHROPIC_API_KEY=your-key
      # - OPENAI_API_KEY=your-key
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Docker Compose with Local MongoDB

If you don't have a MongoDB Atlas account, you can run MongoDB alongside Filament DB:

```yaml
services:
  filament-db:
    image: ghcr.io/hyiger/filament-db
    ports:
      # Loopback-only (see the note above). Use "3456:3000" to expose on the LAN.
      - "127.0.0.1:3456:3000"
    environment:
      - MONGODB_URI=mongodb://mongo:27017/filament-db
    depends_on:
      - mongo
    restart: unless-stopped

  mongo:
    image: mongo:8
    volumes:
      - mongo-data:/data/db
    restart: unless-stopped

volumes:
  mongo-data:
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` | Yes | MongoDB connection string |
| `PORT` | No | Server port inside the container (default: `3000`) |
| `HOSTNAME` | No | Interface the server binds inside the container (default: `0.0.0.0`). Reachability is governed by the `docker run -p` mapping, not this. |
| `TZ` | No | IANA timezone for the container clock, e.g. `America/Los_Angeles` (defaults to UTC). The image bundles `tzdata`, so a zone name resolves correctly. |
| `FILAMENTDB_API_KEY` | No | Bearer-token gate on **every** `/api/*` request. See [Securing a network-exposed instance](#securing-a-network-exposed-instance). **Note:** it disables the browser web UI — use it only for non-browser clients (mobile app, slicers, scripts). |
| `GEMINI_API_KEY` | No | Google Gemini API key for TDS extraction |
| `ANTHROPIC_API_KEY` | No | Anthropic Claude API key for TDS extraction |
| `OPENAI_API_KEY` | No | OpenAI API key for TDS extraction |
| `ALLOWED_DEV_ORIGINS` | No | Comma-separated hostnames allowed to access the dev server (e.g. `myhost.local`) |

### Securing a network-exposed instance

Filament DB's trust model is **localhost / single-user**: by default the API is **unauthenticated**, which is fine when the port is bound to loopback (`127.0.0.1:`) or you're using the desktop app. Publishing it to the LAN (a bare `-p 3456:3000`, or a headless service binding `0.0.0.0`) exposes the full `/api` surface to every device on the network.

You have two ways to secure an exposed instance, depending on **who** needs to reach it:

- **Non-browser clients only** (the [mobile companion app](../packages/mobile/README.md), PrusaSlicer/OrcaSlicer integrations, scripts) — set `FILAMENTDB_API_KEY` to a strong random value. Every `/api/*` request must then send `Authorization: Bearer <key>`; the mobile app and the slicer integrations support this. **Generate the key once, save it, and reuse that exact value** — your clients need it, and it must stay the same across restarts (don't generate it inline, or it changes every run and nothing can authenticate):

  ```bash
  # 1. Generate a key once and copy it (paste this into the mobile app / slicer):
  openssl rand -hex 32

  # 2. Run with that saved value:
  docker run -p 3456:3000 \
    -e MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/filament-db" \
    -e FILAMENTDB_API_KEY="<paste-the-generated-key>" \
    ghcr.io/hyiger/filament-db
  ```

  > **The bearer gate is all-or-nothing and disables the first-party browser web UI.** The web UI makes plain same-origin requests and does not attach the key, so with `FILAMENTDB_API_KEY` set the UI loads but every call returns `401`. There is deliberately no same-origin exemption (those request signals are forgeable). Use the key only when the browser UI isn't how you'll access this instance.

- **Browser web-UI access over the LAN** — do **not** rely on `FILAMENTDB_API_KEY` (it breaks the UI, above). Instead either keep the port on loopback and use the desktop app, or put Filament DB behind an **authenticating reverse proxy** (nginx/Caddy/Authelia with basic-auth, SSO, or mTLS) that terminates auth before the request reaches the app. When you use a reverse proxy, **bind Filament DB itself to loopback** (`-p 127.0.0.1:3456:3000` for Docker, `HOSTNAME=127.0.0.1` for the systemd service) or firewall its direct port — otherwise the app stays reachable at `http://<host>:3456` and browser users bypass the proxy straight to the unauthenticated API. The proxy must be the only way in.

  > **Configure the proxy to preserve the original `Host` header (with its port).** The app's CSRF guard compares a request's `Origin` against its `Host`. A proxy that rewrites `Host` to the upstream address (e.g. nginx's bare `proxy_pass`, which sends `Host: 127.0.0.1:3000`) makes browser requests look cross-origin, so they're rejected with a `403`. **This affects normal modern-browser mutations** (create/edit/delete), not just edge cases — browsers send `Origin` on same-origin `POST`/`PUT`/`PATCH`/`DELETE`, and the guard compares it to `Host` regardless of `Sec-Fetch` metadata. For nginx use `proxy_set_header Host $http_host;` — **`$http_host`, not `$host`**: `$host` drops the port, so an instance served on `http://box:3456` would forward `Host: box` and the guard's port comparison would still `403`. Also add `proxy_set_header X-Forwarded-Proto $scheme;`. Caddy's `reverse_proxy` preserves the full `Host` by default.

### Building from Source

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
docker build -t filament-db .
docker run -p 127.0.0.1:3456:3000 -e MONGODB_URI="mongodb+srv://..." filament-db
```

---

## Option 3: Run from Source

### Prerequisites

- **Node.js** v20 or later
- **npm** (included with Node.js)
- **Git**
- A **MongoDB** database (Atlas free tier, or local MongoDB installation)

### Installing Node.js

#### macOS

Using Homebrew (recommended):

```bash
brew install node
```

Or download the installer from https://nodejs.org/

#### Linux (Ubuntu/Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### Linux (Fedora/RHEL)

```bash
sudo dnf install nodejs
```

#### Windows

Download and run the installer from https://nodejs.org/ (LTS version recommended).

Or using winget:

```powershell
winget install OpenJS.NodeJS.LTS
```

Or using Chocolatey:

```powershell
choco install nodejs-lts
```

After installing, verify on any platform:

```bash
node --version
npm --version
```

### Clone and Install

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
npm install
```

### Configure Environment (web app only)

When running as a web app (not the desktop app), create a `.env.local` file:

#### macOS / Linux

```bash
cp .env.example .env.local
```

#### Windows (PowerShell)

```powershell
Copy-Item .env.example .env.local
```

Then edit `.env.local` with your MongoDB connection string and optionally an AI API key for TDS extraction:

```
MONGODB_URI=mongodb+srv://youruser:yourpassword@yourcluster.mongodb.net/filament-db?appName=Filaments

# Optional: AI provider for TDS extraction (choose one)
GEMINI_API_KEY=your-gemini-key
# ANTHROPIC_API_KEY=your-claude-key
# OPENAI_API_KEY=your-openai-key
```

The AI API key enables the "Import from TDS" feature, which uses AI to extract filament properties from Technical Data Sheets. You can also configure this in the Settings page instead of using environment variables.

If you access the dev server from another device on your network (e.g. a Raspberry Pi at `myhost.local`), add the hostname to allow cross-origin dev requests:

```
ALLOWED_DEV_ORIGINS=myhost.local
```

Multiple hostnames can be comma-separated (e.g. `myhost.local,other.local`).

> **Note:** If your password contains special characters (`@`, `#`, `%`, etc.), you must URL-encode them. For example, `p@ssword` becomes `p%40ssword`.

> **Note:** The desktop app does not use `.env.local` -- it prompts for the connection string on first launch and stores it in a locally persisted config file (see [Desktop App](desktop.md) for storage locations). In offline and hybrid modes, the desktop app runs an embedded local MongoDB instance automatically.

### Running

#### Web App

```bash
npm run dev                   # development at http://localhost:3456
npm run build && npm start    # production at http://localhost:3000 (set PORT=3456 to match dev)
```

`npm start` first runs `start:prep` (copies `.next/static` and `public/` into the standalone output) and then the standalone server entrypoint (`node .next/standalone/server.js`) — `next start` is not compatible with the `output: "standalone"` build mode the project uses for Docker and Electron packaging.

#### Desktop App (from source)

```bash
npm run electron:dev          # development mode
npm run electron:build        # build installer for your platform
```

> **Port:** `npm run dev` and the desktop app run on port **3456**. Docker exposes port 3000 internally, mapped to 3456 on the host via `-p 3456:3000`. `npm start` (production) defaults to port **3000** unless `PORT=3456` is set. The desktop app also respects the `PORT` environment variable. [PrusaSlicer Filament Edition](https://github.com/hyiger/PrusaSlicer) defaults to `http://localhost:3456`.

---

## Running as a Linux Service

You can run Filament DB as a systemd service so it starts automatically on boot. This is useful for headless servers or a Raspberry Pi that serves as a dedicated filament database on your network.

These instructions assume you installed the `.deb` package from [GitHub Releases](https://github.com/hyiger/filament-db/releases). If running from source, adjust the paths accordingly (`WorkingDirectory` to your repo's `.next/standalone/` and `ExecStart` to `node server.js`).

### 1. Configure environment

Create or edit `/opt/Filament DB/.env` with your MongoDB connection string:

```bash
sudo tee "/opt/Filament DB/.env" > /dev/null <<'EOF'
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/filament-db?appName=Filaments
PORT=3456
HOSTNAME=0.0.0.0
EOF
sudo chmod 600 "/opt/Filament DB/.env"
```

`HOSTNAME=0.0.0.0` makes the server listen on all network interfaces so other devices on your network can reach it.

> **Security:** binding `0.0.0.0` exposes the **unauthenticated** `/api` surface to everyone on your network. Before doing this, read [Securing a network-exposed instance](#securing-a-network-exposed-instance) — set `FILAMENTDB_API_KEY` if only non-browser clients (the mobile app, slicers) need access, or front the service with an authenticating reverse proxy if you want the browser UI on the LAN (the key disables the web UI). If you go the reverse-proxy route, set `HOSTNAME=127.0.0.1` here (not `0.0.0.0`) — or firewall port 3456 — so the app is reachable only through the proxy; otherwise browser users can hit `http://<host>:3456` directly and bypass it.

> **Note:** If you're running the desktop app instead of a headless service, you don't need to set `HOSTNAME` by hand — flip on the **Share on local network** toggle in Settings (electron-store key `exposeToLan`, off by default) and the embedded server binds `0.0.0.0` for you. It pairs with mDNS auto-discovery, so the mobile companion app can find your instance on the network without typing a URL.

### 2. Create the service

```bash
sudo tee /etc/systemd/system/filament-db.service > /dev/null <<'EOF'
[Unit]
Description=Filament DB
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/opt/Filament DB/resources/app/standalone
ExecStart=/usr/bin/node server.js
EnvironmentFile=/opt/Filament DB/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Replace `your-username` with your Linux user account.

### 3. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable filament-db
sudo systemctl start filament-db
```

The web app will now be available at `http://<hostname>:3456` and will start automatically on boot.

### Useful commands

```bash
sudo systemctl status filament-db      # check service status
sudo systemctl restart filament-db      # restart after an upgrade
sudo systemctl stop filament-db         # stop the service
journalctl -u filament-db -f            # tail the logs
```

### Using NFC alongside the service

The desktop app includes NFC tag read/write support (OpenPrintTag, Bambu, and OpenTag3D) which requires direct USB access to an NFC reader. Since the web service and desktop app both start a Next.js server, run the desktop app on a different port so the web service stays available to PrusaSlicer and other network clients:

```bash
PORT=3457 "/opt/Filament DB/filament-db"
```

Or create a convenience script:

```bash
cat > ~/nfc.sh <<'SCRIPT'
#!/bin/bash
echo "Starting Filament DB desktop for NFC (port 3457)..."
echo "Web service stays running on port 3456."
PORT=3457 "/opt/Filament DB/filament-db"
SCRIPT
chmod +x ~/nfc.sh
```

Then run `~/nfc.sh` whenever you need NFC. The web service continues running on port 3456 uninterrupted.

### Upgrading

After installing a new `.deb` release, restart the service to pick up the changes:

```bash
sudo dpkg -i FilamentDB-x.x.x-linux-arm64.deb
sudo systemctl restart filament-db
```

---

## Connection Modes (Desktop App)

The desktop app supports three connection modes:

### Atlas (Cloud)

- All data stored in MongoDB Atlas
- Requires internet connection at all times
- If Atlas is unreachable on startup, the app automatically falls back to a local database and syncs when the connection is restored

### Hybrid (Local + Cloud Sync)

- Data stored locally in an embedded MongoDB instance
- Automatic bidirectional sync with Atlas when connected
- Works fully offline — syncs automatically when internet returns
- Sync uses last-write-wins conflict resolution based on timestamps
- Manual "Sync Now" button available in the status indicator
- Sync runs every 5 minutes when Atlas is reachable
- **What gets synced**: nozzles, printers, locations, bedtypes, filaments (with embedded spools), printhistories, sharedcatalogs — all with cross-DB ref remap so calibrations, AMS slots, and spool/filament references stay consistent on both sides. Soft-deletes (`_deletedAt`) propagate so an undo on one peer doesn't get resurrected by the other.
- **Spool subdocument limitation**: spool ids inside Filament don't have stable cross-side identifiers, so `printer.amsSlots[].spoolId` and `printhistory.usage[].spoolId` are cleared on cross-side remap. Per-filament gram totals still reconcile correctly; per-spool attribution of which spool was loaded / consumed is dropped.

### Local Only (Offline)

- All data stored locally, no cloud connection
- No MongoDB Atlas account needed
- Can be switched to Hybrid mode later by resetting the configuration (see [Troubleshooting](troubleshooting.md#desktop-app-how-to-switch-connection-modes))

---

## Setting Up MongoDB Atlas (Free Tier)

1. Go to https://www.mongodb.com/cloud/atlas/register and create a free account.

2. **Create a cluster:**
   - Click **"Build a Database"**
   - Select **M0 Free** tier
   - Choose a cloud provider and region close to you
   - Name your cluster (e.g., `Filaments`)
   - Click **"Create Deployment"**

3. **Create a database user:**
   - In the setup wizard, enter a username and password
   - **Built-in role**: pick `Read and write to any database` (or scope to your specific database). The app needs `readWrite` on the target DB — if the user is read-only, the desktop will show a clear sync error pointing you back to Settings → Connection (instead of leaking the raw `user is not allowed to do action [update]` driver text).
   - Click **"Create Database User"**
   - Save these credentials -- you will need them for the connection string

4. **Configure network access:**
   - In the setup wizard (or under **Security > Network Access**), click **"Add IP Address"**
   - For development, click **"Allow Access from Anywhere"** (adds `0.0.0.0/0`)
   - For production, add only your server's IP address
   - Click **"Confirm"**

5. **Get your connection string:**
   - Click **"Connect"** on your cluster
   - Select **"Drivers"**
   - Copy the connection string. It looks like:
     ```
     mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?appName=<appName>
     ```
   - Replace `<username>` and `<password>` with the credentials from step 3
   - Add `/filament-db` before the `?` to specify the database name:
     ```
     mongodb+srv://<username>:<password>@<cluster>.mongodb.net/filament-db?appName=Filaments
     ```
