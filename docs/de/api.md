> 🇩🇪 Deutsche Übersetzung. Bei Diskrepanzen ist [die englische Originalfassung](../api.md) maßgeblich.

# API-Referenz

[< Zurück zur README](../../README.md)

> **Interaktive Dokumentation**: Durchsuche und teste die dokumentierte OpenAPI-Oberfläche in der [Swagger UI](/api-docs) — einem interaktiven OpenAPI-3.0-Explorer, der in die App integriert ist. Diese Markdown-Referenz dokumentiert außerdem neuere Routen, die ausführlicheren Fließtext bieten als die generierte Swagger-Ansicht.

## Filaments

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/filaments` | Listet alle Filamente auf. Query-Parameter: `search`, `type`, `vendor` |
| `POST` | `/api/filaments` | Legt ein neues Filament an |
| `GET` | `/api/filaments/:id` | Ruft ein einzelnes Filament per ID ab (populiert Düsen, Kalibrierungen, Varianten) |
| `PUT` | `/api/filaments/:id` | Aktualisiert ein Filament per ID |
| `DELETE` | `/api/filaments/:id` | Soft-Delete eines Filaments (blockiert, wenn es Varianten hat). Hänge `?permanent=true` an, um es endgültig aus dem Papierkorb zu entfernen. |
| `GET` | `/api/filaments/trash` | Listet soft-gelöschte Filamente auf (versorgt die `/trash`-Oberfläche) |
| `POST` | `/api/filaments/:id/restore` | Stellt ein soft-gelöschtes Filament aus dem Papierkorb wieder her (liefert 409 bei Namenskonflikt) |
| `GET` | `/api/filaments/export` | Lädt alle Filamente als PrusaSlicer-INI-Datei herunter |
| `GET` | `/api/filaments/export-csv` | Lädt alle Filamente als CSV-Datei herunter |
| `GET` | `/api/filaments/export-xlsx` | Lädt alle Filamente als XLSX-Tabelle herunter |
| `POST` | `/api/filaments/import` | Lädt eine INI-Datei hoch, um Filamentprofile zu importieren |
| `POST` | `/api/filaments/import-csv` | Lädt eine CSV-Datei hoch, um Filamente zu importieren |
| `POST` | `/api/filaments/import-xlsx` | Lädt eine XLSX-Datei hoch, um Filamente zu importieren |
| `GET` | `/api/filaments/match` | Gleicht ein NFC-Tag oder einen gescannten Etiketten-QR mit vorhandenen Filamenten ab. Query-Parameter: `instanceId` (höchste Priorität), `name`, `vendor`, `type` |
| `GET` | `/api/filaments/types` | Listet alle eindeutigen Filamenttypen auf |
| `GET` | `/api/filaments/vendors` | Listet alle eindeutigen Herstellernamen auf |
| `GET` | `/api/filaments/parents` | Listet Filamente auf, die als Elternfilament dienen können. Query-Parameter: `search`, `exclude` |
| `POST` | `/api/filaments/parse-ini` | Parst eine INI-Datei und liefert die Filamentprofile zurück, ohne sie zu speichern |
| `POST` | `/api/filaments/import-atlas` | Verbindet sich mit einer entfernten MongoDB-Atlas-Datenbank und importiert Filamente |
| `GET` | `/api/filaments/:id/openprinttag` | Lädt das OpenPrintTag-Binary für ein Filament herunter |
| `GET` | `/api/filaments/:id/calibration` | Liefert Kalibrierungsdaten für ein Filament und einen Düsendurchmesser |
| `GET` | `/api/filaments/:id/spool-check` | Prüft, ob eine Spule genug Filament für einen Druckauftrag hat |
| `POST` | `/api/filaments/:id` | Synchronisiert ein Filament-Preset zurück aus PrusaSlicer |

### Spulen

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `POST` | `/api/filaments/:id/spools` | Fügt einem Filament eine Spule hinzu |
| `PUT` | `/api/filaments/:id/spools/:spoolId` | Aktualisiert Gewicht oder Bezeichnung einer Spule |
| `DELETE` | `/api/filaments/:id/spools/:spoolId` | Entfernt eine Spule aus einem Filament |

### GET /api/filaments

Liefert ein Array projizierter Filament-Zusammenfassungen (nicht die vollständigen Dokumente — schwere Spulen-Unterfelder wie `photoDataUrl`, `usageHistory` und `dryCycles` werden entfernt, um die Antwort kleinzuhalten). Unterstützt optionale Query-Parameter:

- `search` -- Filter nach Name (case-insensitive Regex)
- `type` -- exakte Übereinstimmung beim Filamenttyp (z. B. `PLA`, `PETG`)
- `vendor` -- exakte Übereinstimmung beim Herstellernamen

**Antwortformat pro Zeile** (entspricht `FilamentSummary` in `src/types/filament.ts` plus einigen Extras, die Liste / Formular / Picker benötigen):

```json
{
  "_id": "…",
  "name": "Prusament PLA Galaxy Black",
  "vendor": "Prusament",
  "type": "PLA",
  "color": "#1a1a2e",
  "secondaryColors": [],
  "cost": 35,
  "density": 1.24,
  "parentId": null,
  "spoolWeight": 200,
  "netFilamentWeight": 1000,
  "totalWeight": null,
  "lowStockThreshold": 250,
  "tdsUrl": "https://example.com/tds.pdf",
  "temperatures": { "nozzle": 215, "bed": 60 },
  "hasCalibrations": true,
  "spools": [
    { "_id": "…", "label": "AMS slot 1", "totalWeight": 800, "retired": false }
  ]
}
```

- `hasCalibrations` ist `true`, wenn das Filament mindestens eine Kalibrierung besitzt, **oder** wenn es eine Variante ist, deren Elternfilament mindestens eine hat (per Aggregation `$lookup`). Der Schnellfilter „Fehlende Kalibrierung" auf der Listenseite liest dieses Feld — Varianten, die vom Elternfilament erben, werden korrekt als kalibriert gezählt.
- `tdsUrl` ist enthalten, damit die vendor-gestützten TDS-Vorschläge im `FilamentForm` weiterhin funktionieren.
- `spools[].label` ist enthalten, damit der AMS-Slot-Picker im `PrinterForm` `s.label || s._id.slice(-4)` rendern kann.
- `color` ist **nullable** — coextrudierte mehrfarbige Filamente lassen es null und tragen ihre Farben in `secondaryColors`. `secondaryColors` ist ein geordnetes Array von bis zu 5 `#RRGGBB`-Hex-Codes, das die `secondary_color_0..4`-Schlüssel der OpenPrintTag-Spezifikation (Spec-Schlüssel 20–24) spiegelt. Varianten erben `secondaryColors` nach dem Array-Fallback-Schema: Eine Variante deklariert entweder ihr eigenes nicht-leeres Array oder erbt das vollständige Array des Eltern-Filaments (dasselbe Muster wie `optTags` / `bedTypeTemps`). Slicer-Exporte (PrusaSlicer / OrcaSlicer / Bambu Studio) verwerfen Sekundärfarben stillschweigend — Slicer-Voreinstellungen sind einfarbige Formate.

Für das vollständige Dokument (Kalibrierungs-Array, Presets, Settings, vollständige Spulen-Subdokumente) rufe `GET /api/filaments/:id` auf.

### POST /api/filaments

Legt ein neues Filament an. Sende einen JSON-Body mit mindestens `name`, `vendor` und `type`. Validiert `parentId`, falls angegeben (muss existieren und darf selbst keine Variante sein).

Wenn `totalWeight` angegeben wird, aber kein `spools`-Array, wird automatisch ein initialer Spuleneintrag aus dem Gewichtswert erstellt.

### GET /api/filaments/:id

Liefert ein einzelnes Filament mit `compatibleNozzles`, `calibrations.nozzle` und `calibrations.printer` als vollständige Dokumente populiert. Enthält außerdem:

- `_variants` -- Array untergeordneter Varianten-Filamente (`_id`, `name`, `color`, `cost`)
- Auflösung geerbter Felder, wenn das Filament eine `parentId` hat -- Felder, die in der Variante nicht gesetzt sind, werden vom Elternfilament geerbt, und ein `_inherited`-Array listet auf, welche Felder geerbt wurden

### PUT /api/filaments/:id

Aktualisiert ein Filament. Sende einen JSON-Body mit den zu aktualisierenden Feldern. Unterstützt Teilaktualisierungen. Validiert Änderungen an `parentId` (verhindert zirkuläre Referenzen, verschachtelte Vererbung und Selbstreferenzen).

### DELETE /api/filaments/:id

Soft-Delete eines Filaments per ID (setzt den Zeitstempel `_deletedAt`). Das Filament wird in allen Abfragen ausgeblendet, bleibt aber für die Sync-Propagation im Hybridmodus und für die Wiederherstellung über den Papierkorb-Workflow erhalten. Liefert `{ message: "Deleted" }`.

**Ein Filament mit Farbvarianten kann nicht gelöscht werden.** Liefert 400: `"Cannot delete a filament that has color variants. Delete the variants first."`.

#### Endgültiges Löschen: `DELETE /api/filaments/:id?permanent=true`

Hänge `?permanent=true` an, um ein Filament als endgültig entfernt zu markieren. **Nur erlaubt, wenn das Filament bereits soft-gelöscht ist** (also im Papierkorb liegt). Liefert `{ message: "Permanently deleted" }`.

Dies setzt `_purged: true` auf dem Dokument, statt die Zeile physisch zu entfernen. Die Hybrid-Sync-Engine (`electron/sync-service.ts`) paart Dokumente zwischen Peers per `syncId` und behandelt „auf einer Seite fehlend, auf der anderen vorhanden" als frische Neueinfügung von der anderen Seite — ein `deleteOne` würde deshalb beim nächsten Sync vom Papierkorb-Peer wieder auferstehen. Der `_purged`-Tombstone propagiert über Peers hinweg, blendet die Zeile auf jeder UI-Oberfläche aus (auch der Papierkorb-Liste und der Restore-Route) und bleibt bestehen, damit die Zeile nie wieder auftaucht. Tombstones sind klein und werden derzeit nicht per Garbage Collection entfernt.

