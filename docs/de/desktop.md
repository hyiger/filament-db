> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../desktop.md) maßgeblich.

# Desktop-App

[< Zurück zur README](../../README.md)

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

> **macOS Gatekeeper:** Seit v1.39.1 sind die Release-DMGs mit einer Apple-Developer-ID signiert **und** notarisiert, öffnen also ohne jede Gatekeeper-Warnung und aktualisieren sich normal automatisch — keine manuellen Schritte nötig. Der erste Start nach einer notarisierten Installation kann etwas dauern, während macOS die App prüft (die erste Notarisierung selbst läuft beim Release ~40 Minuten, das ist kein Hängenbleiben). Wenn du selbst ein **unsigniertes** DMG gebaut hast, blockiert macOS es möglicherweise; entferne dann das Quarantäne-Flag mit:
>
> ```bash
> xattr -cr "/Applications/Filament DB.app"
> ```
>
> Das brauchst du nur für eine selbst gebaute, unsignierte App, und nur einmal nach der Installation.

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

## Im lokalen Netzwerk freigeben *(v1.45.0)*

Standardmäßig bindet der eingebettete Next.js-Server an `localhost` und ist somit nur vom selben Rechner aus erreichbar. **Einstellungen → Im lokalen Netzwerk freigeben** (ein `electron-store`-Schalter, `exposeToLan`, standardmäßig aus) bindet den Server an `0.0.0.0`, sodass andere Geräte im LAN ihn erreichen können. Ist er aktiviert, liefert der **`get-lan-ip`-IPC** die zu verwendende LAN-URL (z. B. `http://192.168.1.20:3456`), die mit der mobilen Scanner-App zusammenspielt.

Seit v1.47.0 kündigt sich der Desktop zusätzlich per **mDNS** an (`_filamentdb._tcp`, über `electron/mdns-service.ts` / `bonjour-service`) – **nur solange „Im lokalen Netzwerk freigeben" aktiv ist** –, sodass der **Im Netzwerk suchen**-Scan der mobilen App ihn ohne URL-Eingabe automatisch findet.

> **Eine im LAN freigegebene Instanz absichern:** Setze die Umgebungsvariable `FILAMENTDB_API_KEY`, um bei jeder `/api/*`-Anfrage ein Bearer-Token zu verlangen (`src/lib/apiAuth.ts`). Bleibt sie ungesetzt, bleibt die API unauthentifiziert (Standard).

## Auto-Update *(v1.11)*

Die paketierte App fragt GitHub Releases regelmäßig nach neuen Versionen ab und zeigt oben im Fenster einen Banner, sobald ein Update verfügbar ist. Der Lebenszyklus:

1. **available** — der Banner bietet **Download** (lädt im Hintergrund) und **View release** (öffnet die GitHub-Release-Seite).
2. **downloading** — der Banner zeigt einen Fortschrittsbalken.
3. **ready** — der Banner bietet **Neu starten & installieren**. Ein Klick öffnet einen nativen Bestätigungsdialog, dessen Texte vom Renderer übergeben werden und so deine aktuelle Sprache respektieren.
4. **error** — der Banner färbt sich gelb und zeigt einen **View release**-Link als manuellen Fallback.

**Plattformspezifisches Verhalten:**
- **macOS**: Signierte + notarisierte Builds (v1.39.1+) aktualisieren sich sauber automatisch über Gatekeeper. Das `mac.target` ist `[dmg, zip]`, weil electron-updater nicht aus einem DMG automatisch aktualisieren kann, und der Updater lädt das ZIP der passenden Architektur. Die „view release page"-Fallback-Option erscheint weiterhin im **error**-Zustand.
- **Windows**: Unsignierte NSIS-Installer installieren automatisch problemlos. Beim nächsten App-Start erscheint eine SmartScreen-Warnung.
- **Linux**: AppImage-Updates funktionieren, wenn die App über AppImageLauncher oder eine vergleichbare Integration gestartet wurde. `.deb`-Builds werden nicht automatisch aktualisiert — nutze stattdessen deinen Paketmanager.

