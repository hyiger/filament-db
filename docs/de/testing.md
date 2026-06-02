> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../testing.md) maßgeblich.

# Tests

[< Zurück zur README](../../README.md)

## Überblick

Das Projekt verwendet [Vitest](https://vitest.dev/) mit [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server) für In-Memory-Datenbanktests. Tests erzwingen Abdeckungsschwellen für alle Library- und Modell-Dateien.

## Tests ausführen

```bash
# Tests einmal ausführen
npm test

# Tests im Watch-Modus ausführen
npm run test:watch

# Tests mit Abdeckungsbericht ausführen
npm run test:coverage
```

## Teststruktur

Tests liegen unter `tests/` und spiegeln die Struktur von `src/` und `electron/` wider. Die Dateien decken ab:

- **Domain-Decoder/Encoder** — OpenPrintTag CBOR, NDEF-Wrapping, Bambu Lab MIFARE, NFC-Roundtrip
- **Parser und Importer** — INI, CSV/XLSX, Prusament QR, TDS (mit Mocks für KI-Anbieter), Spool-CSV-Import
- **Mongoose-Modelle** — Filament (inkl. Spulen, Varianten, Kalibrierungen), Nozzle, Printer, BedType, Location, PrintHistory, SharedCatalog
- **Library-Helfer** — resolveFilament-Vererbung, PrusaSlicer/OrcaSlicer-Bundle-Export, OpenPrintTag-Browser-Bewertung, Theme-Init, Bildkomprimierung, Spool-Body-Validierung, Währung
- **Next.js-Route-Handler** — locations, print-history, share, snapshot, spools/import, Sub-Routen (Spool-Trockenzyklen / Nutzung)
- **Electron** — sync-service-URI-Parsing und (in PR #118) Standort-Sync-Roundtrip über zwei In-Memory-MongoDB-Instanzen
- **Regressions-Guards** — Variant-Edit/Clone-Vererbungs-Roundtrip (#106 / #111 / #115 / #113)

Die exakten Datei- und Testzahlen ändern sich mit jedem PR — führe `npm test` aus, um die aktuellen Werte zu sehen (der Verbose-Reporter gibt sie bei Erfolg aus).

## Abdeckungsschwellen

Die Vitest-Konfiguration (`vitest.config.ts`) erzwingt die folgenden Mindestschwellen für Dateien in `src/lib/` und `src/models/`:

- **Statements**: 80%
- **Branches**: 75%
- **Functions**: 90%
- **Lines**: 80%

Tests schlagen fehl, wenn die Abdeckung unter diese Schwellen fällt.

**Geltungsbereich der Abdeckung**: Die Schwellen gelten derzeit nur für `src/lib/**` und `src/models/**`. API-Routen (`src/app/api/`), Seiten (`src/app/`) und Electron-Code (`electron/`) sind nicht vom Schwellen-Gate erfasst.

## CI / GitHub Actions

### Test-Workflow (`.github/workflows/test.yml`)

Läuft automatisch bei:
- Push auf `main`
- Pull Requests auf `main`

Tests laufen gegen Node.js 20 und 22. Abdeckungsberichte werden im Node-22-Lauf als Artefakte hochgeladen.

### Release-Workflow (`.github/workflows/release.yml`)

Läuft automatisch bei Versions-Tags (`v*`). Tests werden in allen sechs Build-Konfigurationen (macOS arm64 + x64, Windows x64 + arm64, Linux x64 + arm64) ausgeführt, bevor die Electron-Installer gebaut werden. Wenn Tests fehlschlagen, wird der Build für diese Plattform übersprungen.

## Test-Setup

Die Datei `tests/setup.ts` verwaltet den Lebenszyklus des mongodb-memory-server:
- **beforeAll**: Startet eine In-Memory-MongoDB-Instanz und verbindet Mongoose
- **afterEach**: Leert alle Collections und gecachten Modelle zwischen Tests
- **afterAll**: Trennt Mongoose und stoppt den In-Memory-Server

Zum Ausführen der Tests ist keine externe MongoDB-Verbindung nötig.