Ablehnungsgründe:
- `400` — Filament ist nicht im Papierkorb. Vorher soft-löschen.
- `400` — das Filament ist selbst ein Elternfilament und nicht gepurgte, im Papierkorb liegende Varianten referenzieren es noch. Lösche diese Varianten zuerst endgültig, um Dangling-Referenzen zu vermeiden.
- `400` — Filament ist bereits gepurgt (idempotent).

### GET /api/filaments/trash

Liefert soft-gelöschte Filamente, sortiert nach Neuesten zuerst, mit einer leichten Projektion: `_id`, `name`, `vendor`, `type`, `color`, `cost`, `parentId`, `_deletedAt`. Versorgt die `/trash`-UI. **Schließt** `_purged: true`-Tombstones **aus** — die werden nur für die Sync-Propagation auf Platte gehalten und tauchen auf keiner Benutzeroberfläche wieder auf.

```json
[
  {
    "_id": "67abc...",
    "name": "PLA Galaxy Black",
    "vendor": "Prusa",
    "type": "PLA",
    "color": "#1a1a1a",
    "cost": 31.99,
    "parentId": null,
    "_deletedAt": "2026-05-09T18:24:11.123Z"
  }
]
```

### POST /api/filaments/:id/restore

Hebt das Soft-Delete eines Filaments auf — entfernt `_deletedAt`, sodass das Filament in der regulären Liste wieder erscheint. Liefert `{ message: "Restored", _id: "67abc..." }`.

Ablehnung:
- `404` — das Filament ist nicht im Papierkorb (bereits aktiv oder nicht gefunden).
- `409` — ein anderes aktives Filament verwendet den Namen des gelöschten weiter. Der partielle Unique-Index auf `name` deckt nur nicht-gelöschte Dokumente ab, sodass die Wiederherstellung sonst mit einem Mongo-Duplikatschlüssel-Fehler abstürzen würde. Benenne zuerst eines davon um.

```json
{
  "error": "Cannot restore: another active filament named \"PLA Galaxy Black\" already exists. Rename one of them first."
}
```

### GET /api/filaments/export

Lädt alle Filamente als PrusaSlicer-kompatible INI-Datei mit einem `[filament:Name]`-Abschnitt pro Filament herunter. Verwendet denselben Generator wie `GET /api/filaments/prusaslicer` — strukturierte DB-Felder werden auf PrusaSlicer-INI-Schlüssel gemappt und mit dem Settings-Passthrough-Bag zusammengeführt.

### POST /api/filaments/import

Lade eine PrusaSlicer-Config-Bundle-INI-Datei per `multipart/form-data` mit einem `file`-Feld hoch. Parst alle `[filament:...]`-Abschnitte und upsertet sie in die Datenbank.

Liefert:
```json
{
  "message": "Imported 27 filaments (25 new, 2 updated)",
  "total": 27,
  "created": 25,
  "updated": 2
}
```

### GET /api/filaments/match

Gleicht die dekodierten Daten eines NFC-Tags oder einen gescannten Brother-Etikettendrucker-QR-Code mit vorhandenen Filamenten ab. Intern vom NFC-Lese-Workflow genutzt und überall dort, wo ein Instanz-ID-QR zurück in die App gescannt wird.

- `instanceId` -- exakte Instanz-ID-Übereinstimmung (höchste Konfidenz; zuerst geprüft). Derselbe Wert, der auf NFC-Tags getragen und vom Instanz-ID-QR-Modus des Etikettendruckers gedruckt wird. Exakte Groß-/Kleinschreibung bevorzugt; fällt auf case-insensitive zurück, wenn keine exakte Übereinstimmung gefunden wird. Eine Kollision nur durch Groß-/Kleinschreibung (Legacy-Daten mit gespeichertem `ABC` und `abc`) liefert beide als `candidates` statt willkürlicher Auswahl. Max. Länge 128; der Wert wird vor dem case-insensitive Regex escaped, sodass Regex-Sonderzeichen in gespeicherten IDs wörtlich übereinstimmen.
- `name` -- Materialname (exakte Übereinstimmung, case-insensitive)
- `vendor` -- Markenname (Teilstring-Übereinstimmung, case-insensitive)
- `type` -- Materialtyp (exakte Übereinstimmung, case-insensitive)

Die vier Parameter werden in Prioritätsreihenfolge geprüft: `instanceId` → `name` → `vendor`+`type` → nur `vendor`. Wenn `instanceId` nicht trifft, fällt die Route auf den nächsten Zweig zurück, wenn die entsprechenden Parameter ebenfalls angegeben sind — so kann ein Etiketten-Scan gegen ein inzwischen gelöschtes Filament noch Vorschläge liefern statt 404 zu liefern.

Liefert:
```json
{
  "match": { "_id": "...", "name": "...", "vendor": "...", "type": "...", "color": "..." },
  "candidates": []
}
```

Match-Priorität: exakter Namens-Match > Vendor+Type > nur Vendor. Wird ein einzelner Vendor+Type-Match gefunden, wird er als Match zurückgegeben. Andernfalls werden bis zu 5 Kandidaten geliefert.

### GET /api/filaments/types

Liefert ein Array eindeutiger Filamenttyp-Strings (z. B. `["ABS", "ASA", "PCTG", "PETG", "PLA"]`).

### GET /api/filaments/vendors

Liefert ein sortiertes Array eindeutiger Herstellernamen-Strings (z. B. `["Bambu Lab", "Polymaker", "Prusament"]`). Wird vom Hersteller-Dropdown im Filament-Formular genutzt.

### GET /api/filaments/parents

Liefert Filamente, die als Eltern für Farbvarianten dienen können, sortiert nach Hersteller und dann nach Name. Unterstützt optionale Query-Parameter:

- `search` -- Filter nach Name (case-insensitive Regex)
- `exclude` -- Filament-ID, die aus den Ergebnissen ausgeschlossen werden soll (z. B. das aktuell bearbeitete Filament)

Liefert ein Array aus `{ _id, name, vendor, type, color }`-Objekten.

### POST /api/filaments/parse-ini

Parst ein PrusaSlicer-INI-Config-Bundle und liefert die extrahierten Filamentprofile zurück, ohne sie in die Datenbank zu speichern. Upload per `multipart/form-data` mit einem `file`-Feld. Liefert `{ filaments: [...] }` mit derselben Form wie das Filament-Modell.

### POST /api/filaments/import-atlas

Verbindet sich mit einer entfernten MongoDB-Atlas-Datenbank und importiert Filamente. Dieser Endpunkt erfüllt je nach Request-Body zwei Zwecke:

**Filamente auflisten** — sende `{ uri }`, um dich zu verbinden und alle Filamente aus der entfernten Datenbank abzurufen:
```json
{ "uri": "mongodb+srv://user:pass@cluster.mongodb.net/" }
```
Liefert `{ filaments: [...] }` mit projizierten Feldern: `_id`, `name`, `vendor`, `type`, `color`, `temperatures.nozzle`, `temperatures.bed`.

**Filamente importieren** — sende `{ uri, filamentIds: [...] }`, um ausgewählte Filamente in die lokale Datenbank zu importieren:
```json
{ "uri": "mongodb+srv://user:pass@cluster.mongodb.net/", "filamentIds": ["id1", "id2"] }
```
Liefert:
```json
{
  "message": "Imported 5 filaments (3 new, 2 updated)",
  "total": 5,
  "created": 3,
  "updated": 2
}
```

Bestehende Filamente mit demselben Namen werden aktualisiert; neue Filamente werden angelegt. Eltern-Varianten-Beziehungen aus der entfernten Datenbank werden nicht erhalten.

### GET /api/filaments/:id/calibration

Liefert Kalibrierungsdaten für ein bestimmtes Filament und einen Düsendurchmesser. Der `{id}`-Parameter kann ein URL-kodierter Preset-Name (z. B. `The%20K8%20PC`) oder eine MongoDB-ObjectId sein. Varianten-Filamente erben Kalibrierungen von ihrem Elternfilament.

Query-Parameter:
- `nozzle_diameter` (erforderlich) -- Düsendurchmesser in mm (z. B. `0.4`)
- `high_flow` (optional) -- `0` oder `1`. Wenn angegeben, werden nur Düsen mit dem entsprechenden `highFlow`-Flag gematcht. Disambiguiert Standard- vs. High-Flow-Düsen mit gleichem Durchmesser.
- `bed_type` (optional) -- Name oder ID des Druckbett-Typs. Wenn angegeben, werden Kalibrierungswerte speziell für diese Druckbettoberfläche zurückgegeben. Fallback-Reihenfolge: bed-type-spezifischer Match → Match ohne bed-type → erster Durchmesser-Match.

Liefert bei Erfolg:
```json
{
  "filament": "Prusament PETG Prusa Galaxy Black",
  "nozzle": { "diameter": 0.4, "name": "Brass 0.4mm", "highFlow": false },
  "printer": "My MK4",
  "bedType": { "name": "Smooth PEI", "material": "PEI" },
  "calibration": {
    "pressureAdvance": 0.045,
    "maxVolumetricSpeed": 15,
    "extrusionMultiplier": 1.0,
    "retractLength": 0.6,
    "retractSpeed": 45,
    "retractLift": 0.2,
    "nozzleTemp": 240,
    "nozzleTempFirstLayer": 245,
    "bedTemp": 80,
    "bedTempFirstLayer": 85,
    "chamberTemp": null,
    "fanMinSpeed": null,
    "fanMaxSpeed": null,
    "fanBridgeSpeed": null
  }
}
```

Liefert 400, wenn `nozzle_diameter` fehlt. Liefert 404 mit einem `available`-Array aus `{ diameter, name }`-Objekten, wenn keine Kalibrierung dem angefragten Durchmesser entspricht.

Wird von PrusaSlicer Filament Edition genutzt, um Filament-Settings automatisch anzupassen, wenn Nutzende zwischen Druckerpresets wechseln.

### POST /api/filaments/:id

Synchronisiert ein Filament-Preset zurück aus PrusaSlicer. Der `{id}`-Parameter kann ein URL-kodierter Preset-Name oder eine MongoDB-ObjectId sein.

