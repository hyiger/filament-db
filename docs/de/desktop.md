> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../desktop.md) maßgeblich.

# Desktop-App

[< Zurück zur README](../README.md)

Filament DB kann mit Electron als installierbare Desktop-Anwendung für macOS, Windows und Linux paketiert werden.

## Installation

Lade die neueste Version für deine Plattform von [GitHub Releases](https://github.com/hyiger/filament-db/releases):

| Plattform | Datei | Hinweise |
|----------|------|----------|
| macOS (Apple Silicon) | `FilamentDB-x.x.x-mac-arm64.dmg` | Für M1/M2/M3/M4-Macs |
| macOS (Intel) | `FilamentDB-x.x.x-mac-x64.dmg` | Für ältere Intel-Macs |
| Windows | `FilamentDB-x.x.x-windows-x64-setup.exe` | NSIS-Installer, erlaubt benutzerdefiniertes Installationsverzeichnis |
| Linux x64 | `FilamentDB-x.x.x-linux-x86_64.AppImage` | Universell, keine Installation nötig — einfach ausführbar machen und starten |
| Linux x64 | `FilamentDB-x.x.x-linux-amd64.deb` | Für Ubuntu/Debian — installiere mit `sudo dpkg -i` |
| Linux arm64 | `FilamentDB-x.x.x-linux-arm64.AppImage` | Für Raspberry Pi 5 und andere arm64-Boards |
| Linux arm64 | `FilamentDB-x.x.x-linux-arm64.deb` | Für arm64 Ubuntu/Debian — installiere mit `sudo dpkg -i` |

> **macOS Gatekeeper:** Die App ist nicht mit einer Apple-Developer-ID notarisiert. Nach der Installation blockiert macOS die App möglicherweise. Führe im Terminal aus:
>
> ```bash
> xattr -cr "/Applications/Filament DB.app"
> ```
>
> Das entfernt das Quarantäne-Flag, das macOS auf heruntergeladene Apps setzt. Nach der Installation nur einmal erforderlich.

## Erster Start

Beim ersten Start zeigt die App einen Einrichtungs-Assistenten, in dem du einen Verbindungsmodus wählst:

- **MongoDB Atlas (Cloud)** — Verbindung zu einer Cloud-Datenbank (Internet erforderlich)
- **Hybrid (Lokal + Cloud-Sync)** — Daten lokal gespeichert, synchronisiert mit Atlas wenn verbunden (empfohlen)
- **Nur lokal (Offline)** — alle Daten lokal gespeichert, kein Cloud-Konto nötig

Für Atlas- und Hybrid-Modus wirst du nach einer MongoDB-Atlas-Verbindungszeichenfolge gefragt. Trage sie ein und klicke auf **Verbinden** — die App validiert die Verbindung vor dem Speichern.

Deine Konfiguration wird in einer verschlüsselten lokalen Datei gespeichert (per `electron-store` mit AES-Verschlüsselung). Dazu gehören MongoDB-Verbindungseinstellungen, AI-Provider-API-Key und Verbindungsmodus.
- **macOS**: `~/Library/Application Support/filament-db/config.json`
- **Windows**: `%APPDATA%/filament-db/config.json`
- **Linux**: `~/.config/filament-db/config.json`

Im Offline- und Hybrid-Modus liegen die lokalen Datenbankdateien unter demselben Verzeichnis im Unterordner `mongodb-data/`.

## Auto-Update *(v1.11)*

Die paketierte App fragt GitHub Releases regelmäßig nach neuen Versionen ab und zeigt oben im Fenster einen Banner, sobald ein Update verfügbar ist. Der Lebenszyklus:

1. **available** — der Banner bietet **Download** (lädt im Hintergrund) und **View release** (öffnet die GitHub-Release-Seite).
2. **downloading** — der Banner zeigt einen Fortschrittsbalken.
3. **ready** — der Banner bietet **Neu starten & installieren**. Ein Klick öffnet einen nativen Bestätigungsdialog, dessen Texte vom Renderer übergeben werden und so deine aktuelle Sprache respektieren.
4. **error** — der Banner färbt sich gelb und zeigt einen **View release**-Link als manuellen Fallback.

**Plattformspezifisches Verhalten:**
- **macOS**: Unsignierte Builds können über Gatekeeper nicht automatisch installieren; die App bietet die „view release page"-Fallback-Option, damit du die neue DMG manuell herunterladen kannst. Signierte Builds installieren sauber.
- **Windows**: Unsignierte NSIS-Installer installieren automatisch problemlos. Beim nächsten App-Start erscheint eine SmartScreen-Warnung.
- **Linux**: AppImage-Updates funktionieren, wenn die App über AppImageLauncher oder eine vergleichbare Integration gestartet wurde. `.deb`-Builds werden nicht automatisch aktualisiert — nutze stattdessen deinen Paketmanager.

**Wie Updates gefunden werden:** Der Release-Workflow erzeugt bei jedem `v*`-Tag `latest-mac.yml`, `latest-linux.yml` und `latest-linux-arm64.yml`. `electron-updater` liest diese Manifeste beim Start vom GitHub-Release (mit 20 Sekunden Verzögerung, damit die UI Zeit zum Mounten hat) und danach alle 6 Stunden, solange die App läuft.

**Im Dev-Modus:** Die IPC-Handler sind immer registriert, geben aber bei mutierenden Aktionen `{ ok: false, error: "dev-mode" }` zurück, damit der Banner in einem nicht-paketierten Lauf nie auslöst.

## Aus den Quellen bauen

### Entwicklung

Starte die Desktop-App im Entwicklungsmodus mit Hot-Reload:

```bash
npm run electron:dev
```

Das startet den Next.js-Dev-Server auf Port 3456 und Electron gleichzeitig. Die App lädt `http://localhost:3456`.

> **Hinweis:** Im Dev-Modus verbindet sich Electron mit dem `next dev`-Server auf Port 3456. Verbindungsmodus-Änderungen (offline/hybrid/atlas) im Einrichtungs-Assistenten speichern den Konfigurationsspeicher und rekonfigurieren den Electron-Hauptprozess (lokale MongoDB, Sync-Service), aber das Next.js-Backend verwendet weiterhin die `MONGODB_URI` aus deiner `.env.local`. Um Verbindungsmodi vollständig zu testen, nutze einen Produktions-Build (`npm run electron:build`).

### Produktions-Build

Baue einen Installer für deine aktuelle Plattform:

```bash
npm run electron:build
```

Das führt fünf Schritte aus:
1. `npm run build` — baut Next.js im Standalone-Modus
2. `npm run electron:fixlinks` — löst Symlinks im Standalone-Output auf und kopiert ihn mit statischen Assets
3. `npm run electron:rebuild` — baut native Module (PC/SC) für die Electron-Node.js-Version neu
4. `npm run electron:compile` — bündelt Electron-TypeScript mit esbuild
5. `npm run electron:pack` — paketiert alles mit electron-builder

Der erzeugte Installer liegt in `dist-electron/`.

## Automatisierte Releases via GitHub Actions

Ein GitHub-Actions-Workflow (`.github/workflows/release.yml`) baut Installer für alle Plattformen automatisch, sobald du einen Version-Tag pushst:

```bash
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

Anschließend ein GitHub-Release erstellen:

```bash
gh release create v1.0.0 --title "v1.0.0" --generate-notes
```

Der Workflow läuft parallel auf macOS-, Windows- und Ubuntu-Runnern (Linux baut x64 und arm64 per Cross-Compilation). Die Installer jeder Plattform werden automatisch auf das GitHub-Release hochgeladen.

### Was der Workflow tut:
1. Code auschecken
2. Abhängigkeiten installieren
3. Tests ausführen
4. `npm run electron:build` ausführen (Next.js bauen, Symlinks auflösen, Electron bündeln, Installer paketieren)
5. Installer auf GitHub Releases hochladen

## Architektur

Die Desktop-App kapselt die Next.js-Anwendung in Electron:

```
┌─ Electron-Shell ────────────────────────────┐
│                                             │
│  ┌─ Main-Prozess ────────────────────────┐  │
│  │ electron/main.ts (gebündelt mit esbuild)│ │
│  │ - App-Lebenszyklus                    │  │
│  │ - BrowserWindow-Verwaltung            │  │
│  │ - Startet Next.js-Standalone-Server   │  │
│  │   via Electron utilityProcess         │  │
│  │ - Verschlüsselter Konfig-Speicher     │  │
│  │   (MongoDB-URI, AI-API-Key etc.)      │  │
│  │ - IPC-Handler (save/load config)      │  │
│  │ - HTTP-Polling für Server-Bereitschaft│  │
│  │ - NFC-Reader/Writer-Service (PC/SC)   │  │
│  │   via @pokusew/pcsclite               │  │
│  │ - Eingebettete lokale MongoDB (mongod)│  │
│  │ - Bidirektionaler Atlas-Sync-Service  │  │
│  │ - Externer-Link-Schutz: nur http(s)   │  │
│  │   URLs erreichen shell.openExternal   │  │
│  │ - Server-Absturz-Auto-Recovery        │  │
│  │ - IPC-Timeout-Schutz (15s)            │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ Renderer (BrowserWindow) ────────────┐  │
│  │ Next.js-App                           │  │
│  │ - Alle Web-UI-Seiten                  │  │
│  │ - API-Routen (filaments, nozzles)     │  │
│  │ - Einrichtungs-Assistent (/setup)     │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ Preload-Skript ──────────────────────┐  │
│  │ electron/preload.ts                   │  │
│  │ - Sichere IPC-Brücke (contextBridge)  │  │
│  │ - Exponiert: getConfig, saveConfig,   │  │
│  │   resetConfig, showMessage,           │  │
│  │   nfcGetStatus, nfcReadTag,           │  │
│  │   nfcWriteTag, sync status/trigger,   │  │
│  │   Event-Listener                      │  │
│  └───────────────────────────────────────┘  │
│                                             │
└─────────────────────────────────────────────┘
         │
         ▼
   Lokale MongoDB (eingebettet) ←→ MongoDB Atlas (Cloud, optional)
```

Im **Entwicklungsmodus**: Electron lädt `http://localhost:3456` (Next.js-Dev-Server).

Im **Produktionsmodus**: Electron nutzt `utilityProcess.fork()`, um den Standalone-Next.js-Server auf `http://localhost:3456` zu starten, und lädt ihn dann ins BrowserWindow. Stürzt der Server unerwartet ab, versucht die App automatisch einen Neustart und lädt das Fenster neu. Schlägt der Neustart fehl, erscheint ein Fehlerdialog.

IPC-Aufrufe an NFC-Operationen und Sync haben einen 15-Sekunden-Timeout, damit die UI nicht hängt, wenn eine Operation nicht antwortet.

## Konfiguration zurücksetzen

Um die MongoDB-Verbindung neu zu konfigurieren, lösche die Konfigurationsdatei am oben genannten Pfad, oder öffne die Entwicklerkonsole im Electron-Fenster und rufe `window.electronAPI.resetConfig()` auf.
