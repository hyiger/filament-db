# Filament DB — Deutsche Dokumentation

Deutsche Übersetzung der Dokumente in [`docs/`](..). Bei Diskrepanzen zwischen der deutschen und englischen Fassung ist die englische Originalfassung maßgeblich.

## Inhalt

- [Einrichtung](setup.md) — Erstinstallation, MongoDB Atlas / Hybrid / Offline-Modi konfigurieren
- [Tutorial](tutorial.md) — Schritt-für-Schritt-Anleitung von Null bis Druck
- [Bedienung](usage.md) — Alltags-Workflows (Filament-Verwaltung, Spulen, Druckverlauf)
- [Import & Export](importing.md) — CSV/XLSX, OpenPrintTag-DB, Prusament-QR, Snapshots
- [API-Referenz](api.md) — REST-API-Endpunkte, Felder, Beispiele
- [NFC](nfc.md) — OpenPrintTag und Bambu-Lab-Tag-Workflows, Hardware-Voraussetzungen
- [Desktop-App](desktop.md) — Electron-spezifische Hinweise, Installationsorte, Auto-Update
- [Smart Filament Workflow Guide](smart-filament-workflow-guide.md) — Endbenutzer-Anleitung für den NFC-Scan → Slicer-Preset-Workflow (Screenshots stammen aus v1.25.1)
- [Tests](testing.md) — Vitest-Setup, Testkonventionen
- [Fehlerbehebung](troubleshooting.md) — Häufige Probleme und Lösungen

## Hinweise zur Übersetzung

- **Screenshots in den Bildern** (`docs/images/`) zeigen die englische Benutzeroberfläche. Wenn du die App auf Deutsch nutzt (Einstellungen → Sprache: Deutsch), entsprechen die Beschriftungen den deutschen i18n-Strings unter [`src/i18n/locales/de.json`](../../src/i18n/locales/de.json).
- **Code-Blöcke, API-Pfade, Dateinamen, GitHub-Verweise und Versionsnummern** bleiben in der Übersetzung unverändert (sind Teil des öffentlichen API-Vertrags bzw. unveränderlicher Bezeichner).
- **CSV-Spaltennamen** (z. B. `Parent`, `Variant Count`, `filament`, `totalWeight`) bleiben ebenfalls unverändert — sie sind literale Header-Werte, die der Import-Endpunkt erwartet.
- **PDF-Version** des Smart Filament Workflow Guide: Die deutsche PDF-Variante steht unter [`docs/de/smart-filament-workflow-guide.pdf`](smart-filament-workflow-guide.pdf) bereit — extern aus der englischen [`docs/smart-filament-workflow-guide.pdf`](../smart-filament-workflow-guide.pdf) übersetzt, damit Layout und Schriften des Originals erhalten bleiben.

## Beitragen

Findest du Übersetzungsfehler oder veraltete Stellen? Bitte öffne ein Issue oder einen PR. Die englischen Originale werden bei jedem Release aktualisiert — die deutschen Übersetzungen können geringfügig hinterherhinken.