Query-Parameter:
- `nozzle_diameter` (optional) -- Düsendurchmesser in mm (z. B. `0.4`). Wenn angegeben, werden kalibrierungsbezogene Schlüssel (`extrusion_multiplier`, `pressure_advance`, `filament_retract_length`, `filament_retract_speed`, `filament_retract_lift`) in den passenden Per-Düse-Kalibrierungseintrag geschrieben statt in den Settings-Bag.
- `high_flow` (optional) -- `0` oder `1`. Wird zusammen mit `nozzle_diameter` genutzt, um Standard- vs. High-Flow-Düsen mit gleichem Durchmesser zu unterscheiden.

Sende einen JSON-Body:
```json
{ "config": { "temperature": "215", "filament_density": "1.24", "my_custom_key": "value" } }
```

Erkannte PrusaSlicer-INI-Schlüssel (`filament_type`, `filament_vendor`, `filament_colour`, `filament_diameter`, `filament_density`, `filament_cost`, `filament_spool_weight`, `filament_max_volumetric_speed`, `temperature`, `first_layer_temperature`, `bed_temperature`, `first_layer_bed_temperature`, `filament_shrinkage_compensation_xy`, `filament_shrinkage_compensation_z`, `filament_soluble`, `filament_abrasive`) werden umgekehrt auf strukturierte DB-Felder gemappt. Alle übrigen Schlüssel werden in den `settings`-Passthrough-Bag des Filaments zusammengeführt.

Liefert:
```json
{
  "message": "Synced 12 settings for \"Prusament PETG Prusa Galaxy Black\"",
  "filamentId": "64a1b2c3d4e5f6a7b8c9d0e1"
}
```

### GET /api/filaments/:id/spool-check

Prüft, ob irgendeine Spule dieses Filaments genug verbleibendes Filament (nach Gewicht) für einen Druckauftrag hat. Der `{id}`-Parameter kann ein URL-kodierter Preset-Name oder eine MongoDB-ObjectId sein.

Query-Parameter:
- `weight` (erforderlich) -- geschätztes Filamentgewicht in Gramm

Liefert:
```json
{
  "ok": true,
  "filament": "Prusament PETG Prusa Galaxy Black",
  "requiredWeightG": 42.5,
  "requiredLengthM": 14.03,
  "spools": [
    {
      "id": "default",
      "label": "Default",
      "remainingWeightG": 864,
      "remainingLengthM": 285.12,
      "enough": true
    }
  ]
}
```

Hat keine Spule genug Filament, ist `ok` gleich `false` und ein `warning`-String beschreibt das Defizit. Hat das Filament keine Spulen oder keine Spulengewichts-Daten, wird `ok: true` zurückgegeben (keine Daten = keine Warnung).

Liefert 400, wenn `weight` fehlt oder ungültig ist. Liefert 404, wenn das Filament nicht gefunden wird.

### GET /api/filaments/:id/openprinttag

Lädt das Filament als OpenPrintTag-CBOR-Binary (`.bin`-Datei) herunter. Das Binary kann auf ein NFC-V-Tag (ISO 15693) geschrieben oder mit anderen OpenPrintTag-kompatiblen Tools verwendet werden.

### POST /api/filaments/:id/spools

Fügt einem Filament eine neue Spule hinzu. Sende einen JSON-Body:

```json
{ "label": "Spool #2", "totalWeight": 1236 }
```

Beide Felder sind optional (`label` ist standardmäßig `""`, `totalWeight` standardmäßig `null`). Liefert das aktualisierte Filament-Dokument mit der neuen Spule im `spools`-Array.

### PUT /api/filaments/:id/spools/:spoolId

Aktualisiert Gewicht oder Bezeichnung einer Spule. Sende einen JSON-Body mit beliebiger Kombination aus:

```json
{ "totalWeight": 850, "label": "Opened 2025-03-15" }
```

Liefert das aktualisierte Filament-Dokument.

### DELETE /api/filaments/:id/spools/:spoolId

Entfernt eine Spule aus einem Filament. Liefert das aktualisierte Filament-Dokument.

---

## PrusaSlicer Config Bundle

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/filaments/prusaslicer` | Exportiert Filamente als PrusaSlicer-kompatibles INI-Config-Bundle |
| `POST` | `/api/filaments/prusaslicer` | Importiert ein PrusaSlicer-INI-Config-Bundle |

### GET /api/filaments/prusaslicer

Exportiert alle Filamente als PrusaSlicer-kompatibles INI-Config-Bundle mit einem `[filament:Name]`-Abschnitt pro Filament. Strukturierte DB-Felder (Temperaturen, Dichte, Kosten, max. volumetrische Geschwindigkeit, Schrumpfung) werden auf ihre PrusaSlicer-INI-Äquivalente gemappt und mit dem `settings`-Passthrough-Bag zusammengeführt. Kalibrierungs-Overrides (extrusion multiplier, pressure advance, retraction, max volumetric speed) werden NICHT in das Bundle eingebacken — sie werden dynamisch von PrusaSlicer Filament Edition über `GET /api/filaments/:name/calibration` angewendet, wenn sich der Drucker-/Düsenkontext ändert.

Jeder ausgegebene Abschnitt enthält außerdem standardmäßig `compatible_printers = ` und `compatible_printers_condition = ` (beide leer), was PrusaSlicer als „keine Einschränkung" interpretiert — das synchronisierte Filament erscheint im Dropdown jedes Druckers, und die Auto-Auswahl des Scan-Streams funktioniert unabhängig davon, welches Druckerprofil aktiv ist. Hat ein Nutzer über einen vorherigen Round-Trip-Import eine spezifische Einschränkung gesetzt (die Schlüssel kommen non-empty im Settings-Bag an), bleibt diese Einschränkung beim Export erhalten.

Query-Parameter:
- `type` -- Filter nach Filamenttyp (z. B. `PLA`, `PETG`)
- `vendor` -- Filter nach Herstellername
- `ids` -- kommagetrennte Liste von Filament-IDs

Liefert `text/plain`-INI-Inhalt.

### POST /api/filaments/prusaslicer

Importiert ein PrusaSlicer-INI-Config-Bundle. Sende den INI-Text als rohen Request-Body (z. B. `Content-Type: text/plain`).

Liefert:
```json
{
  "created": 12,
  "updated": 3,
  "filaments": ["Prusament PLA Galaxy Black", "Prusament PETG Orange", "..."]
}
```

`filaments` ist ein Array der Preset-Namen, die importiert wurden.

---

## OrcaSlicer Profile

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/filaments/orcaslicer` | Exportiert Filamente als OrcaSlicer-kompatible JSON-Profile |
| `POST` | `/api/filaments/:name-or-id/orcaslicer` | Synchronisiert Filament-Settings zurück aus OrcaSlicer |

### GET /api/filaments/orcaslicer

Exportiert Filamente als Array OrcaSlicer-kompatibler JSON-Profile. Strukturierte DB-Felder werden auf OrcaSlicer-Schlüssel gemappt (z. B. `nozzle_temperature`, `hot_plate_temp`, `filament_flow_ratio`), wobei die Werte gemäß OrcaSlicers Mehr-Extruder-Konvention in einelementige Arrays gepackt werden. Eltern-/Varianten-Vererbung wird vor dem Export aufgelöst.

Query-Parameter:
- `type` -- Filter nach Filamenttyp (z. B. `PLA`, `PETG`)
- `vendor` -- Filter nach Herstellername
- `ids` -- kommagetrennte Liste von Filament-IDs

Liefert `application/json`: ein Array von OrcaSlicer-Profil-Objekten.

### POST /api/filaments/:name-or-id/orcaslicer

Synchronisiert Filament-Settings zurück aus OrcaSlicer. Das Pfadsegment ist der URL-kodierte Filamentname ODER eine 24-stellige Hex-ObjectId; die Route versucht zuerst den Namen und fällt dann auf die ID zurück.

Der Request-Body ist ein JSON-Objekt mit beliebiger Kombination von OrcaSlicer-Schlüsseln. Erkannte strukturierte Schlüssel (`type`, `vendor`, `color`, `density`, `cost`, `diameter`, `maxVolumetricSpeed`, `temperatures`) werden in die entsprechenden DB-Felder geschrieben; alle übrigen Top-Level-Schlüssel werden in den `settings`-Passthrough-Bag zusammengeführt, sodass sie beim nächsten Export sauber zurückkommen.

Liefert:
```json
{
  "success": true,
  "filament": "Prusament PLA Galaxy Black",
  "updated": ["temperatures", "density", "settings"],
  "settingsAdded": ["filament_start_gcode"]
}
```

- `updated` -- Top-Level-Felder, die am Filament-Dokument modifiziert wurden.
- `settingsAdded` -- unbekannte Schlüssel, die im `settings`-Bag erhalten wurden.

404, wenn Filamentname / ID nicht auflösbar ist; 400, wenn der Body kein gültiges JSON ist.

---

## Bambu Studio Filament-Preset

