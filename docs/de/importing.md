> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../importing.md) maßgeblich.

# Filamente importieren

[< Zurück zur README](../../README.md)

## Config Bundle aus PrusaSlicer exportieren

1. Öffne **PrusaSlicer**
2. Gehe zu **Datei > Export > Config Bundle exportieren...**
3. Speichere die Datei (z. B. `PrusaSlicer_config_bundle.ini`)
4. Merke dir den Dateipfad — du brauchst ihn im nächsten Schritt

---

## Option 1: Web-/Desktop-UI (empfohlen)

1. Öffne Filament DB (Desktop-App oder im Web unter `http://localhost:3456`)
2. Öffne das Dropdown **Importieren/Exportieren** auf der Startseite und klicke auf **„Import INI"**
3. Wähle deine PrusaSlicer-Config-Bundle-`.ini`-Datei
4. Die Filamente werden geparst und in die Datenbank eingefügt bzw. aktualisiert

---

## Option 2: CLI-Seed-Skript

Das Seed-Skript erzeugt zusätzlich Düsenkonfigurationen aus PrusaSlicers `compatible_printers_condition` und verknüpft sie automatisch mit den Filamenten.

### Standardpfad

Standardmäßig sucht das Skript das Config Bundle unter `~/Downloads/PrusaSlicer_config_bundle.ini`.

```bash
npx tsx scripts/seed.ts
```

### Benutzerdefinierter Pfad

Übergib den Dateipfad als Argument:

#### macOS / Linux

```bash
npx tsx scripts/seed.ts /path/to/your/PrusaSlicer_config_bundle.ini
```

#### Windows

```powershell
npx tsx scripts/seed.ts C:\Users\YourName\Downloads\PrusaSlicer_config_bundle.ini
```

### Beispielausgabe

```
Reading INI file: /path/to/PrusaSlicer_config_bundle.ini
Parsed 27 filament profiles

Found 5 unique nozzle configurations:
  ✓ 0.4mm (0.4mm, standard)
  ✓ 0.4mm HF (0.4mm, high-flow)
  ✓ 0.6mm (0.6mm, standard)
  ...

Importing filaments:
  ✓ 3D-Fuel PCTG CF (Spectrum - PCTG) [0.4mm]
  ✓ Generic HIPS MultiMaterial (Generic - HIPS) [0.4mm, 0.6mm]
  ...

Seeded 27 filaments and 5 nozzles successfully!
```

Beim erneuten Ausführen des Seed-Skripts werden bestehende Filamente (anhand des Namens gematcht) aktualisiert, ohne Duplikate zu erzeugen.

---

## Import aus einem Technical Data Sheet (AI)

Extrahiere Filamenteigenschaften automatisch aus dem Datenblatt eines Herstellers mit AI. Funktioniert mit PDF- und Web-TDS-URLs.

### Voraussetzungen

Konfiguriere einen AI-Provider-API-Key unter **Einstellungen > AI-Funktionen**. Unterstützte Anbieter:

