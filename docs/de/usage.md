> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../usage.md) maßgeblich.

# Anwendung verwenden

[< Zurück zur README](../../README.md)

## Filamente durchsuchen

Die Startseite zeigt alle Filamente in einer sortierbaren Tabelle mit Spalten für Farbe, Name, Vendor, Typ, Düsentemperatur, Betttemperatur, Kosten und verbleibender Spulen-Prozentangabe.

- **Statistik**: Klicke die Zusammenfassungszeile (z. B. „18 Filamente · 8 Typen · 5 Vendors"), um eine Tafel mit Balkendiagrammen nach Typ und Vendor sowie ein Farbswatch-Grid auszuklappen
- **Suche**: Tippe in das Suchfeld, um Filamente nach Namen zu filtern
- **Filter nach Typ**: Nutze die Typ-Dropdown-Liste, um nur bestimmte Materialtypen anzuzeigen (PLA, PETG, ASA usw.)
- **Filter nach Vendor**: Nutze die Vendor-Dropdown-Liste, um nur Filamente eines bestimmten Herstellers anzuzeigen
- **Sortieren**: Klicke einen Spaltenkopf, um auf-/absteigend zu sortieren. Die aktive Sortierspalte ist mit einem blauen Pfeil hervorgehoben

## Filament-Details ansehen

Klicke einen Filamentnamen in der Tabelle, um alle Details zu sehen:

- Temperatureinstellungen (Düse, Bett, Kammer, Erste-Schicht-Varianten)
- Physikalische Eigenschaften (Kosten, Dichte, Durchmesser)
- Performance-Einstellungen (Max Volumetric Speed, Extrusion Multiplier, Pressure Advance)
- Kompatible Düsen und Pro-Drucker-Pro-Düse-Kalibrierungswerte (EM, Max Vol Speed, PA, Retraction)
- Technical Data Sheet — klicke „Technical Data Sheet anzeigen" für eine eingebettete Vorschau oder „In neuem Tab öffnen" für Vollbild
- Vererbungsinformationen (Verweis auf Basisprofil)
- Ein **Technische Referenz**-Panel — das Kapitel der FDM-Polymer-Referenz, das zum Materialtyp des Filaments passt (blendet sich aus, wenn der Typ keinem Kapitel entspricht)

## Neues Filament hinzufügen

1. Klicke oben rechts auf **„+ Filament hinzufügen"**
2. Optional die Werkzeugleiste **„Vorbefüllen von"** nutzen, um das Formular vorab zu befüllen:
   - **Lege einen NFC-Tag** auf den Reader, um aus OpenPrintTag-Daten automatisch zu befüllen (nur Desktop)
   - **Aus TDS importieren** — extrahiert Eigenschaften aus einer Technical-Data-Sheet-URL per AI (erfordert API-Key — siehe [AI-Einstellungen](#ai-einstellungen))
   - **Prusament QR** — lädt Specs aus einem Prusament-Spulen-QR-Code
   - **Aus INI laden** — wählt ein Profil aus einem PrusaSlicer-Config-Bundle
   - **Bestehendes duplizieren** — kopiert Identifikationsfelder eines anderen Filaments und erbt dessen Einstellungen als Variante. (Auf der Detailseite eines Filaments steht zusätzlich ein dedizierter **„Variante erstellen"**-Button bei Root-Filamenten — schnellster Weg, wenn du das Eltern-Filament bereits kennst.)
3. Pflichtfelder ausfüllen (Name, Vendor, Typ)
4. Optional Temperaturen, Kosten, Dichte, Farbe, Lüftereinstellungen, Retraction, Schwindung, Pressure Advance und andere Eigenschaften setzen
5. Kompatible Düsen auswählen und Pro-Düse-Kalibrierungs-Overrides eintragen
6. Einen TDS-Link hinzufügen (Vorschläge anderer Filamente desselben Vendors erscheinen automatisch)
7. Klicke auf **„Filament erstellen"**

## Filament bearbeiten

1. Klicke **„Bearbeiten"** neben einem Filament in der Liste oder **„Bearbeiten"** auf der Detailseite
2. Ändere die gewünschten Felder
3. Klicke auf **„Filament aktualisieren"**

## Filament löschen

Es gibt zwei Wege zu löschen:

- **Aus der Filament-Liste** — hake eine oder mehrere Checkboxen neben Zeilen an. Eine rote Auswahlleiste über der Tabelle erscheint mit **„{Anzahl} löschen"**; klicke sie an und bestätige.
- **Von der Detailseite** — klicke den roten **Löschen**-Button in der Aktionsleiste oben rechts (seit v1.29). Er löst dasselbe Soft-Delete aus und ist schneller, wenn das Filament bereits geöffnet ist.

Das Löschen ist **soft** — Filamente landen im **Papierkorb**, statt endgültig zu verschwinden. Die Auswahlleiste enthält einen kleinen „Papierkorb öffnen"-Link, sodass das Ziel beim Löschen sichtbar ist.

Eltern-Filamente, die noch Farbvarianten haben, werden vom Löschen blockiert — entferne oder verlagere die Varianten zuerst.

### Aus dem Papierkorb wiederherstellen oder endgültig löschen

Gehe zu `/trash` (auch über **Einstellungen → Papierkorb** erreichbar). Jede Zeile zeigt, wann das Filament gelöscht wurde, plus zwei Aktionen:

- **Wiederherstellen** — macht das Löschen rückgängig und holt das Filament zurück in die reguläre Liste. Wenn du in der Zwischenzeit ein neues aktives Filament mit demselben Namen angelegt hast, wird die Wiederherstellung mit 409 abgelehnt — benenne eins der beiden zuerst um.
- **Endgültig löschen** — hard-Delete in MongoDB. Kann nicht rückgängig gemacht werden. Der Button ist nur bei Filamenten verfügbar, die bereits im Papierkorb sind; ein aktives Filament muss als Sicherheitsschritt erst soft-gelöscht werden.

Die Papierkorb-Seite hat zusätzlich eine **Papierkorb leeren**-Aktion, die alles auf einmal endgültig löscht (Varianten werden vor Eltern-Filamenten gepurged, damit die No-Orphan-Refs-Bedingung eingehalten wird).

---

## Mehrfarbige Filamente *(v1.33)*

Manche Filamente tragen mehr als eine Farbe in einem einzigen Strang — dreifarbige Silks (coextrudiert), Verlauf-/Rainbow-Rollen (allmählicher Farbwechsel) und zweifarbige Materialien. Filament DB modelliert das nativ und folgt dabei der OpenPrintTag-Spezifikation.

### Farben bearbeiten

Öffne ein Filament und scrolle zum Abschnitt **Farben** im Formular. Jedes Filament hat:

- **Anordnung** — eine der folgenden:
  - **Solid** — eine einzige Farbe (Standard für die meisten Filamente)
  - **Coextrudiert** — mehrere Farben liegen nebeneinander quer zum Strang (konstant entlang der Länge)
  - **Verlauf** — die Farbe wechselt entlang der Länge beim Vorschub (Color-Change / Rainbow)
- **Primärfarbe** — die einzige Hauptfarbe. Kann bei coextrudierten Filamenten leer bleiben, wenn kein Slot „die" Primärfarbe ist.
- **Sekundärfarben (0–5)** — bis zu fünf zusätzliche Farb-Slots in Anzeigereihenfolge. Verwende die **+ Farbe hinzufügen** / × Buttons zum Hinzufügen und Entfernen.

Eine Live-Vorschau neben dem Editor zeigt, wie das Filament in der Liste gerendert wird — Streifen für coextrudiert, weicher Verlauf für gradient, einfache Füllung für solid. Die Auswahl „Coextrudiert" leert automatisch die Primärfarbe, damit die Sekundär-Slots das gesamte Streifenmuster definieren; ein Wechsel zurück zu „Solid" oder „Verlauf" stellt einen Primärfarb-Slot wieder her.

### Anzeige-Regeln

- **List- und Detail-Swatches** rendern die vollständige Farbanordnung. Filamente mit mindestens einer Sekundärfarbe zeigen zusätzlich ein kleines Farbanzahl-Badge.
- **Varianten** erben `secondaryColors` vom übergeordneten Filament nach demselben Schema wie andere Array-Felder (`optTags`, `bedTypeTemps`) — eine Variante deklariert entweder ihr eigenes nicht-leeres Array oder erbt das vollständige Array des Eltern-Filaments. Eine Variante auf `[]` zu setzen löscht NICHT, sondern fällt auf das Eltern-Filament zurück. Für einfarbige Darstellung muss mindestens ein Sekundär-Slot gesetzt oder eine andere `optTags`-Anordnung gewählt werden.

### NFC und OpenPrintTag

Filament DBs NFC-Reader/Writer kodiert die vollständige Farbanordnung in OpenPrintTag-Felder (`primary_color`, `secondary_color_0..4` und die Tags `coextruded` / `gradual_color_change`). Beim Scannen eines mehrfarbigen OpenPrintTag-Tags füllt das Formular jeden Slot in der richtigen Reihenfolge vor. Bambus MIFARE-Tag-Format trägt nur eine einzige Farbe, daher füllt das Lesen eines Bambu-Tags nur die Primärfarbe.

### Slicer-Export-Hinweis

PrusaSlicer, OrcaSlicer und Bambu Studio-Voreinstellungen sind einfarbige Formate — es gibt keinen Schlüssel für mehrere Farben. Beim Export eines mehrfarbigen Filaments als Slicer-Voreinstellung:

- Die **Primärfarbe** wird exportiert.
- Wenn die Primärfarbe leer ist (coextrudiert), wird die **erste Sekundärfarbe** an deren Stelle exportiert.
- Wenn beide leer sind (ein frisch erstelltes coextrudiertes Filament ohne Sekundärfarben), wird `filament_colour` komplett weggelassen und der Slicer verwendet seine eigene Standardfarbe — Filament DB erfindet keine Farbe, die du nicht gewählt hast.
- **Sekundärfarben jenseits der Primärfarbe werden stillschweigend verworfen.**

Das „Für Slicer exportieren"-Aufklappmenü auf der Detailseite eines mehrfarbigen Filaments zeigt einen bernsteinfarbenen Hinweis, der diesen Kompromiss vor dem Download explizit macht.

### CSV-Import/-Export

Der Filament-CSV-Export enthält eine Spalte **Secondary Colors** mit kommagetrennten Hex-Codes (z. B. `#FF0000,#00FF00,#0000FF`). Der Importer erkennt dieselbe Spalte beim Re-Import: Er parst bis zu 5 Hex-Codes, verwirft fehlerhafte Einträge und bewahrt eine leere Primärfarbe, wenn die Zelle `Color` der Zeile leer ist und `Secondary Colors` befüllt ist (coextruded Round-Trip).

---

## Bulk-Import / -Export

Zwei Wege zu den Bulk-Daten-Aktionen:

- **Filament-Liste → „Importieren/Exportieren"-Dropdown** in der Aktionsleiste. Praktisch, wenn du gerade Filamente verwaltest.
- **Einstellungen → Importieren/Exportieren** (oder direkt `/import-export`). Gleiche Aktionen als beschriftete Kacheln präsentiert, nützlich zum Entdecken und Bookmarken.

Beide Oberflächen decken ab:

- **Filamente importieren** — Prusament-QR-Scan, Atlas-Import, OpenPrintTag-Browse, Datei-Upload (CSV / XLSX / PrusaSlicer INI). Vollständige DB-Snapshots werden unter Einstellungen → Sicherung & Wiederherstellen wiederhergestellt.
- **Spulen importieren** — Bulk-CSV mit einer Zeile pro Spule
- **Filamente exportieren** — PrusaSlicer-INI-Bundle, CSV oder XLSX
- **Spulen exportieren** — CSV-Inventar mit Location und Lot-Nummer

Ein separater **Snapshot**-Workflow auf der Einstellungen-Seite kümmert sich um vollständige DB-Sicherung/-Wiederherstellung (Filamente + Düsen + Drucker + Druckbett-Typen + Locations + Druckverlauf + Shared Catalogs in einer JSON-Datei).

---

## Aus MongoDB Atlas importieren

Du kannst Filamente aus einer anderen Filament-DB-Instanz auf MongoDB Atlas importieren:

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„Aus Atlas importieren"**
2. Trage die MongoDB-Atlas-Verbindungszeichenfolge ein (z. B. `mongodb+srv://user:pass@cluster.mongodb.net/`)
3. Klicke auf **„Verbinden"** — die App ruft alle Filamente aus der Remote-Datenbank ab
4. Wähle, welche Filamente importiert werden sollen (standardmäßig alle). Nutze **„Alle auswählen"** / **„Auswahl aufheben"** zum Umschalten
5. Klicke auf **„Importieren"**, dann **„Import bestätigen"**
6. Bestehende Filamente mit demselben Namen werden aktualisiert; neue Filamente werden angelegt

Eltern-/Varianten-Beziehungen aus der Remote-DB werden nicht erhalten — alle importierten Filamente sind eigenständig.

---

## Verbindungsstatus-Anzeige

Eine Status-Pille erscheint neben dem „Filament DB"-Titel auf der Startseite und zeigt den aktuellen Verbindungszustand:

### Web-App

| Indikator | Bedeutung |
|-----------|-----------|
| 🟢 **Connected** | Browser hat Netzwerkverbindung |
| 🔴 **Offline** | Keine Netzwerkverbindung |

### Desktop-App — Atlas-Modus

| Indikator | Bedeutung |
|-----------|-----------|
| 🟢 **Connected** | Atlas ist erreichbar (per regelmäßigem Ping bestätigt) |
| 🟡 **No Connection** | Atlas ist nicht erreichbar; nutzt lokalen Fallback, wenn Atlas beim Start nicht erreichbar war |

### Desktop-App — Hybrid-Modus

| Indikator | Bedeutung |
|-----------|-----------|
| 🟢 **Synced 2m ago** | Letzter Sync war erfolgreich |
| 🔵 **Syncing...** | Sync läuft (pulsierender Punkt) |
| 🟡 **Offline** | Kein Netzwerk; nutzt lokale Daten, synchronisiert bei erneuter Verbindung |
| 🔴 **Sync error** | Letzter Sync-Versuch ist fehlgeschlagen |

Klicke die Pille, um einen Tooltip mit Modus, Netzwerkstatus, Zeitstempel des letzten Syncs, Fehlerdetails und einem **„Jetzt synchronisieren"**-Button für manuellen Sync zu öffnen. Automatischer Sync läuft alle 5 Minuten, wenn Atlas erreichbar ist.

Synchronisierte Sammlungen: filaments (mit eingebetteten Spulen), nozzles, printers, locations, bedtypes, printhistories, sharedcatalogs. Der Sync verwendet **Last-Write-Wins**-Konfliktauflösung: Wurde dasselbe Filament auf beiden Seiten bearbeitet, gewinnt die zuletzt aktualisierte Version (pro Dokument, basierend auf `updatedAt`-Zeitstempel). Soft-Deletes propagieren über `_deletedAt`.

### Desktop-App — Offline-Modus

| Indikator | Bedeutung |
|-----------|-----------|
| ⚪ **Local** | Alle Daten lokal gespeichert (immer angezeigt) |

---

## Sprache

Gehe zu **Einstellungen** und nutze den **Sprache**-Umschalter, um zwischen Englisch und Deutsch zu wechseln. Die Einstellung wird in der Desktop-App-Konfiguration persistiert (oder im localStorage der Web-App) und greift sofort auf allen Seiten.

---

## Düsen verwalten

Gehe zu **Einstellungen** und klicke auf **Düsen**, um Düsenprofile anzusehen, anzulegen, zu bearbeiten und zu löschen.

Jede Düse hat:
- **Durchmesser** (0.25 mm, 0.4 mm, 0.6 mm usw.)
- **Typ** (Messing, gehärteter Stahl, Edelstahl, ObXidian, Diamondback usw.)
- **High Flow**-Flag
- **Hardened**-Flag
- **Installiert in** — den einen Drucker, in dem diese physische Düse aktuell installiert ist, aus einer Radio-Liste gewählt (oder **Nicht in einem Drucker installiert**). Eine Düse kann nur in einem Drucker gleichzeitig sein; wählst du hier einen Drucker, wird sie aus dem vorherigen entfernt.
- **Notizen**

---

## Druckbett-Typen verwalten

Gehe zu **Einstellungen** und klicke auf **Druckbett-Typen**, um Druckbett-Typ-Profile anzusehen, anzulegen, zu bearbeiten und zu löschen.

Jeder Druckbett-Typ hat:
- **Name** (z. B. „Smooth PEI", „Textured PEI", „G10/FR4")
- **Material** — die Oberflächenmaterial-Art (PEI, Textured PEI, Federstahl, Glas, G10/FR4, BuildTak, PEX, Polypropylen, Sonstiges)
- **Notizen**

Druckbett-Typen werden in Kalibrierungen verwendet, um Pro-Drucker-Pro-Düse-Pro-Druckbett-Typ-Override-Werte zu speichern. Sie können nicht gelöscht werden, solange eine Filament-Kalibrierung sie referenziert, sie auf einem Drucker installiert sind oder eine Filament-Pro-Druckbett-Typ-Temperaturtabelle sie namentlich nennt — die Fehlermeldung zeigt, was das Löschen blockiert.

---

## Drucker verwalten

Gehe zu **Einstellungen** und klicke auf **Drucker**, um Druckerprofile anzusehen, anzulegen, zu bearbeiten und zu löschen.

Jeder Drucker hat:
- **Hersteller** (z. B. Prusa, Bambu Lab)
- **Modell** (z. B. Core One, X1C)
- **Name** — automatisch aus Hersteller + Modell erzeugt, aber editierbar
- **Installierte Düsen** — die physisch in diesem Drucker installierten Düsen. Ein Drucker kann mehrere haben (z. B. Toolchanger oder Multi-Head), aber jede physische Düse kann nur in einem Drucker gleichzeitig installiert sein.
- **Multi-Material-Slots (AMS / MMU)** — optional; definiere einen Slot pro AMS/MMU-Position, um zu verfolgen, welche Spule wo geladen ist (siehe [Drucker-Slot-Zuweisung](#drucker-slot-zuweisung-v121))
- **Notizen**

Drucker können nicht gelöscht werden, wenn Filament-Kalibrierungen sie referenzieren. Die Fehlermeldung zeigt, wie viele Filamente den Drucker referenzieren.

---

## Kalibrierungen

Beim Bearbeiten eines Filaments erscheint unter den Kompatible-Düsen-Checkboxen der Abschnitt **„Kalibrierungen"**. Für jede ausgewählte Düse kannst du Override-Werte eintragen für:

**Kalibrierungsfelder:**
- Extrusion Multiplier (EM)
- Max Volumetric Speed (mm³/s)
- Pressure Advance (PA)
- Retraction Length (mm)
- Retraction Speed (mm/s)
- Z Lift (mm)

**Temperatur-Overrides** (pro Kalibrierungseintrag):
- Düsentemperatur / Düsentemperatur 1. Schicht
- Betttemperatur / Betttemperatur 1. Schicht
- Kammertemperatur

**Lüftereinstellungen** (pro Kalibrierungseintrag):
- Min Fan Speed (%)
- Max Fan Speed (%)
- Bridge Fan Speed (%)

### Pro-Drucker-Kalibrierungen

Wenn du Drucker definiert hast, erscheinen oberhalb der Kalibrierungsfelder **Drucker-Tabs**. Jeder Tab steht für einen Drucker (plus ein „Default (jeder Drucker)"-Tab für Werte, die für alle Drucker gelten).

- **Default-Tab** — Kalibrierungswerte, die gelten, wenn kein drucker-spezifischer Override existiert
- **Drucker-Tabs** — Kalibrierungswerte spezifisch für diesen Drucker. Platzhalter-Werte zeigen den Default-Kalibrierungswert, sodass du siehst, was du überschreibst.

### Pro-Druckbett-Typ-Kalibrierungen

Wenn du Druckbett-Typen definiert hast, erscheint innerhalb jedes Düsen-Abschnitts ein **Druckbett-Typ-Selektor**. Wähle einen Druckbett-Typ (oder „Jedes Bett" für den Default), um Kalibrierungswerte spezifisch für diese Druckbett-Oberfläche einzutragen.

So kannst du unterschiedliche Temperaturen, PA-, EM- und Retraction-Werte für dasselbe Filament auf verschiedenen Drucker- + Düsen- + Druckbett-Typ-Kombinationen speichern (z. B. Smooth PEI auf einem Prusa Core One vs. Textured PEI auf einem Bambu H2D).

Felder leer lassen, um die Basis-Defaults des Filaments zu verwenden. Top-Level-Filament-Temperaturen bleiben als hersteller-empfohlene Defaults. Der INI-Export nutzt eine Single-Section-pro-Filament-Architektur: Jedes Filament erzeugt einen `[filament:Name]`-Abschnitt mit seinen Basis-Einstellungen. Kalibrierungs-Overrides werden nicht in die INI eingebettet — PrusaSlicer Filament Edition lädt sie dynamisch via `GET /api/filaments/{id}/calibration`, wenn du Drucker oder Düse wechselst.

---

## Technical Data Sheets

Jedes Filament kann einen TDS-Link (Technical Data Sheet) haben. Im Bearbeitungs-Formular:

- Trage die URL in das **„TDS-Link"**-Feld ein
- Ist das Feld leer, erscheinen Vorschlagsbuttons anderer Filamente desselben Vendors — klicke einen, um die URL automatisch zu füllen

Auf der Detailseite:

- Klicke **„Technical Data Sheet anzeigen"**, um eine eingebettete Vorschau zu öffnen
- Klicke **„In neuem Tab öffnen"**, um das vollständige Dokument in einem neuen Browser-Tab zu sehen

---

## NFC-Tags (nur Desktop-App)

Die Desktop-App unterstützt Lesen und Schreiben von OpenPrintTag-NFC-V-Tags und Lesen von Bambu-Lab-MIFARE-Classic-Spulen-Tags. Siehe [NFC-Dokumentation](nfc.md) für Hardware-Voraussetzungen und Setup.

### Tags lesen

Lege einen Tag auf den Reader — die App erkennt den Tag-Typ automatisch (OpenPrintTag oder Bambu Lab) und liest ihn. Ein Dialog zeigt:

- **Treffer gefunden**: zeigt das passende Filament mit Link zur Detailseite
- **Kein Treffer**: zeigt die dekodierten Daten mit Option, ein neues Filament anzulegen (Formular mit Tag-Daten vorbefüllt)
- **Bambu-Lab-Spulen**: zeigt ein „read-only"-Badge, da Bambu-Tags nicht beschrieben werden können; zeigt zusätzlich Produktionsdatum und Filamentlänge

### Tags schreiben

Auf der Detailseite eines beliebigen Filaments:

1. Lege einen Tag auf den Reader (Status wird grün)
2. Klicke auf **„NFC schreiben"**
3. Warte, bis der Schreibvorgang abgeschlossen ist (Button zeigt „Geschrieben!" bei Erfolg)

### Tags löschen / formatieren

Auf der **Einstellungen**-Seite kannst du im Abschnitt NFC-Tools einen Tag löschen:

1. Lege einen Tag auf den Reader (Status wird grün)
2. Klicke **„Tag löschen"** und bestätige
3. Der Tag wird geleert — leerer CC-Header, Terminator und genullter Speicher

### OpenPrintTag-Binärdatei exportieren

Klicke **„OPT exportieren"** auf der Detailseite eines Filaments, um die Binärdatei als `.bin`-Datei für externe NFC-Tools herunterzuladen.

---

## AI-gestützter TDS-Import

Extrahiere Filament-Eigenschaften automatisch aus dem Datenblatt eines Herstellers mit AI. Unterstützt PDF- und Web-TDS-URLs.

### Setup

1. Gehe zu **Einstellungen** und scrolle zum Abschnitt **AI-Funktionen**
2. Wähle deinen bevorzugten AI-Provider: **Google Gemini**, **Anthropic Claude** oder **OpenAI ChatGPT**
3. Hole einen kostenlosen API-Key vom gewählten Provider (Links sind auf der Einstellungen-Seite hinterlegt)
4. Füge den Key ein und klicke auf **Key speichern** — der Key wird vor dem Speichern validiert

### TDS-Import nutzen

1. Klicke auf der Startseite auf **„+ Filament hinzufügen"**
2. Klicke in der Werkzeugleiste **„Vorbefüllen von"** auf **„Aus TDS importieren"** (lila Button)
3. Füge die URL eines Filament-Datenblatts ein
4. Klicke auf **„Extrahieren"** — die AI analysiert das Dokument und extrahiert Eigenschaften
5. Das Formular wird automatisch mit den extrahierten Daten befüllt (Temperaturen, Dichte, Trockenspezifikationen, Tg, HDT, Shore-Härte, Druckgeschwindigkeiten usw.)
6. Prüfe und passe Felder an, klicke dann auf **„Filament erstellen"**

Die TDS-URL wird zusätzlich im `tdsUrl`-Feld des Filaments für spätere Referenz gespeichert.

### Unterstützte Anbieter

| Anbieter | Modell | Kostenlose Stufe | PDF-Unterstützung |
|----------|--------|------------------|-------------------|
| Google Gemini | gemini-2.0-flash | 15 Anfragen/Min | Nativ |
| Anthropic Claude | claude-sonnet-4-20250514 | Pay-per-use | Nativ |
| OpenAI ChatGPT | gpt-4o-mini | Pay-per-use | Textextraktion |

### AI-Einstellungen

Auf der **Einstellungen**-Seite unter **AI-Funktionen**:

- **Anbieter-Auswahl** — klicke einen Anbieter-Button, um zwischen Gemini, Claude und ChatGPT zu wechseln
- **API-Key** — maskiertes Eingabefeld mit Anzeigen/Verbergen-Umschalter
- **Key speichern** — validiert den Key beim gewählten Anbieter vor dem Speichern
- **Key entfernen** — löscht den gespeicherten Key
- **Statusanzeige** — grüner Punkt bei Konfiguration, grau wenn nicht

In der Desktop-App wird der API-Key in der lokal persistierten Konfigurationsdatei gespeichert. In der Web-App setze den Key über die Einstellungen-Seite oder per Umgebungsvariablen (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY` oder `OPENAI_API_KEY`).

---

## Spulen-Tracking

Jedes Filament kann mehrere physische Spulen mit individuellen Gewichten verfolgen.

### Spulen hinzufügen

Auf der Detailseite eines Filaments wird der Abschnitt **Spulen-Tracker** immer gerendert (seit v1.30.3 / #380). Wenn es noch keine Spulen und keine Gewichtsmetadaten gibt, zeigt der Abschnitt einen kurzen „Noch keine Spulen"-Hinweis über dem **„+ Spule hinzufügen"**-Button — klicke ihn, um eine neue Spule mit optionalem Label und Gewicht anzulegen.

### Spulen verwalten

Jede Spulen-Zeile zeigt:
- **Label** — editierbarer Text (z. B. „Geöffnet 2025-03-15" oder eine Prusament-Spulen-ID)
- **Gesamtgewicht** — Gewicht in Gramm (inklusive leerer Spule)
- **Löschen**-Button zum Entfernen des Spulen-Eintrags

Der Tracker aggregiert Statistiken über alle Spulen und zeigt Gesamt-Restgewicht und berechnete Länge (aus Dichte und Durchmesser).

### Aus Single-Gewicht migrieren

Wenn ein Filament einen `totalWeight`-Wert, aber kein Spulen-Array hat, konvertiert ein **„Mehrere Spulen verfolgen"**-Button das einzelne Gewicht in einen Spulen-Eintrag.

### Spool-Check (PrusaSlicer-Integration)

Wenn du PrusaSlicer Filament Edition verwendest, läuft nach dem Slicen automatisch ein Spool-Check. PrusaSlicer fragt die Filament-DB-API mit dem geschätzten Druckgewicht ab und vergleicht es mit dem verbleibenden Filament jeder Spule. Hat keine Spule genug Material, erscheint in PrusaSlicer eine Warnmeldung.

Der Check erfordert, dass das Filament ein gesetztes **Spulengewicht** (leere Spule) hat und mindestens eine Spule ein **Gesamtgewicht** (aktueller Waagenwert) hat. Sind keine Gewichtsdaten verfügbar, wird der Check stillschweigend übersprungen.

---

## Prusament-Spulen-Import

Prusament-Filamentspulen haben einen QR-Code, der auf eine Detailseite mit vollständigen Specs verlinkt.

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„Prusament QR"**, oder klicke auf **„+ Prusament QR"** im Spulen-Tracker eines Filaments
2. Trage die Spulen-ID (z. B. `c6974284da`) ein oder füge die vollständige URL ein
3. Prüfe die extrahierten Daten (Material, Farbe, Temperaturen, Gewichte, Preise, Durchmessertoleranzen)
4. Wähle **„Neues Filament"**, um einen voll befüllten Eintrag anzulegen, oder **„Spule zu bestehendem hinzufügen"**, um die Spule einem passenden Filament zuzuordnen
5. Klicke auf **Importieren**

Funktioniert auch von der Detailseite eines Filaments, um eine weitere Spule desselben Materials hinzuzufügen.

---

## Spulen-Inventar *(v1.32)*

Die **Inventar**-Seite unter `/inventory` zeigt dieselben Daten wie die Filamentliste, jedoch aus der entgegengesetzten Perspektive — statt „jedes Filament mit seinen Spulen darunter" siehst du „jeden Standort mit den dort gelagerten Filamenten darunter". Nutze sie, um ein Regal oder eine Trockenbox auf einen Blick zu prüfen, oder um häufige Spulen-Details (Etikett, verbleibende Gramm, Standort wechseln, ausmustern) an mehreren Spulen gleichzeitig zu aktualisieren, ohne dich durch jede Filament-Detailseite zu klicken.

Was du siehst:

- **Kopfzeilen-Statistiken** — Gesamtspulenanzahl, Standortanzahl, aktive Gramm im Bestand
- **Filterzeile** — Suche nach Filamentname / Etikett / Lot-Nummer (clientseitig), Filter nach Standortart (Regal, Trockenbox, Drucker, …), Filter nach Filamenttyp oder Vendor, „Ausgemusterte einschließen"-Schalter (standardmäßig aus — ausgemusterte Spulen sind nicht im Bestand)
- **Aufklappbare Gruppe pro Standort** — der Zusammenfassungs-Chip jeder Gruppe zeigt Spulenanzahl und Gesamtgramm. Eine synthetische **„Kein Standort"**-Gruppe fängt jede Spule mit `locationId: null` ab und wird absichtlich an das ENDE der Liste sortiert, damit man Nachzügler als „benötigen Aufmerksamkeit" erkennt statt sie mit dem Hauptbestand zu verwechseln.
- **Spulen-Zeile** — Farbtupfer, Filamentname, Typ, Vendor, Etikett, **Inline-Gewichtseditor** (klicke den Gramm-Wert zum Bearbeiten, Enter zum Speichern, Esc zum Abbrechen), Rest-Prozentbalken, letztes Trocknungsdatum, **„Verschieben nach"**-Dropdown für den Standort der Spule, **Ausmustern/Reaktivieren**-Schalter (Ausmustern zeigt eine Bestätigung, um das Entfernen aus dem Bestand explizit zu machen).

Alle Bearbeitungen laufen über denselben `PUT /api/filaments/{id}/spools/{spoolId}`-Endpunkt wie die Filament-Detailseite, sodass die Semantik — Ausmustern-bei-Null-Prompts, Gewichtsvalidierung, Sync-Verhalten — identisch zur SpoolCard ist.

---

## CSV- und XLSX-Import/-Export

### Exportieren

Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke unter **Export** auf **„CSV"** oder **„Excel (XLSX)"**, um alle Filamente im gewählten Format herunterzuladen. Der Export enthält Name, Vendor, Typ, Farbe, Farbname, Temperaturen (Düse, Bett, Erste Schicht, Bereiche, Standby), Kosten, Dichte, Gewichte, Instance-ID, Trockentemperatur/-zeit, Transmission Distance, Glass Transition (Tg), Heat Deflection (HDT), Shore-Härte (A/D), Druckgeschwindigkeitsbereiche und Spool-Typ.

XLSX-Exporte enthalten gestaltete Kopfzeilen, farbcodierte Zellen, Auto-Filter und eine fixierte Kopfzeile.

### Importieren

Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„Datei importieren (INI / CSV / XLSX)"**, um eine Datei hochzuladen (max. 10 MB). Die App leitet anhand der Erweiterung weiter: `.ini` → PrusaSlicer-Bundle-Import, `.csv` → CSV-Importer, `.xlsx` → XLSX-Importer. Die Datei muss eine Kopfzeile mit mindestens den Spalten `Name`, `Vendor` und `Type` haben. Weitere Spalten werden case-insensitiv anhand des Headers gemappt, inklusive Glass Transition (Tg), Heat Deflection (HDT), Shore-Härte (A/D), Druckgeschwindigkeitsbereiche, Düsentemp-Bereiche, Standby-Temp, Farbname und Spool-Typ. Nur in der Datei vorhandene Felder werden aktualisiert — bestehende Daten für nicht zugeordnete Spalten bleiben erhalten. Zeilen ohne Pflichtfelder werden mit Zeilennummern und Begründungen gemeldet.

---

## Snapshot-Sicherung & -Wiederherstellung

### Snapshot exportieren

Gehe zu **Einstellungen → Sicherung & Wiederherstellen** und klicke auf **„Snapshot herunterladen"**, um einen JSON-Snapshot der Kerndaten der App herunterzuladen. Der Snapshot enthält Filamente, Düsen, Drucker, Druckbett-Typen, Locations, Druckverlauf und Shared Catalogs (inklusive soft-gelöschter Dokumente und Tombstones) mit erhaltenen Referenzen und Zeitstempeln.

### Snapshot wiederherstellen

Gehe zu **Einstellungen → Sicherung & Wiederherstellen** und klicke auf **„Aus Snapshot wiederherstellen"**. Wähle eine zuvor exportierte Snapshot-Datei. Das ersetzt alle aktuellen Daten durch die Snapshot-Inhalte. Die Wiederherstellung nutzt Best-Effort-Rollback — schlägt ein Teil fehl, versucht der Handler, die vorherigen Daten aus einem In-Memory-Backup neu einzufügen.

---

## Instance-IDs

Jedes Filament hat eine eindeutige Instance-ID (5-Byte-Hex-String, z. B. `2acc21072a`), die bei der Erstellung automatisch erzeugt wird. Das entspricht dem `brand_specific_instance_id`-Format von Prusament und wird auf NFC-Tags geschrieben. Instance-IDs sind auf der Filament-Detailseite neben Vendor/Typ sichtbar und in CSV-/XLSX-Exporten enthalten.

---

## Etikettendrucker (nur Desktop-App) *(v1.34)*

Drucke ein Spulen-Etikett (24-mm-Band) direkt von der Filament-Detailseite auf einen **Brother PT-P710BT** (P-touch CUBE). Das Etikett enthält einen (optionalen) QR-Code und konfigurierbaren Text. Zwei QR-Modi, die du pro Druck wählen kannst:

- **Filament-Instanz-ID** — die 5-Byte-Hex-ID des Filaments (z. B. `2acc21072a`). Das ist ein Wert auf **Filament-Ebene** (einer pro Filament — *nicht* pro Spule) und entspricht dem, was auf einem NFC-Tag steht. Er wird vom NFC-Reader in der App und von der Slicer-Integration erkannt; eine Handykamera zeigt nur den rohen Hex-Text, mit dem sich nichts anfangen lässt. Nutze diesen Modus für das NFC-/Slicer-Ökosystem, nicht zum Scannen mit dem Handy.
- **Deep-Link-URL** — eine vollständige URL zur Filament-Detailseite (z. B. `https://meine-instanz.lan/filaments/<id>`). Beim Scannen mit **einem beliebigen Smartphone** öffnet sich die Seite direkt — keine App nötig. Das ist die per Handy scanbare Option. Bei einem Filament mit **mehreren Spulen** erscheint eine Spulenauswahl, sodass der QR eine bestimmte Spule ansteuern kann (`…/filaments/<id>?spool=<spoolId>`); beim Scannen öffnet sich das Filament mit hervorgehobener Spule. *(Spulen-Targeting, v1.35.)*

Deine letzte Auswahl wird als Standard für den nächsten Druck gemerkt.

> **Per USB verbinden, nicht per Bluetooth.** Das Bluetooth des PT-P710BT ist nur für iOS/Android; am Desktop verbindet sich der Drucker per **USB** und erscheint als gewöhnlicher USB-Drucker. Verwende ein USB-C-**Datenkabel** (kein reines Ladekabel). Die App druckt über das Drucksystem deines Betriebssystems — CUPS unter macOS/Linux, den Druckspooler unter Windows. *(Überarbeitet in v1.34.9; frühere Builds nutzten einen nicht unterstützten, instabilen Bluetooth-Serial-Pfad.)*

### Einmalige Einrichtung

1. **Drucker per USB verbinden** und einschalten. Unter macOS/Linux ist er automatisch über CUPS erreichbar; unter Windows als normalen Drucker installieren, falls das Betriebssystem dazu auffordert.
2. **Desktop-App öffnen → Einstellungen → Etikettendrucker**. Klicke auf **Aktualisieren**, um Drucker aufzulisten. Der PT-P710BT erscheint mit einem grünen **PT-Touch**-Badge (unter macOS/Linux als `usb://Brother/PT-P710BT…`-Gerät). Wähle ihn aus.
3. **(Optional) Öffentliche URL für QR-Modus-Etiketten**: Wenn du Etiketten mit Deep-Link-URLs drucken willst, die auch vom Smartphone aus scanbar sind, setze zusätzlich das Feld **Öffentliche Basis-URL**. Der URL-Modus in der Desktop-App benötigt eine Nicht-Localhost-Adresse, weil `window.location.origin` im Renderer `http://localhost:3456` ist — von einem anderen Gerät aus nicht erreichbar. Beispiele: `https://filament-db.lan`, `https://meine-instanz.example.com`. Loopback-Adressen, Query-Strings und URL-Fragmente werden mit einer beschreibenden Fehlermeldung abgelehnt. Lass das Feld leer, um den URL-Modus in der Desktop-App zu deaktivieren — der Instanz-ID-Modus funktioniert auch ohne diese Einstellung.
4. **Test-Druck**: Klicke auf **Test-Etikett drucken**, um ein kurzes Etikett mit deinem gespeicherten Format zu senden. Bestätige, dass der QR scanbar und der Text gestochen scharf ist, bevor du echte Etiketten druckst.

### Etikett anpassen

Unter **Einstellungen → Etikettenformat** legst du fest, wie jedes Etikett aussieht — mit einer Live-Vorschau anhand eines Beispiel-Filaments:

- **QR-Code** — **links**, **rechts** oder **aus** (für ein reines Text-Etikett).
- **Textfelder** — wähle eine Vorlage (*Nur Name*, *Hersteller + Typ*, *Hersteller über Typ*, *Typ + Farbe*) oder schalte einzelne Felder (Name, Hersteller, Typ, Farbe) ein/aus. Mehrere Felder werden als getrennte Zeilen gestapelt (z. B. Hersteller über Typ).
- **Schriftart** — Serifenlos, Serif, Monospace oder Schmal, plus eine Größe (der Renderer passt sie an den Druckkopf an).
- **Ausrichtung** — horizontaler oder vertikaler Text.
- **Invertieren** — weißer Text auf schwarzem Hintergrund. Der QR bleibt dunkel auf hell auf seiner eigenen Kachel, damit er weiterhin scanbar ist.

Das Format ist **global** — es gilt für jedes gedruckte Etikett (und den Web-`.bin`-Download). Der Druckdialog lässt dich weiterhin pro Druck den QR-*Payload* wählen (Filament-Instanz-ID vs. Deep-Link-URL). Es gibt bewusst kein „Restmenge"-Feld: ein gedruckter Wert ist sofort veraltet — scanne stattdessen den QR für den Live-Wert.

### Etiketten drucken

Auf einer beliebigen Filament-Detailseite → **Export ▾** → **Etikett drucken**. Der Dialog rendert eine Live-Vorschau in nativer Druckauflösung (pixelated CSS, damit du siehst was gedruckt wird) mit deinem gespeicherten Format. Wähle den QR-Payload (Filament-Instanz-ID / Deep-Link) — und bei einem Filament mit mehreren Spulen im Deep-Link-Modus, auf welche Spule der QR zeigt —, dann klicke auf **Drucken**.

Wenn du die Web-App statt Electron nutzt, lädt der Drucken-Button stattdessen eine `.bin`-Datei mit dem kodierten Byte-Stream herunter — nützlich zur Inspektion. Lokal mit `npm run label:sim --in <Datei>` decodieren, um zu sehen was gedruckt worden wäre.

### Fehlerbehebung

- **Kein Drucker aufgelistet** in Einstellungen → Etikettendrucker: Stelle sicher, dass der Drucker mit einem USB-**Datenkabel** verbunden (reine Ladekabel versorgen den Drucker, melden ihn aber nicht an) und eingeschaltet ist, dann auf **Aktualisieren** klicken. Unter Linux musst du den Drucker eventuell zuerst in den Systemeinstellungen für Drucker hinzufügen.
- **Upgrade von einem Build vor v1.34.9**: Wenn du zuvor ein Bluetooth-/Serial-Gerät ausgewählt hattest, wähle deinen Drucker in Einstellungen → Etikettendrucker erneut aus. Die App erkennt die alte Serial-Einstellung und bittet dich um eine neue Auswahl, statt kryptisch fehlzuschlagen.
- **Etikett wird gespiegelt gedruckt** (Text rückwärts, QR seitenverkehrt): in v1.34.9 behoben — auf die neueste Version aktualisieren.
- **Nichts gedruckt, obwohl es „erfolgreich" war**: Der PT-P710BT schaltet sich im Leerlauf automatisch ab. Wecke ihn (Power-Taste drücken), prüfe das Band und drucke erneut.

---

## OpenPrintTag-Community-Datenbank-Browser

Durchstöbere die [OpenPrintTag-Community-Datenbank](https://github.com/OpenPrintTag/openprinttag-database) direkt aus Filament DB, um Tausende FDM-Filamente von vielen Marken zu entdecken und zu importieren. Der Untertitel des Browsers zeigt die Live-Anzahl aus der Upstream-Datenbank (sie wächst, je mehr die Community beiträgt).

### Browser öffnen

Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„OpenPrintTag-DB durchsuchen"** (türkiser Punkt). Der Browser lädt beim ersten Aufruf die gesamte Datenbank von GitHub (~3 MB, 1 Stunde lang gecacht).

### Durchsuchen und filtern

Der Browser zeigt nur FDM-Filamente (SLA-Harze werden herausgefiltert). Nutze die Seitenleiste, um Ergebnisse einzuschränken:

- **Suche** — filtere nach Filamentname oder Marke
- **Sortierung** — nach Name, Marke, Typ oder Vollständigkeits-Score
- **Datenqualität** — Filter nach Vollständigkeitsstufe:
  - 🟢 **Rich** (7–10 Felder) — gut dokumentierte Materialien
  - 🟡 **Partial** (4–6 Felder) — mäßig vollständig
  - ⚪ **Stub** (0–3 Felder) — minimale Daten, mit 50 % Deckkraft dargestellt
- **Typ** — Filter nach Materialtyp (PLA, PETG, ABS, TPU usw.)
- **Marke** — Filter nach Hersteller (durchsuchbare Liste mit Materialzählungen)

### Material-Details ansehen

Klicke eine Material-Zeile, um eine Detailansicht mit drei Spalten auszuklappen:

- **Identität** — Marke, Slug, Typkürzel, Farbswatch, UUID
- **Eigenschaften** — Dichte, Düsentemp-Bereich, Betttemp-Bereich, Kammertemp, Trockentemp/-zeit, Shore-Härte, Transmission Distance
- **Datenqualität & Links** — Vollständigkeits-Score-Balken (von 10), Foto-Vorschau, Produkt-URL, Tags

### Materialien importieren

1. Wähle Materialien per Checkboxen aus (oder nutze **Alle auswählen** / **Alle abwählen** in der Werkzeugleiste)
2. Klicke auf **„Auswahl importieren (N)"** zum Import
3. Materialien werden anhand von Name und Hersteller gematcht:
   - **Neue Materialien** werden mit allen verfügbaren Feldern angelegt
   - **Bestehende Materialien** werden konservativ aktualisiert — nur null/leere Felder werden gefüllt, deine vorhandenen Kalibrierungsdaten bleiben erhalten

---

## PrusaSlicer-Integration

### Live-Sync (PrusaSlicer Filament Edition)

Wenn du [PrusaSlicer Filament Edition](https://github.com/hyiger/PrusaSlicer) nutzt, werden Filament-Presets beim Start automatisch aus Filament DB geladen:

1. Starte Filament DB (Desktop-App oder Web unter `http://localhost:3456`)
2. Starte PrusaSlicer Filament Edition
3. Deine Filament-Presets erscheinen in der Filament-Dropdown-Liste; Kalibrierungswerte (EM, Max Volumetric Speed, Pressure Advance, Retraction) werden dynamisch angewandt, wenn du Drucker/Düse wechselst

### Spool-Check (Warnung bei zu wenig Filament)

PrusaSlicer Filament Edition kann nach dem Slicen prüfen, ob die gewählte Spule genug Filament für den Druck hat. Es ruft `GET /api/filaments/{name}/spool-check?weight=XX` mit dem geschätzten Filamentgewicht in Gramm. Hat keine Spule genug Restfilament, zeigt PrusaSlicer eine Warnung mit dem Fehlbetrag. Das erfordert eingerichtetes Spulen-Tracking mit aktuellen Gewichten (siehe [Spulen-Tracking](#spulen-tracking)).

### Manueller INI-Export/-Import

Auch ohne den Fork kannst du manuell synchronisieren:

- **Export**: Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke unter **Export** auf **„INI (PrusaSlicer)"**, um alle Filamente als PrusaSlicer-kompatibles Config-Bundle herunterzuladen
- **Import**: Gehe in PrusaSlicer zu **Datei > Importieren > Config Bundle importieren**, um die exportierte Datei zu laden
- **Re-Import**: Öffne das Dropdown **Importieren/Exportieren** und klicke auf **„Datei importieren (INI / CSV / XLSX)"**, um ein PrusaSlicer-Config-Bundle zurück in Filament DB zu importieren

---

## API-Dokumentation

Gehe zu **Einstellungen** und klicke auf **„API-Dokumentation"**, um die interaktive Swagger-UI unter `/api-docs` zu öffnen. Sie bietet eine durchsuchbare, testbare Oberfläche für die dokumentierte OpenAPI-Surface, während die [API-Referenz](api.md) zusätzliche Prosa zu neueren Routen und Verhaltens-Details enthält. Die zugrunde liegende OpenAPI-3.0-Spezifikation ist unter `/api/openapi` verfügbar (dynamisch aus `package.json` versioniert).

---

## Dashboard *(v1.11)*

Die **Dashboard**-Seite unter `/dashboard` ist die Heimat deines Inventars auf einen Blick:

- **Summen** — Filamentanzahl, Spulenanzahl, Gramm vorrätig sowie Drucker-/Düsen-/Betttyp-Anzahl
- **Low-Stock-Warnungen** — jedes Filament, dessen aggregierter Rest unter seinem pro-Filament-`lowStockThreshold` liegt. Klicken einer Zeile springt zur Filament-Detailseite.
- **Trocknen nötig** — Spulen, deren letzter Trockenzyklus älter als 30 Tage ist (später in den Einstellungen konfigurierbar), nach Filamenttyp gruppiert
- **Neueste Druckhistorie** — die zuletzt protokollierten Druckaufträge

Low-Stock-Schwellen werden pro Filament auf der Bearbeitungsseite unter **Bestandseinstellungen → Low-Stock-Schwellwert (g)** gesetzt. Ein Filament ohne Schwellwert wird nie geflaggt.

## Locations *(v1.11)*

Die **Locations**-Seite unter `/locations` lässt dich beschreiben, wo deine physischen Spulen leben — Dryboxen, Regale, Schränke, AMS-Einheiten usw. Jede Location hat:

- **Name** (eindeutig) und optionale **Art** — freier Text zum Gruppieren von Locations in Auswahllisten (`drybox`, `shelf`, `cabinet`, `printer` usw.)
- **Luftfeuchtigkeit %rF** — optional, vom Nutzer aktualisiert. Nützlich, um die Bedingungen in einer Drybox zu verfolgen.
- **Notizen** — Freitext.

Sobald du mindestens eine Location angelegt hast, bekommt die Spulen-Detailansicht ein **Location**-Dropdown. Weise Spulen dort zu, und die Statistiken in der Listenansicht zeigen Spulenanzahl und Gesamtgramm pro Location.

**Löschschutz:** Die UI verweigert das Löschen einer Location, die noch von einer Spule referenziert wird. Verlagere diese Spulen zuerst oder muster sie aus, dann gelingt das Löschen.

## Drucker-Slot-Zuweisung *(v1.21)*

Getrennt von ihrer **Location** (ihrem Lager-„Zuhause") kann eine Spule einem **Drucker-Slot** zugewiesen werden — der AMS-/MMU-Position, an der sie aktuell zum Drucken geladen ist. Wenn ein Drucker Multi-Material-Slots definiert hat, zeigt die Spulen-Detailansicht einen **Drucker-Slot**-Picker direkt unter dem Location-Dropdown.

- Wähle einen `Drucker · Slot`-Eintrag, um die Spule zuzuweisen; ein Badge zeigt dann, wo sie geladen ist, mit einem **Löschen**-Button zum Entfernen.
- Eine Spule belegt höchstens einen Slot gleichzeitig — die Zuweisung in einen neuen Slot räumt sie automatisch aus dem vorherigen.
- Ausgemusterte Spulen können aus einem Slot gelöscht, aber nicht neu zugewiesen werden (sie sind aus dem Inventar).

**Hybrid-Modus-Vorbehalt:** Drucker-Slot-Zuweisungen werden am Drucker gespeichert und werden im Hybrid-Modus **nicht** zwischen Datenbanken synchronisiert — sie können beim nächsten Sync-Zyklus geleert werden. Die Funktion ist in reinen Cloud-only- oder Offline-only-Setups voll zuverlässig.

## Spulen-Fotos, Ausmusterung & Trockenzyklen *(v1.11)*

Jede Spule hat nun drei zusätzliche Register, die in ihrer Detailansicht zugänglich sind:

- **Foto** — lade ein JPEG/PNG hoch (SVG wird aus Sicherheitsgründen abgelehnt). Die Datei wird client-seitig auf 1200 px herunterskaliert und auf ~200 KB komprimiert, bevor sie inline im Spulen-Subdokument gespeichert wird — es gibt also keinen Datei-Upload-Endpunkt.
- **Ausgemustert** — Umschalter, um eine Spule aus den Inventarsummen, dem PrusaSlicer-Spool-Check-Endpunkt und der Hauptspulenliste zu entfernen. Die Historie bleibt erhalten. Seit v1.30.3 (#381) löst das Setzen des Restgewichts einer Spule auf **0** eine Abfrage aus, ob sie im selben Schritt auch als ausgemustert markiert werden soll — der kanonische „Ich habe diese Spule fertig"-Moment, ein Klick statt zwei.
- **Trockenzyklen** — protokolliere jeden Trockenvorgang mit optionaler Temperatur (°C), Dauer (Minuten) und Notizen. Die „Trocknen nötig"-Warnung des Dashboards liest aus diesem Log.
- **Verbrauchshistorie** — jede manuelle Gewichtsreduktion (oder slicer-getriebener Druckauftrag) hängt einen Eintrag an, der mit seiner Quelle (`manual`, `slicer`, `job`, `nfc`) markiert ist.

## Bulk-Spulen-CSV-Import *(v1.11)*

Klicke in der Hauptliste auf **Importieren → Spulen aus CSV**. Füge deine CSV ein oder lade eine Datei mit diesen Spalten hoch:

- **Erforderlich:** `filament`, `totalWeight`
- **Optional:** `vendor` (disambiguiert doppelte Filamentnamen), `label`, `lotNumber`, `purchaseDate` (YYYY-MM-DD), `openedDate`, `location` (wird automatisch angelegt, falls nicht vorhanden)

Der Importer meldet Pro-Zeile-Erfolg/-Fehler, sodass ein paar Tippfehler nicht den ganzen Einfügevorgang abbrechen. Zeilen sind auf 10.000 pro Request begrenzt.

## Druckverlauf *(v1.11)*

Wenn ein Slicer (oder ein Nutzer) einen Druckauftrag an `/api/print-history` postet, passieren zwei Dinge:

1. Ein `PrintHistory`-Dokument wird angelegt — der kanonische Datensatz, was gelaufen ist, auf welchem Drucker, mit wie viel Gramm welchen Filaments.
2. Jeder referenzierten Spule wird `totalWeight` reduziert und ein `usageHistory`-Eintrag mit `source: "job"` angehängt.

Diese Schreibvorgänge laufen in einer MongoDB-Transaktion, wo das Deployment es unterstützt (Atlas-Replicas, Hybrid-Modus), sodass ein Fehler mitten im Schreiben nicht das Inventar aus dem History-Ledger geraten lässt.

## Verbrauchsanalyse *(v1.11)*

Die **Analytics**-Seite unter `/analytics` schöpft aus PrintHistory-Records plus etwaigen manuellen Pro-Spule-Verbrauchseinträgen (jene, die du direkt im Spulen-UI ohne den Print-History-Endpunkt geloggt hast).

- **Fenster**: 7, 30, 90 oder 365 Tage
- **Summen**: Gramm, geschätzte Kosten, Aufträge (`+N manuell` wird unter dem Auftragszähler angezeigt, wenn mindestens ein manueller Pro-Spule-Eintrag zu den Summen beiträgt — unterscheidet, ob Inventar via PrintHistory-Aufträge oder via direkten Spulen-UI-Logs abgebaut wurde)
- **Verbrauch pro Tag**: Balkendiagramm
- **Aufschlüsselung**: nach Filament, nach Vendor, nach Drucker

Manuelle Auftragseinträge werden nicht doppelt gezählt: Einträge mit `source: "job"` oder `"slicer"` gehören zu einer PrintHistory-Zeile und sind bereits in der primären Aggregation enthalten. Nur Einträge mit `source: "manual"` (echte direkte Edits) werden aus dem Fallback-Pass hinzugefügt.

## Katalog teilen *(v1.11)*

Die **Share**-Seite unter `/share` lässt dich einen statischen Snapshot ausgewählter Filamente unter einem Kurz-Slug veröffentlichen. Anwendungsfall: Du willst einem Freund die exakte PLA+PETG-Aufstellung installieren lassen, die du nutzt.

1. Wähle die zu teilenden Filamente (Multi-Select). Seit v1.34.1 hat die Auswahl eine Sofortsuche (gleicht Name, Hersteller, Typ oder Farbe ab), Materialtyp-Filterchips sowie einen "Nur Ausgewählte anzeigen"-Schalter, damit das Finden der richtigen Zeilen in einem großen Katalog handhabbar bleibt. Die Bedienelemente erscheinen erst ab ≥12 Filamenten — kleine Kataloge bleiben bei der schlichten Liste.
2. Gib dem Katalog einen Titel + optionale Beschreibung und optionales Ablaufdatum
3. Klicke auf **Veröffentlichen** — der Server sammelt jede von diesen Filamenten referenzierte Düse / Drucker / Druckbett-Typ und denormalisiert alles in die Payload, sodass der Empfänger ein vollständiges, konsistentes Set erhält

**Öffentliche Ansicht** (`/share/{slug}`) — jeder mit dem Link kann den Katalog durchsehen, selektiv Filamente in die eigene Instanz importieren und einen atomar inkrementierenden Aufrufzähler sehen. Veröffentlichte Kataloge sind statisch: spätere Änderungen an den Quell-Filamenten ändern nicht, was nachfolgende Betrachter herunterladen.

**Unpublish** ist ein Soft-Delete: Der Slug liefert sofort 404 für die Öffentlichkeit, aber die Zeile bleibt in der Sammlung, damit der Peer-Sync das Unpublish als Tombstone übertragen kann (sonst würde der andere Peer beim nächsten Sync-Zyklus die noch aktive Kopie zurückspielen). Slugs aus zurückgezogenen Katalogen können bei künftigem Republish wiederverwendet werden.

**Importieren** auf der Empfänger-Seite re-hydratisiert zuerst die referenzierten Entitäten (Düsen, Drucker, Druckbett-Typen) und erstellt dann die Filamente mit den korrekten lokalen IDs. Gleichnamige Datensätze am Ziel werden wiederverwendet statt dupliziert; Kalibrierungen, die auf nicht auflösbare Referenzen zeigen, werden verworfen statt baumelnd gespeichert.

## Filamentvergleich *(v1.11)*

Die **Compare**-Seite unter `/compare` nimmt bis zu 8 Filamente (im eingebauten Picker ausgewählt oder per `?ids=`-Query-String übergeben) und rendert eine Side-by-Side-Tabelle mit Temperaturen, Kosten, Dichte, Durchmesser, Kalibrierungen und aktuellem Restgewicht. Nützlich, wenn du dich zwischen mehreren ähnlichen Filamenten für einen Job entscheiden musst. Seit v1.34.1 hat die Auswahl dieselbe Sofortsuche, Materialtyp-Filterchips und den "Nur Ausgewählte anzeigen"-Schalter wie `/share` (erst ab ≥12 Filamenten sichtbar), damit das Herausgreifen von 4–8 Zeilen aus einem großen Katalog schnell bleibt.

## System-Theme *(v1.11)*

Einstellungen → **Theme**: wähle **Hell**, **Dunkel** oder **System**. System-Modus folgt der `prefers-color-scheme`-Media-Query des OS. Ein Inline-Init-Skript läuft vor dem Mounten von React, sodass die erste Darstellung bereits das richtige Theme zeigt — kein Dark-Mode-Flackern beim Kaltstart.

## Auto-Update (Desktop) *(v1.11)*

Ein schmaler Banner oben in der App kündigt eine neue Version an, lädt sie auf Wunsch im Hintergrund und fordert zum Restart-and-Install auf, sobald bereit. Alle Texte sind lokalisiert — der native Installations-Bestätigungsdialog nutzt die aktuelle Sprache des Renderers.

Unter macOS können unsignierte Builds nicht über Gatekeeper automatisch installieren. Der Banner zeigt als Fallback einen **View release**-Button, damit du die DMG manuell herunterladen kannst.