Bambu Studio ist ein OrcaSlicer-Fork und teilt das `.json`-Filament-Preset-Schema. Die App stellt Export und Import für Bambu Studio bereit. Round-Trip ist verlustfrei für die strukturierten Felder; unbekannte Slicer-Keys fließen in den `settings`-Bag und überleben einen Export → Re-Import.

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET`  | `/api/filaments/:id/bambustudio` | Lädt ein einzelnes Filament als Bambu-Studio-Preset (`.json`) herunter |
| `POST` | `/api/filaments/:id/bambustudio` | Synchronisiert ein Bambu-Studio-Preset IN dieses spezifische Filament (per ID gepinnt — der geparste Name wird ignoriert) |
| `POST` | `/api/filaments/bambustudio`     | Importiert ein Bambu-Studio-Preset per Name (Upsert; bei vorhandenem Trash-Eintrag mit gleichem Namen wird dieser wiederbelebt statt eines Duplikats) |

### GET /api/filaments/:id/bambustudio

Identisches Datenmodell wie der OrcaSlicer-Export, mit `from: "User"` gestempelt, damit Bambu Studio das Preset als benutzerdefiniert klassifiziert. Variant-Filamente werden gegen ihren Parent aufgelöst, sodass das exportierte Preset die vollständigen wirksamen Werte trägt. Setzt `Content-Disposition: attachment` mit einem aus dem Filament-Namen abgeleiteten Dateinamen.

### POST /api/filaments/:id/bambustudio

Sync per ID — wird vom „Sync von Bambu Studio“-Button auf der Filament-Detailseite verwendet. Der Body ist entweder `multipart/form-data` mit einem `file`-Feld ODER `application/json` mit dem Bambu-Profil direkt. Der geparste `name`/`filament_settings_id` wird IGNORIERT (das Pinning erfolgt per ID — ein in Bambu Studio umbenanntes Preset aktualisiert weiterhin den richtigen Datensatz). Spulen-Subdokumente, `usageHistory` und `dryCycles` werden bei einem Sync NIE angerührt — das ist lokaler Bestand und nicht in der Bambu-Datei.

Antwort:

```json
{
  "created": false,
  "updated": true,
  "filamentId": "…",
  "name": "…",
  "calibrationApplied": true,
  "calibrationUnresolved": false,
  "calibrationContext": { "printerId": "…", "printerName": "…", "nozzleId": "…", "nozzleDiameter": 0.4 },
  "settingsAdded": ["filament_unique_key", "…"]
}
```

### POST /api/filaments/bambustudio

Bulk-Variante — Upsert per Name (`filament_settings_id` bevorzugt, sonst Top-Level-`name`). Drei-Phasen-Pattern: aktualisiert eine aktive Zeile gleichen Namens; belebt eine getrashte (nicht-purged) Zeile wieder; legt sonst neu an (mit E11000-Race-Recovery falls ein paralleler Import zwischen Find und Create denselben Namen erstellt hat). Calibration-Auto-Detect wie bei der Per-ID-Variante; `calibrationUnresolved: true` wenn die Drucker-Modell-Hint mehrere Treffer hat oder kein eindeutiger Nozzle am angegebenen Durchmesser auflösbar ist.

400, wenn `filament_type` oder `filament_vendor` beim Anlegen fehlen. 413 bei Multipart-Uploads über 10 MB.

---

## Scan-Stream

Pusht Live-NFC-Tag-Lesungen in einen langlebigen Stream, sodass Slicer abonnieren und automatisch das passende Filament-Preset auswählen können. Der Renderer veröffentlicht jeden Scan, nachdem er ein Tag dekodiert und gegen die DB gematcht hat; Konsumenten (das PrusaSlicer-/OrcaSlicer-FilamentDB-Modul oder jeder andere Client) abonnieren per Server-Sent Events.

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/scan/stream` | Abonniert NFC-Scans als Server-Sent Events |
| `POST` | `/api/scan/publish` | Veröffentlicht einen dekodierten Scan an Abonnenten (vom Renderer genutzt) |

### GET /api/scan/stream

Server-Sent-Events-Endpunkt. Die Antwort bleibt offen; jede NFC-Tag-Lesung sendet einen Datensatz. Event-Typen:

| `event:`-Wert | Wann gesendet | Hinweise |
|----------------|-----------|-------|
| `replay` | Einmal beim Verbinden | Der zuletzt veröffentlichte Scan, erneut gesendet, damit ein Slicer, der kurz nach einer Tag-Lesung geöffnet wird, ihn noch mitbekommt. Übersprungen, wenn in dieser Prozesslaufzeit noch kein Scan stattgefunden hat. |
| `scan` | Pro Tag-Lesung | Ein frisch dekodiertes + gematchtes Tag. |

Query-Parameter:
- `replay` -- auf `0` setzen, um das Replay beim Verbinden zu unterdrücken (nur das Prelude + zukünftige `scan`-Events werden gesendet).

Jede `data:`-Payload hat dieselbe JSON-Form:

```json
{
  "timestamp": 1700000000000,
  "filament": {
    "_id": "65f00000000000000000abcd",
    "name": "Prusament PLA Galaxy Black",
    "vendor": "Prusament",
    "type": "PLA",
    "color": "#000000"
  },
  "candidates": [],
  "decoded": {
    "materialName": "Prusament PLA Galaxy Black",
    "brandName": "Prusament",
    "materialType": "PLA",
    "color": "#000000",
    "spoolUid": "2acc21072a",
    "tagSource": "openprinttag"
  }
}
```

Feldhinweise:
- `filament` ist die gematchte DB-Zeile oder `null`, wenn keine Zeile passt. Slicer schlüsseln Presets per Name und sollten bei `filament.name` umschalten, wenn nicht-null.
- `candidates` ist eine kurze Liste plausibler Alternativen (Vendor + Type, dann nur Vendor), wenn kein exakter Match vorliegt; sonst leer.
- `decoded` trägt eine Teilmenge der Tag-Felder, die für Konsumenten nützlich sind; `tagSource` ist `"openprinttag"` oder `"bambu"`.

Response-Header:
- `content-type: text/event-stream; charset=utf-8`
- `cache-control: no-cache, no-transform`
- `x-accel-buffering: no` (verhindert Response-Buffering durch nginx-artige Proxies)

Der Stream sendet ein `retry: 5000`-Prelude (EventSource-Clients verbinden sich nach 5 s bei einem Abbruch erneut) und einen `: hb`-Heartbeat-Kommentar alle 25 Sekunden, damit Idle-Proxies die Verbindung nicht abbrechen. Konsumenten mit libcurl-artigen HTTP-Clients müssen ihre eigene Reconnect-Schleife implementieren.

Der Bus ist in-process (Node `EventEmitter` auf `globalThis`). „In-process" bedeutet hier **eine Filament-DB-Instanz, nicht eine physische Maschine** — Abonnenten können überall sitzen, wo sie per HTTP erreichbar sind (ein Pi, der Filament DB ausführt, kann PrusaSlicer auf einem Mac über das LAN ansteuern; der Slicer verbindet sich einfach mit `http://<filament-db-host>:3456/api/scan/stream`). Was auf eine einzelne Maschine festgenagelt ist, ist der Publisher: NFC-Lesungen kommen aus dem `NfcProvider` des Electron-Renderers, also muss der Reader an die Box angeschlossen sein, die die Electron-App ausführt — ein Headless-Docker-/Web-Only-Deploy hat keinen `NfcProvider` und veröffentlicht nichts. Ein horizontal skaliertes Multi-Prozess-Deployment bräuchte einen externen Broker hinter dem Bus.

Ein paar Netzwerk-Deploy-Hinweise, wenn du cross-machine gehst: Die API ist absichtlich nicht authentifiziert (Single-User-Vertrauensmodell — siehe README-Warnung), also überlege bewusst, auf welchem Netzwerk Port 3456 freigegeben ist. Das Electron-gebündelte Next.js bindet sich anhand der `HOSTNAME`-Umgebungsvariable; wenn cross-machine-Abonnenten sich nicht verbinden können, versuche `HOSTNAME=0.0.0.0`. Und weil `replay`-Events veraltete Scans über Slicer-Neustarts hinweg tragen, sollten Konsumenten nach `timestamp` filtern, falls ein mehrere Stunden altes Tag nicht erneut angewendet werden soll.

### POST /api/scan/publish

Vom `NfcProvider` des Renderers genutzt, um nach dem vorhandenen `/api/filaments/match`-Schritt einen Scan zu pushen. Öffentliche Clients müssen das normalerweise nicht direkt aufrufen; es ist der Vollständigkeit halber und zum Testen des SSE-Pfads ohne physischen Reader dokumentiert.

Request-Body:

```json
{
  "filament": {
    "_id": "65f00000000000000000abcd",
    "name": "Prusament PLA Galaxy Black",
    "vendor": "Prusament",
    "type": "PLA",
    "color": "#000000"
  },
  "candidates": [],
  "decoded": {
    "materialName": "Prusament PLA Galaxy Black",
    "brandName": "Prusament",
    "materialType": "PLA",
    "color": "#000000",
    "spoolUid": "2acc21072a",
    "tagSource": "openprinttag"
  }
}
```

- `filament` -- die gematchte DB-Zeile oder `null`, wenn keine Zeile passte.
- `candidates` -- optionales Array plausibler Alternativen in derselben Form wie `filament`.
- `decoded` -- Teilmenge der dekodierten Tag-Felder. Unbekannte `tagSource`-Werte werden verworfen.

Der Body wird gegen eine Allow-List validiert — unbekannte Felder werden entfernt, bevor das Event veröffentlicht wird, sodass ein fehlerhafter POST den Replay-Cache nicht verschmutzen kann.

Liefert `202 Accepted`:

```json
{
  "ok": true,
  "event": { /* der veröffentlichte Scan, inklusive des serververgebenen Zeitstempels */ }
}
```

400, wenn der Body kein gültiges JSON ist, kein Objekt ist oder weder einen Filament-Match noch dekodierte Felder enthält (nichts, worauf ein Konsument reagieren könnte).

---