**Wie Updates gefunden werden:** Der Release-Workflow erzeugt bei jedem `v*`-Tag die `electron-updater`-Manifeste — `latest.yml` (Windows, **nur x64** per Design, siehe unten), `latest-mac.yml` (macOS, ein **zusammengeführtes Multi-Arch**-Manifest, das sowohl `-mac-arm64.zip` als auch `-mac-x64.zip` auflistet) und `latest-linux.yml` / `latest-linux-arm64.yml` (Linux). `electron-updater` liest diese Manifeste beim Start vom GitHub-Release (mit 20 Sekunden Verzögerung, damit die UI Zeit zum Mounten hat) und danach alle 6 Stunden, solange die App läuft. Auf macOS filtert sein `MacUpdater` das Multi-Arch-Manifest auf die laufende Architektur, sodass Apple Silicon das arm64-ZIP und Intel das x64-ZIP zieht.

**Multi-Arch-Auto-Update:** Sowohl die macOS- als auch die Windows-Multi-Arch-Builds sind so gelöst, dass jede Architektur auf einem funktionierenden Update-Kanal bleibt.
> - **macOS** — beide Arch-Build-Jobs laufen mit `--publish never`, und ein dedizierter `merge-mac-metadata`-CI-Job führt ihre beiden Single-Arch-`latest-mac.yml`-Dateien zu einem Multi-Arch-Manifest zusammen (dem alleinigen Schreiber dieses Assets). `MacUpdater` filtert es dann auf die laufende Architektur, sodass Apple Silicon sich automatisch auf arm64 und Intel auf x64 aktualisiert.
> - **Windows** — x64 ist per Design der **einzige** Update-Kanal (#586). Der arm64-Cross-Job läuft mit `--publish never` und löscht seine `latest.yml`, sodass nur das x64-Manifest ausgeliefert wird. arm64-Windows aktualisiert sich automatisch auf den emulierten x64-Build (der über die Emulationsschicht des Betriebssystems problemlos läuft); ein nativer arm64-Installer bleibt zum manuellen Download im Release.
> - **Linux** ist nicht betroffen — dort hängt electron-builder ein Architektur-Suffix an (`latest-linux.yml` / `latest-linux-arm64.yml`).

**Im Dev-Modus:** Die IPC-Handler sind immer registriert, geben aber bei mutierenden Aktionen `{ ok: false, error: "dev-mode" }` zurück, damit der Banner in einem nicht-paketierten Lauf nie auslöst.

## Aus den Quellen bauen

### Entwicklung

Starte die Desktop-App im Entwicklungsmodus mit Hot-Reload:

```bash
npm run electron:dev
```

Das startet den Next.js-Dev-Server auf Port 3456 und Electron gleichzeitig. Die App lädt `http://localhost:3456`.

> **Hinweis:** Im Dev-Modus verbindet sich Electron mit dem `next dev`-Server auf Port 3456. Verbindungsmodus-Änderungen (offline/hybrid/atlas) im Einrichtungs-Assistenten speichern den Konfigurationsspeicher und rekonfigurieren den Electron-Hauptprozess (lokale MongoDB, Sync-Service), aber das Next.js-Backend verwendet weiterhin die `MONGODB_URI` aus deiner `.env.local`. Um Verbindungsmodi vollständig zu testen, nutze einen Produktions-Build (`npm run electron:build`). Seit v1.34.1 zeigt die Desktop-App im Dev-Modus zusätzlich ein ausblendbares gelbes Banner am oberen Rand des Renderers an, damit dieser Sonderfall deutlich sichtbar ist, bevor du etwas Veränderndes anklickst.

### Produktions-Build

Baue einen Installer für deine aktuelle Plattform:

```bash
npm run electron:build
```

Das führt fünf Schritte aus:
1. `npm run build` — baut Next.js im Standalone-Modus
2. `npm run electron:fixlinks` — löst Symlinks im Standalone-Output auf und kopiert ihn mit statischen Assets
3. `npm run electron:rebuild` — baut das native Modul für die Electron-Node.js-ABI neu: `@pokusew/pcsclite` (PC/SC, für NFC). Der Brother-Etikettendrucker braucht kein natives Modul mehr (seit v1.34.9 druckt er über das Drucksystem des Betriebssystems per USB, nicht mehr über `serialport`)
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

Der Workflow läuft parallel auf macOS-, Windows- und Ubuntu-Runnern — insgesamt sechs Jobs, da macOS (arm64 + x64), Windows (x64 + arm64) und Linux (x64 + arm64) jeweils beide Architekturen bauen (die zweite Architektur per Cross-Compilation). Die Installer jeder Plattform werden automatisch auf das GitHub-Release hochgeladen.

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
│  │   resetConfig, getRuntimeMode,        │  │
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
