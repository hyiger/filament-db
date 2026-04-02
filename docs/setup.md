# Setup Guide

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
docker run -p 3000:3000 \
  -e MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/filament-db" \
  ghcr.io/hyiger/filament-db
```

Open http://localhost:3000.

### Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  filament-db:
    image: ghcr.io/hyiger/filament-db
    ports:
      - "3000:3000"
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
      - "3000:3000"
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
| `PORT` | No | Server port (default: `3000`) |
| `GEMINI_API_KEY` | No | Google Gemini API key for TDS extraction |
| `ANTHROPIC_API_KEY` | No | Anthropic Claude API key for TDS extraction |
| `OPENAI_API_KEY` | No | OpenAI API key for TDS extraction |

### Building from Source

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
docker build -t filament-db .
docker run -p 3000:3000 -e MONGODB_URI="mongodb+srv://..." filament-db
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

> **Note:** If your password contains special characters (`@`, `#`, `%`, etc.), you must URL-encode them. For example, `p@ssword` becomes `p%40ssword`.

> **Note:** The desktop app does not use `.env.local` -- it prompts for the connection string on first launch and stores it in an encrypted local config file (see [Desktop App](desktop.md) for storage locations). In offline and hybrid modes, the desktop app runs an embedded local MongoDB instance automatically.

### Running

#### Web App

```bash
npm run dev                   # development at http://localhost:3000
npm run build && npm start    # production
```

#### Desktop App (from source)

```bash
npm run electron:dev          # development mode
npm run electron:build        # build installer for your platform
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