## OpenPrintTag-Datenbank

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/openprinttag` | Durchsucht die OpenPrintTag-Community-Datenbank (nur FDM-Filamente) |
| `POST` | `/api/openprinttag/import` | Importiert ausgewählte Materialien in Filament DB |

### GET /api/openprinttag

Holt die [OpenPrintTag-Community-Datenbank](https://github.com/OpenPrintTag/openprinttag-database) von GitHub, parst alle Material-YAML-Dateien, filtert auf FFF-(FDM-)Filamente und gibt sie mit Vollständigkeits-Scores zurück. Ergebnisse werden 1 Stunde gecacht.

Query-Parameter:
- `refresh=true` -- erzwingt erneuten Fetch von GitHub (leert den Cache)

Liefert:
```json
{
  "brands": [
    { "slug": "prusament", "name": "Prusament", "materialCount": 42 }
  ],
  "materials": [
    {
      "slug": "prusament-pla-prusa-galaxy-black",
      "uuid": "1aaca54a-...",
      "brandSlug": "prusament",
      "brandName": "Prusament",
      "name": "PLA Prusa Galaxy Black",
      "type": "PLA",
      "color": "#3d3e3d",
      "density": 1.24,
      "nozzleTempMin": 205,
      "nozzleTempMax": 225,
      "completenessScore": 8,
      "completenessTier": "rich"
    }
  ],
  "cachedAt": "2026-04-02T...",
  "totalFFF": 11194,
  "totalSLA": 171
}
```

Vollständigkeits-Scoring (0–10): Farbe, Dichte, Drucktemperaturen, Druckbett-Temperaturen, Trocknungstemperatur, Härte, Transmission Distance, Kammer-Temperatur, Fotos, Produkt-URL. Stufen: rich (7–10), partial (4–6), stub (0–3).

### POST /api/openprinttag/import

Importiert ausgewählte OpenPrintTag-Materialien in Filament DB. Sende einen JSON-Body:

```json
{ "slugs": ["prusament-pla-prusa-galaxy-black", "polymaker-fiberon-pa6-cf20-black"] }
```

Materialien werden auf das Filament-DB-Schema gemappt (Typ, Hersteller, Temperaturen, Dichte, Härte, Transmission Distance, Trocknungsdaten, OPT-Tags) und per Name upsertet. Existiert bereits ein Filament mit demselben Namen unter einem anderen Hersteller, wird der Import mit einer aussagekräftigen Fehlermeldung übersprungen (der Unique-Index liegt allein auf `name`).

Liefert:
```json
{
  "message": "Imported 2 filaments (2 new)",
  "total": 2,
  "created": 2,
  "updated": 0
}
```

---

## Prusament

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/prusament` | Scraped eine Prusament-Spulen-Seite per Spulen-ID |
| `POST` | `/api/prusament/import` | Importiert eine gescrapte Spule als Filament |

### GET /api/prusament

Holt eine Prusament-Spulen-Detailseite (vom QR-Code auf der Spule) und extrahiert die eingebetteten Spulen-Daten. Query-Parameter:

- `spoolId` -- die Spulen-Kennung (z. B. `c6974284da`) oder die vollständige URL

Liefert:
```json
{
  "spoolId": "c6974284da",
  "productName": "Prusament PETG Prusa Galaxy Black 1kg - v1",
  "material": "PETG",
  "colorName": "Prusa Galaxy Black",
  "colorHex": "#292929",
  "diameter": 1.75,
  "diameterAvg": 1.748,
  "diameterStdDev": 2.5183,
  "ovality": 0.971,
  "netWeight": 1050,
  "spoolWeight": 186,
  "totalWeight": 1236,
  "lengthMeters": 345,
  "nozzleTempMin": 240,
  "nozzleTempMax": 260,
  "bedTempMin": 70,
  "bedTempMax": 90,
  "manufactureDate": "2025-01-05 08:21:40",
  "country": "CZ",
  "goodsId": 4715,
  "priceUsd": 29.99,
  "priceEur": 29.99,
  "photoUrl": "https://...",
  "pageUrl": "https://prusament.com/spool/?spoolId=c6974284da"
}
```

### POST /api/prusament/import

Importiert eine gescrapte Prusament-Spule in die Datenbank. Sende einen JSON-Body:

```json
{
  "spool": { "...scraped data from GET /api/prusament..." },
  "action": "create",
  "filamentId": null
}
```

**`action: "create"`** -- Legt ein neues Filament mit dem Namen `"Prusament {material} {colorName}"` und allen ausgefüllten Spezifikationen an (Temperaturen, Dichte, Gewichte, Spule). Existiert bereits ein Filament mit diesem Namen, wird die Spule stattdessen dort hinzugefügt.

**`action: "add-spool"`** -- Fügt die Spule einem bestehenden Filament hinzu, das per `filamentId` angegeben ist.

Liefert:
```json
{
  "action": "create",
  "filament": { "...full filament document..." },
  "message": "Created \"Prusament PETG Prusa Galaxy Black\" with spool c6974284da"
}
```

---

## Düsen

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/nozzles` | Listet alle Düsen auf. Query-Parameter: `diameter`, `type`, `highFlow` |
| `POST` | `/api/nozzles` | Legt eine neue Düse an |
| `GET` | `/api/nozzles/:id` | Ruft eine einzelne Düse per ID ab |
| `PUT` | `/api/nozzles/:id` | Aktualisiert eine Düse per ID |
| `DELETE` | `/api/nozzles/:id` | Soft-Delete einer Düse (blockiert, wenn von Filamenten referenziert) |
| `POST` | `/api/nozzles/:id/clone` | Klont eine Düse in eine neue Zeile als physische Instanz |

### GET /api/nozzles

Liefert ein Array von Düsen-Dokumenten, sortiert nach Durchmesser und dann nach Typ. Unterstützt optionale Query-Parameter:

- `diameter` -- Filter nach Durchmesser (z. B. `0.4`)
- `type` -- Filter nach Düsentyp (z. B. `Brass`)
- `highFlow` -- Filter nach High-Flow-Flag (`true` oder `false`)

### POST /api/nozzles

Legt eine neue Düse an. Pflichtfelder: `name`, `diameter`, `type`.

### PUT /api/nozzles/:id

Aktualisiert eine Düse. Sende einen JSON-Body mit den zu aktualisierenden Feldern.

### DELETE /api/nozzles/:id

Soft-Delete einer Düse per ID (setzt den Zeitstempel `_deletedAt`). Eine Düse, die von Filamenten referenziert oder in einem Drucker installiert ist, kann nicht gelöscht werden. Liefert `{ message: "Deleted" }`.

### POST /api/nozzles/:id/clone

Klont eine bestehende Düse in eine neue Zeile. Der Klon kopiert jedes Spec-Feld (Durchmesser, Typ, High-Flow, gehärtet, Notizen) unter einem `Name #N`-Suffix mit einer frischen `_id`. Wird vom Move-or-Clone-Konfliktlösungs-Workflow im Drucker-Formular genutzt, wenn eine physische Düse bereits in einem anderen Drucker installiert ist. Der Klon wird **nicht** automatisch an einen Drucker angehängt — der Aufrufer weist ihn zu. Liefert die neue Düse mit `201`.

---

## Drucker

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/printers` | Listet alle Drucker auf. Query-Parameter: `manufacturer` |
| `POST` | `/api/printers` | Legt einen neuen Drucker an |
| `GET` | `/api/printers/:id` | Ruft einen einzelnen Drucker per ID ab (populiert installierte Düsen) |
| `PUT` | `/api/printers/:id` | Aktualisiert einen Drucker per ID |
| `DELETE` | `/api/printers/:id` | Soft-Delete eines Druckers (blockiert, wenn von Kalibrierungen referenziert) |

### GET /api/printers

Liefert ein Array von Drucker-Dokumenten, sortiert nach Hersteller und dann nach Name, mit populierten `installedNozzles`. Unterstützt optionale Query-Parameter:

- `manufacturer` -- Filter nach Herstellername

### POST /api/printers

Legt einen neuen Drucker an. Pflichtfelder: `name`, `manufacturer`, `printerModel`.

### GET /api/printers/:id

Liefert einen einzelnen Drucker mit `installedNozzles` als vollständige Düsen-Dokumente populiert.

### PUT /api/printers/:id

Aktualisiert einen Drucker. Sende einen JSON-Body mit den zu aktualisierenden Feldern.

### DELETE /api/printers/:id

Soft-Delete eines Druckers per ID (setzt den Zeitstempel `_deletedAt`). Ein Drucker, der von Filament-Kalibrierungen referenziert wird, kann nicht gelöscht werden. Liefert `{ message: "Deleted" }`.

---

## Druckbett-Typen

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/bed-types` | Listet alle Druckbett-Typen auf. Query-Parameter: `material` |
| `POST` | `/api/bed-types` | Legt einen neuen Druckbett-Typ an |
| `GET` | `/api/bed-types/:id` | Ruft einen einzelnen Druckbett-Typ per ID ab |
| `PUT` | `/api/bed-types/:id` | Aktualisiert einen Druckbett-Typ per ID |
| `DELETE` | `/api/bed-types/:id` | Soft-Delete eines Druckbett-Typs (blockiert, wenn von Filament-Kalibrierungen referenziert) |

### GET /api/bed-types

Liefert ein Array von Druckbett-Typ-Dokumenten, sortiert nach Name. Unterstützt optionale Query-Parameter:

- `material` -- Filter nach Material (z. B. `PEI`, `Glass`)

### POST /api/bed-types

Legt einen neuen Druckbett-Typ an. Pflichtfelder: `name`, `material`.

### PUT /api/bed-types/:id

Aktualisiert einen Druckbett-Typ. Sende einen JSON-Body mit den zu aktualisierenden Feldern.

### DELETE /api/bed-types/:id

Soft-Delete eines Druckbett-Typs per ID (setzt den Zeitstempel `_deletedAt`). Ein Druckbett-Typ, der von Filament-Kalibrierungen referenziert wird, kann nicht gelöscht werden. Liefert `{ message: "Deleted" }`.

---

## TDS-Extraktion (KI)

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/tds` | Prüft, ob ein KI-API-Key konfiguriert ist |
| `PUT` | `/api/tds` | Speichert einen KI-API-Key (mit Anbieterauswahl) |
| `DELETE` | `/api/tds` | Entfernt den gespeicherten KI-API-Key |
| `POST` | `/api/tds` | Extrahiert Filamentdaten aus einer TDS-URL |

### GET /api/tds

Liefert zurück, ob ein KI-API-Key konfiguriert ist und welcher Anbieter aktiv ist.

```json
{ "configured": true, "provider": "gemini" }
```

### PUT /api/tds

Speichert und validiert einen KI-API-Key. Sende einen JSON-Body:

```json
{ "apiKey": "your-api-key", "provider": "gemini" }
```

Unterstützte Anbieter: `gemini` (Google Gemini), `claude` (Anthropic Claude), `openai` (OpenAI ChatGPT).

Der Key wird vor dem Speichern gegen die API des Anbieters validiert. Liefert `{ success: true }` bei Erfolg oder 401, wenn der Key ungültig ist.

### DELETE /api/tds

Entfernt den gespeicherten API-Key und setzt den Anbieter auf den Standard zurück (Gemini).

### POST /api/tds

Extrahiert Filamenteigenschaften aus einem Technical Data Sheet mittels KI. Akzeptiert zwei Eingabemodi:

**URL-basiert** -- Sende einen JSON-Body:
```json
{ "url": "https://example.com/filament-tds.pdf", "apiKey": "optional-key", "provider": "gemini" }
```

- `url` (erforderlich) -- URL zu einem TDS-Dokument (PDF oder Webseite)
- `apiKey` (optional) -- zu verwendender API-Key. Fällt zurück auf Umgebungsvariable (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY` oder `OPENAI_API_KEY`) oder den per PUT gespeicherten Key.
- `provider` (optional) -- zu verwendender KI-Anbieter. Fällt zurück auf den gespeicherten Anbieter.

