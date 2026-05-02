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

> **Note:** The Docker image runs the web app only. NFC tag reading/writing requires the [desktop app](#option-1-desktop-app-easiest) for direct USB hardware access.

### Quick Start

```bash
docker run -p 3456:3000 \
  -e MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/filament-db" \
  ghcr.io/hyiger/filament-db
```

Open http://localhost:3456.

### Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  filament-db:
    image: ghcr.io/hyiger/filament-db
    ports:
      - "3456:3000"
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
      - "3456:3000"
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
| `GEMINI_API_KEY` | No | Google Gemini API key for TDS extraction |
| `ANTHROPIC_API_KEY` | No | Anthropic Claude API key for TDS extraction |
| `OPENAI_API_KEY` | No | OpenAI API key for TDS extraction |
| `ALLOWED_DEV_ORIGINS` | No | Comma-separated hostnames allowed to access the dev server (e.g. `myhost.local`) |

### Building from Source

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
docker build -t filament-db .
docker run -p 3456:3000 -e MONGODB_URI="mongodb+srv://..." filament-db
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

The desktop app includes NFC tag read/write support which requires direct USB access to an NFC reader. Since the web service and desktop app both start a Next.js server, run the desktop app on a different port so the web service stays available to PrusaSlicer and other network clients:

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
