> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../tutorial.md) maßgeblich.

# Einstieg in Filament DB

[< Zurück zur README](../README.md)

Schritt-für-Schritt-Anleitung durch jede Funktion der App — vom ersten Start bis zum NFC-Tag-Beschreiben.

---

## Schritt 1: Installation und Verbindungsmodus wählen

### Desktop-App (empfohlen)

1. Lade die neueste Version von [GitHub Releases](https://github.com/hyiger/filament-db/releases) herunter:
   - **macOS**: `.dmg`
   - **Windows**: `.exe`
   - **Linux**: `.AppImage` oder `.deb`
2. Öffne die App. Beim ersten Start erscheint der **Einrichtungs-Assistent** mit drei Verbindungsmodus-Optionen:

| Modus | Beschreibung | Atlas nötig? | Internet nötig? |
|------|-------------|:------------:|:---------------:|
| **MongoDB Atlas (Cloud)** | Alle Daten in der Cloud. Ist Atlas beim Start nicht erreichbar, weicht die App automatisch auf eine lokale Datenbank aus. | Ja | Ja (mit Fallback) |
| **Hybrid (Lokal + Cloud-Sync)** | Daten lokal gespeichert, synchronisiert mit Atlas bei Verbindung. *Empfohlen.* | Ja | Nein (funktioniert offline) |
| **Nur lokal (Offline)** | Alles auf diesem Computer gespeichert. Kein Konto nötig. | Nein | Nein |

3. **Für Atlas oder Hybrid**: Füge deine MongoDB-Atlas-Verbindungszeichenfolge ein und klicke auf **Verbinden**. Die App validiert vor dem Speichern.
   - Du hast noch keine? Klicke im Wizard auf den Atlas-Link, erstelle einen kostenlosen Cluster und kopiere die Verbindungszeichenfolge aus **Connect > Drivers**. Details in der [Einrichtungsanleitung](setup.md#mongodb-atlas-einrichten-kostenlose-stufe).
   - Die Zeichenfolge sieht so aus: `mongodb+srv://user:pass@cluster0.abc123.mongodb.net/filament-db`
4. **Für Offline**: Klicke auf **Nur lokal**, dann auf **Offline starten**. Keine Verbindungszeichenfolge nötig.

### Aus Quellen (Web-App)

```bash
git clone https://github.com/hyiger/filament-db.git
cd filament-db
npm install
cp .env.example .env.local   # mit deiner MongoDB-Atlas-URI bearbeiten
npm run dev                   # öffnet http://localhost:3456
```

> **Hinweis:** Die Web-App benötigt immer eine `MONGODB_URI` in `.env.local`. Offline- und Hybrid-Modus sind ausschließlich Desktop-App-Funktionen.
>
> **Port:** Source/Dev und die Desktop-App nutzen Port **3456**. Docker bindet Container-Port **3000** und wird normalerweise per `-p 3456:3000` auf den Host-Port 3456 gemappt.

---

## Schritt 2: Die App-Shell verstehen

Eine permanente obere Leiste begleitet jede Seite, links mit dem App-Namen und Schnellzugriff auf **Filamente**, **Dashboard**, **Vergleich**, **Analyse**, **Teilen** und **Einstellungen**. Auf schmalen Bildschirmen (Mobil) klappen die Links zu einem Hamburger-Menü zusammen. Die aktive Seite ist hervorgehoben.

Neben dem **Filament DB**-Titel auf der Startseite befindet sich eine kleine **Verbindungsstatus-Pille**, die deinen aktuellen Verbindungszustand auf einen Blick zeigt:

### Web-App

| Indikator | Bedeutung |
|-----------|-----------|
| 🟢 **Connected** | Browser hat Netzwerkverbindung |
| 🔴 **Offline** | Keine Netzwerkverbindung erkannt |

### Desktop-App — Atlas-Modus

| Indikator | Bedeutung |
|-----------|-----------|
| 🟢 **Connected** | Atlas ist erreichbar (per regelmäßigem Ping bestätigt) |
| 🟡 **No Connection** | Atlas ist nicht erreichbar; war Atlas beim Start nicht erreichbar, nutzt die App eine lokale Fallback-Datenbank |

### Desktop-App — Hybrid-Modus

| Indikator | Bedeutung |
|-----------|-----------|
| 🟢 **Synced 2m ago** | Letzte Synchronisation war erfolgreich (Relativzeit aktualisiert sich automatisch) |
| 🔵 **Syncing...** | Sync läuft (pulsierender Punkt) |
| 🟡 **Offline** | Kein Netzwerk; App nutzt lokale Daten und synchronisiert bei erneuter Verbindung |
| 🔴 **Sync error** | Letzter Sync-Versuch ist fehlgeschlagen |

**Klick auf die Pille** öffnet einen Tooltip mit:
- Aktuellem Verbindungsmodus
- Netzwerkstatus (Online / Offline)
- Zeitstempel des letzten Syncs
- Fehlerdetails (falls vorhanden)
- **Jetzt synchronisieren**-Button für manuellen Sync (deaktiviert, wenn offline)

### Desktop-App — Offline-Modus

| Indikator | Bedeutung |
|-----------|-----------|
| ⚪ **Local** | Alle Daten lokal gespeichert (immer angezeigt) |

---

## Schritt 3: Drucker einrichten

Wenn du mehrere Drucker hast (z. B. einen Prusa Core One und einen Bambu H2D), lege sie jetzt an, damit du später drucker-spezifische Kalibrierungen speichern kannst. Wenn du nur einen Drucker hast oder das überspringen möchtest, gehe zu Schritt 4.

1. Gehe in der oberen Navigation zu **Einstellungen** und klicke auf **Drucker**.
2. Klicke auf **+ Drucker hinzufügen**.
3. Trage ein:
   - **Hersteller** — z. B. `Prusa`
   - **Modell** — z. B. `Core One`
   - **Name** wird automatisch als `Prusa Core One` erzeugt (editierbar)
4. Wähle unter **Installierte Düsen** die Düsen, die auf diesem Drucker installiert sind (kannst du nach Schritt 4 nachholen). Ein Drucker kann mehrere haben, aber jede physische Düse lebt nur in einem Drucker gleichzeitig.
5. Klicke auf **Drucker erstellen**.
6. Wiederhole für jeden Drucker.

---

## Schritt 4: Erste Düse anlegen

Bevor du Filamente hinzufügst, benötigst du mindestens ein Düsenprofil, damit du später Pro-Düse-Kalibrierungen zuordnen kannst.

1. Gehe in der oberen Navigation zu **Einstellungen** und klicke auf **Düsen**.
2. Klicke auf **+ Düse hinzufügen**.
3. Fülle das Formular aus:
   - **Name** — kurze Bezeichnung, z. B. `0.4 Brass`
   - **Durchmesser** — Wert eintippen oder aus der Dropdown-Liste wählen (0.1 bis 2.0 mm)
   - **Typ** — Messing (Brass), gehärteter Stahl, Edelstahl, Kupfer, ObXidian, Diamondback usw.
   - **High Flow** — anhaken, wenn es eine High-Flow-Düse ist
   - **Hardened** — anhaken, wenn sie abrasive Materialien drucken kann
   - **Installiert in** — optional den einen Drucker wählen, in dem die Düse installiert ist (oder **Nicht in einem Drucker installiert** lassen); kann später gesetzt werden
   - **Notizen** — optionaler Freitext
4. Klicke auf **Düse erstellen**.
5. Wiederhole für jede Düse. Du kannst jederzeit weitere hinzufügen.

---

## Schritt 5: Filament hinzufügen

### Option A: Manuell anlegen

1. Klicke auf der Startseite auf **+ Filament hinzufügen**.
2. Fülle die Pflichtfelder aus:
   - **Name** — z. B. `Prusament PLA Galaxy Black`
   - **Vendor** — z. B. `Prusa`
   - **Typ** — aus der Dropdown-Liste wählen oder benutzerdefiniert eintippen. Übliche Typen: PLA, PETG, PCTG, ABS, ASA, PA, PC, TPU.
3. Setze die **Farbe** mit dem Farbwähler.
4. Trage Temperaturen ein:
   - **Düse / Düse 1. Schicht** — z. B. `215 / 220`
   - **Bett / Bett 1. Schicht** — z. B. `60 / 65`
   - **Kammer** — bei Open-Air-Materialien leer lassen
5. Trage optionale Eigenschaften ein:
   - **Kosten** ($/kg), **Dichte** (g/cm³), **Durchmesser** (mm, Standard 1.75)
   - **Max. Volumetric Speed**, **Extrusion Multiplier**, **Pressure Advance**
   - **Schwindung** XY/Z, **Lüfter**-Geschwindigkeiten, **Retraction**-Einstellungen
   - **Abrasiv**- / **Löslich**-Flags
6. Hake unter **Kompatible Düsen** jede Düse an, mit der du dieses Filament getestet hast.
7. Füge unter **TDS-Link** eine URL zum Technical Data Sheet des Herstellers ein. Wenn du bereits Filamente desselben Herstellers hinzugefügt hast, erscheinen Vorschlagsbuttons — Klicken füllt automatisch aus.
8. Klicke auf **Filament erstellen**.

### Option B: Aus bestehender Quelle vorbefüllen

Auf der **Neues Filament**-Seite bietet die Werkzeugleiste **„Vorbefüllen von"** vier Buttons plus einen automatischen NFC-Pfad:

- **Prusament QR** — gib eine Spulen-ID oder URL aus einem Prusament-QR-Code ein, um vollständige Specs zu laden.
- **Aus TDS importieren** — füge eine Technical-Data-Sheet-URL ein, und die AI extrahiert Temperaturen, Dichte, Trockenspezifikationen, Tg, HDT, Shore-Härte und mehr. Erfordert einen in den Einstellungen konfigurierten AI-API-Key (siehe [Schritt 5b](#schritt-5b-aus-einem-technical-data-sheet-importieren)).
- **Aus INI laden** — lade ein PrusaSlicer-`.ini`-Config-Bundle hoch. Enthält es ein Filament-Profil, wird das Formular automatisch befüllt. Bei mehreren Profilen erlaubt ein Auswahldialog die Wahl.
- **Clone Existing** — durchsuche deine Bibliothek und wähle ein Filament. Es werden nur Identifikationsfelder (Name mit „(copy)"-Suffix, Farbe, Vendor, Typ) übernommen; alles andere wird live vom Eltern-Filament geerbt, sodass die neue Variante die Kalibrierungen des Elternfilaments verfolgt.
- **NFC-Tag** (nur Desktop, kein Button — automatisch) — bei verbundenem Reader eine Spule mit Tag auflegen. Das Formular befüllt sich automatisch mit Material, Hersteller, Temperaturen, Dichte und Farbe aus den OpenPrintTag-Daten.

Nach dem Befüllen prüfe und passe Felder an, bevor du auf **Filament erstellen** klickst.

### Schritt 5b: Aus einem Technical Data Sheet importieren

Wenn du einen Link auf das Technical Data Sheet eines Herstellers hast (PDF oder Webseite), kann die App mit AI die Filamenteigenschaften automatisch extrahieren.

**Erstmaliges Setup (einmalig):**

1. Gehe in der oberen Navigation zu **Einstellungen** (oder zu `/settings`).
2. Scrolle zu **AI-Funktionen**.
3. Wähle einen Anbieter: **Google Gemini** (kostenlose Stufe), **Anthropic Claude** oder **OpenAI ChatGPT**.
4. Klicke auf den Anbieter-Link, um einen API-Key zu erhalten (Gemini ist kostenlos, Claude und OpenAI sind pay-per-use).
5. Füge den Key ein und klicke auf **Key speichern**. Ein grüner Punkt bestätigt die Konfiguration.

**Aus TDS importieren:**

1. Klicke auf der **Neues Filament**-Seite auf **„Aus TDS importieren"** (lila Button in der Werkzeugleiste).
2. Füge die TDS-URL ein (z. B. `https://bambulab.com/filament/pla-basic-tds.pdf`).
3. Klicke auf **Extrahieren**. Die AI liest das Dokument und extrahiert alle verfügbaren Eigenschaften.
4. Das Formular befüllt sich automatisch mit den extrahierten Daten. Ein Toast zeigt, wie viele Felder extrahiert wurden (z. B. „12 Felder aus TDS extrahiert").
5. Die TDS-URL wird zusätzlich im TDS-Link-Feld des Filaments gespeichert.
6. Prüfe, passe bei Bedarf an und klicke auf **Filament erstellen**.

---

## Schritt 6: Filamente in Bulk importieren

### Aus PrusaSlicer

Wenn du bereits Profile in PrusaSlicer hast, importiere sie in Bulk statt jedes einzeln einzutippen.

1. Gehe in PrusaSlicer zu **Datei > Export > Config Bundle exportieren** und speichere die `.ini`-Datei.
2. Öffne auf der Filament-DB-Startseite das Dropdown **Importieren/Exportieren** und klicke auf **INI importieren**.
3. Wähle die `.ini`-Datei.
4. Ein Toast bestätigt: `42 Filamente importiert (38 neu, 4 aktualisiert)`.

### Aus einer anderen Filament-DB (Atlas-Import)

Du kannst Filamente aus einer anderen Filament-DB-Instanz auf MongoDB Atlas importieren:

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **Aus Atlas importieren**.
2. Trage die MongoDB-Atlas-Verbindungszeichenfolge der Remote-Datenbank ein.
3. Klicke auf **Verbinden** — die App ruft alle Filamente aus der Remote-Datenbank ab.
4. Eine Liste erscheint mit Checkboxen pro Filament. Die Eltern-/Varianten-Hierarchie wird durch Einrückung und Pfeil-Marker dargestellt. Nutze **Alle auswählen** / **Auswahl aufheben** zum Umschalten.
5. Klicke auf **X Filamente importieren**, dann **Import bestätigen**.
6. Bestehende Filamente mit demselben Namen werden aktualisiert; neue werden angelegt. Eltern-/Varianten-Beziehungen aus der Remote-DB werden nicht erhalten.

### Aus einem Prusament-Spulen-QR-Code

Prusament-Spulen haben einen QR-Code, der auf eine Detailseite mit vollständigen Specs verweist (Material, Farbe, Temperaturen, Gewicht, Durchmessertoleranzen, Preise).

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **Prusament QR**.
2. Trage die Spulen-ID (z. B. `c6974284da`) ein oder füge die vollständige URL vom QR-Code ein.
3. Die App lädt die Spulendaten und zeigt Material, Farbswatch, Temperaturen, Gewichte und Preise.
4. Wähle **„Neues Filament"** für einen voll befüllten Filament-Eintrag oder **„Spule zu bestehendem hinzufügen"**, um die Spule einem passenden Filament zuzuordnen.
5. Klicke auf **Importieren**.

Du kannst auch **„+ Prusament QR"** auf der Detailseite eines Filaments (im Spulen-Tracker) anklicken, um eine weitere Spule desselben Materials hinzuzufügen.

### Aus CSV oder XLSX

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **Datei importieren (INI / CSV / XLSX)**. Die App leitet anhand der Dateierweiterung weiter (`.csv` → CSV-Importer, `.xlsx` → XLSX-Importer, `.ini` → PrusaSlicer-Bundle).
2. Wähle eine Datei mit einer Kopfzeile, die mindestens `Name`, `Vendor` und `Type` enthält.
3. Ein Toast bestätigt die Anzahl importierter Filamente. Nur in der Datei vorhandene Felder werden aktualisiert — bestehende Daten für nicht zugeordnete Spalten bleiben erhalten.

### Aus einer Snapshot-Sicherung

1. Gehe zu **Einstellungen → Sicherung & Wiederherstellen** und klicke auf **„Aus Snapshot wiederherstellen"**.
2. Wähle eine zuvor exportierte Snapshot-JSON-Datei.
3. Alle aktuellen snapshot-relevanten Daten werden durch die Snapshot-Inhalte ersetzt (Best-Effort-Rollback bei Fehler).

### Via CLI (alternativ)

```bash
# Standardpfad (~/Downloads/PrusaSlicer_config_bundle.ini)
npx tsx scripts/seed.ts

# Benutzerdefinierter Pfad
npx tsx scripts/seed.ts /path/to/your_config.ini
```

Das CLI erzeugt zusätzlich Düsenprofile aus `compatible_printers_condition` in der INI-Datei.

---

## Schritt 7: Bibliothek durchsuchen und filtern

Die Startseite zeigt alle Filamente in einer sortierbaren Tabelle.

- **Suche** — tippe in das Suchfeld, um nach Namen zu filtern
- **Filter nach Typ** — nutze die Typ-Dropdown-Liste, um nur PLA, PETG, ASA usw. anzuzeigen
- **Filter nach Vendor** — nutze die Vendor-Dropdown-Liste, um nur einen Hersteller anzuzeigen
- **Sortieren** — klicke einen Spaltenkopf (Name, Vendor, Typ, Düsen-Temp, Bett-Temp, Kosten), um auf- oder absteigend zu sortieren. Die aktive Sortierung zeigt einen blauen Pfeil.
- **Farbswatches** — jede Zeile zeigt die Farbe des Filaments als Punkt
- **Statistik** — klicke auf die Zusammenfassungszeile (z. B. „18 Filamente · 8 Typen · 5 Vendors"), um Balkendiagramme nach Typ und Vendor sowie ein Farbswatch-Grid einzublenden

### Eltern-/Varianten-Gruppierung

Wenn du Farbvarianten hast, zeigen Elternfilamente ein Count-Badge (z. B. „5 Farben"). Klicke den Pfeil zum Erweitern und sieh die Variantenzeilen mit eigenen Swatches und Namen. Erneuter Klick klappt zusammen.

---

## Schritt 8: Filament-Details ansehen

Klicke einen Filamentnamen, um die Detailseite zu öffnen. Du siehst:

- **Header** — Farbswatch, Name, Vendor, Typ und Badges für „Variante" oder „3 Farben"
- **Info-Karten** — Düsen-Temp, Bett-Temp, Kosten, Dichte, Durchmesser, Max. Volumetric Speed. Karten mit blauem Hintergrund und „(geerbt)"-Label zeigen Werte, die vom Eltern-Filament geerbt werden.
- **Kalibrierungen** — Tabellen gruppiert nach Drucker (wenn mehrere Drucker Daten haben) mit Pro-Düse-Werten für EM, Max Vol Speed, PA, Retract Length, Retract Speed und Z Lift. Gibt es keine Kalibrierungen, werden kompatible Düsen als einfache Badges angezeigt.
- **TDS-Vorschau** — klicke „Technical Data Sheet anzeigen" für eine eingebettete Vorschau oder „In neuem Tab öffnen" für Vollbild. Viele Hersteller-Seiten (Shopify, Wix usw.) verweigern das Einbetten in andere Seiten; für solche URLs zeigt das Vorschaufenster eine erläuternde Tafel mit einem **Datenblatt öffnen ↗**-Button statt einer leeren iframe.
- **PrusaSlicer-Einstellungen** — klicke „Alle PrusaSlicer-Einstellungen anzeigen", um jedes Roh-Key-Value-Paar einzublenden.

### Navigation für Varianten

- Bei einem **Eltern**-Filament zeigt ein Abschnitt „Farbvarianten" klickbare Karten pro Variante (Farbpunkt + Name + Kosten).
- Bei einer **Variante** zeigt ein blaues Banner „Erbt Einstellungen vom Elternfilament" mit der Anzahl geerbter Felder.

---

## Schritt 9: Filament bearbeiten

1. Klicke auf der Detailseite **Bearbeiten** (blauer Button).
2. Ändere beliebige Felder. Das Formular ist identisch zum Erstellen-Formular und mit aktuellen Werten vorbefüllt.
3. Um Kalibrierungen hinzuzufügen: hake eine Düse unter „Kompatible Düsen" an und fülle die darunter erscheinenden Kalibrierungsfelder aus. Wenn du Drucker definiert hast, nutze die Drucker-Tabs für drucker-spezifische Werte.
4. Klicke auf **Filament aktualisieren**.

Du kannst den **Bearbeiten**-Button auch direkt in der Zeile auf der Startseite klicken.

---

## Schritt 10: Farbvarianten erstellen

Varianten teilen sich die Einstellungen eines Elternfilaments (Temperaturen, Dichte, Retraction, Kalibrierungen) und speichern nur Unterschiede: Name, Farbe und Kosten.

Es gibt zwei Affordances auf der Detailseite. Beide erzeugen eine neue Variante, sie befüllen das Formular aber unterschiedlich:

- **„+ Variante erstellen"** (fuchsia Button) — nur auf **Root**-Filamenten sichtbar (also nicht bereits eine Variante). Das Formular öffnet sich mit verknüpftem Eltern-Filament, **Vendor** und **Typ** sind vom Eltern-Filament übernommen, und die weiteren Werte des Eltern-Filaments erscheinen als **Platzhalter-Text** in den Eingabefeldern (nicht vorbefüllt). Lässt du ein Feld leer, erbt die Variante weiterhin live vom Eltern-Filament; tippst du etwas hinein, überschreibt sie nur dieses eine Feld. Schnellster Weg, wenn du eine echte Variante willst, die alles außer der Farbe teilt.
- **Klonen** (amber Button) — auf **jedem** Filament sichtbar, ob Root oder Variante. Das Formular öffnet sich mit **Name** (mit „(copy)"-Suffix), **Farbe**, **colorName**, **Vendor** und **Typ** wortgleich vom Quell-Filament kopiert — ein vollständiges Identitäts-Duplikat. Die Eltern-Beziehung wird automatisch gesetzt: Klonen eines Roots macht das neue Filament zu einer Variante dieses Roots; Klonen einer Variante macht das neue Filament zu einer **Schwester** unter demselben Eltern-Filament. Am besten, wenn du einen Ausgangspunkt willst, an dem du stark verändern möchtest.

Schritte:

1. Öffne die Detailseite eines Filaments.
2. Klicke auf **„+ Variante erstellen"** (falls verfügbar) oder **Klonen**.
3. Das Formular öffnet sich nach den obigen Regeln vorbefüllt. Nicht vorbefüllte (bzw. nicht überschriebene) Felder erben live vom Eltern-Filament — das ist das Design aus GH #106; der Platzhalter-Text zeigt, was du bekommst.
4. Bearbeite den **Namen** (nur bei Klonen — Variante erstellen lässt das Feld leer zum selbst-Eingeben), wähle eine neue **Farbe** und passe optional **colorName** an.
5. Klicke auf **Filament erstellen**. Das neue Filament wird als Variante des Eltern-Filaments registriert; künftige Änderungen an Kalibrierungen / Temperaturen / Einstellungen des Eltern-Filaments fließen automatisch in nicht überschriebene Felder.

> **Designregel**: Varianten von Varianten werden nicht unterstützt. Ein Eltern-Filament muss ein Top-Level-Filament sein. Deshalb ist „+ Variante erstellen" auf Varianten-Seiten ausgeblendet, und Klonen einer Variante erzeugt eine Schwester statt einer Verschachtelung.

Um ein bestehendes eigenständiges Filament in eine Variante umzuwandeln:

1. Klicke auf **Bearbeiten** beim Filament.
2. Suche und wähle unter **Eltern-Filament** das Eltern-Filament.
3. Klicke auf **Filament aktualisieren**.

---

## Schritt 11: Nach PrusaSlicer exportieren

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **INI exportieren**.
2. Eine `.ini`-Datei wird heruntergeladen, die alle Filamente als `[filament:Name]`-Abschnitte enthält — ein Abschnitt pro Filament.
3. Gehe in PrusaSlicer zu **Datei > Importieren > Config Bundle importieren** und wähle die Datei.

Kalibrierungs-Overrides (Extrusion Multiplier, Pressure Advance, Retraction, Max Volumetric Speed) sind in der exportierten INI **nicht** enthalten — sie werden dynamisch von PrusaSlicer Filament Edition über die Kalibrierungs-API angewandt, wenn sich der Drucker-/Düsen-Kontext ändert.

---

## Schritt 12: Düsen und Drucker verwalten

### Düsen

Gehe zu **Einstellungen** und klicke auf **Düsen**.

- **Bearbeiten** — klicke „Bearbeiten" neben einer Düse, um ihre Eigenschaften zu ändern.
- **Löschen** — klicke „Löschen", um eine Düse zu entfernen. Wenn Filamente sie referenzieren, wird das Löschen blockiert und eine Meldung zeigt dir, wie viele Filamente du vorher aktualisieren musst.
- **Erstellen** — klicke „+ Düse hinzufügen", um eine neue anzulegen.

### Drucker

Gehe zu **Einstellungen** und klicke auf **Drucker**.

- **Bearbeiten** — klicke „Bearbeiten" neben einem Drucker, um Eigenschaften oder installierte Düsen zu ändern.
- **Löschen** — klicke „Löschen", um einen Drucker zu entfernen. Referenzieren Filament-Kalibrierungen ihn, wird das Löschen blockiert.
- **Erstellen** — klicke „+ Drucker hinzufügen" zum Anlegen.

### Druckbett-Typen

Gehe zu **Einstellungen** und klicke auf **Druckbett-Typen**.

- **Erstellen** — klicke „+ Druckbett-Typ hinzufügen", um eine Druckbett-Oberfläche zu definieren (z. B. „Smooth PEI", „Textured PEI", „G10/FR4").
- **Bearbeiten** — klicke „Bearbeiten" neben einem Druckbett-Typ, um Name, Material oder Notizen zu ändern.
- **Löschen** — klicke „Löschen", um einen Druckbett-Typ zu entfernen. Referenzieren Filament-Kalibrierungen ihn, wird das Löschen blockiert.

Sobald Druckbett-Typen definiert sind, zeigt der Kalibrierungs-Abschnitt im Filament-Formular einen Druckbett-Typ-Selektor, sodass du pro Druckbett-Typ Overrides für Temperaturen, Lüftereinstellungen und Kalibrierungswerte hinterlegen kannst.

---

## Schritt 13: NFC-Tags (nur Desktop-App)

NFC-Funktionen erfordern die Electron-Desktop-App plus Hardware. Überspringe diesen Abschnitt, wenn du nur die Web-App nutzt.

### Benötigte Hardware

| Element | Details |
|---------|---------|
| **Lesegerät** | ACS ACR1552U USB (~40–50 $) |
| **OpenPrintTag-Tags** | NXP ICODE SLIX2 (ISO 15693, 320 Bytes) — Lesen/Schreiben |
| **Bambu-Lab-Spulen** | MIFARE-Classic-Tags auf Bambu-Filamentspulen — nur lesen (automatisch erkannt) |
| **macOS-Treiber** | Installiere [ifd-acsccid.bundle](https://www.acs.com.hk/en/drivers/) von ACS |
| **Linux- / RPi-Treiber** | `sudo apt install pcscd libpcsclite-dev` (Standard-`ccid`-Treiber) |
| **Windows-Treiber** | Nicht nötig — eingebauter Microsoft-CCID-Treiber funktioniert |

### NFC-Statusanzeige

Ein kleiner farbiger Punkt im Header:

| Farbe | Bedeutung |
|-------|-----------|
| Grau | Kein Reader erkannt — USB-Verbindung prüfen |
| Gelb | Reader verbunden, wartet auf Tag |
| Grün | Tag auf dem Reader erkannt |

### Tag lesen

1. Schließe den ACR1552U an. Der Statuspunkt wird **gelb**.
2. Lege eine Spule mit Tag auf den Reader. Der Punkt wird **grün**.
3. Die App erkennt den Tag-Typ automatisch (OpenPrintTag oder Bambu Lab) und liest ihn. Ein Dialog erscheint:
   - **Treffer gefunden** — zeigt das gematchte Filament mit einem **Filament öffnen**-Link.
   - **Kein Treffer** — zeigt die dekodierten Tag-Daten (Material, Marke, Temperaturen, Dichte usw.) mit einem **Neues Filament erstellen**-Button, der das Formular mit allen Tag-Daten vorbefüllt.
   - **Ähnliche Filamente** — gibt es keinen exakten Treffer, aber Hersteller oder Typ passen, werden Kandidaten angezeigt. Klicke **+ Variante** neben einem, um das Tag-Filament als Farbvariante eines bestehenden Eltern-Filaments anzulegen.
   - **Bambu-Lab-Spulen** — zeigt ein „read-only"-Badge mit Produktionsdatum und Filamentlänge. Erstellen/Importieren funktioniert gleich — nur das Zurückschreiben ist deaktiviert.
4. Klicke auf **Schließen**, um den Dialog zu schließen.

### Tag schreiben

1. Navigiere zur Detailseite eines beliebigen Filaments.
2. Lege einen leeren SLIX2-Tag auf den Reader (Punkt wird grün).
3. Klicke auf **NFC schreiben** (lila Button).
4. Warte ~2 Sekunden. Der Button zeigt **Geschrieben!** bei Erfolg oder **Schreiben fehlgeschlagen** bei Fehler.

### Tag löschen

1. Gehe in der oberen Navigation zu **Einstellungen**.
2. Scrolle zum Abschnitt **NFC-Tools** — er zeigt Reader-/Tag-Status.
3. Lege einen Tag auf den Reader (Status wird grün).
4. Klicke auf **Tag löschen** (roter Button).
5. Bestätige die Aktion. Die App nullt alle Speicherblöcke und schreibt einen leeren Header.
6. Der Tag ist jetzt leer und bereit, neu beschrieben zu werden.

Wenn du den Tag entfernst, bevor du bestätigst, schließt sich die Bestätigung automatisch.

### OpenPrintTag-Binärdatei exportieren

Falls du externe NFC-Tools bevorzugst:

1. Klicke auf der Detailseite eines Filaments auf **OPT exportieren** (grüner Button).
2. Eine `.bin`-Datei wird heruntergeladen, die die NDEF-verpackte CBOR-Nutzlast enthält.
3. Schreibe diese Datei mit deiner bevorzugten NFC-Software auf einen Tag.

---

## Schritt 14: Sync- und Offline-Workflow (Desktop-App — Hybrid-Modus)

Wenn du im Setup **Hybrid** gewählt hast, leben deine Daten lokal und werden automatisch mit Atlas synchronisiert. So funktioniert es im Alltag:

### Automatische Synchronisation

- Die App synchronisiert alle **5 Minuten** mit Atlas, wenn verbunden.
- Lokale Änderungen werden zu Atlas gepusht; entfernte Änderungen (z. B. von der Web-App oder einem anderen Gerät) werden geholt.
- **Synchronisierte Sammlungen**: filaments (mit eingebetteten Spulen), nozzles, printers, locations, bedtypes, printhistories, sharedcatalogs.
- Die Sync-Status-Pille neben „Filament DB" zeigt den aktuellen Zustand — siehe [Schritt 2](#schritt-2-die-app-shell-verstehen).

### Offline arbeiten

- Verlierst du das Internet, arbeitet die App normal weiter gegen die lokale Datenbank.
- Die Status-Pille wird gelb („Offline").
- Sobald Internet wieder verfügbar ist, holt der nächste Sync-Zyklus Änderungen von beiden Seiten.

### Manuelle Synchronisation

- Klicke auf die Status-Pille, um den Tooltip zu öffnen, und klicke dann auf **Jetzt synchronisieren**, um sofort einen Sync auszulösen.

### Konfliktauflösung

Wurde dasselbe Filament seit dem letzten Sync auf beiden Seiten bearbeitet, gewinnt die Version mit dem neuesten `updatedAt`-Zeitstempel (**Last-Write-Wins**). Pro Dokument, nicht pro Feld.

### Atlas-Fallback (Atlas-Modus)

Sogar im reinen **Atlas-Modus** startet die App eine lokale Datenbank, wenn Atlas beim Start nicht erreichbar ist, und zeigt eine gelbe Pille „Offline — using local data". Sobald Atlas wieder erreichbar ist, gleicht ein Sync beide Seiten ab.

---

## Schritt 15: Spulen verfolgen

Jedes Filament kann mehrere physische Spulen mit individuellen Gewichten verfolgen.

1. Suche auf der Detailseite eines Filaments den Abschnitt **Spulen-Tracker**. Seit v1.30.3 wird er immer angezeigt — bei einem brandneuen Filament ohne Gewichtsmetadaten erscheint über dem **„+ Spule hinzufügen"**-Button ein kurzer „Noch keine Spulen"-Hinweis.
2. Klicke auf **„+ Spule hinzufügen"**, um eine neue Spule mit optionalem Label und Gewicht hinzuzufügen.
3. Jede Spule zeigt Label, Gesamtgewicht und einen Lösch-Button.
4. Der Tracker aggregiert Statistiken über alle Spulen (Gesamtgewicht, berechnete Länge aus Dichte und Durchmesser).
5. Jede Spule kann zusätzlich einer **Location** (Lagerort) und einem **Drucker-Slot** (AMS/MMU-Position, an der sie aktuell geladen ist — eine Spule belegt einen Slot zu einer Zeit) zugewiesen werden.

Wenn ein Filament ein einzelnes `totalWeight`, aber noch keine Spulen hat, klicke auf **„In Spulen-Tracking migrieren"**, um es zu konvertieren.

Wenn du eine Spule aufbrauchst und ihr Restgewicht auf **0** setzt, fragt die App, ob sie im selben Schritt auch als **ausgemustert** markiert werden soll — das ist der kanonische „Ich habe diese Spule fertig"-Workflow. Beim Ausmustern bleibt die vollständige Historie (Daten, Trockenzyklen, Verbrauchslog) erhalten, sie wird aber aus den Inventarsummen ausgeschlossen, sodass deine Restgewichtsanzeigen sauber bleiben, ohne die Herkunft zu verlieren.

---

## Schritt 16: OpenPrintTag-Community-Datenbank durchsuchen

Entdecke Tausende FDM-Filamente von vielen Marken in der [OpenPrintTag-Community-Datenbank](https://github.com/OpenPrintTag/openprinttag-database) und importiere sie gezielt in deine Bibliothek. Die Seite zeigt im Untertitel Live-Anzahlen (die Datenbank wächst, je mehr die Community beiträgt).

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„OpenPrintTag-DB durchsuchen"**.
2. Der Browser lädt alle FDM-Filamente (SLA-Harze werden automatisch herausgefiltert).
3. Materialien sind nach Datenvollständigkeit farbcodiert:
   - 🟢 **Rich** (7–10 Felder) — grüner Fortschrittsbalken, voll deckend
   - 🟡 **Partial** (4–6 Felder) — gelber Fortschrittsbalken, voll deckend
   - ⚪ **Stub** (0–3 Felder) — grauer Fortschrittsbalken, 50 % Deckkraft
4. Verwende die **Seitenleisten-Filter**, um die Ergebnisse einzuschränken:
   - **Suche** nach Name oder Marke
   - **Sortierung** nach Name, Marke, Typ oder Vollständigkeit
   - Filter nach **Datenqualität**, **Typ** oder **Marke**
5. **Klicke eine Zeile**, um eine Detailansicht zu öffnen, die Identität, Eigenschaften (Dichte, Temperaturen, Härte, Transmission Distance) sowie Datenqualität mit Links zeigt.
6. **Wähle Materialien** mit Checkboxen, dann klicke auf **„Auswahl importieren"**.
7. Importierte Filamente werden anhand von Name und Hersteller gematcht — bestehende Einträge werden aktualisiert (nur leere Felder werden ergänzt), neue Einträge werden angelegt.

---

## Schritt 17: PrusaSlicer-Integration

### Live-Sync mit PrusaSlicer Filament Edition

Wenn du [PrusaSlicer Filament Edition](https://github.com/hyiger/PrusaSlicer) nutzt:

1. Starte Filament DB (Desktop-App oder Web)
2. Starte PrusaSlicer Filament Edition — es lädt Filament-Presets automatisch aus Filament DB
3. Deine Filamente erscheinen in der Filament-Dropdown-Liste; Kalibrierungswerte (EM, Max Volumetric Speed, PA, Retraction) werden dynamisch angewandt, wenn du Drucker/Düse wechselst
4. Bearbeite Filamente in Filament DB, starte PrusaSlicer neu — die aktualisierten Werte erscheinen automatisch

> **Port:** Filament-DB-Dev/Desktop läuft auf Port **3456**. Docker verwendet Container-Port **3000** und wird normalerweise auf Host-Port **3456** gemappt. PrusaSlicer erwartet standardmäßig `http://localhost:3456`.

### Manueller Export/Import

Ohne den Fork synchronisierst du manuell:

1. Öffne auf der Startseite das Dropdown **Importieren/Exportieren** und klicke auf **„INI exportieren"** für ein PrusaSlicer-kompatibles Config-Bundle
2. Gehe in PrusaSlicer zu **Datei > Importieren > Config Bundle importieren** zum Laden
3. Um aus PrusaSlicer zurückzuimportieren, exportiere ein Config-Bundle und nutze **Importieren/Exportieren > „INI importieren"** in Filament DB

---

## Schritt 18: Filament löschen

Zwei Wege, gleiches Ergebnis:

- **Bulk** — auf der Startseite eine Checkbox am Anfang einer Filament-Zeile aktivieren (oder die Kopf-Checkbox für alle Zeilen). Eine rote Bulk-Aktionsleiste über der Tabelle zeigt die Anzahl ausgewählter Filamente. Klicke **N löschen** und bestätige.
- **Einzeln (v1.29)** — auf der Filament-Detailseite den roten **Löschen**-Button oben rechts klicken. Schneller, wenn du das Filament bereits geöffnet hast.

**Hinweis**: Eltern-Filamente mit Farbvarianten können nicht gelöscht werden — lösche zuerst die Varianten. Fehlgeschlagene Löschungen erscheinen als Pro-Zeile-Fehler-Toast und der Rest des Stapels läuft trotzdem durch.

Beide Wege soft-löschen: das Filament wird mit einem `_deletedAt`-Zeitstempel markiert und in den Papierkorb verschoben. Die Löschung propagiert im Hybrid-Modus beim nächsten Sync-Zyklus korrekt zwischen Geräten. Aus dem Papierkorb kannst du wiederherstellen oder endgültig löschen; endgültige Löschungen propagieren ebenfalls über einen `_purged`-Tombstone, sodass sie nicht durch den Sync eines Peers wiederauferstanden werden.

---

## Schritt 19: Locations einrichten *(v1.11)*

Bevor du zum Spulen-Tracker greifst, lohnt es sich zu beschreiben, wo deine physischen Spulen liegen:

1. Navigiere zu **Locations** (obere Nav) → `/locations`
2. Klicke auf **+ Location hinzufügen**
3. Gib einen Namen (z. B. `Drybox #1`), wähle eine **Art** (Regal / Drybox / Schrank / Drucker) und optional die Luftfeuchtigkeit
4. Wiederhole für jeden physischen Container, den du verfolgen möchtest

Sobald mindestens eine Location existiert, bekommt jede Spule, die du hinzufügst (oder bearbeitest), ein **Location**-Dropdown. Die Locations-Listenansicht zeigt Live-Inventarzählungen — Anzahl Spulen und Gesamtgramm pro Location —, sodass du auf einen Blick siehst, welche Drybox fast leer ist.

## Schritt 20: Low-Stock-Schwellen konfigurieren *(v1.11)*

1. Bearbeite ein beliebiges Filament
2. Setze unter **Bestandseinstellungen** den **Low-Stock-Schwellwert (g)** — z. B. `250`, um gewarnt zu werden, wenn über alle Spulen weniger als 250 g verbleiben
3. Speichern

Das Dashboard zeigt jedes Filament unter seinem Schwellwert in der **Niedriger Bestand**-Liste. Ein kleiner Chip in der Hauptliste markiert sie ebenfalls. Filamente ohne Schwellwert werden nie geflaggt.

## Schritt 21: Druckaufträge protokollieren, Analysen beobachten *(v1.11)*

Jedes Mal, wenn du einen Druck startest, logge ihn entweder aus deinem Slicer (via `/api/print-history`) oder manuell auf der Spulen-Detailseite (**Verbrauch loggen** → Gramm eintragen). Die App:

- Verringert das Gewicht der Spule
- Hängt einen `usageHistory`-Eintrag an
- Aktualisiert das **Analytics**-Dashboard

Öffne **Analytics** (`/analytics`), um den Verbrauch der letzten 7 / 30 / 90 / 365 Tage zu sehen, aufgeschlüsselt nach Filament, Vendor und Drucker. Manuelle Spulen-Edit-Einträge und Slicer-gesteuerte Jobs erscheinen in derselben Ansicht, ohne doppelt gezählt zu werden.

## Schritt 22: Trockenzyklen protokollieren *(v1.11)*

Wenn du dein Filament vor dem Druck trocknest, logge jeden Zyklus auf der Spulen-Detailseite:

1. Öffne die Spule
2. Klicke auf **+ Trockenzyklus protokollieren**
3. Erfasse Temperatur, Dauer und Notizen

Die **Trocknen nötig**-Liste des Dashboards zeigt Spulen, deren letzter Zyklus älter als 30 Tage ist.

## Schritt 23: Katalog teilen *(v1.11)*

Möchtest du einem Freund deinen exakten PLA- + PETG-Setup schicken?

1. Navigiere zu **Teilen** (`/share`)
2. Klicke auf **+ Neuen Shared Catalog**
3. Wähle Filamente (Multi-Select), setze einen Titel, optional eine Beschreibung, optional Ablaufdatum
4. Klicke auf **Veröffentlichen** — du bekommst eine Kurz-URL

Empfänger, die die URL öffnen, sehen eine schreibgeschützte Liste. Sie können per Multi-Select **Auswahl importieren** klicken, um die Filamente (plus referenzierte Düsen/Drucker/Druckbett-Typen) in ihre eigene Instanz zu ziehen. Gleichnamige Datensätze am Zielort werden wiederverwendet, sodass nichts doppelt entsteht.

**Unpublish** ist ein Soft-Delete: Der Slug liefert sofort 404 für alle, die den Link halten, aber die Zeile bleibt in der Sammlung, damit der Peer-Sync das Unpublish überträgt (sonst würde der andere Peer die noch aktive Kopie zurückspielen). Slugs können bei künftigem Republish wiederverwendet werden.

## Schritt 24: Filamente vergleichen *(v1.11)*

Hake in der Filament-Liste die Checkboxen neben 2–4 Zeilen an und klicke auf **Vergleichen**. Die `/compare`-Seite legt sie nebeneinander — Temperaturen, Kosten, Dichte, Kalibrierungen und Restgewicht —, sodass du das passende für einen Job wählen kannst.

## Schritt 25: Spulen aus einer Tabelle bulk-importieren *(v1.11)*

1. Exportiere dein Inventar aus einer Tabelle mit den Spalten: `filament, totalWeight` (erforderlich) plus optional `vendor, label, lotNumber, purchaseDate, openedDate, location`
2. Klicke auf der Filament-Liste auf **Importieren → Spulen aus CSV**
3. Füge die CSV ein oder lade die Datei hoch
4. Prüfe die Pro-Zeile-Ergebnisse — Tippfehler werden mit Zeilennummer markiert, sodass du sie korrigieren und erneut versuchen kannst

Fehlende Locations werden automatisch angelegt, du musst sie nicht vorher anlegen.

---

## Schnellreferenz

| Aktion | Ort |
|--------|-----|
| Filament hinzufügen | Startseite > + Filament hinzufügen |
| Vorbefüllen via NFC / TDS / INI / Clone | Filament hinzufügen > Vorbefüllen-Werkzeugleiste |
| Aus TDS importieren | Filament hinzufügen > Aus TDS importieren |
| AI-Provider konfigurieren | Einstellungen > AI-Funktionen |
| Aus PrusaSlicer importieren | Startseite > Importieren/Exportieren > INI importieren |
| Aus CSV/XLSX importieren | Startseite > Importieren/Exportieren > Datei importieren (INI / CSV / XLSX) — nach Erweiterung weitergeleitet |
| Prusament-Spule importieren | Startseite > Importieren/Exportieren > Prusament QR |
| Aus Atlas importieren | Startseite > Importieren/Exportieren > Aus Atlas importieren |
| OpenPrintTag-DB durchsuchen | Startseite > Importieren/Exportieren > OpenPrintTag-DB durchsuchen |
| Aus Snapshot wiederherstellen | Einstellungen > Sicherung & Wiederherstellen > Aus Snapshot wiederherstellen |
| Nach PrusaSlicer exportieren | Startseite > Importieren/Exportieren > INI exportieren |
| Nach CSV/XLSX exportieren | Startseite > Importieren/Exportieren > CSV exportieren / XLSX exportieren |
| Datenbank sichern | Einstellungen > Sicherung & Wiederherstellen > Snapshot herunterladen |
| Filament-Details ansehen | Startseite > Filament-Namen klicken |
| Filament bearbeiten | Detailseite > Bearbeiten |
| Farbvariante hinzufügen | Detailseite > + Variante erstellen (oder Klonen) |
| Düsen verwalten | Einstellungen > Düsen |
| Drucker verwalten | Einstellungen > Drucker |
| API-Dokumentation öffnen | Einstellungen > API-Dokumentation (oder zu `/api-docs` navigieren) |
| NFC-Tag schreiben | Detailseite > NFC schreiben (Desktop-App) |
| NFC-Tag löschen | Einstellungen > NFC-Tools > Tag löschen (Desktop-App) |
| NFC-Binärdatei exportieren | Detailseite > OPT exportieren |
| Spulen verfolgen | Detailseite > Spulen-Tracker > + Spule hinzufügen |
| Spule einer Location zuweisen | Spulen-Detail > Location-Dropdown |
| Spule einem Drucker-Slot zuweisen | Spulen-Detail > Drucker-Slot-Auswahl |
| Manuellen Spulen-Verbrauch loggen | Spulen-Detail > Verbrauch loggen |
| Trockenzyklus protokollieren | Spulen-Detail > + Trockenzyklus protokollieren |
| Verbrauchsanalysen ansehen | Obere Nav > Analytics |
| Low-Stock-Schwelle setzen | Filament-Bearbeitung > Bestandseinstellungen |
| Filamente vergleichen | Liste > Zeilen auswählen > Vergleichen |
| Shared Catalog veröffentlichen | Obere Nav > Teilen > + Neu |
| Spulen aus CSV importieren | Startseite > Importieren > Spulen aus CSV |
| Theme wechseln | Einstellungen > Theme |
| Manueller Sync | Status-Pille klicken > Jetzt synchronisieren (Desktop Hybrid-Modus) |
| Verbindungsstatus prüfen | Status-Pille neben „Filament DB"-Titel |

---

## Fehlerbehebung

Siehe [Fehlerbehebungs-Anleitung](troubleshooting.md) für häufige Probleme und Lösungen.