**Datei-Upload** -- Upload per `multipart/form-data` mit einem `file`-Feld (max. 10 MB). PDF- und Klartextdateien werden unterstützt. Zusätzliche Formularfelder `apiKey` und `provider` werden ebenfalls akzeptiert.

```
POST /api/tds
Content-Type: multipart/form-data

file=<PDF or text file>
apiKey=<optional>
provider=<optional>
```

Liefert:
```json
{
  "success": true,
  "fieldsExtracted": 12,
  "data": {
    "name": "SuperPLA Pro",
    "vendor": "ExampleBrand",
    "type": "PLA",
    "density": 1.24,
    "diameter": 1.75,
    "temperatures": {
      "nozzle": 215,
      "nozzleRangeMin": 200,
      "nozzleRangeMax": 230,
      "bed": 60
    },
    "dryingTemperature": 55,
    "dryingTime": 4,
    "glassTempTransition": 60,
    "heatDeflectionTemp": 52
  }
}
```

Extrahierte Felder umfassen: Name, Hersteller, Typ, Dichte, Durchmesser, Temperaturen (Düse, Druckbett, Bereiche), Trocknungstemperatur/-zeit, Glasübergang (Tg), Heat Deflection (HDT), Shore-Härte (A/D), volumetrische Geschwindigkeit, Druckgeschwindigkeits-Bereiche und Gewichte. Felder, die im TDS nicht gefunden werden, werden aus der Antwort weggelassen.

**SSRF-/Redirect-Handling**: Der URL-Fetcher nutzt den geteilten `assertExternalUrl`-Guard (keine `file:`-/`gopher:`-Schemata; lehnt Loopback-/RFC1918-/Link-Local-/Cloud-Metadata-IPs ab). Redirects werden manuell verfolgt, wobei der gleiche Guard bei jedem Hop erneut angewendet wird, gedeckelt auf 5 Redirects — so kann ein öffentlicher Host nicht per 30x in privaten Raum umleiten (entspricht dem Muster der `embed-check`-Route). Das `tdsUrl`-Feld am `Filament` wird zusätzlich schema-validiert auf http(s) bei Erstellung und auf jedem Update-Pfad.

---

## Setup

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `POST` | `/api/setup` | Testet einen MongoDB-Connection-String |

---

## Snapshot

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/snapshot` | Exportiert Kern-App-Daten als JSON-Snapshot |
| `POST` | `/api/snapshot` | Stellt die Datenbank aus einem JSON-Snapshot wieder her |
| `DELETE` | `/api/snapshot/delete` | Löscht alle lokalen App-Daten endgültig |

### GET /api/snapshot

Lädt einen JSON-Snapshot der Kern-App-Daten herunter: Filamente, Düsen, Drucker, Druckbett-Typen, Locations, Druckverlauf und Shared Catalogs (inklusive soft-gelöschter Dokumente und Tombstones). Der Snapshot bewahrt `_id`-Werte, Zeitstempel und Referenzen, damit er exakt wiederhergestellt werden kann. Die Snapshot-Schema-Version ist ab v1.14.0 `4`; ältere v1-/v2-/v3-Snapshots lassen sich weiterhin wiederherstellen (fehlende Collections kommen als leer zurück).

Liefert eine JSON-Datei mit `Content-Disposition: attachment`-Header.

### POST /api/snapshot

Stellt die Datenbank aus einem zuvor exportierten Snapshot wieder her. Dies ist eine destruktive Operation: Alle vorhandenen Snapshot-bezogenen Daten werden durch die Snapshot-Inhalte ersetzt.

Upload per `multipart/form-data` mit einem `file`-Feld, das das Snapshot-JSON enthält, oder sende das JSON direkt als Request-Body.

Das Restore verwendet **Best-Effort-Rollback**: Schlägt ein Teil des Restores fehl, versucht der Handler, die vorherigen Daten aus einem In-Memory-Backup erneut einzufügen. Gleichzeitige Restore-Anfragen werden mit 409 abgelehnt. Hinweis: Das Restore ist nicht wirklich atomar — gleichzeitige Leser können während des Delete-/Insert-Fensters partiellen Zustand beobachten, und wenn das Rollback selbst fehlschlägt, kann die Datenbank unvollständig bleiben. Lege aus Sicherheitsgründen vor dem Wiederherstellen ein Backup an.

Liefert:
```json
{
  "message": "Snapshot restored successfully",
  "restored": {
    "filaments": 42,
    "nozzles": 5,
    "printers": 2,
    "bedTypes": 3,
    "locations": 4,
    "printHistory": 12,
    "sharedCatalogs": 1
  }
}
```

### DELETE /api/snapshot/delete

Löscht endgültig alle Dokumente aus Filamenten, Düsen, Druckern, Druckbett-Typen, Locations, Druckverlauf und Shared Catalogs. Liefert die Anzahl gelöschter Dokumente pro Collection.

---

## CSV-/XLSX-Import und -Export

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/filaments/export-csv` | Lädt alle Filamente als CSV-Datei herunter |
| `GET` | `/api/filaments/export-xlsx` | Lädt alle Filamente als XLSX-Tabelle herunter |
| `POST` | `/api/filaments/import-csv` | Importiert Filamente aus einer CSV-Datei |
| `POST` | `/api/filaments/import-xlsx` | Importiert Filamente aus einer XLSX-Datei |

### GET /api/filaments/export-csv

Lädt alle Filamente als CSV-Datei mit Spalten für Name, Hersteller, Typ, Farbe, Farbname, Durchmesser, Temperaturen (Düse, Druckbett, erste Schicht, Bereiche, Standby), Kosten, Dichte, Gewichte, Instance-ID, Trocknungstemperatur/-zeit, Transmission Distance, Glasübergang (Tg), Heat Deflection (HDT), Shore-Härte (A/D), Druckgeschwindigkeits-Bereiche und Spulentyp herunter.

### GET /api/filaments/export-xlsx

Lädt alle Filamente als gestylte XLSX-Tabelle mit Auto-Filter, eingefrorener Kopfzeile, farbcodierten Zellen und denselben Spalten wie der CSV-Export herunter.

### POST /api/filaments/import-csv

Lade eine CSV-Datei per `multipart/form-data` mit einem `file`-Feld hoch (max. 10 MB). Die CSV muss mindestens eine Kopfzeile mit den Spalten `Name`, `Vendor` und `Type` haben. Zusätzliche Spalten werden per Spaltenname (case-insensitive) zugeordnet, darunter: `Color`, `Color Name`, `Diameter`, `Cost`, `Density`, `Nozzle Temp`, `Bed Temp`, `Nozzle First Layer`, `Bed First Layer`, `Max Volumetric Speed`, `Spool Weight`, `Net Filament Weight`, `TDS URL`, `Instance ID`, `Drying Temp`, `Drying Time`, `Transmission Distance` / `HueForge TD`, `Glass Transition` / `Tg`, `Heat Deflection` / `HDT`, `Shore A`, `Shore D`, `Min Print Speed`, `Max Print Speed`, `Nozzle Range Min`, `Nozzle Range Max`, `Standby Temp`, `Spool Type`. Nur in der CSV vorhandene Felder werden aktualisiert — vorhandene Daten für nicht zugeordnete Spalten bleiben erhalten.

### POST /api/filaments/import-xlsx

Lade eine XLSX-Datei per `multipart/form-data` mit einem `file`-Feld hoch (max. 10 MB). Gleiches Spalten-Mapping und Verhalten wie beim CSV-Import.

Beide liefern:
```json
{
  "message": "Imported 10 filaments (8 new, 1 updated, 1 skipped)",
  "total": 10,
  "created": 8,
  "updated": 1,
  "skipped": 1,
  "skippedRows": [
    { "row": 5, "name": "Partial Entry", "reason": "Missing required field(s): vendor" }
  ]
}
```

---

## Setup

### POST /api/setup

Testet eine MongoDB-Atlas-Verbindung. Sende einen JSON-Body:

```json
{
  "mongodbUri": "mongodb+srv://user:pass@cluster.mongodb.net/filament-db"
}
```

Liefert `{ success: true, message: "Connection successful" }` bei Erfolg, oder einen 400-Fehler mit dem Grund des Fehlschlags. Wird vom Setup-Assistenten der Desktop-App genutzt, um die Verbindung vor dem Speichern zu validieren.

---

## Locations (v1.11)

