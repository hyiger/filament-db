> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../nfc.md) maßgeblich.

# NFC-Tag lesen/schreiben

[< Zurück zur README](../README.md)

Filament DB unterstützt das Lesen und Schreiben von [OpenPrintTag](https://openprinttag.io/)-NFC-V-Tags (ISO 15693) und das Lesen von Bambu-Lab-MIFARE-Classic-Spulen-Tags direkt aus der Desktop-App.

## Voraussetzungen

- **Lesegerät**: ACS ACR1552U USB-NFC-Reader/Writer (oder kompatibles PC/SC-Lesegerät mit ISO-15693- und ISO-14443-Unterstützung)
- **OpenPrintTag-Tags**: NXP ICODE SLIX2 (oder kompatible NFC-V- / ISO-15693-Tags mit mindestens 320 Byte Nutzerspeicher) — Lesen/Schreiben
- **Bambu-Lab-Spulen**: MIFARE-Classic-1K-Tags auf Bambu-Lab-Filamentspulen — nur lesen (automatisch erkannt)
- **Desktop-App**: NFC-Funktionen sind ausschließlich in der Electron-Desktop-App verfügbar, nicht in der Web-Version

### Treiber-Setup

**macOS**: Installiere `ifd-acsccid.bundle` aus dem [ACS-Treiberpaket](https://www.acs.com.hk/en/drivers/). Ein Neustart kann nötig sein.

**Linux / Raspberry Pi**: Installiere den PC/SC-Daemon und die Entwicklungs-Header. Der im Kernel enthaltene Standardtreiber `ccid` deckt den ACR1552U ab — ein zusätzlicher ACS-Treiber ist nicht nötig.

```bash
sudo apt install pcscd libpcsclite-dev
```

Prüfe, ob der Reader erkannt wird:

```bash
pcsc_scan
```

**Windows**: Kein zusätzlicher Treiber nötig — der eingebaute Microsoft-CCID-Treiber funktioniert sofort.

## Wie es funktioniert

### Auto-Lesen

Wenn ein Tag auf den Reader gelegt wird, erkennt die App automatisch den Tag-Typ und liest ihn:

**OpenPrintTag (NFC-V / ISO 15693)**:
1. Liest alle Speicherblöcke per ISO-15693-Pass-Through-Befehlen
2. Parst die NDEF-Nachricht (Typ: `application/vnd.openprinttag`)
3. Dekodiert die CBOR-Nutzlast in Filamentdaten

**Bambu Lab (MIFARE Classic / ISO 14443-3A)**:
1. Erkennt den Tag als MIFARE Classic über den Get-UID-Befehl
2. Leitet pro Sektor Verschlüsselungsschlüssel aus der Tag-UID mit HKDF-SHA256 ab
3. Authentifiziert und liest Sektoren 0–9 (Filamentdaten)
4. Parst das proprietäre Binärformat (Materialtyp, Farbe, Temperaturen, Gewicht, Produktionsdatum)

In beiden Fällen sucht die App anschließend in der Datenbank nach einem passenden Filament. Ein Dialog zeigt:

- **Treffer gefunden**: das gematchte Filament mit einem „Filament öffnen"-Button zur Navigation
- **Kein Treffer**: die dekodierten Tag-Daten mit einem „Neues Filament erstellen"-Button, der das Formular mit allen Feldern aus dem Tag vorbefüllt (Name, Hersteller, Typ, Farbe, Temperaturen, Dichte usw.)
- **Ähnliche Filamente**: gibt es keinen exakten Treffer, aber Hersteller oder Typ stimmen, werden ähnliche Filamente als anklickbare Vorschläge angezeigt

Bei Bambu-Tags zeigt ein „Bambu-Lab-Spule (read-only)"-Badge an, dass diese Tags nicht beschrieben werden können (sie sind RSA-2048-signiert).

### Live-Scan-Stream (Slicer-Integration)

Jeder erfolgreiche Auto-Read wird zusätzlich auf einen Server-Sent-Events-Stream unter `GET /api/scan/stream` gelegt, sodass ein abonnierter Slicer sein aktives Filament-Preset bei jedem Scan umschalten kann. Der Slicer muss nicht auf derselben Maschine laufen wie Filament DB — alles, was den Server per HTTP erreicht, funktioniert (LAN, Tailscale, Reverse-Tunnel). So kann ein headless Filament DB auf einem Raspberry Pi PrusaSlicer auf einem Mac im Nebenraum steuern. Der Renderer publiziert via `POST /api/scan/publish` nach dem Match-Schritt; Konsumenten erhalten ein `scan`-Event pro Lesevorgang und beim Connect zusätzlich ein `replay`-Event mit dem letzten Scan, damit ein Slicer, der direkt nach einem Tag-Read geöffnet wurde, ihn trotzdem mitbekommt.

Event-Payload-Form (gleich für `scan` und `replay`):

```json
{
  "timestamp": 1700000000000,
  "filament": { "_id": "…", "name": "Prusament PLA Galaxy Black", "vendor": "Prusament", "type": "PLA", "color": "#000000" },
  "candidates": [],
  "decoded": { "materialName": "…", "brandName": "…", "materialType": "PLA", "tagSource": "openprinttag" }
}
```

Konsumenten sollten das Preset anhand `filament.name` umschalten, sofern dieses nicht null ist, und das Event sonst ignorieren. `?replay=0` unterdrückt das Replay beim Connect. Den vollen Endpunkt-Vertrag siehe [API-Referenz — Scan Stream](api.md#scan-stream).

Der Bus läuft im Prozess: Ein `EventEmitter`, geteilt von allen Subskribenten derselben Filament-DB-Instanz. Das ist das einzige „Single" — Subskribenten können auf verschiedenen Maschinen sein, solange sie alle dieselbe Instanz verbinden. Die wirkliche Bindung an eine Maschine liegt auf der *Publisher*-Seite: Scans werden vom `NfcProvider` im Electron-Renderer ausgelöst, der NFC-Reader muss also an die Maschine angeschlossen sein, die die Electron-App ausführt. Ein headless Docker- / Web-only-Deploy hat keinen `NfcProvider` und veröffentlicht nichts — der Stream bleibt einfach leer. Ein horizontal skaliertes Filament-DB-Deployment mit mehreren Prozessen würde einen externen Broker (Redis pub/sub o. Ä.) hinter dem Bus benötigen.

Wenn du tatsächlich cross-machine arbeitest: Die API ist absichtlich nicht authentifiziert (siehe README-Warnung) — sei also bewusst, in welchem Netzwerk du Port 3456 freigibst. Das in Electron gebündelte Next.js bindet basierend auf der `HOSTNAME`-Umgebungsvariablen; wenn entfernte Subskribenten sich nicht verbinden können, probiere `HOSTNAME=0.0.0.0`.

### Tags beschreiben

Von der Detailseite eines beliebigen Filaments:

1. Lege einen Tag auf den Reader (die NFC-Statusanzeige wird grün)
2. Klicke auf **„NFC schreiben"** (lila Button)
3. Die App codiert die Filamentdaten als OpenPrintTag-CBOR, verpackt sie in eine NDEF-Nachricht und schreibt sie blockweise
4. Der Button zeigt Fortschritt und Erfolg/Fehler an

### Tags löschen / formatieren

Über die Seite **Einstellungen** (nur Electron):

1. Lege einen Tag auf den Reader (die NFC-Statusanzeige wird grün)
2. Klicke auf **„Tag löschen"** (roter Button)
3. Bestätige die Aktion in der inline angezeigten Bestätigung
4. Die App schreibt einen leeren NFC-Forum-Type-5-Header (CC-Bytes) in Block 0, einen Terminator in Block 1 und nullt alle übrigen Nutzerblöcke
5. Nach Abschluss erscheint eine Erfolgs- oder Fehlermeldung

Wenn du den Tag entfernst, bevor du bestätigst, schließt sich die Bestätigung automatisch.

### OpenPrintTag-Binärexport

Klicke auf der Detailseite eines Filaments auf **„OPT exportieren"**, um die OpenPrintTag-Binärdaten als `.bin`-Datei herunterzuladen. Diese Datei kann mit externer NFC-Schreibsoftware auf einen Tag geschrieben werden.

## NFC-Statusanzeige

Die Status-Pille erscheint im Header, wenn die Desktop-App läuft:

| Farbe | Label | Zustand |
|-------|-------|---------|
| Grau | „No NFC reader" | Kein Reader erkannt |
| Gelb | „Ready — place tag" | Reader verbunden, wartet auf Tag |
| Grün | „Loaded: \<Filamentname\>" | Tag erkannt und dekodiert; Name gegen die DB gematcht (oder der vom Tag deklarierte Materialname, wenn es keinen DB-Treffer gibt) |
| Grün | „Tag detected (\<uid\>)" | Tag erkannt, aber noch nicht dekodiert — kurzer Übergangszustand |
| Grün | „Tag detected" | Tag erkannt, der Reader hat noch keine UID gemeldet |

Das „Loaded"-Label bleibt sichtbar, nachdem der Tag-Lese-Dialog geschlossen wurde (damit du weiterhin siehst, welche Spule auf dem Reader liegt), und aktualisiert sich nach erfolgreichem **NFC schreiben** sofort — kein Anheben und Neuauflegen nötig. Sobald der Reader meldet, dass der Tag entfernt wurde, wird das Label zurückgesetzt — beim Wechsel von Tag A zu Tag B siehst du also kurz den Zwischenstand „Tag detected (\<uid\>)" statt des alten Tag-Namens.

## Technische Details

### Kommunikationsprotokoll

Die App kommuniziert mit dem ACR1552U via PC/SC und `@pokusew/pcsclite`:

- **Verbindung**: Versucht zunächst `SCARD_SHARE_SHARED` (Windows/Linux), fällt auf `SCARD_SHARE_DIRECT` zurück (macOS-Workaround für ISO 15693)
- **Tag-Erkennung**: Versucht zuerst MIFARE-Classic-Read (Bambu); bei Misserfolg fällt sie auf ISO 15693 (OpenPrintTag) zurück
- **OpenPrintTag-Befehle**: ACR1552U-Pass-Through (`FF FB`), das ISO-15693-Read/Write-Single-Block-Befehle umschließt
- **Bambu-Befehle**: Standard-PC/SC-Pseudo-APDUs für MIFARE Classic — Get UID (`FF CA`), Load Key (`FF 82`), Authenticate (`FF 86`), Read Binary (`FF B0`)
- **Fallback**: PCSC 2.0 Part 3 Transparent Exchange (`FF C2 00 01`) via `SCardControl` für DIRECT-Modus

### Datenformat

**OpenPrintTag (NFC-V)**:
- **Tag-Speicher-Layout**: CC (4B) + NDEF TLV + NDEF Record (TNF=0x02, Type=`application/vnd.openprinttag`) + Terminator (0xFE)
- **Nutzlast**: CBOR-codierte OpenPrintTag-Daten (Meta-Map + Main-Map mit Materialinfos, Temperaturen, Farbe, Dichte, Instance-ID, Trockentemperatur/-zeit, Transmission Distance, Tags usw.)
- **Schreib-Optimierung**: Es werden nur Blöcke mit tatsächlichen Daten geschrieben (kein Null-Padding am Ende), so wird der potenziell schreibgeschützte letzte Block auf SLIX2-Tags vermieden

**Bambu Lab (MIFARE Classic)**:
- **Tag**: MIFARE Classic 1K — 16 Sektoren × 4 Blöcke × 16 Bytes, verschlüsselt mit Pro-Sektor-Schlüsseln
- **Schlüsselableitung**: HKDF-SHA256 mit Master-Key `9a759cf2c4f7caff222cb9769b41bc96`, UID als IKM, Info `"RFID-A\0"` → 16 Sektorschlüssel × 6 Bytes
- **Daten-Layout**: Sektoren 0–4 enthalten Filamentdaten (Materialtyp, Farbe RGBA, Temperaturen, Gewicht, Durchmesser, Produktionsdatum, Tray-UID); Sektoren 5–9 sind leer; Sektoren 10–15 enthalten eine RSA-2048-Signatur
- **Codierung**: Alle Zahlen sind little-endian (uint16 LE, float32 LE); Zeichenketten sind null-padded ASCII
- **Read-only**: Tags sind RSA-2048-signiert — das Ändern eines Bytes invalidiert die Signatur

### Architektur

```
┌─ Electron-Hauptprozess ─────────────────┐
│  NfcService (electron/nfc-service.ts)   │
│  ├── PC/SC-Reader-Erkennung             │
│  ├── Tag-Präsenz-Überwachung            │
│  ├── Auto-Read beim Auflegen            │
│  ├── Tag-Typ-Auto-Erkennung             │
│  ├── OpenPrintTag: ISO 15693 read/write │
│  ├── Bambu: MIFARE Classic read (HKDF)  │
│  └── NDEF wrap/parse, CBOR encode/decode│
│                                          │
│  IPC-Handler: nfc-get-status,           │
│    nfc-read-tag, nfc-write-tag           │
│  Events: nfc-status-changed,             │
│    nfc-tag-detected                      │
└──────────────────────────────────────────┘
         │ IPC
┌─ Renderer ───────────────────────────────┐
│  NfcProvider (globaler Context)         │
│  ├── Statusverfolgung                   │
│  ├── Auto-Read-Event-Handling           │
│  ├── Filament-Matching via API          │
│  ├── NfcReadDialog (Match-/Create-Flow) │
│  └── POST /api/scan/publish (Fan-out)   │
│                                          │
│  Filament-Detailseite                   │
│  └── „NFC schreiben"-Button             │
└──────────────────────────────────────────┘
         │ HTTP
┌─ Scan-Stream (Next.js-Server) ──────────┐
│  scanBus (Node-EventEmitter global)      │
│  ├── POST /api/scan/publish              │
│  └── GET  /api/scan/stream (SSE)         │
│         └── PrusaSlicer / OrcaSlicer    │
│             FilamentDB-Modul abonniert  │
│             und wechselt aktives Preset │
└──────────────────────────────────────────┘
```

### Geschriebene OpenPrintTag-Felder

Folgende Felder werden in jeden NFC-Tag codiert:

| Feld | CBOR-Key | Beschreibung |
|-------|----------|-------------|
| Materialname | 8 | Filament-Name |
| Markenname | 9 | Herstellername |
| Materialtyp | 10 | PLA, PETG, ABS etc. (numerisches Enum) |
| Primärfarbe | 11 | RGB-Farbbytes |
| Dichte | 17 | g/cm³ (float16) |
| Filamentdurchmesser | 22 | mm (float16) |
| Temperaturen | 12–16, 18 | Düse (min/max), Bett (min/max), Kammer, Preheat |
| Gewichte | 19–21 | Nettogewicht, Istgewicht, Leergewicht der Spule |
| Instance-ID | 5 | Markenspezifische Instanz-ID (5 Byte Hex-String, max. 16 Zeichen) |
| Trockentemperatur | 57 | °C |
| Trockenzeit | 58 | Minuten |
| Transmission Distance | 27 | HueForge-TD-Wert |
| Shore-Härte A | 31 | Flexible Materialien (TPU/TPE/PEBA) |
| Shore-Härte D | 32 | Starre Materialien |
| Tags | 28 | Flag-Array (42 unterstützte Tags: abrasiv, löslich, matt, silk, Carbon-Faser, High Speed, recycelt usw.) |
| Verbrauchtes Gewicht | aux 0 | Im Aux-Bereich getrackt (falls gesetzt) |

Instance-IDs werden für jedes Filament automatisch erzeugt (im 5-Byte-Hex-Format von Prusament, z. B. `2acc21072a`) und gemäß OpenPrintTag-Spezifikation als `brand_specific_instance_id`-Feld geschrieben.

### Gelesene Bambu-Lab-Felder

Folgende Felder werden aus Bambu-Lab-Spulen-Tags extrahiert:

| Feld | Block | Beschreibung |
|-------|-------|-------------|
| Material-Variant-ID | 1 (Bytes 0–7) | Bambu-Materialcode (z. B. „A50-K0") |
| Material-ID | 1 (Bytes 8–15) | Bambu-Material-ID (z. B. „GFA50") |
| Filamenttyp | 2 | Materialtyp-String (z. B. „PLA Basic") |
| Detail-Typ | 4 | Detailvariante (z. B. „PLA Matte") |
| Farbe | 5 (Bytes 0–3) | RGBA-Farbbytes |
| Spulengewicht | 5 (Bytes 4–5) | Nettogewicht in Gramm (uint16 LE) |
| Durchmesser | 5 (Bytes 8–11) | Filamentdurchmesser in mm (float32 LE) |
| Trockentemperatur | 6 (Bytes 0–1) | Trockentemperatur in °C |
| Trockenzeit | 6 (Bytes 2–3) | Trockenzeit in Stunden |
| Betttemperatur | 6 (Bytes 6–7) | Betttemperatur in °C |
| Max. Hotend-Temp | 6 (Bytes 8–9) | Maximale Düsentemperatur |
| Min. Hotend-Temp | 6 (Bytes 10–11) | Minimale Düsentemperatur |
| Tray-UID | 9 | Spulen-Instanz-ID |
| Produktionsdatum | 12 | ASCII „YYYY_MM_DD_HH_MM" |
| Filamentlänge | 14 (Bytes 4–5) | Länge in Metern |

Sie werden auf dasselbe Datenmodell wie OpenPrintTag-Felder gemappt, sodass die Match-, Create- und Import-Workflows identisch funktionieren.

## Fehlerbehebung

### „No NFC reader" (graue Anzeige)

- Prüfe, ob der Reader per USB angeschlossen ist
- Auf macOS sicherstellen, dass `ifd-acsccid.bundle` installiert ist (ggf. Neustart erforderlich)
- Prüfe die `pcsc_scan`-Ausgabe, um zu verifizieren, dass PC/SC den Reader erkennt

### Lese-/Schreibvorgang schlägt sporadisch fehl

- Stelle sicher, dass der Tag mittig auf dem Reader liegt und nicht bewegt wird
- SLIX2-Tags haben eine kleine Antenne — die Position ist entscheidend
- Auf macOS kann `SCARD_SHARE_SHARED` für ISO 15693 sporadisch sein; die App fällt automatisch auf DIRECT zurück

### Schreiben schlägt am letzten Block fehl (SW 640F)

- Block 79 auf SLIX2-Tags ist schreibgeschützt (Konfigurations-/Passwort-Bereich)
- Die App überspringt automatisch null-gefüllte Blöcke am Speicher-Ende
- Ist deine Nutzlast ungewöhnlich groß, kann sie in den geschützten Bereich reichen