- **Google Gemini** — kostenlose Stufe (15 Anfragen/Min), Key unter [Google AI Studio](https://aistudio.google.com/apikey)
- **Anthropic Claude** — pay-per-use, Key unter [Anthropic Console](https://console.anthropic.com/settings/keys)
- **OpenAI ChatGPT** — pay-per-use, Key unter [OpenAI Platform](https://platform.openai.com/api-keys)

Alternativ kannst du eine Umgebungsvariable setzen: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` oder `OPENAI_API_KEY`.

### Benutzung

1. Klicke auf der Startseite auf **„+ Filament hinzufügen"**
2. Klicke auf **„Aus TDS importieren"** in der „Vorbefüllen von"-Werkzeugleiste
3. Füge eine TDS-URL ein (z. B. `https://bambulab.com/filament-tds.pdf`)
4. Klicke auf **Extrahieren** — die AI analysiert das Dokument und gibt strukturierte Daten zurück
5. Das Formular wird automatisch mit den extrahierten Feldern befüllt (Name, Hersteller, Typ, Temperaturen, Dichte, Trockenangaben, Tg, HDT, Shore-Härte, Druckgeschwindigkeiten, Gewichte)
6. Prüfe, passe an und klicke auf **Filament erstellen**

---

## Prusament-Spulen-Import

Prusament-Filamentspulen haben einen QR-Code, der auf eine Detailseite mit Spezifikationen (Material, Farbe, Temperaturen, Gewicht, Herstellungsdatum, Durchmessertoleranzen, Preise) verweist.

1. Scanne den QR-Code auf der Spule oder lies die Spulen-ID vom Etikett ab
2. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„Prusament QR"** (oder klicke **„+ Prusament QR"** im Spulen-Tracker eines Filaments)
3. Trage die Spulen-ID (z. B. `c6974284da`) ein oder füge die vollständige URL ein
4. Prüfe die extrahierten Daten und wähle:
   - **Neues Filament** — erstellt einen voll befüllten Filament-Eintrag
   - **Spule zu bestehendem Filament hinzufügen** — fügt die Spule einem passenden Filament hinzu
5. Klicke auf **Importieren**

Funktioniert auch von der Detailseite eines Filaments, um eine weitere Spule desselben Materials hinzuzufügen.

---

## CSV-/XLSX-Import

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„Datei importieren (INI / CSV / XLSX)"** — die App leitet anhand der Dateierweiterung weiter (`.csv` → CSV-Importer, `.xlsx` → XLSX-Importer, `.ini` → PrusaSlicer-Bundle)
2. Wähle eine Datei mit einer Kopfzeile, die mindestens die Spalten `Name`, `Vendor` und `Type` enthält (max. 10 MB)
3. Weitere unterstützte Spalten: `Color`, `Color Name`, `Diameter`, `Cost`, `Density`, `Nozzle Temp`, `Bed Temp`, `Nozzle First Layer`, `Bed First Layer`, `Max Volumetric Speed`, `Spool Weight`, `Net Filament Weight`, `TDS URL`, `Instance ID`, `Drying Temp`, `Drying Time`, `Transmission Distance` (HueForge TD), `Glass Transition` / `Tg`, `Heat Deflection` / `HDT`, `Shore A`, `Shore D`, `Min Print Speed`, `Max Print Speed`, `Nozzle Range Min`, `Nozzle Range Max`, `Standby Temp`, `Spool Type`
4. Spaltennamen werden case-insensitiv mit üblichen Aliassen gematcht (z. B. „HueForge TD" wird auf Transmission Distance gemappt, „Tg" auf Glass Transition)
5. Nur in der Datei vorhandene Felder werden aktualisiert — bestehende Daten für nicht zugeordnete Spalten bleiben erhalten
6. Zeilen, denen Pflichtfelder fehlen (Name, Vendor oder Type), werden übersprungen — die Antwort enthält ein `skippedRows`-Array mit Zeilennummern und Begründungen

---

## Snapshot wiederherstellen

Du kannst einen zuvor exportierten Snapshot wiederherstellen, um die Kerndaten der App zurückzuspielen: Filamente, Düsen, Drucker, Druckbett-Typen, Standorte, Druckverlauf und Shared Catalogs (inklusive soft-gelöschter Dokumente und Tombstones).

1. Gehe zu **Einstellungen → Sicherung & Wiederherstellen** und klicke auf **„Aus Snapshot wiederherstellen"**
2. Wähle eine Snapshot-JSON-Datei (exportiert via **„Snapshot herunterladen"**)
3. Alle aktuellen snapshot-relevanten Daten werden durch die Snapshot-Inhalte ersetzt
4. Die Wiederherstellung nutzt einen Best-Effort-Rollback — bei einem Fehler versucht der Handler, die vorherigen Daten erneut einzufügen

---

## CSV-/XLSX-Export

Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„CSV exportieren"** oder **„XLSX exportieren"**, um alle Filamente herunterzuladen. Der Export enthält Name, Hersteller, Typ, Farbe, Farbname, Temperaturen (Düse, Bett, Erste Schicht, Bereiche, Standby), Kosten, Dichte, Gewichte, Instance-ID, Trockeneinstellungen, Transmission Distance, Glass Transition (Tg), Heat Deflection (HDT), Shore-Härte (A/D), Druckgeschwindigkeitsbereiche, Spool-Typ und (seit v1.30.3) zwei Spalten, die die Eltern-/Variantenbeziehung sichtbar machen:

- **Parent** — Name des Elternfilaments, wenn diese Zeile eine Variante ist; leer für Roots und eigenständige Filamente.
- **Variant Count** — Anzahl der Varianten dieses Filaments (>0 nur für Eltern mit Varianten).

Varianten erben weiterhin die Druckwerte ihres Elternfilaments (diese werden in jede Variantenzeile geflättet), die beiden neuen Spalten sind also der *einzige* Weg, den Eltern-/Varianten-Baum aus einem Export zu rekonstruieren.

Der Spulen-CSV-Export (`/api/spools/export-csv`) spiegelt diese beiden Spalten auf Spulenebene.

> Slicer-Exporte (PrusaSlicer `.ini` / OrcaSlicer `.json` / Bambu Studio `.json`) bleiben absichtlich flach — Slicer kennen das Konzept „Variante" nicht und brauchen jedes Preset als eigenständigen Eintrag.

---

## Import aus der OpenPrintTag-Community-Datenbank

Durchstöbere die [OpenPrintTag-Community-Datenbank](https://github.com/OpenPrintTag/openprinttag-database) (Tausende FDM-Materialien von vielen Marken; der Untertitel des Browsers zeigt die Live-Anzahl aus der Upstream-Datenbank) und importiere gezielt Filamente in deine Bibliothek.

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„OpenPrintTag-DB durchsuchen"**
2. Der Browser lädt alle FDM-Filamente aus der OpenPrintTag-Datenbank (SLA-Harze werden herausgefiltert)
3. Nutze die Seitenleiste zum Filtern nach:
   - **Suche** — nach Name oder Marke filtern
   - **Sortierung** — nach Name, Marke, Typ oder Vollständigkeits-Score
   - **Datenqualität** — Filter nach Rich (grün, 7–10 Felder), Partial (gelb, 4–6 Felder) oder Stub (grau, 0–3 Felder)
   - **Typ** — nach Materialtyp filtern (PLA, PETG, ABS usw.)
   - **Marke** — nach Hersteller filtern (durchsuchbar)
4. Klicke eine Materialzeile an, um eine Detailansicht zu öffnen:
   - **Identität** — Marke, Typ, Farbswatch, UUID
   - **Eigenschaften** — Dichte, Temperaturen (Düse, Bett, Kammer, Trocknen), Härte, Transmission Distance
   - **Datenqualität & Links** — Vollständigkeits-Score-Balken, Foto, Produkt-URL
5. Wähle Materialien per Checkbox aus (oder **Alle auswählen** / **Auswahl löschen** in der Werkzeugleiste)
6. Klicke auf **Auswahl importieren (N)**, um die ausgewählten Materialien zu importieren
7. Importierte Filamente werden anhand von Name und Hersteller gematcht — bestehende Filamente werden aktualisiert (nur leere Felder werden ergänzt), neue Filamente werden angelegt

Stub-Einträge (Vollständigkeits-Score 0–3) werden mit 50 % Deckkraft dargestellt, um auf die spärlichen Daten hinzuweisen.

---

## PrusaSlicer-Live-Sync

Wenn du [PrusaSlicer Filament Edition](https://github.com/hyiger/PrusaSlicer) nutzt, synchronisieren sich Filament-Presets automatisch via REST-API:

1. Baue und starte die PrusaSlicer Filament Edition (Build-Anleitung in der README des Forks)
2. Starte Filament DB (Desktop-App oder im Web unter `http://localhost:3456`)
3. In PrusaSlicer erscheinen die Filament-Presets aus Filament DB beim Start in der Filament-Dropdown-Liste
4. Kalibrierungswerte (EM, Max Volumetric Speed, Pressure Advance, Retraction) werden dynamisch angewandt, wenn Drucker/Düse wechseln — sie werden via `GET /api/filaments/:name/calibration` abgerufen

PrusaSlicer Filament Edition lädt die Basis-Presets beim Start aus `GET /api/filaments/prusaslicer` (eine Section pro Filament). Kalibrierungs-Overrides werden separat pro Drucker-/Düsenkontext angefragt. Du kannst ein PrusaSlicer-Config-Bundle auch wieder zurück in Filament DB importieren via `POST /api/filaments/prusaslicer`.

---

## Export nach PrusaSlicer INI

Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„INI exportieren"**, um alle Filamente als PrusaSlicer-kompatible INI-Datei herunterzuladen. Die Datei enthält alle gespeicherten Einstellungen pro Filament und kann über **Datei > Importieren > Config Bundle importieren...** zurück in PrusaSlicer geladen werden.

Jedes Filament erzeugt einen `[filament:Name]`-Abschnitt. Kalibrierungs-Overrides sind nicht enthalten — sie werden dynamisch über die Kalibrierungs-API angewandt.