Locations sind Orte, an denen physische Spulen liegen — Dryboxes, Regale, Schränke, AMS-Einheiten. Jede Spule kann optional eine einzelne Location referenzieren.

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET`    | `/api/locations`        | Listet alle nicht-gelöschten Locations auf (nach Name sortiert). Query-Parameter: `kind`, `stats=true` (hängt spoolCount + totalGrams pro Location an) |
| `POST`   | `/api/locations`        | Legt eine Location an. Liefert 409 bei doppeltem Namen. |
| `GET`    | `/api/locations/:id`    | Ruft eine einzelne Location ab |
| `PUT`    | `/api/locations/:id`    | Aktualisiert veränderliche Felder |
| `DELETE` | `/api/locations/:id`    | Soft-Delete. Liefert 400, wenn eine Spule diese Location noch referenziert — weise diese Spulen zuerst neu zu. |

### Location-Dokumentform

```json
{
  "_id": "…",
  "name": "Drybox #1",
  "kind": "drybox",          // free-form: "drybox", "shelf", "cabinet", "printer"
  "humidity": 35,             // optional %RH (0–100), user-updated
  "notes": "Kept in the garage"
}
```

### GET /api/locations?stats=true

Wenn Stats angefragt werden, wird die Antwort um Live-Inventarzählungen angereichert, berechnet über eine einzelne Aggregation über `Filament.spools`:

```json
[
  { "_id": "…", "name": "Drybox #1", "kind": "drybox", "spoolCount": 3, "totalGrams": 2450 }
]
```

Ausgemusterte Spulen (`spool.retired === true`) werden aus den Zählungen ausgeschlossen.

---

## Druckverlauf (v1.11)

Per-Job-Ledger der Druckläufe. Reduziert Spulengewichte, hängt Spulen-Level-`usageHistory`-Einträge mit `source: "job"` an und führt einen Top-Level-Record für Analytics.

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET`    | `/api/print-history`      | Listet Druckaufträge auf (absteigend nach `startedAt`). Query: `filamentId`, `printerId`, `limit` (Standard 100, Max 1000) |
| `POST`   | `/api/print-history`      | Zeichnet einen Druckauftrag auf (siehe Body unten) |
| `GET`    | `/api/print-history/{id}` | Lädt einen einzelnen Druckauftrag mit denselben populierten Feldern wie die Liste (Druckername + Filament-Name/Vendor/Typ/Farbe je Verbrauchszeile). Tombstoned-Zeilen liefern 404 |
| `PUT`    | `/api/print-history/{id}` | Aktualisiert nur Job-Metadaten. Akzeptiert fünf Felder: `jobLabel` (getrimmt, max. 200), `notes` (auf 2000 gekürzt), `source` (Enum), `printerId` (oder `null`), `startedAt`. **Unbekannte Felder werden mit 400 abgelehnt** (ein versehentliches `_purged` oder Legacy-`durationSeconds` rutscht nicht durch). Verbrauchszeilen + Spulen-Grammwerte sind hier NICHT änderbar — bei Änderungen mit DELETE + POST neu anlegen |
| `DELETE` | `/api/print-history/{id}` | Macht einen Druckauftrag rückgängig — erstattet das Spulengewicht, entfernt die passenden `usageHistory`-Einträge, soft-löscht die Zeile |

### POST /api/print-history

```json
{
  "jobLabel": "benchy.3mf",
  "printerId": "optional-printer-id",
  "startedAt": "2026-04-22T10:00:00Z",
  "source": "prusaslicer",
  "notes": "optional free-form",
  "usage": [
    { "filamentId": "…", "spoolId": "optional", "grams": 42 },
    { "filamentId": "…", "grams": 8 }
  ]
}
```

Validierungen:
- `jobLabel` ist erforderlich, max. 200 Zeichen.
- `usage` muss 1–100 Einträge haben, jeweils mit gültiger `filamentId` und nicht-negativem `grams`-Wert.
- `notes` wird auf 2000 Zeichen gekürzt.
- `source` muss einer von `manual | prusaslicer | orcaslicer | bambu | other` sein; unbekannte Werte fallen auf `manual` zurück.

Jedes referenzierte Filament wird **vor** jeder Mutation geholt und validiert. Fehlt eines, wird die gesamte Anfrage mit 404 abgebrochen, und keine Spulengewichte werden angefasst. Die Schreibvorgänge laufen innerhalb einer MongoDB-Transaktion, wenn das Deployment dies unterstützt (Atlas immer), und fallen auf sequentielle Saves auf standalone mongod zurück.

Jeder vom POST geschriebene Spulen-`usageHistory`-Eintrag wird mit `jobId` versehen, das auf die neue PrintHistory-`_id` gesetzt ist, sodass ein späteres `DELETE` die exakten zu erstattenden Einträge matchen kann.

Antwort: das angelegte `PrintHistory`-Dokument, `201`.

### DELETE /api/print-history/{id}

Mache einen Job rückgängig: Für jeden `usage`-Eintrag des Records, finde die passende Spule, erstatte ihren `totalWeight` um die aufgezeichneten Gramm und entferne den entsprechenden `usageHistory`-Eintrag. Dann **soft-lösche** das `PrintHistory`-Dokument, indem `_deletedAt` gesetzt wird (statt eines harten `deleteOne`), damit der Peer-Sync das Löschen über den Tombstone propagieren kann — ein hartes Löschen würde dem anderen Peer erlauben, die Zeile im nächsten Sync-Zyklus zurück zu pushen.

Erstattungs-Matching erfolgt über `usageHistory.jobId === entry._id` — eindeutig, sodass ein manueller Usage-Log, der zufällig `(grams, date)` mit dem Job teilt, **nicht** betroffen ist. Legacy-Einträge, die vor der Einführung von `jobId` geschrieben wurden (pre-v1.12.7), fallen auf einen `(grams, date, source)`-Match zurück, der weiterhin auf `source: "job" | "slicer"` beschränkt ist, sodass manuelle Logs auch auf diesem Pfad überleben.

**Idempotent**: ein Retry / Doppelklick / Client-Retry nach Timeout liefert `404` zurück, statt Spulengewicht erneut zu erstatten. Die Lookup filtert auf `_deletedAt: null`, sodass nach dem Tombstoning der Zeile der zweite Aufruf kurzschließt, bevor irgendetwas angefasst wird.

Liefert `200 { "message": "Deleted and refunded" }` beim ersten Erfolg, `404` bei jedem folgenden Aufruf (oder wenn eine PrintHistory mit dieser ID nie existierte).

Best-Effort: Wurde eine referenzierte Spule mittlerweile gelöscht (oder das Filament soft-gelöscht), wird dieser Eintrag stillschweigend übersprungen — die übrigen Erstattungen werden trotzdem angewendet und das PrintHistory-Dokument trotzdem getombstoned.

---

## Analytics (v1.11)

Aggregiert PrintHistory-Zeilen plus alle manuellen Per-Spulen-`usageHistory`-Einträge (jene, die Nutzende direkt auf der Spulen-UI geloggt haben, ohne über `/api/print-history` zu gehen).

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/analytics?days=30` | Nutzungs-Analytics für die letzten N Tage (7–365, Standard 30) |

### Antwort

```json
{
  "since": "2026-03-23T00:00:00Z",
  "days": 30,
  "totals": { "grams": 3240, "cost": 82.50, "jobs": 17, "manualEntries": 2 },
  "usageByDay": [{ "date": "2026-03-23", "grams": 0 }, …],
  "byFilament":  [{ "_id": "…", "name": "PLA Black", "vendor": "Vendor A", "cost": 25, "grams": 1200 }, …],
  "byVendor":    [{ "vendor": "Vendor A", "grams": 2100 }, …],
  "byPrinter":   [{ "_id": "…", "name": "Core One", "grams": 1900 }, …]
}
```

`usageHistory`-Einträge werden nur dann mitgezogen, wenn `source === "manual"`. Einträge mit `source: "job"` oder `"slicer"` gehören zu einer PrintHistory-Zeile und sind bereits in der primären Aggregation gezählt — würde man sie hier einbeziehen, würden dieselben Gramm doppelt gezählt.

`totals.manualEntries` (hinzugefügt in GH #204) zählt die manuellen `usageHistory`-Zeilen, die zum Zeitfenster beigetragen haben — unterscheidet Inventar, das über PrintHistory-Jobs verbraucht wurde, von Inventar, das über direkte Spulen-UI-Logs verbraucht wurde. Der Renderer zeigt dies als `+N manual`-Hinweis unter der **Print jobs**-Statistik-Box an, wenn > 0, sodass eine frische DB mit nur manuellen Logs nicht mehr `0 g · $0 · 0 jobs` anzeigt, obwohl Nutzung aufgezeichnet wurde.

---

## Share (v1.11)

Veröffentlicht einen statischen Snapshot ausgewählter Filamente mit ihren referenzierten Düsen/Druckern/Druckbett-Typen, ausgeliefert unter einem kurzen Slug, sodass ein anderer Nutzer (oder eine andere Maschine) das Set importieren kann.

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET`    | `/api/share`            | Listet Catalogs auf, die du veröffentlicht hast (neueste zuerst; soft-gelöschte Catalogs sind ausgeblendet) |
| `POST`   | `/api/share`            | Veröffentlicht einen neuen Catalog |
| `GET`    | `/api/share/:slug`      | Öffentlicher Fetch. Inkrementiert `viewCount` atomar. Liefert 404, wenn soft-gelöscht, 410, wenn abgelaufen. |
| `DELETE` | `/api/share/:slug`      | Veröffentlichung zurückziehen (soft-löschen) |

### POST /api/share

```json
{
  "title": "My favourite PLAs",
  "description": "Optional markdown-ish summary",
  "filamentIds": ["…", "…"],
  "expiresAt": "2026-12-31T00:00:00Z"
}
```

Validierungen:
- `title` ist erforderlich, max. 200 Zeichen. `description` max. 5000 Zeichen.
- `filamentIds` muss 1–500 Einträge haben.

Der Server sammelt jede Düse/jeden Drucker/jeden bedType, der von den ausgewählten Filamenten referenziert wird, und denormalisiert sie alle in die Catalog-Payload. Spätere Änderungen an den Quell-Filamenten ändern nichts an dem, was nachfolgende Viewer herunterladen — der Snapshot ist statisch.

### GET /api/share/:slug

Die Antwort enthält `viewCount` (atomar per `$inc` inkrementiert) und die vollständige denormalisierte Payload. Verwende dies als Quelle der Wahrheit für den Import auf der Zielseite. Die Query filtert auf `_deletedAt: null`, sodass zurückgezogene Slugs 404 liefern.

### DELETE /api/share/:slug

Soft-löscht den Catalog durch Setzen von `_deletedAt` (statt `deleteOne`). Der Slug liefert ab sofort 404 vom öffentlichen GET. Die Zeile bleibt in der Collection, damit der Peer-Sync das Unpublish als Tombstone weitertragen kann — ein hartes Löschen würde dem anderen Peer erlauben, die noch aktive Kopie im nächsten Zyklus zurück zu pushen.

Der Slug-Index ist **partiell-unique auf `_deletedAt: null`** (automatisch migriert vom Legacy-plain-unique-Index durch `SharedCatalog.syncIndexes()` im dbConnect-Migrationsblock), sodass ein Slug, der von einer getombstoned Zeile genutzt wurde, durch eine zukünftige Neuveröffentlichung wiederverwendet werden kann, ohne ein E11000 auszulösen.

