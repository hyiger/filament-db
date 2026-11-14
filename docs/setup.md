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

> **Security:** the `127.0.0.1:` prefix binds the port to **this machine only**. A bare `-p 3456:3000` publishes on **all** host interfaces, exposing Filament DB's API to your whole LAN, and this port is **unauthenticated**. To reach Filament DB from other devices, keep the prefix and turn on the secure gateway (HTTPS + API key) instead: see [Securing a network-exposed instance](#securing-a-network-exposed-instance).

### Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  filament-db:
    image: ghcr.io/hyiger/filament-db
    ports:
      # Loopback-only: the open HTTP port, for this host.
      - "127.0.0.1:3456:3000"
      # Optional: HTTPS + API key for other devices (needs FILAMENTDB_HTTPS_PORT
      # below). See "Securing a network-exposed instance".
      # - "3443:3443"
    environment:
      - MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/filament-db
      # Optional: the secure gateway. Also uncomment the "3443:3443" port above
      # and BOTH volumes blocks below (they keep the generated key + certificates).
      # - FILAMENTDB_HTTPS_PORT=3443
      # - FILAMENTDB_TLS_HOSTS=192.168.1.10,nas.local
      # Optional: AI provider for TDS extraction (choose one)
      # - GEMINI_API_KEY=your-key
      # - ANTHROPIC_API_KEY=your-key
      # - OPENAI_API_KEY=your-key
    # volumes:
    #   - filamentdb-data:/data
    restart: unless-stopped

