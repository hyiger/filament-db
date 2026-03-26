# Setup Guide

## Option 1: Desktop App (easiest)

Download the latest installer for your platform from [GitHub Releases](https://github.com/hyiger/filament-db/releases):

- **macOS**: `Filament.DB-x.x.x.dmg`
- **Windows**: `Filament.DB-Setup-x.x.x.exe`
- **Linux**: `Filament.DB-x.x.x.AppImage` or `.deb`

On first launch, you'll be prompted to enter your MongoDB Atlas connection string. The app validates the connection and stores it securely on your machine. See [Setting Up MongoDB Atlas](#setting-up-mongodb-atlas-free-tier) below if you don't have an account yet.

## Option 2: Run from Source

### Prerequisites

- **Node.js** v18 or later
- **npm** (included with Node.js)
- **Git**
- A **MongoDB Atlas** account (free tier works)

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

Then edit `.env.local` with your MongoDB Atlas connection string:

```
MONGODB_URI=mongodb+srv://youruser:yourpassword@yourcluster.mongodb.net/filament-db?appName=Filaments
```

> **Note:** If your password contains special characters (`@`, `#`, `%`, etc.), you must URL-encode them. For example, `p@ssword` becomes `p%40ssword`.

> **Note:** The desktop app does not use `.env.local` -- it prompts for the connection string on first launch and stores it securely via the OS keychain.

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