Liefert `200 { "message": "Unpublished" }` beim ersten Erfolg, `404` bei jedem folgenden Aufruf.

#### SharedCatalog-Schemaerweiterungen (v1.13)

Das Modell hat zwei Felder bekommen, um sync-sicheres Löschen zu unterstützen:

- `_deletedAt: Date | null` — Soft-Delete-Tombstone, Standard `null`. Wird von GET-Endpunkten herausgefiltert.
- `syncId: string | null` — unique-sparse stabile Cross-DB-Kennung, vom Sync-Engine automatisch zugewiesen.

---

## Spulennutzung und Trocknungszyklen (v1.11)

Per-Spulen-Ledger-Endpunkte. Werden von der Spulen-Detail-UI genutzt, um direkten Gewichtsverbrauch und Drybox-Zyklen zu loggen.

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `POST` | `/api/filaments/:id/spools/:spoolId/usage`       | Loggt verbrauchte Gramm auf dieser Spule. Reduziert `totalWeight` (geclampt bei 0) und hängt einen `usageHistory`-Eintrag mit `source: "manual"` an. |
| `POST` | `/api/filaments/:id/spools/:spoolId/dry-cycles`  | Loggt einen Trocknungszyklus. Alle Felder optional; `date` ist standardmäßig jetzt. |

### POST .../usage

```json
{ "grams": 120, "jobLabel": "optional", "date": "optional ISO string" }
```

`grams` muss > 0 sein. `jobLabel` max. 200 Zeichen.

### POST .../dry-cycles

```json
{ "date": "optional ISO", "tempC": 65, "durationMin": 240, "notes": "pre-print dry" }
```

Alle Felder optional. Nicht angegebene numerische Felder werden als `null` gespeichert.

---

## Bulk-Spulen-Import (CSV) (v1.11)

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `POST` | `/api/spools/import` | Bulk-Erstellung von Spulen aus CSV |

Akzeptiert entweder:
- `Content-Type: text/csv` mit dem rohen CSV-Body
- `Content-Type: application/json` mit `{ "csv": "…" }`

### Pflichtspalten

- `filament` — wird mit `Filament.name` gematcht; `vendor` disambiguiert Duplikate
- `totalWeight` — nicht-negative Gramm

### Optionale Spalten

- `vendor`, `label`, `lotNumber`, `purchaseDate` (ISO), `openedDate`, `location` (Name — automatisch angelegt, wenn nicht vorhanden)

Jede Zeile wird unabhängig verarbeitet; Per-Zeilen-Fehler werden in der Antwort gemeldet, ohne den Batch abzubrechen:

```json
{
  "imported": 12,
  "failed": 2,
  "results": [
    { "row": 2, "ok": true, "filament": "PLA Black" },
    { "row": 3, "ok": false, "error": "No filament named \"Unknown\"" }
  ]
}
```

Eine einzelne Anfrage ist von `parseCsv` auf 10.000 Zeilen gedeckelt; darüber wird die Anfrage mit 400 abgelehnt.

### GET /api/spools/export-csv

Pendant zu `GET /api/filaments/export-csv` für das Spulen-Inventar. Streamt jede aktive Spule aus jedem aktiven Filament als eine einzelne CSV mit einer Zeile pro Spule. Spalten umfassen `filament`, `vendor`, `label`, `totalWeight`, `lotNumber`, `purchaseDate`, `openedDate`, `location` und `retired`. Soft-gelöschte Filamente und ausschließlich ausgemusterte Spulen werden standardmäßig ausgeschlossen. Geeignet für Round-Trip über `POST /api/spools/import` bei der Migration zwischen Instanzen.

Response-Header: `Content-Type: text/csv` und `Content-Disposition: attachment; filename="spools-YYYY-MM-DD.csv"`.

---

## Spulen-Drucker-Slot-Zuweisung

Verfolgt, welchen AMS-/MMU-Slot eines Druckers eine Spule aktuell belegt. Dies ist **distinkt von** der Location der Spule (`locationId`): Die Location ist das semi-permanente Lager-„Zuhause" der Spule; der Slot ist ihre transiente Position, während sie in einem Drucker geladen ist. Eine Spule kann zu einem Zeitpunkt höchstens einen Slot belegen.

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/spools/:spoolId/assignment` | Ruft die aktuelle Drucker-Slot-Zuweisung der Spule ab |
| `PUT` | `/api/spools/:spoolId/assignment` | Weist die Spule einem Drucker-Slot zu |
| `DELETE` | `/api/spools/:spoolId/assignment` | Entfernt die Spule aus jedem Slot |

Diese Endpunkte schreiben nur in `Printer.amsSlots[].spoolId`; sie ändern niemals die `locationId` der Spule.

### GET /api/spools/:spoolId/assignment

Liefert `{ "assignment": … }`, wobei `assignment` `null` ist, wenn die Spule in keinem Slot ist, ansonsten der Drucker + Slot, der sie hält:

```json
{
  "assignment": {
    "printerId": "…",
    "printerName": "Bambu Labs H2D",
    "slotId": "…",
    "slotName": "AMS Slot 1",
    "filamentId": "…"
  }
}
```

### PUT /api/spools/:spoolId/assignment

Body: `{ "printerId": "…", "slotId": "…" }`. Weist die Spule diesem Slot zu und entfernt sie zuerst aus jedem anderen Slot, den sie belegt hatte — eine Spule ist ein physisches Objekt. Liefert das frische `{ "assignment": … }`.

- `400` — fehlerhafter Body, oder die Spule ist ausgemustert (ausgemusterte Spulen können nicht in einen Drucker geladen werden)
- `404` — die Spule, der Drucker oder der Slot existiert nicht

### DELETE /api/spools/:spoolId/assignment

Entfernt die Spule aus dem Slot, in dem sie sich befindet. Idempotent — liefert `{ "assignment": null }`, auch wenn die Spule bereits nicht zugewiesen war.

> **Hybrid-Sync-Einschränkung:** `Printer.amsSlots[].spoolId` wird beim Cross-Side-Sync-Remap geleert (Spulen-Subdokumente haben keine stabile Cross-Side-ID). Slot-Zuweisungen sind nur in Single-Database-Deployments (cloud-only oder offline-only) zuverlässig.

---

## Interne Hilfs-Endpunkte

Diese Endpunkte versorgen spezifische Seiten in der First-Party-UI. Die Formen sind auf diese Seiten zugeschnitten und können sich über Minor Releases hinweg ohne Vorankündigung ändern — externe Konsumenten sollten stattdessen die oben dokumentierten öffentlichen APIs verwenden.

### GET /api/dashboard (v1.11)

Aggregierte Zusammenfassung für die Dashboard-Seite — Zählungen, verbleibende Gramm gesamt, knappe Filamente, Spulen, die einen Trocknungszyklus benötigen, und die 10 neuesten Druckverlauf-Einträge — serverseitig in einem einzigen Round-Trip berechnet.

Liefert:
```json
{
  "counts": {
    "filaments": 48,
    "nozzles": 3,
    "printers": 2,
    "bedTypes": 4,
    "spools": 62,
    "retiredSpools": 5
  },
  "totalGrams": 38250,
  "lowStock": [
    { "_id": "…", "name": "PETG Black", "vendor": "…", "color": "#000", "remainingGrams": 120, "threshold": 500 }
  ],
  "dryDue": [
    { "filamentId": "…", "filamentName": "Nylon X", "spoolId": "…", "spoolLabel": "Spool #2", "lastDried": "2025-12-01T…" }
  ],
  "recentPrintHistory": [
    { "_id": "…", "jobLabel": "Benchy", "printerName": "MK4", "startedAt": "…", "source": "manual", "totalGrams": 12.4 }
  ]
}
```

`dryDue` ist auf 20 Einträge gedeckelt und enthält nur Spulen, bei denen das Filament eine `dryingTemperature` gesetzt hat UND in den letzten 30 Tagen keinen Trocknungszyklus hatte.

### GET /api/filaments/compare?ids=a,b,c (v1.11)

Holt mehrere Filamente für die Vergleichsansicht in einem Round-Trip. `ids` ist eine kommagetrennte Liste (Minimum 1, Maximum 8). Liefert Filamente in derselben Reihenfolge wie die `ids`-Liste, mit `compatibleNozzles` und `calibrations.{nozzle,printer,bedType}` populiert, damit die UI Namen direkt rendern kann.

`400`, wenn `ids` fehlt, leer ist oder über 8 liegt.

### GET /api/embed-check?url=…

Prüft, ob eine entfernte URL innerhalb eines `<iframe>` gerendert werden kann. Wird von der Filament-Detailseite genutzt, um anmutig auf „in neuem Tab öffnen" zurückzufallen, wenn die Quellseite `X-Frame-Options: DENY|SAMEORIGIN` oder eine restriktive `Content-Security-Policy: frame-ancestors` setzt.

Die URL läuft durch den geteilten SSRF-Guard (Loopback-/RFC1918-/Cloud-Metadata-IPs blockiert, nur http(s)). Redirects werden manuell verfolgt, wobei der gleiche Guard bei jedem Hop erneut angewendet wird, sodass ein öffentlicher Host, der per 30x in privaten Raum umleitet, abgelehnt wird. Gedeckelt auf 5 Redirects und einen 8-Sekunden-Timeout.

Antwortform:
```json
{ "embeddable": true, "contentType": "text/html; charset=utf-8" }
```
oder:
```json
{ "embeddable": false, "reason": "X-Frame-Options: deny", "contentType": "text/html" }
```

Netzwerkfehler kollabieren zu `{ embeddable: false, reason: <message> }` statt eines 5xx — die UI zeigt in beiden Fällen denselben Fallback.

### GET /api/openapi

Liefert das OpenAPI-3.0-Spec-Dokument, das von der In-App-Swagger-UI genutzt wird. Die Version wird dynamisch aus `package.json` injiziert, damit externe Konsumenten verifizieren können, dass die Spec zum laufenden Build passt.
