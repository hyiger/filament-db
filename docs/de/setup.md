> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../setup.md) maßgeblich.

# Einrichtungsanleitung

[< Zurück zur README](../README.md)

## Option 1: Desktop-App (am einfachsten)

Lade den neuesten Installer für deine Plattform von [GitHub Releases](https://github.com/hyiger/filament-db/releases):

- **macOS (Apple Silicon)**: `FilamentDB-x.x.x-mac-arm64.dmg`
- **macOS (Intel)**: `FilamentDB-x.x.x-mac-x64.dmg`
- **Windows**: `FilamentDB-x.x.x-windows-x64-setup.exe`
- **Linux x64**: `FilamentDB-x.x.x-linux-x86_64.AppImage` oder `FilamentDB-x.x.x-linux-amd64.deb`
- **Linux arm64** (Raspberry Pi 5): `FilamentDB-x.x.x-linux-arm64.AppImage` oder `FilamentDB-x.x.x-linux-arm64.deb`

Beim ersten Start wirst du nach einem Verbindungsmodus gefragt:

- **MongoDB Atlas (Cloud)** — Verbindung zu einer Cloud-Datenbank. Benötigt ein MongoDB-Atlas-Konto und Internet.
- **Hybrid (Lokal + Cloud-Sync)** — Daten lokal speichern mit automatischem Hintergrund-Sync zu Atlas. Funktioniert offline und synchronisiert, sobald Internet verfügbar ist. *Empfohlen für die meisten Nutzer.*
- **Nur lokal (Offline)** — alle Daten auf deinem Computer gespeichert. Kein Cloud-Konto, kein Internet nötig. Du kannst später in den Hybrid-Modus wechseln.

Für Atlas- und Hybrid-Modus brauchst du eine MongoDB-Atlas-Verbindungszeichenfolge. Siehe [MongoDB Atlas einrichten](#mongodb-atlas-einrichten-kostenlose-stufe), falls du noch kein Konto hast.

## Option 2: Docker

Filament DB als Docker-Container betreiben. Das Image ist ~72 MB groß, basiert auf `node:22-alpine` und unterstützt sowohl `linux/amd64` als auch `linux/arm64` (Raspberry Pi).

> **Hinweis:** Das Docker-Image betreibt nur die Web-App. NFC-Tag-Lesen/Schreiben erfordert die [Desktop-App](#option-1-desktop-app-am-einfachsten) für den direkten USB-Hardwarezugriff.

### Schnellstart

```bash
docker run -p 3456:3000 \
  -e MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/filament-db" \
  ghcr.io/hyiger/filament-db
```

Öffne http://localhost:3456.

### Docker Compose

Lege eine `docker-compose.yml` an:

```yaml
services:
  filament-db:
    image: ghcr.io/hyiger/filament-db
    ports:
      - "3456:3000"
    environment:
      - MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/filament-db
      # Optional: AI-Provider für TDS-Extraktion (eine wählen)
      # - GEMINI_API_KEY=your-key
      # - ANTHROPIC_API_KEY=your-key
      # - OPENAI_API_KEY=your-key
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Docker Compose mit lokaler MongoDB

Wenn du kein MongoDB-Atlas-Konto hast, kannst du MongoDB neben Filament DB laufen lassen:

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

### Umgebungsvariablen

| Variable | Erforderlich | Beschreibung |
|----------|----------|-------------|
| `MONGODB_URI` | Ja | MongoDB-Verbindungszeichenfolge |
| `PORT` | Nein | Serverport im Container (Standard: `3000`) |
| `GEMINI_API_KEY` | Nein | Google-Gemini-API-Key für TDS-Extraktion |
| `ANTHROPIC_API_KEY` | Nein | Anthropic-Claude-API-Key für TDS-Extraktion |
| `OPENAI_API_KEY` | Nein | OpenAI-API-Key für TDS-Extraktion |
| `ALLOWED_DEV_ORIGINS` | Nein | Komma-separierte Hostnamen, die auf den Dev-Server zugreifen dürfen (z. B. `myhost.local`) |

### Aus Quellen bauen

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
docker build -t filament-db .
docker run -p 3456:3000 -e MONGODB_URI="mongodb+srv://..." filament-db
```

---

## Option 3: Aus Quellen ausführen

### Voraussetzungen

- **Node.js** v20 oder neuer
- **npm** (bei Node.js enthalten)
- **Git**
- Eine **MongoDB**-Datenbank (Atlas Free Tier oder lokale MongoDB)

### Node.js installieren

#### macOS

Mit Homebrew (empfohlen):

```bash
brew install node
```

Oder lade den Installer von https://nodejs.org/

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

Lade den Installer von https://nodejs.org/ herunter und führe ihn aus (LTS-Version empfohlen).

Oder mit winget:

```powershell
winget install OpenJS.NodeJS.LTS
```

Oder mit Chocolatey:

```powershell
choco install nodejs-lts
```

Nach der Installation auf jeder Plattform prüfen:

```bash
node --version
npm --version
```

### Klonen und installieren

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
npm install
```

### Umgebung konfigurieren (nur Web-App)

Wenn du als Web-App (nicht als Desktop) läufst, lege eine `.env.local` an:

#### macOS / Linux

```bash
cp .env.example .env.local
```

#### Windows (PowerShell)

```powershell
Copy-Item .env.example .env.local
```

Bearbeite `.env.local` dann mit deiner MongoDB-Verbindungszeichenfolge und optional einem AI-API-Key für die TDS-Extraktion:

```
MONGODB_URI=mongodb+srv://youruser:yourpassword@yourcluster.mongodb.net/filament-db?appName=Filaments

# Optional: AI-Provider für TDS-Extraktion (eine wählen)
GEMINI_API_KEY=your-gemini-key
# ANTHROPIC_API_KEY=your-claude-key
# OPENAI_API_KEY=your-openai-key
```

Der AI-API-Key aktiviert die Funktion „Aus TDS importieren", die mit AI Filamenteigenschaften aus Technical Data Sheets extrahiert. Du kannst das stattdessen auch in der Einstellungen-Seite konfigurieren.

Wenn du den Dev-Server von einem anderen Gerät im Netzwerk aufrufst (z. B. ein Raspberry Pi unter `myhost.local`), trage den Hostnamen für Cross-Origin-Dev-Anfragen ein:

```
ALLOWED_DEV_ORIGINS=myhost.local
```

Mehrere Hostnamen werden mit Komma getrennt (z. B. `myhost.local,other.local`).

> **Hinweis:** Wenn dein Passwort Sonderzeichen enthält (`@`, `#`, `%` usw.), musst du sie URL-codieren. Aus `p@ssword` wird zum Beispiel `p%40ssword`.

> **Hinweis:** Die Desktop-App verwendet **nicht** `.env.local` — sie fragt beim ersten Start nach der Verbindungszeichenfolge und speichert sie in einer lokal persistierten Konfigurationsdatei (siehe [Desktop-App](desktop.md) für die Speicherorte). Im Offline- und Hybrid-Modus startet die Desktop-App automatisch eine eingebettete lokale MongoDB-Instanz.

### Ausführen

#### Web-App

```bash
npm run dev                   # Entwicklung unter http://localhost:3456
npm run build && npm start    # Produktion unter http://localhost:3000 (setze PORT=3456 für gleichen Port wie dev)
```

`npm start` startet den Standalone-Server-Eintrittspunkt (`node .next/standalone/server.js`) — `next start` ist nicht mit dem `output: "standalone"`-Build-Modus kompatibel, den das Projekt für Docker- und Electron-Paketierung verwendet.

#### Desktop-App (aus Quellen)

```bash
npm run electron:dev          # Entwicklungsmodus
npm run electron:build        # Installer für deine Plattform bauen
```

> **Port:** `npm run dev` und die Desktop-App laufen auf Port **3456**. Docker bindet intern auf Port 3000 und wird per `-p 3456:3000` auf 3456 auf dem Host gemappt. `npm start` (Produktion) verwendet standardmäßig Port **3000**, sofern `PORT=3456` nicht gesetzt ist. Die Desktop-App respektiert ebenfalls die `PORT`-Umgebungsvariable. [PrusaSlicer Filament Edition](https://github.com/hyiger/PrusaSlicer) erwartet standardmäßig `http://localhost:3456`.

---

## Als Linux-Dienst betreiben

Du kannst Filament DB als systemd-Dienst betreiben, sodass er automatisch beim Boot startet. Das ist nützlich für Headless-Server oder einen Raspberry Pi, der als dedizierte Filamentdatenbank in deinem Netzwerk dient.

Diese Anleitung geht davon aus, dass du das `.deb`-Paket von [GitHub Releases](https://github.com/hyiger/filament-db/releases) installiert hast. Wenn du aus Quellen läufst, passe die Pfade entsprechend an (`WorkingDirectory` auf das `.next/standalone/` deines Repos und `ExecStart` auf `node server.js`).

### 1. Umgebung konfigurieren

Lege `/opt/Filament DB/.env` mit deiner MongoDB-Verbindungszeichenfolge an oder bearbeite sie:

```bash
sudo tee "/opt/Filament DB/.env" > /dev/null <<'EOF'
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/filament-db?appName=Filaments
PORT=3456
HOSTNAME=0.0.0.0
EOF
sudo chmod 600 "/opt/Filament DB/.env"
```

`HOSTNAME=0.0.0.0` sorgt dafür, dass der Server auf allen Netzwerkschnittstellen lauscht, sodass andere Geräte im Netz ihn erreichen können.

### 2. Dienst anlegen

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

Ersetze `your-username` durch deinen Linux-Benutzernamen.

### 3. Aktivieren und starten

```bash
sudo systemctl daemon-reload
sudo systemctl enable filament-db
sudo systemctl start filament-db
```

Die Web-App ist nun unter `http://<hostname>:3456` erreichbar und startet automatisch beim Boot.

### Nützliche Befehle

```bash
sudo systemctl status filament-db      # Dienststatus prüfen
sudo systemctl restart filament-db      # Nach Upgrade neu starten
sudo systemctl stop filament-db         # Dienst stoppen
journalctl -u filament-db -f            # Logs verfolgen
```

### NFC neben dem Dienst nutzen

Die Desktop-App enthält NFC-Tag-Lese/Schreibe-Unterstützung, die direkten USB-Zugriff auf einen NFC-Reader erfordert. Da sowohl der Web-Dienst als auch die Desktop-App einen Next.js-Server starten, betreibe die Desktop-App auf einem anderen Port, damit der Web-Dienst weiterhin für PrusaSlicer und andere Netzwerkclients verfügbar bleibt:

```bash
PORT=3457 "/opt/Filament DB/filament-db"
```

Oder lege ein praktisches Skript an:

```bash
cat > ~/nfc.sh <<'SCRIPT'
#!/bin/bash
echo "Starte Filament DB Desktop für NFC (Port 3457)..."
echo "Web-Dienst läuft weiter auf Port 3456."
PORT=3457 "/opt/Filament DB/filament-db"
SCRIPT
chmod +x ~/nfc.sh
```

Führe dann `~/nfc.sh` aus, wann immer du NFC brauchst. Der Web-Dienst bleibt auf Port 3456 ununterbrochen erreichbar.

### Upgrade

Nach Installation einer neuen `.deb`-Version starte den Dienst neu, damit er die Änderungen übernimmt:

```bash
sudo dpkg -i FilamentDB-x.x.x-linux-arm64.deb
sudo systemctl restart filament-db
```

---

## Verbindungsmodi (Desktop-App)

Die Desktop-App unterstützt drei Verbindungsmodi:

### Atlas (Cloud)

- Alle Daten werden in MongoDB Atlas gespeichert
- Erfordert dauerhafte Internetverbindung
- Ist Atlas beim Start nicht erreichbar, weicht die App automatisch auf eine lokale Datenbank aus und synchronisiert, sobald die Verbindung wiederhergestellt ist

### Hybrid (Lokal + Cloud-Sync)

- Daten lokal in einer eingebetteten MongoDB-Instanz gespeichert
- Automatische bidirektionale Synchronisation mit Atlas, sobald verbunden
- Funktioniert vollständig offline — synchronisiert automatisch, sobald wieder Internet verfügbar ist
- Sync verwendet Last-Write-Wins-Konfliktauflösung anhand von Zeitstempeln
- Manueller **Jetzt synchronisieren**-Button in der Statusanzeige verfügbar
- Sync läuft alle 5 Minuten, wenn Atlas erreichbar ist
- **Was synchronisiert wird**: nozzles, printers, locations, bedtypes, filaments (mit eingebetteten Spulen), printhistories, sharedcatalogs — alle mit Cross-DB-Ref-Remap, damit Kalibrierungen, AMS-Slots und Spulen-/Filamentreferenzen auf beiden Seiten konsistent bleiben. Soft-Deletes (`_deletedAt`) propagieren so, dass ein Löschen auf einem Peer nicht vom anderen wiederauferstanden wird.
- **Spool-Subdokument-Einschränkung**: Spulen-IDs innerhalb von Filament haben keine stabilen Cross-Side-Identifier, daher werden `printer.amsSlots[].spoolId` und `printhistory.usage[].spoolId` beim Cross-Side-Remap geleert. Pro-Filament-Gramm-Summen stimmen weiterhin; die Zuordnung *welche Spule* geladen/verbraucht wurde, geht verloren.

### Nur lokal (Offline)

- Alle Daten lokal gespeichert, keine Cloud-Verbindung
- Kein MongoDB-Atlas-Konto nötig
- Kann später durch Zurücksetzen der Konfiguration in den Hybrid-Modus umgestellt werden (siehe [Fehlerbehebung](troubleshooting.md#desktop-app-verbindungsmodus-wechseln))

---

## MongoDB Atlas einrichten (kostenlose Stufe)

1. Gehe zu https://www.mongodb.com/cloud/atlas/register und erstelle ein kostenloses Konto.

2. **Cluster erstellen:**
   - Klicke auf **„Build a Database"**
   - Wähle die **M0 Free**-Stufe
   - Wähle einen Cloud-Provider und eine Region in deiner Nähe
   - Benenne deinen Cluster (z. B. `Filaments`)
   - Klicke auf **„Create Deployment"**

3. **Datenbankbenutzer anlegen:**
   - Trage im Wizard einen Benutzernamen und ein Passwort ein
   - **Eingebaute Rolle**: wähle `Read and write to any database` (oder grenze auf deine spezifische Datenbank ein). Die App benötigt `readWrite` auf der Zieldatenbank — bei einem Read-Only-Benutzer zeigt die Desktop-App einen klaren Sync-Fehler, der dich zurück zu Einstellungen → Verbindung führt (anstatt den rohen Treibertext `user is not allowed to do action [update]` durchzureichen).
   - Klicke auf **„Create Database User"**
   - Speichere diese Zugangsdaten — du brauchst sie für die Verbindungszeichenfolge

4. **Netzwerkzugriff konfigurieren:**
   - Klicke im Wizard (oder unter **Security > Network Access**) auf **„Add IP Address"**
   - Für die Entwicklung: **„Allow Access from Anywhere"** (fügt `0.0.0.0/0` hinzu)
   - Für die Produktion: trage nur die IP-Adresse deines Servers ein
   - Klicke auf **„Confirm"**

5. **Verbindungszeichenfolge holen:**
   - Klicke auf **„Connect"** in deinem Cluster
   - Wähle **„Drivers"**
   - Kopiere die Verbindungszeichenfolge. Sie sieht so aus:
     ```
     mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?appName=<appName>
     ```
   - Ersetze `<username>` und `<password>` durch die Zugangsdaten aus Schritt 3
   - Füge vor dem `?` `/filament-db` ein, um den Datenbanknamen anzugeben:
     ```
     mongodb+srv://<username>:<password>@<cluster>.mongodb.net/filament-db?appName=Filaments
     ```