# volumes:
#   filamentdb-data:
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
      # Loopback-only (see the note above). For other devices, add the secure
      # gateway as in the previous example rather than publishing this port.
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
| `FILAMENTDB_HTTPS_PORT` | No | Turns on the **secure gateway**: a second port that speaks HTTPS and requires an API key, for access from other devices. The HTTP port stays open for this machine. See [Securing a network-exposed instance](#securing-a-network-exposed-instance). |
| `FILAMENTDB_HTTPS_HOST` | No | Interface the secure gateway binds (default: `0.0.0.0`). |
| `FILAMENTDB_API_KEY` | No | The API key. With the secure gateway running: the gateway's key, which must be 32 to 512 characters (unset, a random one is generated and can be rolled in Settings). Otherwise: a bearer-token gate on **every** `/api/*` request of the HTTP port, which also disables the browser web UI. |
| `FILAMENTDB_SECURE_DIR` | No | Where the secure gateway keeps its generated API key and certificates. Image default: `/data/secure` (mount a volume at `/data` to keep them). Otherwise `~/.filament-db/secure` of the user the server runs as; for a system service, set an absolute path that user can write to. |
| `FILAMENTDB_TLS_CERT`, `FILAMENTDB_TLS_KEY` | No | Absolute paths of the PEM files of your own certificate for the secure gateway. Unset, it generates a local certificate authority and server certificate. |
| `FILAMENTDB_TLS_HOSTS` | No | Extra comma-separated DNS names and IP addresses for the generated certificate, e.g. `192.168.1.10,nas.local`. Needed in a container, which cannot see its host's address. |
| `GEMINI_API_KEY` | No | Google Gemini API key for TDS extraction |
| `ANTHROPIC_API_KEY` | No | Anthropic Claude API key for TDS extraction |
| `OPENAI_API_KEY` | No | OpenAI API key for TDS extraction |
| `ALLOWED_ORIGINS` | No | Comma-separated full origins (e.g. `https://dash.example.com,http://10.0.0.5:8123`) whose browser pages may call `/api/*` cross-origin. Works in production. See [Calling the API from another web origin (CORS)](#calling-the-api-from-another-web-origin-cors). |
| `ALLOWED_DEV_ORIGINS` | No | Comma-separated hostnames allowed to access the **dev** server (e.g. `myhost.local`). Dev-only, and not CORS: use `ALLOWED_ORIGINS` for that. |

### Securing a network-exposed instance

Filament DB's trust model is **localhost / single-user**: the HTTP port has **no authentication**. That is right while the port is bound to loopback (`127.0.0.1:`) or you use the desktop app, and wrong the moment it is published to a network (a bare `-p 3456:3000`, or a service binding `0.0.0.0`): every device that can reach it can read and change everything.

To reach Filament DB from other devices, leave the HTTP port where it is and turn on the **secure gateway**: a second port that speaks HTTPS and requires an API key.

| Port | Speaks | For | Key |
|------|--------|-----|-----|
| HTTP (`PORT`; `3000` in the container) | plain HTTP | this machine: the browser on it, a slicer on it | none |
| HTTPS (`FILAMENTDB_HTTPS_PORT`) | TLS | every other device: phones, other computers, scripts | required |

One port cannot do both jobs. The server has no trustworthy way to tell a local request from a remote one (every header that could say so can be set by the client), so "open for me, locked for everyone else" takes two ports.

#### Turning it on

```bash
docker run \
  -p 127.0.0.1:3456:3000 \
  -p 3443:3443 \
  -v filamentdb-data:/data \
  -e MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/filament-db" \
  -e FILAMENTDB_HTTPS_PORT=3443 \
  -e FILAMENTDB_TLS_HOSTS="192.168.1.10,nas.local" \
  ghcr.io/hyiger/filament-db
```

- `-p 127.0.0.1:3456:3000` keeps the open HTTP port on this machine. `-p 3443:3443` publishes the secure port to the network.
- `-v filamentdb-data:/data` keeps the API key and certificates. **Without a volume, a new key and a new certificate authority are generated every time the container is re-created**, and every device has to be set up again.
- `FILAMENTDB_TLS_HOSTS` lists the names and addresses other devices will type. A container cannot see its host's address, so the generated certificate would otherwise only name addresses nobody outside the container can use.

For a service started with `npm start` or systemd, set the same variables in its environment and bind the HTTP port to loopback with `HOSTNAME=127.0.0.1`.

> **While the gateway is running, the HTTP port needs no key, even if `FILAMENTDB_API_KEY` is set.** Keep that port on loopback, or don't publish it at all on a machine nobody browses from. The server logs a reminder at every start. If the gateway cannot start (a port already in use, an unreadable certificate), the server logs why, **Settings → Network** shows it, and a `FILAMENTDB_API_KEY` you set goes on gating the HTTP port.

The server needs to write to `/data`. A named volume, as above, works as is. A bind-mounted host directory must be writable by uid `1001`, the user the container runs as.

#### The API key

On first start the server generates a random 256-bit key and stores it in `/data/secure/api-key`, readable only by the server's user.

- **See it:** open Filament DB on the server itself (`http://localhost:3456`) and go to **Settings → Network**, or run `docker exec <container> cat /data/secure/api-key`.
- **Roll it:** **Settings → Network → Roll key…** replaces it with a new random key. The change is immediate and needs no restart: the old key stops working, and every browser signed in with it is signed out.
- **Choose it yourself:** set `FILAMENTDB_API_KEY` to at least 32 characters (`openssl rand -hex 32`). That key cannot be rolled from the app; change the variable and restart. A shorter key is refused and the gateway does not start: nothing locks out a client that keeps guessing, so the key's length is the protection.

After ten wrong keys in a minute from one address, further wrong keys from it are answered `429` for the rest of that minute. The right key is never refused, so one device retrying an old key cannot lock out the others behind the same address.

#### Connecting

- **Scripts, the mobile app, any API client** send the key with every request:

  ```bash
  curl --cacert filament-db-ca.crt \
    -H "Authorization: Bearer <key>" \
    https://192.168.1.10:3443/api/filaments
  ```

- **A browser** opening `https://192.168.1.10:3443` gets a sign-in page that asks for the key once. The session lasts 30 days, or until the key is rolled. **Settings → Network → Sign out of this browser** ends it.

#### The certificate

Unless you provide one, the server generates a **local certificate authority (CA)** and a server certificate signed by it. A device shows a certificate warning until it trusts that CA:

1. Download the CA certificate: **Settings → Network → Download the certificate authority**, or from another device `http://192.168.1.10:3443/__filamentdb/ca.crt`. (The secure port answers plain HTTP for exactly two things: this download, and redirecting a mistyped `http://` address to `https://`. It never serves the app over plain HTTP.)
2. Check that its SHA-256 fingerprint matches the one in **Settings → Network**. A certificate is public, so downloading it over plain HTTP is safe as long as the fingerprint matches.
3. Install it. **macOS:** open the file, add it to Keychain Access, and set it to *Always Trust*. **Windows:** install it into *Trusted Root Certification Authorities*. **iOS:** install the profile, then turn it on under *Settings → General → About → Certificate Trust Settings*. **Android:** *Settings → Security → Install a certificate → CA certificate*.

The CA is valid for ten years. The server certificate is reissued automatically, before it expires and whenever the machine's address changes, without devices noticing.

> **Android apps do not trust a CA you install yourself unless the app opts in**, and the current Filament DB mobile app does not. Android browsers do. For the mobile app on Android, use your own certificate from a public CA (below) for now.

**Your own certificate.** Mount the PEM files and name them by absolute path:

```bash
  -v /srv/filament-db/certs:/certs:ro \
  -e FILAMENTDB_TLS_CERT=/certs/fullchain.pem \
  -e FILAMENTDB_TLS_KEY=/certs/privkey.pem \
```

A certificate from a public CA (Let's Encrypt, Tailscale's `tailscale cert`) needs no setup on the other devices. A renewed file is picked up within ten minutes, without a restart. The key file must not be passphrase-protected, and both files must be readable by uid `1001`.

> **Let's Encrypt:** the files under `/etc/letsencrypt/live/<domain>/` are symlinks into `../../archive`, and `privkey.pem` is readable by root only. Mounting the `live/<domain>` directory alone gives the container dangling links. Copy `fullchain.pem` and `privkey.pem` to a directory of their own from a renewal hook (`--deploy-hook`), make them readable by uid `1001`, and mount that directory.

#### Without the gateway: the key on the HTTP port

Setting `FILAMENTDB_API_KEY` **without** `FILAMENTDB_HTTPS_PORT` keeps the older arrangement: every `/api/*` request on the HTTP port must send `Authorization: Bearer <key>`.

> **This gate is all-or-nothing and disables the first-party browser web UI.** The web UI makes plain same-origin requests and does not attach the key, so the UI loads but every call returns `401`. It also sends the key unencrypted. Use it only for non-browser clients on a network you trust; otherwise use the secure gateway.

#### Behind your own reverse proxy

If you already run nginx, Caddy or Authelia, you can let it terminate TLS and authenticate instead. **Bind Filament DB itself to loopback** (`-p 127.0.0.1:3456:3000` for Docker, `HOSTNAME=127.0.0.1` for the systemd service) or firewall its port; otherwise the app stays reachable at `http://<host>:3456` and users bypass the proxy. The proxy must be the only way in.

> **Configure the proxy to preserve the original `Host` header (with its port).** The app's CSRF guard compares a request's `Origin` against its `Host`. A proxy that rewrites `Host` to the upstream address (e.g. nginx's bare `proxy_pass`, which sends `Host: 127.0.0.1:3000`) makes browser requests look cross-origin, so they're rejected with a `403`. **This affects normal modern-browser mutations** (create/edit/delete), not just edge cases: browsers send `Origin` on same-origin `POST`/`PUT`/`PATCH`/`DELETE`, and the guard compares it to `Host` regardless of `Sec-Fetch` metadata. For nginx use `proxy_set_header Host $http_host;` (**`$http_host`, not `$host`**: `$host` drops the port, so an instance served on `http://box:3456` would forward `Host: box` and the guard's port comparison would still `403`). Also add `proxy_set_header X-Forwarded-Proto $scheme;`. Caddy's `reverse_proxy` preserves the full `Host` by default.

### Calling the API from another web origin (CORS)

A web page served from a different origin (a dashboard, a home-automation panel) can only read Filament DB's API if the server answers with CORS headers, and by default it doesn't: browsers block those reads, and the app's CSRF guard refuses cross-origin mutations with a `403`. To allow specific origins, set `ALLOWED_ORIGINS` to a comma-separated list of **full origins**: scheme, host, and port when it isn't the default.

```bash
docker run -p 3456:3000 \
  -e MONGODB_URI="..." \
  -e ALLOWED_ORIGINS="https://dash.example.com,http://10.0.0.5:8123" \
  ghcr.io/hyiger/filament-db
```

For a listed origin, `/api/*` answers preflight (`OPTIONS`) requests and adds `Access-Control-Allow-Origin` to every response, and the CSRF guard accepts its mutations. The page may send the `Authorization` and `Content-Type` request headers; credentials (cookies) are not used.

> **A listed origin is trusted like the app's own UI.** On the open HTTP port, any page served from it can read and change everything, including wiping or restoring the database. List only origins you control. To require a key as well, have the page call the secure gateway's `https://` address (or, without the gateway, set `FILAMENTDB_API_KEY`) and send `Authorization: Bearer <key>`.

`*` and bare hostnames (`dash.example.com`) are ignored, with a warning in the server log. A wildcard would open the unauthenticated API to every web page you visit. Label printing (`POST /api/labels/print`) stays unavailable to cross-origin pages: its print-token header is not on the allowed list. `ALLOWED_DEV_ORIGINS` is unrelated: it only lets another hostname load the Next.js dev server.

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

- **Node.js** v22.13 or later on the 22 line, or v24 or later. Node 20 is end-of-life, and Node 23 isn't supported by the test and lint tools.
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

> **Security:** binding `0.0.0.0` exposes the **unauthenticated** HTTP port to everyone on your network. To reach the service from other devices, set `HOSTNAME=127.0.0.1` here and add the secure gateway instead (`FILAMENTDB_HTTPS_PORT`, plus an absolute `FILAMENTDB_SECURE_DIR` the service user can write to): see [Securing a network-exposed instance](#securing-a-network-exposed-instance). The same section covers fronting the service with your own reverse proxy.

> **Note:** If you're running the desktop app instead of a headless service, you don't set any of this by hand: flip on the **Share on local network** toggle in Settings (electron-store key `exposeToLan`, off by default) and the app starts the secure gateway for you, with a generated API key. It pairs with mDNS auto-discovery, so the mobile companion app can find your instance on the network without typing a URL.

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
- Can be switched to Hybrid or Atlas later from **Settings → Network Settings → Connection Mode**, no reset needed (see [Troubleshooting](troubleshooting.md#desktop-app-how-to-switch-connection-modes))

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
