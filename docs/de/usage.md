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

- **Wiederherstellen** — macht das Löschen rückgängig und holt das Filament zurück in die reguläre Liste. Wenn du in der Zwischenzeit ein neues aktives Filament mit demselben Namen angelegt hast, wird die Wiederherstellung mit 409 abgelehnt — benenne eins der beiden zuerst um. Stellst du eine *Variante* wieder her, deren Eltern-Filament währenddessen eine eigene Farbe oder eigene Spulen bekommen hat, fragt die App zuerst, ob dieses Eltern-Filament in eine Vorlage umgewandelt werden soll (siehe [Filament-Vorlagen](#filament-vorlagen-v170)).
- **Endgültig löschen** — hard-Delete in MongoDB. Kann nicht rückgängig gemacht werden. Der Button ist nur bei Filamenten verfügbar, die bereits im Papierkorb sind; ein aktives Filament muss als Sicherheitsschritt erst soft-gelöscht werden.

Die Papierkorb-Seite hat zusätzlich eine **Papierkorb leeren**-Aktion, die alles auf einmal endgültig löscht (Varianten werden vor Eltern-Filamenten gepurged, damit die No-Orphan-Refs-Bedingung eingehalten wird).

---

## Filament-Vorlagen *(v1.70)*

Ein Filament mit Farbvarianten ist eine **Vorlage** — die Produktlinie, nicht die einzelne Rolle. Die Vorlage trägt, was die ganze Familie teilt (Temperaturen, Trocknung, Dichte, Leerspulen- und Netto-Filamentgewicht, Sekundärfarben, Tags); jede Farbvariante trägt, was pro Farbe und pro Rolle gilt: ihre Farbe und ihren Farbnamen, ihre Spulen, ihr Gesamtgewicht und ihren Low-Stock-Schwellwert. Ein Filament ohne Varianten ist davon nicht betroffen und verhält sich genau wie bisher.

Vorlage zu sein ist keine Einstellung, die du aktivierst — ein Filament ist genau so lange eine Vorlage, wie es mindestens eine nicht gelöschte Variante hat.

### Umwandlung, sobald die erste Variante entsteht

Es wird nichts hinter deinem Rücken umgebaut. Sobald eine Aktion einem Filament seine **erste** Variante geben würde, während dieses Filament noch eine eigene Farbe, einen eigenen Farbnamen, eigene Spulen oder ein eigenes Gesamtgewicht trägt, hält die App an und fragt:

> **Übergeordnetes Filament in Vorlage umwandeln?**
>
> Dies ist die erste Variante von „Prusament PLA" — es wird zur Vorlage: Farbe und 2 Spule(n) werden auf eine neue Variante namens „Prusament PLA — Galaxy Black" verschoben.

Bestätigst du mit **Umwandeln und erstellen**, legt die App diese Variante an, verschiebt Farbe, Farbname, Spulen, Gesamtgewicht und Low-Stock-Schwellwert des Eltern-Filaments dorthin und lässt das Eltern-Filament farblos und ohne Bestand zurück. Brichst du ab, wird überhaupt nichts geschrieben — kein Filament angelegt, keine Daten angefasst.

Dieselbe Bestätigung sichert vier Einstiegspunkte ab, jeweils mit passendem Wortlaut:

- **„Variante erstellen"** oder **Duplizieren** auf der Detailseite sowie `/filaments/new` mit gewähltem Eltern-Filament — *„Dies ist die erste Variante von …"*, **Umwandeln und erstellen**
- **Bearbeiten → Übergeordnetes Filament** an einem bestehenden Filament — *„Durch das Speichern wird dieses Filament zur ersten Variante von …"*, **Umwandeln und speichern**
- **Wiederherstellen** aus dem Papierkorb — *„Durch das Wiederherstellen wird dieses Filament zur ersten Variante von …"*, **Umwandeln und wiederherstellen**
- **„Als Variante importieren"** im OpenPrintTag-Browser (genau ein Material auswählen, unter **Eltern-Filament** statt „Kein Elternteil (eigenständig)" ein Filament wählen — daraufhin wechselt der Import-Button auf diese Beschriftung) — gleicher Wortlaut wie beim Anlegen

Die neue Variante heißt `<Name des Eltern-Filaments> — <Farbname>`, bzw. `<Name des Eltern-Filaments> — Original`, wenn das Eltern-Filament keinen Farbnamen hatte (mit dem Suffix ` (2)` / ` (3)`, falls dieser Name schon vergeben ist). Alles, was auf die verschobenen Spulen zeigte, folgt ihnen: Druckverlaufs-Einträge, AMS-Slot-Zuweisungen an Druckern und bereits gedruckte QR-Etiketten — beim Scannen eines alten Etiketts löst die App den aktuellen Besitzer der Spule auf und bringt dich dorthin.

### Ein altes Eltern-Filament von Hand umwandeln

Eltern-Filamente aus der Zeit vor v1.70 behalten ihre eigene Farbe und ihre Spulen, bis du etwas anderes bestimmst. Öffnest du eines, zeigt der Abschnitt **Spulen-Tracker** einen bernsteinfarbenen Hinweis — *„Diese Vorlage trägt noch eine eigene Farbe oder eigene Spulen aus der Zeit, bevor sie zur Vorlage wurde."* — neben einem **„In Vorlage umwandeln"**-Button. Der Button erscheint nur, wenn es tatsächlich etwas zu verschieben gibt. Er bestätigt mit:

> **In Vorlage umwandeln?**
>
> Eigene Farbe und 2 Spule(n) dieses Filaments auf eine neue Variante verschieben? Die Vorlage selbst behält weder Farbe noch Spulen.

Bei Erfolg meldet ein Toast *„Umgewandelt — Farbe und Spulen wurden auf eine neue Variante verschoben"*, und die Seite lädt ihre Daten neu. Wird eine Umwandlung unterbrochen (App beendet, Stromausfall), geht nichts verloren — der Button ist weiterhin da, und ein erneuter Versuch beendet die unterbrochene Verschiebung, statt eine zweite Kopie anzulegen.

### Was eine Vorlage kann und was nicht

- **Spulen liegen bei den Varianten.** Der Abschnitt Spulen-Tracker einer Vorlage wird durch *„Vorlagen führen keinen Bestand — Spulen liegen bei den Farbvarianten."* ersetzt — einen **„+ Spule hinzufügen"**-Button gibt es dort nicht. Jeder Weg, der einer Vorlage eine *neue* Spule anlegen würde, wird mit dem Hinweis abgelehnt, dass dieses Filament eine Vorlage ist (es hat Farbvarianten) und keine Spulen tragen kann — die Spule gehört an eine seiner Varianten: der Spule-hinzufügen-Button, der Prusament-QR-Import und der Bulk-CSV-Spulenimport (bei dem genau diese Zeilen scheitern). Spulen, die noch an einem alten Eltern-Filament hängen, gehen nicht verloren, werden hier aber nicht mehr verwaltet — der Tracker auf der Seite der Vorlage selbst besteht nur aus dieser einen Zeile und sonst nichts. Sie zählen weiterhin in die Spulen- und Restmengen-Summen der Filamentliste, und sie bleiben über das ausklappbare Spulen-Panel der Liste (Standort) sowie über **Spulen-Bestand** (Gewicht, Standort, Ausmustern) bearbeitbar. **„In Vorlage umwandeln"** verschiebt sie endgültig auf eine Variante.
- **Das Bearbeitungsformular blendet die Felder Farbe und Farbname aus**: *„Vorlagen haben keine Farbe — jede Farbvariante trägt ihre eigene Farbe und ihren eigenen Farbnamen."* Der Mehrfarben-Editor (Sekundärfarben) bleibt, denn diese Farben erbt die ganze Familie.
- **Der Abschnitt Spulengewicht behält das Kennwert-Paar und blendet die Bestandsfelder aus.** Netto-Filamentgewicht und Leerspulengewicht bleiben — *„Vorlagen führen keinen Bestand — Spulen und Gesamtgewicht liegen bei den Farbvarianten. Die hier gesetzten Werte für Leerspule und Netto-Filament sind gemeinsame Kennwerte, die jede Variante erbt."* Genau dieses einmal an der Vorlage gesetzte Netto-Filamentgewicht gibt jeder Farbvariante ihren Restmengen-Balken. Startgewicht und Low-Stock-Schwellwert sind ausgeblendet.
- **Importe und Slicer-Syncs überspringen an einer Vorlage vier Felder** — Farbe, Farbname, Gesamtgewicht, Low-Stock-Schwellwert — statt zu scheitern. PrusaSlicer-/OrcaSlicer-/Bambu-Studio-Rücksyncs, INI-Bundles, CSV/XLSX, Atlas- und OpenPrintTag-Importe wenden alles Übrige an und melden in den Ergebnis-Hinweisen, was sie übersprungen haben.
- **„Auf Updates prüfen" (OpenPrintTag) bietet an einer Vorlage nie die Farbe an**, sodass eine einzige Verknüpfung am Eltern-Filament jede Eigenschaft der ganzen Familie aktualisiert, ohne sie neu einzufärben.
- **Löschen bleibt blockiert**, solange ein Filament Varianten hat — entferne oder verlagere die Varianten zuerst.

### Farbe entfernen

Leere das Hex-Feld und speichere: Das Filament hat danach gar keine Farbe mehr, und ein erneutes Bearbeiten belässt es dabei. Eine entfernte Farbe wird als schraffierter Platzhalter mit dem Text **„Keine Farbe gesetzt — klicken, um eine auszuwählen"** dargestellt — ein Klick darauf wählt wieder eine Farbe.

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

Gehe zu **Einstellungen → UI-Einstellungen** und nutze den **Sprache**-Umschalter, um zwischen Englisch und Deutsch zu wechseln. Die Einstellung wird in der Desktop-App-Konfiguration persistiert (oder im localStorage der Web-App) und greift sofort auf allen Seiten.

---

## Datumsformat *(v1.65)*

Gehe zu **Einstellungen → UI-Einstellungen** und wähle unter **Datumsformat**, wie jedes Datum in der App dargestellt wird:

- **System (Geräteregion)** — folgt der Regionseinstellung deines Geräts bzw. Betriebssystems (Standard)
- **ISO** — `YYYY-MM-DD`
- **USA** — `MM/DD/YYYY`
- **Europäisch** — `DD/MM/YYYY`
- **Benutzerdefiniert** — dein eigenes Muster aus den Platzhaltern `YYYY` / `YY` (Jahr), `MM` / `M` (Monat) und `DD` / `D` (Tag), z. B. `DD-MM-YY`; alle anderen Zeichen werden als Trennzeichen übernommen

Eine Live-Vorschau zeigt das heutige Datum im gewählten Format. Wie die Sprache wird die Einstellung in der Desktop-App-Konfiguration persistiert (oder im localStorage der Web-App).

---

## Zahlenformat *(v1.66)*

Ebenfalls unter **Einstellungen → UI-Einstellungen** legt **Zahlenformat** die Ziffergruppierung und das Dezimaltrennzeichen für alle angezeigten Zahlen fest — Gewichte, Anzahlen und Preise (Währungsbeträge eingeschlossen):

- **System (Geräteregion)** — folgt der Region deines Geräts (Standard)
- **US / UK** — `1,234,567.89`
- **Europäisch** — `1.234.567,89`
- **Leerzeichen** — `1 234 567,89`
- **Keine** — keine Gruppierung (`1234567.89`)
- **Benutzerdefiniert** — eigenes Tausender- und Dezimalzeichen (jeweils ein einzelnes Zeichen, keine Ziffern, und beide müssen sich unterscheiden)

Eine Live-Vorschau zeigt einen Beispielwert im gewählten Format. Maschinenlesbare Ausgaben (CSV/XLSX und Slicer-Exporte) sind davon nicht betroffen — die Einstellung wirkt nur auf die Anzeige in der Oberfläche.

---

## Währung

Der **Währung**-Bereich ganz oben in **Einstellungen → UI-Einstellungen** legt fest, in welcher Währung Kosten und Preise angezeigt werden. Klicke eine der eingebauten Währungen an oder **füge eine eigene hinzu** mit eigenem Code, Symbol und Namen (eigene Einträge lassen sich über ihren ×-Button wieder entfernen).

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

Felder leer lassen, um die Basis-Defaults des Filaments zu verwenden. Top-Level-Filament-Temperaturen bleiben als hersteller-empfohlene Defaults. Beim INI-Export gilt: Ein Filament mit null oder einer Düsen-Kalibrierung erzeugt einen einzelnen `[filament:Name]`-Abschnitt mit seinen Basis-Einstellungen — Kalibrierungs-Overrides werden dort nicht eingebettet, PrusaSlicer Filament Edition lädt sie dynamisch via `GET /api/filaments/{id}/calibration`, wenn du Drucker oder Düse wechselst. Ein Filament mit Kalibrierungen für **zwei oder mehr unterschiedliche Düsen** exportiert stattdessen ein Preset pro Düse, mit Düsen-Suffix im Namen (z. B. `PLA 0.4 Brass`), jeweils mit den eingebetteten filament-bezogenen Kalibrierungswerten dieser Düse (Pressure Advance bleibt dynamisch über die Kalibrierungs-API).

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

Die Desktop-App ist ein neutraler Multi-Standard-Reader: Sie liest und schreibt OpenPrintTag-NFC-V-Tags (SLIX2) und OpenTag3D-Tags (NTAG213/215/216, NFC-A) und liest Bambu-Lab-MIFARE-Classic-Spulen-Tags. OpenTag3D ist ein offener NFC-Filament-Tag-Standard (opentag3d.info), der u. a. von Polar Filament, American Filament, Numakers, 3D-Fuel und Ecogenesis verwendet wird. Siehe [NFC-Dokumentation](nfc.md) für Hardware-Voraussetzungen und Setup.

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

Unter **Einstellungen → Geräte** kannst du über die **NFC-Tools**-Karte einen Tag löschen:

1. Lege einen Tag auf den Reader (Status wird grün)
2. Klicke **„Tag löschen"** und bestätige
3. Der Tag wird geleert — leerer CC-Header, Terminator und genullter Speicher

### OpenPrintTag-Binärdatei exportieren

Klicke **„OPT exportieren"** auf der Detailseite eines Filaments, um die Binärdatei als `.bin`-Datei für externe NFC-Tools herunterzuladen.

---

## AI-gestützter TDS-Import

Extrahiere Filament-Eigenschaften automatisch aus dem Datenblatt eines Herstellers mit AI. Unterstützt PDF- und Web-TDS-URLs.

### Setup

1. Gehe zu **Einstellungen → KI**
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
| Google Gemini | gemini-3.1-flash (entdeckt automatisch ein verfügbares Flash-Modell, falls dieses jemals eingestellt wird) | 15 Anfragen/Min | Nativ |
| Anthropic Claude | claude-sonnet-4-20250514 | Pay-per-use | Nativ |
| OpenAI ChatGPT | gpt-4o-mini | Pay-per-use | Textextraktion |

### AI-Einstellungen

Unter **Einstellungen → KI**:

- **Anbieter-Auswahl** — klicke einen Anbieter-Button, um zwischen Gemini, Claude und ChatGPT zu wechseln
- **API-Key** — maskiertes Eingabefeld mit Anzeigen/Verbergen-Umschalter
- **Key speichern** — validiert den Key beim gewählten Anbieter vor dem Speichern
- **Key entfernen** — löscht den gespeicherten Key
- **Statusanzeige** — grüner Punkt bei Konfiguration, grau wenn nicht

In der Desktop-App wird der API-Key in der lokal persistierten Konfigurationsdatei gespeichert. In der Web-App setze den Key über die Einstellungen-Seite oder per Umgebungsvariablen (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY` oder `OPENAI_API_KEY`).

---

## Spulen-Tracking

Jedes Filament kann mehrere physische Spulen mit individuellen Gewichten verfolgen. Filamente mit Farbvarianten sind [Vorlagen](#filament-vorlagen-v170) und führen keinen Bestand — lege Rollen stattdessen an den Farbvarianten an.

### Spulen hinzufügen

Auf der Detailseite eines Filaments wird der Abschnitt **Spulen-Tracker** immer gerendert (seit v1.30.3 / #380). Wenn es noch keine Spulen und keine Gewichtsmetadaten gibt, zeigt der Abschnitt einen kurzen „Noch keine Spulen"-Hinweis über dem **„+ Spule hinzufügen"**-Button — klicke ihn, um eine neue Spule mit optionalem Label und Gewicht anzulegen. An einer Vorlage steht dort stattdessen nur „Vorlagen führen keinen Bestand — Spulen liegen bei den Farbvarianten."

Wenn du deine Rollen durchnummerierst, füllt der Button **„Nächste Nr."** neben dem Label-Feld die nächste Nummer ein: das höchste rein numerische Spulen-Etikett in der gesamten Datenbank plus eins (bzw. `1`, wenn es kein numerisches gibt). Ausgemusterte Spulen und Spulen an gelöschten Filamenten zählen **mit Absicht** mit — eine auf eine physische Spule geschriebene Rollennummer darf nie zweimal vergeben werden, der Vorschlag springt also über alles hinweg, was schon einmal benutzt wurde, auch wenn die App es nicht mehr anzeigt. Etiketten, die nicht ausschließlich aus Ziffern bestehen („Geöffnet 2025-03-15", „A12", „1.5"), werden ignoriert statt halb ausgewertet; führende Nullen fallen weg, „0042" zählt also als 42. Reserviert wird nichts — es ist ein Vorschlag in einem ganz normalen, editierbaren Feld, zwei Personen bekommen beim gleichzeitigen Klick dieselbe Nummer, und Überschreiben ist vorgesehen. Schlägt die Abfrage fehl, erscheint der Toast *„Nächste Spulennummer konnte nicht abgerufen werden — bitte manuell eingeben."* und das Feld bleibt unangetastet.

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
- **Aufklappbare Gruppe pro Standort** — der Zusammenfassungs-Chip jeder Gruppe zeigt Spulenanzahl und Gesamtgramm; der Kopf einer Trockenbox-Gruppe trägt zusätzlich einen 🖨-Button, der ein [Trockenbox-Etikett](#trockenbox-etiketten-knaon-y813bt-v169) druckt. Eine synthetische **„Kein Standort"**-Gruppe fängt jede Spule mit `locationId: null` ab und wird absichtlich an das ENDE der Liste sortiert, damit man Nachzügler als „benötigen Aufmerksamkeit" erkennt statt sie mit dem Hauptbestand zu verwechseln.
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

Drucke ein Spulen-Etikett (24-mm-Band) direkt von der Filament-Detailseite auf einen **Brother PT-P710BT** (P-touch CUBE). Das Etikett enthält einen (optionalen) QR-Code und konfigurierbaren Text. Das ist der Drucker für Spulen-Etiketten; 10×15-cm-Trockenbox-Etiketten laufen über ein separates Gerät mit eigener Einstellung — siehe [Trockenbox-Etiketten](#trockenbox-etiketten-knaon-y813bt-v169). Zwei QR-Modi, die du pro Druck wählen kannst:

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

Wenn du die Web-App statt Electron nutzt, lädt der Drucken-Button stattdessen eine `.bin`-Datei mit dem kodierten Byte-Stream herunter — nützlich zur Inspektion. Lokal mit `npm run label:sim -- --in <Datei>` decodieren, um zu sehen was gedruckt worden wäre (das Trennzeichen `--` ist zwingend — ohne es schluckt npm das Flag `--in`, reicht den Pfad aber weiter; das Skript sieht dann ein nacktes Argument und bricht mit `Unknown arg: <Pfad>` ab).

### Fehlerbehebung

- **Kein Drucker aufgelistet** in Einstellungen → Etikettendrucker: Stelle sicher, dass der Drucker mit einem USB-**Datenkabel** verbunden (reine Ladekabel versorgen den Drucker, melden ihn aber nicht an) und eingeschaltet ist, dann auf **Aktualisieren** klicken. Unter Linux musst du den Drucker eventuell zuerst in den Systemeinstellungen für Drucker hinzufügen.
- **Upgrade von einem Build vor v1.34.9**: Wenn du zuvor ein Bluetooth-/Serial-Gerät ausgewählt hattest, wähle deinen Drucker in Einstellungen → Etikettendrucker erneut aus. Die App erkennt die alte Serial-Einstellung und bittet dich um eine neue Auswahl, statt kryptisch fehlzuschlagen.
- **Etikett wird gespiegelt gedruckt** (Text rückwärts, QR seitenverkehrt): in v1.34.9 behoben — auf die neueste Version aktualisieren.
- **Nichts gedruckt, obwohl es „erfolgreich" war**: Der PT-P710BT schaltet sich im Leerlauf automatisch ab. Wecke ihn (Power-Taste drücken), prüfe das Band und drucke erneut.

---

## Trockenbox-Etiketten (KNAON Y813BT) *(v1.69)*

Ein zweiter, völlig eigenständiger Etikettendrucker druckt ein 10×15-cm-**Trockenbox-Etikett** (4×6 Zoll) — einen Aufkleber für die Außenseite einer Trockenbox, der die Box benennt, ihren Inhalt auflistet und festhält, wann das Trockenmittel zuletzt gewechselt wurde. Mit den Brother-Spulen-Etiketten oben hat er nichts zu tun; du kannst einen der beiden Drucker besitzen, beide oder keinen. Die Einstellungs-Karte sagt genau das: *„Druckt 10×15-cm-Trockenbox-Etiketten über TSPL. Unabhängig vom Brother-Spulendrucker — die beiden drucken nie dasselbe."*

Gedruckt wird nur aus der Desktop-App. In der Web-App wird aus dem Drucken-Button **„.prn herunterladen"**, und diese Datei ist ein echter Druckauftrag, kein Inspektions-Artefakt — schicke sie mit `lp -o raw -d <queue> <Datei>.prn` an den Drucker.

### Einmalige Einrichtung

1. **Y813BT per USB verbinden** und einschalten.
2. **Einstellungen → Geräte** → die Karte **Trockenbox-Etikettendrucker (KNAON Y813BT)** unterhalb der Brother-Karte. Drucker, die bereits als System-Warteschlange eingerichtet sind, werden beim Laden der Karte aufgelistet. Fehlt deiner, klicke auf **„Nach USB-Druckern suchen"** (oder **Aktualisieren**) — *„Die Suche nach USB-Druckern kann nach Ihrem Administratorpasswort fragen (macOS)."* Passende Geräte bekommen ein grünes **Y813BT**-Badge. Wähle deines aus.
3. **Testdruck** sendet ein kleines, bekannt gutes Etikett („FILAMENT DB" / „TSPL test print OK" plus einen Barcode) und bestätigt mit *„Testetikett gesendet — prüfen Sie den Drucker."*
4. **Öffentliche Basis-URL** auf der **Brother**-Karte direkt darüber setzen — es gibt nur eine URL, und beide Drucker teilen sie sich. Ohne sie kodiert der QR-Code `localhost`, was kein Smartphone öffnen kann; der Druckdialog warnt davor, druckt aber trotzdem, und ein späterer Nachdruck kostet wenig.

Wird der gewählte Drucker später abgezogen oder seine Warteschlange entfernt, zeigt die Karte einen bernsteinfarbenen Hinweis — *„Der ausgewählte Drucker ist nicht mehr verfügbar:"* — mit dem Pfad und einem **„Auswahl aufheben"**-Link. Beide Druckerkarten haben das.

### Luftfeuchtigkeit und Trockenmittel erfassen

Bearbeite auf der **Standorte**-Seite den Standort (oder lege einen neuen an) und setze seine **Art** auf **Trockenbox** — die Druck-Aktion erscheint nur bei Trockenboxen, weil der Wortlaut des Etiketts trockenbox-spezifisch ist. Zwei optionale Felder speisen das Etikett: **Luftfeuchtigkeit (%rF)** und **Trockenmittel gewechselt** (siehe [Locations](#locations-v111)).

### Ein Etikett drucken

Zwei Einstiegspunkte, beide auf Trockenbox-Standorte beschränkt:

- **Standorte** (`/locations`) — eine **„Etikett drucken"**-Aktion in jeder Trockenbox-Zeile. Das ist der Weg, der auch bei einer brandneuen oder gerade geleerten Box funktioniert.
- **Spulen-Bestand** (`/inventory`) — ein 🖨-Button im Kopf einer Trockenbox-Gruppe, sichtbar solange du nach Standort gruppierst. (Der Spulen-Bestand baut seine Gruppen aus Spulen auf, eine leere Box taucht dort also gar nicht auf.)

Beide öffnen den Dialog **„Trockenbox-Etikett drucken"** mit dem Untertitel *„10×15-cm-Etikett für {Name} — {N} Spule(n) auf der Inhaltsliste"*. Während er den **vollständigen, ungefilterten** Inhalt der Box lädt, zeigt er *„Inhalt der Box wird geladen…"* — eine im Spulen-Bestand noch aktive Suche oder Filterung verkleinert also nicht, was gedruckt wird — und rendert dann eine exakte Vorschau aus demselben Dokument, das der Drucker bekommt. Ausgemusterte Spulen stehen nie auf dem Etikett.

### Was auf dem Etikett steht

- Der **Name der Box** groß in einem Rahmen (lange Namen werden gekürzt), darunter `FILAMENT-TROCKENBOX` sowie `14% RH`, wenn für den Standort eine Luftfeuchtigkeit hinterlegt ist.
- Ein **QR-Code** oben rechts.
- `INHALT  (Stand <Datum>)`, gefolgt von einer Zeile je nicht ausgemusterter Spule — das eigene Etikett der Spule, sofern gesetzt, sonst Hersteller + Filamentname + Material. So viele Zeilen wie passen; enthält die Box mehr, lautet die letzte Zeile `+N weitere`, damit das Etikett nie eine vollständige Liste vortäuscht. Eine leere Box druckt `(leer)`.
- `TROCKENMITTEL GEWECHSELT <Datum>` — oder `nicht erfasst` — und die Erinnerung *„Alle 90 Tage wechseln oder wenn der Indikator rosa wird"*.
- Ein **Code-128-Barcode** mit dem Namen der Box am unteren Rand (er entfällt automatisch, wenn der Name zu lang für einen scanbaren Barcode ist; der QR identifiziert die Box weiterhin).

Die Inhaltsliste ist eine Momentaufnahme — deshalb trägt sie ein Datum. Die aktuelle Antwort liefert der QR-Code.

### Das Etikett scannen

Der QR öffnet `/inventory?location=<id>` — deinen **Spulen-Bestand**, umgeschaltet auf Gruppierung nach Standort, mit der Gruppe dieser Box ausgeklappt, angesprungen und kurz hervorgehoben. Hat die Box keine aktiven Spulen mehr (oder wurde der Standort gelöscht), bekommst du eine kurze Meldung statt einer Seite, die scheinbar nichts tut: *„Die Box dieses Etiketts enthält derzeit keine aktiven Spulen (oder der Lagerort wurde entfernt) — nichts anzuzeigen."*

### Nicht-englischer Etikettentext

Das Etikett druckt immer in reinem ASCII. Das ist eine Hardware-Grenze, keine Vorliebe: Der Y813BT bricht eine Textzeile beim ersten Nicht-ASCII-Zeichen ab, akzentuierter Text würde also stillschweigend mitten im Wort abgeschnitten. Filament DB transliteriert stattdessen — `Grün` wird zu `Grun`, `Straße` zu `Strasse`, `°` zu `deg`, `€` zu `EUR`. Der QR-Link ist davon nicht betroffen.

### Inbetriebnahme per CLI

`npm run label:tspl -- --demo --printer <queue>` rendert ein Beispiel-Trockenbox-Etikett über die echte Pipeline und druckt es; `--file <Pfad.prn>` schickt stattdessen einen rohen TSPL-Auftrag (dessen Zeilenrahmung vorher geprüft wird). Ohne `--printer` schreibt es den Byte-Stream nach `--out` (Standard `/tmp/label.prn`) und gibt den dekodierten Auftragstext aus. Wie bei `label:sim` ist das Trennzeichen `--` nötig, damit npm die Flags durchreicht.

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

### Auf Community-Updates prüfen *(v1.36)*

Die OpenPrintTag-Datenbank wird im Lauf der Zeit überarbeitet, während die Community Daten ergänzt. Ein importiertes Filament behält eine Verknüpfung zu seinem Quell-Material, sodass du spätere Verbesserungen übernehmen kannst, ohne den ganzen Katalog neu zu importieren.

Auf der Detailseite jedes aus OpenPrintTag importierten Filaments erscheint neben **Bearbeiten** ein türkiser **„Auf Updates prüfen"**-Button. Klicke ihn, um dein Filament mit dem aktuellen Upstream-Material zu vergleichen. Der Dialog listet jedes abweichende Feld auf:

- **Sichere Änderungen** (ein Feld, das du nie gefüllt hast, oder eines, das noch mit dem übereinstimmt, was OpenPrintTag zuletzt geliefert hat) sind **vorab angehakt** — sie sind bereit zur Übernahme.
- **Bearbeitete Felder** — bei denen dein lokaler Wert von dem abweicht, was OpenPrintTag zuletzt geliefert hat — sind als **„bearbeitet"** markiert und bleiben **nicht angehakt**, sodass das Anwenden von Updates einen selbst gesetzten Wert nicht stillschweigend überschreibt. Du kannst eines trotzdem anhaken, um den OpenPrintTag-Wert zu übernehmen.

Hake die gewünschten Änderungen an und klicke auf **„Anwenden"**. Nur die Identität bleibt unangetastet — Name, Vendor und Typ werden von einem Sync nie geändert, ebenso wenig der Durchmesser. Deine Spulen, Kalibrierungen und Verbrauchshistorie bleiben unberührt.

Sagt der Dialog, das Filament sei **aktuell**, gibt es upstream nichts Neues. Sagt er, das Material sei **nicht mehr in der Datenbank**, wurde der Eintrag auf der OpenPrintTag-Seite umbenannt oder entfernt.

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
- **Luftfeuchtigkeit %rF** — optional, vom Nutzer aktualisiert. *„Optional. Typisch für Trockenboxen — nach Hygrometer-Ablesung manuell aktualisieren."*
- **Trockenmittel gewechselt** *(v1.69)* — optionales Datum. *„Optional. Üblicherweise für Trockenboxen — setzen Sie es, wenn Sie das Granulat wechseln oder regenerieren."*
- **Notizen** — Freitext.

Luftfeuchtigkeit und Trockenmittel-Datum werden beide auf ein [Trockenbox-Etikett](#trockenbox-etiketten-knaon-y813bt-v169) gedruckt; Locations mit der Art **Trockenbox** bekommen in der Liste zusätzlich eine **„Etikett drucken"**-Aktion.

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
- **Verbrauch pro Tag**: Balkendiagramm mit einem Balken pro Tag. Ein **Detailliert**-Schalter neben der Überschrift („Jeden Balken nach Filament aufschlüsseln") stapelt jeden Balken nach Filament, färbt jedes Segment in der Farbe des jeweiligen Filaments — das größte unten — und ergänzt unter dem Diagramm eine Legende: die 10 Filamente mit den meisten Gramm im Zeitraum, der Rest als `+N weitere`. Standardmäßig aus und pro Browser gemerkt. Die Gramm der Segmente ergeben immer genau die Tagessumme, die der einfache Balken zeigt.
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

**Einstellungen → UI-Einstellungen → Theme**: wähle **Hell**, **Dunkel** oder **System**. System-Modus folgt der `prefers-color-scheme`-Media-Query des OS. Ein Inline-Init-Skript läuft vor dem Mounten von React, sodass die erste Darstellung bereits das richtige Theme zeigt — kein Dark-Mode-Flackern beim Kaltstart.

## Auto-Update (Desktop) *(v1.11)*

Ein schmaler Banner oben in der App kündigt eine neue Version an, lädt sie auf Wunsch im Hintergrund und fordert zum Restart-and-Install auf, sobald bereit. Alle Texte sind lokalisiert — der native Installations-Bestätigungsdialog nutzt die aktuelle Sprache des Renderers.

Unter macOS sind Release-Builds Developer-ID-signiert **und** notarisiert (seit v1.39.1), öffnen also ohne Gatekeeper-Warnung und aktualisieren sich normal automatisch — kein `xattr -cr` nötig. (Der erste Start nach einem notarisierten Download kann langsam sein, während macOS ihn verifiziert; das ist erwartet, kein Hänger.) Nutze `xattr -cr` nur als Fallback für eine *unsignierte* DMG, die du selbst gebaut hast. Der Banner zeigt außerdem einen **View release**-Button, falls du die DMG lieber manuell herunterlädst.

## Im lokalen Netzwerk freigeben (Desktop) *(v1.45)*

Einstellungen → **Im lokalen Netzwerk freigeben** lässt andere Geräte in deinem LAN den eingebauten Server dieser Desktop-Instanz erreichen. Standardmäßig ist die Option **aus** — dann bindet der eingebettete Server nur an localhost und nichts außerhalb dieses Rechners kann sich verbinden.

Schalte sie ein, und der Server bindet neu an `0.0.0.0` (alle Schnittstellen); das Einstellungs-Panel zeigt die LAN-URL, auf die du ein anderes Gerät richten kannst (z. B. `http://192.168.1.50:3456`). Mit dieser Adresse verbindet sich die mobile Scanner-App.

**Eine freigegebene Instanz absichern**: Setze die Umgebungsvariable `FILAMENTDB_API_KEY` auf dem Desktop-Host (oder Server), um ein Bearer-Token-Gate vor jede `/api/*`-Anfrage zu stellen — Clients müssen dann einen passenden API-Key senden. Bleibt sie ungesetzt (Standard), ist die API nicht authentifiziert — in einem vertrauenswürdigen Heimnetz in Ordnung, in einem exponierten nicht. Beachte: Das Gate ist Alles-oder-Nichts und **deaktiviert die Browser-Web-UI** (die den Key nicht sendet); es ist also für Nicht-Browser-Clients gedacht (Mobile-App, Slicer, Skripte). Für Browser-UI-Zugriff im LAN nutze Loopback + die Desktop-App oder einen authentifizierenden Reverse-Proxy — siehe [Eine netzwerkexponierte Instanz absichern](setup.md#eine-netzwerkexponierte-instanz-absichern).

## Im Netzwerk finden — mDNS-Auto-Discovery *(v1.47)*

Solange **Im lokalen Netzwerk freigeben** aktiviert ist, kündigt sich die Desktop-App per mDNS / Bonjour an (`_filamentdb._tcp`), sodass Clients sie finden können, ohne eine IP einzutippen. Der Button **„Im Netzwerk suchen"** der mobilen Scanner-App scannt nach dieser Ankündigung und bietet die gefundene Instanz zur Verbindung an. Die Ankündigung stoppt, sobald du die LAN-Freigabe wieder ausschaltest.

## Mobile Scanner-App

Eine leichtgewichtige iOS-/Android-Begleit-App liegt in [`packages/mobile/`](../../packages/mobile/README.md). Sie ist eine schlanke „Fernbedienung" für deinen Filament-DB-Server — die Geschäftslogik bleibt auf dem Server; die App leitet Scans und Bearbeitungen an die REST-API weiter und rendert die Antworten (plus eine kleine idempotente Offline-Schreibwarteschlange, die einen App-Neustart übersteht).

Was sie kann:

- **Verbinden** mit einem Filament-DB-Server per manueller URL **oder** mDNS-Auto-Discovery (siehe oben), mit optionalem API-Key, der im Geräte-Schlüsselbund gespeichert wird
- **Scannen** des QR-Labels einer Spule (ein Label-Deep-Link oder eine bloße Instanz-ID) oder eines **OpenPrintTag**-NFC-Tags (Rohbytes werden serverseitig dekodiert + gematcht); NFC ist über das Build-Flag `EXPO_PUBLIC_ENABLE_NFC` schaltbar (damit eine kostenlose Apple-ID einen reinen QR-Build ausliefern kann)
- **Filament anlegen** aus einem Scan sowie **Spulen-Deep-Links** folgen (`?spool=`)
- **Spule aktualisieren**: Restgewicht setzen, zwischen Standorten verschieben, ausmustern / reaktivieren sowie Verbrauch oder Trockenzyklen protokollieren

Bambu-Lab-MIFARE-Classic-Tags sind Android-only — iPhones können sie mit Core NFC nicht lesen. Siehe [`packages/mobile/README.md`](../../packages/mobile/README.md) für Build- und Setup-Anweisungen.
