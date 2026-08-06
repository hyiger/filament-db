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
| `POST` | `/api/filaments/:id/promote` | Wandelt ein Filament, das bereits Varianten hat, in eine Vorlage um — verschiebt dessen eigene Farbe/Spulen auf eine neue Variante |
| `GET` | `/api/filaments/export` | Lädt alle Filamente als PrusaSlicer-INI-Datei herunter |
| `GET` | `/api/filaments/export-csv` | Lädt alle Filamente als CSV-Datei herunter |
| `GET` | `/api/filaments/export-xlsx` | Lädt alle Filamente als XLSX-Tabelle herunter |
| `POST` | `/api/filaments/import` | Lädt eine INI-Datei hoch, um Filamentprofile zu importieren |
| `POST` | `/api/filaments/import-csv` | Lädt eine CSV-Datei hoch, um Filamente zu importieren |
| `POST` | `/api/filaments/import-xlsx` | Lädt eine XLSX-Datei hoch, um Filamente zu importieren |
| `GET` | `/api/filaments/match` | Gleicht ein NFC-Tag oder einen gescannten Etiketten-QR mit vorhandenen Filamenten ab. Query-Parameter: `instanceId` (höchste Priorität), `name`, `vendor`, `type` |
| `GET` | `/api/filaments/types` | Listet alle eindeutigen Filamenttypen auf |
| `GET` | `/api/filaments/vendors` | Listet alle eindeutigen Herstellernamen auf |
| `GET` | `/api/filaments/colors` | Eindeutige `(colorName, color)`-Paare über alle nicht gelöschten Filamente (Datenquelle für die Farbnamen-Autovervollständigung) |
| `GET` | `/api/filaments/parents` | Listet Filamente auf, die als Elternfilament dienen können. Query-Parameter: `search`, `exclude` |
| `POST` | `/api/filaments/parse-ini` | Parst eine INI-Datei und liefert die Filamentprofile zurück, ohne sie zu speichern |
| `POST` | `/api/filaments/import-atlas` | Verbindet sich mit einer entfernten MongoDB-Atlas-Datenbank und importiert Filamente |
| `GET` | `/api/filaments/:id/openprinttag` | Lädt das OpenPrintTag-Binary für ein Filament herunter |
| `GET` | `/api/filaments/:id/openprinttag/check` | Vergleicht ein verknüpftes Filament mit dem aktuellen OpenPrintTag-Material |
| `POST` | `/api/filaments/:id/openprinttag/sync` | Wendet ausgewählte OpenPrintTag-Aktualisierungen auf ein verknüpftes Filament an |
| `GET` | `/api/filaments/:id/calibration` | Liefert Kalibrierungsdaten für ein Filament und einen Düsendurchmesser |
| `GET` | `/api/filaments/:id/spool-check` | Prüft, ob eine Spule genug Filament für einen Druckauftrag hat |
| `POST` | `/api/filaments/:id` | Synchronisiert ein Filament-Preset zurück aus PrusaSlicer |
| `GET` | `/api/filaments/:id/prusaslicer` | Lädt ein einzelnes Filament als PrusaSlicer-Preset (`.ini`) herunter |
| `GET` | `/api/filaments/:id/orcaslicer` | Lädt ein einzelnes Filament als OrcaSlicer-Preset (`.json`) herunter |

### Spulen

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `POST` | `/api/filaments/:id/spools` | Fügt einem Filament eine Spule hinzu |
| `PUT` | `/api/filaments/:id/spools/:spoolId` | Aktualisiert Gewicht oder Bezeichnung einer Spule |
| `DELETE` | `/api/filaments/:id/spools/:spoolId` | Entfernt eine Spule aus einem Filament |
| `GET` | `/api/spools/next-label` | Schlägt die nächste numerische Rollennummer für ein Spulen-Label vor (`{ next, max }`) |

`POST /api/filaments/:id/spools`, `PUT /api/filaments/:id/spools/:spoolId` und `DELETE /api/filaments/:id/spools/:spoolId` — plus `POST /api/filaments/:id/spools/:spoolId/usage` und `POST .../dry-cycles` — akzeptieren einen optionalen Query-Parameter `?shape=spool`, der die Antwort auf die betroffene Spule eindampft. Siehe Abschnitt **Antwortform bei Spulen-Mutationen** weiter unten.

### Filament-Vorlagen

Ein Filament mit mindestens einer nicht gelöschten Variante ist eine **Vorlage**: die Produktlinie, nicht eine Rolle. Die Vorlagen-Eigenschaft wird aus der Anzahl lebender Varianten *abgeleitet* und nie als Flag gespeichert — sie entsteht in dem Moment, in dem die erste Variante angelegt wird, und verschwindet wieder, sobald jede Variante im Papierkorb liegt. Eine Vorlage trägt die Spezifikation, die die gesamte Familie erbt (Temperaturen, Dichte, Trocknung, `spoolWeight`, `netFilamentWeight`, `secondaryColors`, `optTags`); die rollenspezifischen Felder — `color`, `colorName`, `totalWeight`, `lowStockThreshold` — und die Spulen selbst gehören auf die Varianten.

Drei Verträge setzen das über die gesamte API durch. Die Durchsetzung wirkt **nur nach vorn**: Ein Alt-Elternfilament, das bereits eine Farbe oder Spulen trägt, behält sie, bis es ausdrücklich umgewandelt wird (siehe `POST /api/filaments/:id/promote`).

#### `409 parent_promotion_required` — die erste Variante bestätigen

Das Anlegen der ERSTEN lebenden Variante eines Elternfilaments, das noch rollenspezifischen Zustand *trägt*, strukturiert ein **zweites** Dokument um: Das Elternfilament wird zur Vorlage, und dieser Zustand wandert auf eine neu angelegte Geschwistervariante. Als tragend gilt ein Elternfilament, wenn es eine nicht-leere gespeicherte `color` hat (einschließlich des historischen Standardwerts `#808080`), einen nicht-leeren `colorName`, mindestens eine Spule oder ein `totalWeight` ungleich null. Ab der zweiten Variante sperrt nichts mehr: Die Sperre greift ausschließlich bei der ERSTEN lebenden Variante, und die Durchsetzung wirkt nur nach vorn — ein Alt-Elternfilament mit zwei oder mehr Varianten kann durchaus noch tragen, und genau für diesen Zustand existiert `POST /api/filaments/:id/promote`.

Statt still umzustrukturieren, lehnen die vier interaktiven Routen, die eine erste Variante erzeugen können, mit `409` ab und beschreiben genau, was eine Bestätigung bewirken würde:

- `POST /api/filaments` — der Body trägt eine `parentId`
- `PUT /api/filaments/:id` — der Body führt eine `parentId` ein oder ändert sie
- `POST /api/filaments/:id/restore` — Wiederherstellen einer im Papierkorb liegenden Variante unter einem Elternfilament, das inzwischen wieder tragenden Zustand erworben hat
- `POST /api/openprinttag/import` im Variantenmodus (`parentId`)

Alle vier liefern denselben Body:

```json
{
  "error": "parent_promotion_required",
  "message": "Creating the first variant makes \"Prusament PETG\" a template: its color and 2 spool(s) move to a new variant named \"Prusament PETG — Prusa Galaxy Black\". Repeat the request with promoteParent: true to confirm.",
  "parentName": "Prusament PETG",
  "parentColor": "#292929",
  "spoolCount": 2,
  "variantName": "Prusament PETG — Prusa Galaxy Black"
}
```

Zum Bestätigen wiederhole die **identische** Anfrage mit `"promoteParent": true` im Body. Es ist ein Steuerflag, nie ein gespeichertes Feld — die Create- und Update-Routen entfernen es aus dem Body, bevor irgendetwas anderes ihn liest; `restore` nimmt historisch überhaupt keinen Body entgegen, ein fehlender oder nicht parsbarer Body bedeutet dort also schlicht `false`.

Die Sperre greift **zuletzt**, nach jeder anderen Validierung. Ein `409` heißt deshalb: „Diese Anfrage wäre sonst erfolgreich, hat aber eine Nebenwirkung auf ein zweites Dokument, der du ausdrücklich zustimmen musst" — und es wird überhaupt nichts geschrieben. Eine *bestätigte* Anfrage wird **vor** der Umwandlung im Trockenlauf validiert (Namenskollision, Schemavalidierung), sodass ein ungültiger Body weiterhin scheitert und das Elternfilament dabei völlig unangetastet bleibt.

Das Bestätigen verschiebt `color`, `colorName`, `spools` (Subdokument-`_id`s und die `instanceId` jeder Spule bleiben wörtlich erhalten), `totalWeight` und `lowStockThreshold` des Elternfilaments auf eine Variante mit dem Namen `"<Elternfilament> — <colorName>"` — oder `"<Elternfilament> — Original"`, wenn das Elternfilament keinen Farbnamen hat, wobei `" (2)"`, `" (3)"`, … eine Namenskollision auflösen — und leert anschließend genau diese fünf Felder auf dem Elternfilament. `spoolWeight` und `netFilamentWeight` werden bewusst **nicht** verschoben: Sie sind gemeinsame Spezifikation und bleiben auf der Vorlage, von der jede Variante sie erbt. Persistierte `(filamentId, spoolId)`-Referenzen folgen den Spulen — `PrintHistory.usage[].filamentId` und `Printer.amsSlots[].filamentId` werden auf die neue Variante umgebogen (einschließlich eines Druckerslots, der ohne konkrete Spule auf das Elternfilament festgelegt ist).

Ein weiterer Schreibpfad kann eine erste Variante erzeugen, und er liefert nie ein `409`:

- `POST /api/filaments/import-csv` / `import-xlsx` — ein Create mit aufgelöster `Parent`-Spalte oder das Wiederherstellen einer im Papierkorb liegenden Variante. Ein Bulk-Import kann keine Rückfrage beantworten, deshalb wird eine Zeile, deren Elternfilament noch **Bestand** hält (Spulen oder ein `totalWeight` ungleich null), mit einem `skippedRows`-Grund übersprungen, der auf `"Convert to template"` verweist, während der Rest des Batches weiterläuft. Die Farbe sperrt hier bewusst **nicht**: Das Schema setzt `color` standardmäßig auf `#808080`, also würde jedes Elternfilament, das derselbe Batch gerade erst angelegt hat, als tragend gelten und jeder Roundtrip aus Elternfilament plus Variante abgelehnt. Ein CSV-/XLSX-Import kann daher ohne Rückfrage die erste Variante eines farbtragenden Elternfilaments erzeugen — genau die nach vorn wirkende Altform, die `POST /api/filaments/:id/promote` umwandelt.

Der zweite Fall ohne Rückfrage — auf jeder dieser Routen — ist ein Elternfilament, das **nur eine Schwelle** trägt. `lowStockThreshold` gilt bewusst nicht als tragend: Eine Schwelle ohne Bestand dahinter verschiebt nichts, was eine Bestätigung wert wäre. Ein Elternfilament, das eine Schwelle speichert, aber weder `color` noch `colorName`, weder Spulen noch ein `totalWeight` hat, erzeugt seine erste Variante daher ohne `409`. Sobald diese Variante existiert, ist die Schwelle tote Konfiguration (der Bestandsalarm würde sonst gegen eine Vorlage ausgewertet) — sie wird deshalb *nach* dem Schreiben der Variante auf dem Elternfilament geleert, und dieses Leeren taucht in keinem Antwortfeld auf. Der Wert wird **nicht** auf die neue Variante kopiert: Wer den Alarm behalten will, muss `lowStockThreshold` selbst auf der Variante mitsenden. Weder ein *tragendes* Elternfilament noch eines, das bereits Varianten hat, ist betroffen — das erste verschiebt seine Schwelle zusammen mit dem Bestand während der oben beschriebenen Umwandlung, das zweite behält seinen Wert nach der nach vorn wirkenden Regel.

#### `400 template_no_spools` — eine Vorlage hält keine Spulen

Jede Route, die eine Spule anhängt, lehnt ab, wenn das Ziel eine Vorlage ist:

```json
{
  "error": "template_no_spools",
  "message": "This filament is a template (it has color variants) and cannot hold spools — add the spool to one of its variants instead."
}
```

- `POST /api/filaments/:id/spools` — liefert den obigen Body mit `400`
- `POST /api/prusament/import` — dasselbe `400` für die Aktion `add-spool` und für den „ein Filament mit diesem Namen existiert bereits"-Fallback der Aktion `create`
- `POST /api/spools/import` — pro Zeile: dieselbe `message` wird zum `error` dieser Zeile, der Rest des Batches läuft weiter

Spulen, die ein Alt-Elternfilament bereits trägt, bleiben liegen, werden weiterhin gezählt und bleiben bearbeitbar. Der CSV-Spulen-Import trennt entsprechend: Eine Zeile, die auf einer Vorlage eine Spule **anlegen** würde, scheitert, während eine Zeile, deren `spoolId` ein vorhandenes Subdokument trifft (also eine Aktualisierung), weiterhin angewendet wird.

#### `_strippedTemplateFields` — variantenspezifische Felder, die ein Schreibvorgang verwirft

Schreibpfade, die Felder per `$set` auf ein *bestehendes* Filament schreiben, **entfernen** `totalWeight`, `color`, `colorName` und `lowStockThreshold`, statt sie abzulehnen, wenn das Ziel eine Vorlage ist. Ein Slicer-Preset — genau wie ein veraltetes Bearbeitungsformular — schickt eine wegverschobene Farbe bei jedem Speichern wörtlich zurück, und ein 4xx würde die gesamte Synchronisation an einem Wert scheitern lassen, den der Nutzer nie erneut eingegeben hat. Ein ausdrückliches `null` geht unverändert durch, sodass sich ein Restwert auf einem Alt-Elternfilament weiterhin löschen lässt.

Das Entfernen wird gemeldet, nie stillschweigend ausgeführt. Diese Routen ergänzen ihre Erfolgsantwort um den Schlüssel `_strippedTemplateFields: string[]`, der die verworfenen Felder benennt (der Schlüssel entfällt, wenn nichts entfernt wurde):

- `PUT /api/filaments/:id`
- `POST /api/filaments/:id` (PrusaSlicer-Rücksynchronisation)
- `POST /api/filaments/:id/orcaslicer`
- `POST /api/filaments/:id/bambustudio`
- `POST /api/filaments/bambustudio`

Die Bulk-Importer (INI, CSV/XLSX, Atlas, OpenPrintTag) melden dasselbe stattdessen als Satz pro Zeile im `errors`-Array ihrer Antwort. Der INI-, der CSV-/XLSX- und der OpenPrintTag-Importer benennen die verworfenen Felder komma-verkettet — `"… skipped color, colorName — the local filament is a template (inventory and color live on its variants)"`. Der Atlas-Importer formuliert jedes verworfene Feld ausgeschrieben und verkettet sie mit `" and "` (`"… skipped 2 spool(s) and a color — the local filament is a template …"`), und er verwirft ein Feld, das die gemeinsame Strip-Liste nicht führt: ein eingehendes `spools`-Array.

Der Strip-Hinweis selbst ist nie fatal — der Rest der Zeile wird trotzdem angewendet. Ein reiner Hinweiskanal ist `errors` aber nur beim CSV-/XLSX-Importer (dessen harte Fehlschläge stattdessen in `skippedRows` landen) und bei Atlas (wo der Strip-Hinweis das Einzige ist, was je hineingeschrieben wird). Bei beiden INI-Importern und beim OpenPrintTag-Bulk-Import ist `errors` ein **gemischter** Kanal: Eine Zeile, die wirft, schiebt ihren Fehlschlag in dasselbe Array (ein Validierungsfehler bei jedem der drei, dazu bei OpenPrintTag die Herstellernamen-Kollision und übersprungene Lost-Write-Races). Ein Client, der diese Antworten liest, darf deshalb nicht jeden Eintrag als unkritisch behandeln — ein teilweise gescheiterter Import würde sonst als vollständig erfolgreich gemeldet.

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

Ist `parentId` gesetzt und wäre dies die **erste** lebende Variante dieses Elternfilaments, während das Elternfilament noch eine eigene Farbe oder eigene Spulen trägt, wird die Anfrage mit `409 parent_promotion_required` abgelehnt und nichts geschrieben; wiederhole sie mit `"promoteParent": true`, um zu bestätigen. Body-Form und Umfang der Verschiebung stehen im Abschnitt **Filament-Vorlagen** weiter oben.

### GET /api/filaments/:id

Liefert ein einzelnes Filament mit `compatibleNozzles`, `calibrations.nozzle` und `calibrations.printer` als vollständige Dokumente populiert. Enthält außerdem:

- `_variants` -- Array untergeordneter Varianten-Filamente (`_id`, `name`, `color`, `cost`)
- Auflösung geerbter Felder, wenn das Filament eine `parentId` hat -- Felder, die in der Variante nicht gesetzt sind, werden vom Elternfilament geerbt, und ein `_inherited`-Array listet auf, welche Felder geerbt wurden

### PUT /api/filaments/:id

Aktualisiert ein Filament. Sende einen JSON-Body mit den zu aktualisierenden Feldern. Unterstützt Teilaktualisierungen. Validiert Änderungen an `parentId` (verhindert zirkuläre Referenzen, verschachtelte Vererbung und Selbstreferenzen).

Ein Body, der eine `parentId` **einführt oder ändert**, kann die erste lebende Variante dieses Elternfilaments erzeugen und durchläuft deshalb dieselbe Bestätigungssperre wie der Create-Pfad: `409 parent_promotion_required`, bis die Anfrage mit `"promoteParent": true` wiederholt wird. Und wenn das aktualisierte Filament selbst eine Vorlage ist, werden Nicht-null-Schreibvorgänge auf `totalWeight` / `color` / `colorName` / `lowStockThreshold` verworfen und in einem `_strippedTemplateFields`-Array der Antwort benannt. Beides ist im Abschnitt **Filament-Vorlagen** weiter oben beschrieben.

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

Auch das Wiederherstellen einer **Variante** kann die erste lebende Variante ihres Elternfilaments erzeugen — das Elternfilament kann eine Farbe oder Spulen erhalten haben, während die Variante im Papierkorb lag. Deshalb durchläuft der Restore dieselbe Bestätigungssperre wie der Create-Pfad und lehnt mit `409 parent_promotion_required` ab. Genau dafür akzeptiert die Route einen optionalen JSON-Body: Wiederhole den POST mit `{ "promoteParent": true }`, um zu bestätigen. Ein POST ohne Body (der historische Vertrag) verhält sich in jedem nicht gesperrten Fall wie bisher. Siehe Abschnitt **Filament-Vorlagen** weiter oben.

### POST /api/filaments/:id/promote

„In Vorlage umwandeln" — die ausdrückliche, vom Nutzer angestoßene Variante derselben Umwandlung, die die Erste-Variante-Sperre ausführt. Same-Origin-geschützt; nimmt keinen Request-Body entgegen. Nutze sie für ein Filament, das **bereits** Varianten hat, aber weiterhin eine eigene Farbe, einen eigenen Farbnamen, eigene Spulen oder ein eigenes Inventar-`totalWeight` trägt (die Form aus der Zeit vor den Vorlagen; die Umwandlung läuft nie im Bulk hinter dem Rücken des Nutzers).

Die Umwandlung verschiebt genau das, was auch die Sperre verschiebt — siehe Abschnitt **Filament-Vorlagen** weiter oben — und liefert die angelegte Variante zusammen mit dem frisch geleerten Elternfilament:

```bash
curl -X POST http://localhost:3456/api/filaments/64a1b2c3d4e5f6a7b8c9d0e1/promote
```

```json
{
  "variant": { "_id": "…", "name": "Prusament PETG — Prusa Galaxy Black", "parentId": "64a1…", "…": "…" },
  "parent": { "_id": "64a1…", "color": null, "colorName": null, "spools": [], "totalWeight": null, "…": "…" },
  "resumed": false
}
```

`resumed` ist `true`, wenn dieser Aufruf die Teilkopie **übernommen** hat, die eine zuvor abgebrochene Umwandlung hinterlassen hatte (App beendet, Stromausfall), statt eine neue anzulegen — der Endzustand ist in beiden Fällen identisch, und ein erneuter Versuch ist immer gefahrlos.

Ablehnungsgründe:
- `400` — die `{id}` ist keine gültige ObjectId.
- `404` — kein aktives Filament mit dieser ID.
- `400 not_a_template` — das Ziel ist selbst eine Variante oder hat keine lebenden Varianten: *„Only a filament that already has color variants can be converted — a standalone becomes a template when its first variant is created."*
- `400 nothing_to_convert` — das Ziel ist eine Vorlage, trägt aber nichts, was auf eine Variante gehört: *„This template already carries nothing that belongs on a variant — no color, no color name, no spools, no inventory weight."* Beachte: `spoolWeight` / `netFilamentWeight` allein zählen nicht — sie sind gemeinsame Spezifikation und bleiben auf der Vorlage.

### GET /api/filaments/export

Lädt alle Filamente als PrusaSlicer-kompatible INI-Datei herunter. Verwendet denselben Generator wie `GET /api/filaments/prusaslicer` — strukturierte DB-Felder werden auf PrusaSlicer-INI-Schlüssel gemappt und mit dem Settings-Passthrough-Bag zusammengeführt; ein Filament mit Kalibrierungen für ≥ 2 unterschiedliche Düsen exportiert einen namenssuffigierten Abschnitt pro Düse (Details beim genannten Endpunkt).

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

### GET /api/filaments/:id/openprinttag/check

Vergleicht ein Filament, das aus der OpenPrintTag-Community-Datenbank importiert wurde, mit dem **aktuellen** Upstream-Material und liefert eine feldweise Änderungsliste. Nur lesend — es wird nichts verändert. Die Verknüpfung ist der `settings.openprinttag_slug`, der beim Import gestempelt wurde.

Antworten:
- `{ "linked": false }` — das Filament hat keinen OpenPrintTag-Slug.
- `{ "linked": true, "found": false, "slug": "…" }` — der Slug existiert nicht mehr in der OpenPrintTag-Datenbank (Upstream umbenannt/entfernt).
- `{ "linked": true, "found": true, "slug": "…", "materialName": "…", "changes": [...] }` — ein leeres `changes`-Array bedeutet, dass die Zeile bereits aktuell ist.

Jeder `changes[]`-Eintrag hat die Form `{ field, labelKey, current, incoming, kind }`. `kind` ist entweder `"adopt"` (das Feld war nicht gesetzt, hielt noch den grauen `#808080`-Platzhalter oder stimmte mit dem Wert überein, den OpenPrintTag zuletzt geschrieben hat — sicher zu übernehmen) oder `"conflict"` (der lokale Wert weicht von dem ab, was OpenPrintTag zuletzt geschrieben hat, d. h. du hast ihn bearbeitet — wird angezeigt, aber nicht automatisch angewendet). Nur die verwalteten Felder werden verglichen (Farbe, Sekundärfarben, Dichte, die von OPT mitgeführten Temperaturen, Trocknungstemperatur/-zeit, Shore D, Transmissionsdistanz, Tags); Identitätsfelder (Name/Hersteller/Typ) und der Durchmesser werden nie neu synchronisiert.

### POST /api/filaments/:id/openprinttag/sync

Wendet die vom Benutzer akzeptierte Teilmenge der OpenPrintTag-Aktualisierungen auf ein verknüpftes Filament an. Same-Origin-geschützt. Sende einen JSON-Body:

```json
{ "fields": ["density", "temperatures.nozzle"] }
```

Es werden nur Feldschlüssel aus dem verwalteten Satz akzeptiert — ein unbekannter Schlüssel liefert 400, statt stillschweigend verworfen zu werden. Der Provenance-Snapshot (`openprinttagSnapshot`) wird bei jeder Synchronisation auf das vollständige aktuelle OpenPrintTag-Angebot aktualisiert, unabhängig davon, welche Felder angewendet wurden, sodass eine spätere Prüfung für die abgelehnten Felder weiterhin "OpenPrintTag hat es geändert" von "du hast es geändert" unterscheiden kann.

Antworten:
- `{ "applied": ["density", "temperatures.nozzle"], "filament": { … } }` — die geschriebenen Felder + das frische Dokument.
- `400` — fehlerhafter Body, ein unbekanntes Feld, ein Feld, das OpenPrintTag derzeit nicht anbietet (Prüfung erneut ausführen), oder das Filament ist nicht mit OpenPrintTag verknüpft.
- `404` — der Slug existiert nicht mehr in der OpenPrintTag-Datenbank.

### POST /api/filaments/:id/openprinttag/link

Verknüpft ein **bestehendes** Filament mit einem OpenPrintTag-Material, damit es den `check`-/`sync`-Loop oben nutzen kann (v1.52, #753). Same-Origin-geschützt. Sende einen JSON-Body:

```json
{ "slug": "prusament-pla-galaxy-black" }
```

Schreibt **nur** die Verknüpfung (`settings.openprinttag_slug` / `_uuid`) und den Provenance-Snapshot (`openprinttagSnapshot`) — es wird nie ein Feldwert angefasst. Das Verknüpfen kann also keinen benutzergesetzten oder (bei einer Variante) geerbten Wert überschreiben: ein abweichendes Feld erscheint bei der nächsten Prüfung als `conflict`, nicht als automatisches Zurücksetzen.

Antworten:
- `{ "linked": true, "slug": "…", "filament": { … } }` — Verknüpfung hergestellt + das frische Dokument.
- `404` mit `{ "linked": false, "found": false, "slug": "…" }` — der Slug existiert nicht mehr in der OpenPrintTag-Datenbank.
- `400` — fehlender oder ungültiger `slug`.

### Antwortform bei Spulen-Mutationen

Die fünf Spulen-Mutations-Routen — `POST /api/filaments/:id/spools`, `PUT` und `DELETE /api/filaments/:id/spools/:spoolId`, `POST .../usage` und `POST .../dry-cycles` — antworten historisch mit dem **gesamten Filament-Dokument**: jedem `photoDataUrl`-Blob und dem vollständigen `usageHistory`-Ledger jeder Geschwisterspule, für einen Schreibvorgang, der einen einzelnen Skalar geändert hat. Seit v1.72 (#1027) akzeptieren sie einen optionalen Query-Parameter `shape`:

- **`?shape=spool`** — die Antwort ist `{ "spool": { … } }` und trägt nur die betroffene Spule, dafür vollständig (ihr eigenes Foto und ihr eigenes Ledger bleiben erhalten; weg fallen die übrigen N−1 Spulen). `DELETE` liefert stattdessen `{ "deleted": true, "spoolId": "…" }`, da das Dokument nach dem `$pull` die Spule nicht mehr enthält.
- **Kein `shape`-Parameter** — das vollständige Filament-Dokument, byteidentisch zur Antwort vor v1.72. Das ist der Standard mit Absicht: Ausgelieferte Clients (insbesondere die mobile App, die unabhängig vom Server aktualisiert wird) lesen `.spools` aus dem Body.
- **Jeder andere Wert** — `400 { "error": "Invalid shape parameter: expected \"spool\"" }`. Ein Tippfehler scheitert damit laut, statt stillschweigend genau die mehrere Megabyte große Standardantwort zu liefern, die der Aufrufer vermeiden wollte.

```bash
curl -X PUT 'http://localhost:3456/api/filaments/64a1…/spools/65b2…?shape=spool' \
  -H 'Content-Type: application/json' -d '{"totalWeight": 850}'
```

### POST /api/filaments/:id/spools

Fügt einem Filament eine neue Spule hinzu. Sende einen JSON-Body:

```json
{ "label": "Spool #2", "totalWeight": 1236 }
```

Der Body muss **mindestens ein** inhaltlich relevantes Spulenfeld enthalten — eines aus `label`, `totalWeight`, `lotNumber`, `purchaseDate`, `openedDate`, `locationId`, `photoDataUrl`, `retired` oder `instanceId`. Ein leerer Body wird mit `400` abgelehnt (die Phantomspulen-Sperre, GH #203), damit nicht versehentlich eine Platzhalter-Spule mit 0 g entsteht. Die einzelnen Felder sind ansonsten optional (`label` ist standardmäßig `""`, `totalWeight` standardmäßig `null`). Bei Erfolg liefert die Route `201` mit dem aktualisierten Filament-Dokument (die neue Spule liegt in dessen `spools`-Array) — oder `{ "spool": … }` unter `?shape=spool`.

Ablehnungsgründe:
- `400` — die oben genannte Phantomspulen-Sperre bei leerem Body, eine ungültige Filament-ID oder ein nicht erkanntes `shape`.
- `400 template_no_spools` — das Filament ist eine Vorlage (es hat Farbvarianten) und kann daher keine Spulen halten; füge die Spule einer seiner Varianten hinzu. Siehe Abschnitt **Filament-Vorlagen** weiter oben.
- `404` — kein aktives Filament mit dieser ID.
- `409` — eine explizit angegebene `instanceId`, die bereits von einer anderen Spule verwendet wird.

### PUT /api/filaments/:id/spools/:spoolId

Aktualisiert Gewicht oder Bezeichnung einer Spule. Sende einen JSON-Body mit beliebiger Kombination aus:

```json
{ "totalWeight": 850, "label": "Opened 2025-03-15" }
```

Liefert das aktualisierte Filament-Dokument — oder `{ "spool": … }` unter `?shape=spool`.

### DELETE /api/filaments/:id/spools/:spoolId

Entfernt eine Spule aus einem Filament. Liefert das aktualisierte Filament-Dokument — oder `{ "deleted": true, "spoolId": "…" }` unter `?shape=spool`.

### GET /api/spools/next-label

Liefert die nächste vorzuschlagende numerische Rollennummer für ein Spulen-Label — genau das, was der „Nächste Nr."-Button im Formular zum Hinzufügen einer Spule vorbelegt (v1.73, #1060):

```json
{ "next": 214, "max": 213 }
```

`max` ist das höchste Label in der gesamten Datenbank, das nach dem Trimmen ausschließlich aus Ziffern besteht (`"A12"`, `"1.5"` und `"12a"` werden ignoriert; führende Nullen werden entfernt, `"0042"` zählt also als 42), oder `null`, wenn sich kein Label als Zahl lesen lässt — dann ist `next` gleich `1`.

Die Abfrage filtert bewusst **nichts**: Filamente im Papierkorb, gepurgte Tombstones und ausgemusterte Spulen zählen alle mit. Rollennummern sind physisch und dauerhaft — eine Nummer, die auf einer ausgemusterten Spule steht, liegt weiterhin im Regal, und eine Nummer aus einem Filament im Papierkorb würde in dem Moment kollidieren, in dem dieses wiederhergestellt wird. Eine Nummer zu überspringen, die man für frei halten könnte, ist die sichere Richtung.

Reine Vorschlagssemantik: Es wird nichts reserviert oder zugewiesen, das Feld bleibt editierbar, und zwei gleichzeitige Leser können denselben Wert erhalten.

---

## PrusaSlicer Config Bundle

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/filaments/prusaslicer` | Exportiert Filamente als PrusaSlicer-kompatibles INI-Config-Bundle |
| `POST` | `/api/filaments/prusaslicer` | Importiert ein PrusaSlicer-INI-Config-Bundle |

### GET /api/filaments/prusaslicer

Exportiert alle Filamente als PrusaSlicer-kompatibles INI-Config-Bundle. Strukturierte DB-Felder (Temperaturen, Dichte, Kosten, max. volumetrische Geschwindigkeit, Schrumpfung) werden auf ihre PrusaSlicer-INI-Äquivalente gemappt und mit dem `settings`-Passthrough-Bag zusammengeführt. Wie ein Filament in Abschnitte zerlegt wird, hängt davon ab, für wie viele **unterschiedliche Düsen** es Kalibrierungen hat (#876):

- **0 oder 1 Düse** — ein einzelner `[filament:Name]`-Abschnitt ohne eingebackene Kalibrierung. Kalibrierungs-Overrides (extrusion multiplier, pressure advance, retraction, max volumetric speed) werden dynamisch von PrusaSlicer Filament Edition über `GET /api/filaments/:name/calibration` angewendet, wenn sich der Drucker-/Düsenkontext ändert.
- **≥ 2 unterschiedliche Düsen** — ein flacher, namenssuffigierter Abschnitt pro Düse (z. B. `[filament:PLA 0.4 Brass]`), jeweils mit den **filament-bezogenen** Kalibrierungswerten dieser Düse **eingebacken** — extrusion multiplier, retraction, max volumetric speed und Pro-Kalibrierung-Temperaturen; **pressure advance wird bewusst NICHT eingebacken** und bleibt dynamisch über `GET /api/filaments/:id/calibration` (PrusaSlicer kennt kein Eltern-/Kind-Modell für User-Filament-Presets). Alle Geschwister-Abschnitte teilen sich eine `filamentdb_id` und tragen je einen `filamentdb_nozzle`-Routing-Hinweis, damit die Rück-Synchronisation (`POST /api/filaments/:id`) Updates dem richtigen Per-Düsen-Kalibrierungseintrag zuordnet.

Jeder Abschnitt trägt den `filamentdb_id`-Routing-Schlüssel (die stabile `_id` des Filaments).

Jeder ausgegebene Abschnitt enthält außerdem standardmäßig `compatible_printers = ` und `compatible_printers_condition = ` (beide leer), was PrusaSlicer als „keine Einschränkung" interpretiert — das synchronisierte Filament erscheint im Dropdown jedes Druckers, und die Auto-Auswahl des Scan-Streams funktioniert unabhängig davon, welches Druckerprofil aktiv ist. Hat ein Nutzer über einen vorherigen Round-Trip-Import eine spezifische Einschränkung gesetzt (die Schlüssel kommen non-empty im Settings-Bag an), bleibt diese Einschränkung beim Export erhalten.

Query-Parameter:
- `type` -- Filter nach Filamenttyp (z. B. `PLA`, `PETG`)
- `vendor` -- Filter nach Herstellername
- `ids` -- kommagetrennte Liste von Filament-IDs

Liefert `text/plain`-INI-Inhalt.

### POST /api/filaments/prusaslicer

Importiert ein PrusaSlicer-INI-Config-Bundle. Sende den INI-Text als rohen Request-Body (z. B. `Content-Type: text/plain`).

Per-Düsen-suffigierte Abschnitte aus einem Filament-DB-Export (erkennbar am `filamentdb_nozzle`-Hinweis) werden beim Import **wieder in ihr Basis-Filament zusammengefaltet**, sodass ein Export-→-Import-Round-Trip den Originaldatensatz aktualisiert, statt suffigierte `"PLA 0.4 Brass"`-Duplikate anzulegen. Das Per-Düsen-Kalibrierungsmodell wird dabei NICHT aus dem flachen Bundle rekonstruiert — der verlustfreie Round-Trip ist der Snapshot-Export/-Restore (Einstellungen → Sicherung & Daten).

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
| `GET` | `/api/filaments/orcaslicer` | Exportiert alle Filamente als OrcaSlicer-kompatible JSON-Profile (Bundle) |
| `GET` | `/api/filaments/:id/orcaslicer` | Exportiert ein einzelnes Filament als OrcaSlicer-Preset (`.json`) |
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
- `decoded` trägt eine Teilmenge der Tag-Felder, die für Konsumenten nützlich sind; `tagSource` ist `"openprinttag"`, `"opentag3d"` oder `"bambu"`.

Response-Header:
- `content-type: text/event-stream; charset=utf-8`
- `cache-control: no-cache, no-transform`
- `x-accel-buffering: no` (verhindert Response-Buffering durch nginx-artige Proxies)

Der Stream sendet ein `retry: 5000`-Prelude (EventSource-Clients verbinden sich nach 5 s bei einem Abbruch erneut) und einen `: hb`-Heartbeat-Kommentar alle 25 Sekunden, damit Idle-Proxies die Verbindung nicht abbrechen. Konsumenten mit libcurl-artigen HTTP-Clients müssen ihre eigene Reconnect-Schleife implementieren.

Der Bus ist in-process (Node `EventEmitter` auf `globalThis`). „In-process" bedeutet hier **eine Filament-DB-Instanz, nicht eine physische Maschine** — Abonnenten können überall sitzen, wo sie per HTTP erreichbar sind (ein Pi, der Filament DB ausführt, kann PrusaSlicer auf einem Mac über das LAN ansteuern; der Slicer verbindet sich einfach mit `http://<filament-db-host>:3456/api/scan/stream`). Was auf eine einzelne Maschine festgenagelt ist, ist der Publisher: NFC-Lesungen kommen aus dem `NfcProvider` des Electron-Renderers, also muss der Reader an die Box angeschlossen sein, die die Electron-App ausführt — ein Headless-Docker-/Web-Only-Deploy hat keinen `NfcProvider` und veröffentlicht nichts. Ein horizontal skaliertes Multi-Prozess-Deployment bräuchte einen externen Broker hinter dem Bus.

Ein paar Netzwerk-Deploy-Hinweise, wenn du cross-machine gehst: Die API ist standardmäßig nicht authentifiziert (Single-User-Vertrauensmodell — siehe README-Warnung), also überlege bewusst, auf welchem Netzwerk Port 3456 freigegeben ist. Für freigegebene Deployments kannst du `FILAMENTDB_API_KEY` setzen; danach muss jede `/api`-Anfrage — einschließlich dieses SSE-Streams und der Slicer-Integrationen — den Header `Authorization: Bearer <key>` senden; bei nicht gesetztem Schlüssel ist es ein No-op. Das Electron-gebündelte Next.js bindet sich anhand der `HOSTNAME`-Umgebungsvariable; wenn cross-machine-Abonnenten sich nicht verbinden können, versuche `HOSTNAME=0.0.0.0`. Und weil `replay`-Events veraltete Scans über Slicer-Neustarts hinweg tragen, sollten Konsumenten nach `timestamp` filtern, falls ein mehrere Stunden altes Tag nicht erneut angewendet werden soll.

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

## NFC-Tag-Dekodierung

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `POST` | `/api/nfc/decode` | Dekodiert rohe NFC-Tag-Bytes serverseitig (OpenPrintTag, OpenTag3D oder Bambu) und gleicht das Ergebnis mit der DB ab. Ein roher Speicherauszug wird automatisch erkannt (die OpenTag3D-MIME-Kennung wird über die Codec-Registry ermittelt). Versorgt die mobile Scanner-App |

### POST /api/nfc/decode

Dekodiert rohe NFC-Tag-Bytes in ein `DecodedOpenPrintTag` und hängt in einem einzigen Roundtrip einen DB-Match an. Die mobile Scanner-App liest die Tag-Bytes auf dem Gerät, sendet sie per POST hierher und rendert das Ergebnis — die Dekodierlogik (OpenPrintTag-CBOR, Bambu MIFARE Classic mit seinem aus der UID abgeleiteten HKDF-Schlüssel) ist komplex und hängt bei Bambu von Node-`crypto` ab, das in React Native nicht läuft, deshalb liegt sie auf dem Server. Das hält zudem einen einzigen, getesteten Codepfad gemeinsam mit dem Desktop-Reader, statt eines abdriftenden Client-Dekoders.

Wie `GET /api/filaments/match` ist diese Route absichtlich **nicht** durch `assertSameOriginRequest` geschützt — sie führt keine Mutation aus (Dekodierung + reiner Lesezugriff) und ist dafür gedacht, von der Cross-Origin-Mobile-App erreicht zu werden. Wenn `FILAMENTDB_API_KEY` gesetzt ist, verlangt `src/proxy.ts` von jedem `/api`-Aufrufer (auch von dieser Route) ein `Authorization: Bearer <key>`; dieser Schlüssel — nicht eine Same-Origin-Prüfung — regelt den Zugriff von außerhalb des Geräts.

Sende einen JSON-Body. `tagType` wählt den Dekoder; die Byte-Felder sind base64-kodiert:

```json
{
  "tagType": "openprinttag",
  "payload": "…base64…",
  "tagMemory": "…base64…",
  "blocks": { "1": "…base64…", "2": "…base64…" }
}
```

- `tagType` (erforderlich) — `"openprinttag"`, `"opentag3d"` oder `"bambu"`.
- **OpenPrintTag (ISO 15693 / NFC-V)** — genau **eines** angeben:
  - `payload` — base64 der NDEF-Record-Payload (CBOR). Bevorzugt; iOS Core NFC liefert bereits geparste NDEF-Records zurück.
  - `tagMemory` — base64 des rohen Tag-Speichers; die Route ruft `parseNdefFromTag` auf, um die Payload zu extrahieren.
- **OpenTag3D (Type-2-NTAG / Type-5-SLIX2, feste binäre Speicherkarte)** — `payload` (vorab geparste Record-Bytes) oder `tagMemory` (Rohauszug) angeben. Ein roher `tagMemory`-Auszug wird unabhängig vom `tagType`-Hinweis **automatisch erkannt** (CC-Offset + Record-MIME über die austauschbare Codec-Registry), sodass der mobile Client keine Formaterkennung benötigt.
- **Bambu (MIFARE Classic / ISO 14443-3A)** — `blocks`: ein Objekt, das die absolute MIFARE-Blocknummer (`0`–`63`, als String-Schlüssel) auf die base64-Kodierung des jeweiligen 16-Byte-Klartextblocks abbildet. Mindestens ein lesbarer Block ist erforderlich, und der Auszug muss mindestens einen Identitätsblock (Varianten-/Material-ID oder Filamenttyp) enthalten — eine leere oder identitätslose Block-Map wird als nicht dekodierbare Lesung abgelehnt, statt als erfundenes Null-Tag zurückgegeben zu werden.

Das Matching spiegelt den NFC-Lese-Workflow: die dekodierte `spoolUid` wird zuerst als `instanceId` versucht (ein von Filament DB geschriebenes OpenPrintTag speichert die `instanceId` des Filaments im Feld `spool_uid`), dann fällt es auf `name` → `vendor`+`type` zurück, genau wie `GET /api/filaments/match`. Dekodierte Zeichenketten werden auf 128 Zeichen begrenzt, bevor sie in die Regex-Abfragen einfließen.

Gibt `200` zurück:

```json
{
  "decoded": {
    "materialName": "Prusament PLA Galaxy Black",
    "brandName": "Prusament",
    "materialType": "PLA",
    "color": "#000000",
    "spoolUid": "2acc21072a",
    "tagSource": "openprinttag"
  },
  "match": { "_id": "…", "name": "…", "vendor": "…", "type": "…", "color": "…" },
  "matchedSpool": { "_id": "…", "instanceId": "…", "label": "…" },
  "candidates": [],
  "matchedBy": "instanceId"
}
```

- `decoded` — das vollständige `DecodedOpenPrintTag`.
- `match` — die gematchte DB-Zeile oder `null`, wenn nichts passt.
- `matchedSpool` — die Spule, deren `instanceId` mit dem Tag übereinstimmte (#732), oder `null`, wenn der Treffer auf Filamentebene oder heuristisch war.
- `candidates` — plausible Alternativen (Hersteller+Typ, dann nur Hersteller), wenn es keinen sicheren Match gibt; sonst leer.
- `matchedBy` — `"instanceId"`, wenn die `spool_uid` des Tags eine **spulenspezifische** `spools[].instanceId` ODER die `instanceId` auf Filamentebene traf, `"heuristic"` bei einem Treffer aus den schwächeren Stufen (Name / Hersteller+Typ), oder `null`, wenn es keinen Match gibt.

Fehler:
- `400` — ungültiges JSON, Body ist kein Objekt, fehlende Byte-Felder für den gewählten `tagType` oder nicht dekodierbare / falsch formatierte Bytes (`"Could not decode tag"` mit dem zugrunde liegenden Grund).
- `413` — Request-Body größer als die Obergrenze von 64 KB (geprüft gegen den `Content-Length`-Header und die gepufferte Byte-Länge, sodass ein Chunked-Body nicht durchrutschen kann).
- `415` — `tagType` ist keines von `"openprinttag"`, `"opentag3d"` oder `"bambu"`.

---

## OpenPrintTag-Datenbank

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/openprinttag` | Durchsucht die OpenPrintTag-Community-Datenbank (nur FDM-Filamente) |
| `POST` | `/api/openprinttag` | Erzwingt eine Cache-Aktualisierung und holt erneut von GitHub (Same-Origin-geschützt) |
| `POST` | `/api/openprinttag/import` | Importiert ausgewählte Materialien in Filament DB |

### GET /api/openprinttag

Holt die [OpenPrintTag-Community-Datenbank](https://github.com/OpenPrintTag/openprinttag-database) von GitHub, parst alle Material-YAML-Dateien, filtert auf FFF-(FDM-)Filamente und gibt sie mit Vollständigkeits-Scores zurück. Ergebnisse werden 1 Stunde gecacht.

Um eine Aktualisierung zu erzwingen, sende ein POST an denselben Pfad — der alte `GET ?refresh=true`-Trigger wurde entfernt (ein Cache-leerender Seiteneffekt auf einem GET verletzt die REST-Semantik; GH #427).

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

Im **Variantenmodus** — ein optionales `parentId` im Body, das genau einen Slug als Variante eines bestehenden Filaments importiert (v1.52 / #753) — greift dieselbe Erste-Variante-Sperre wie bei `POST /api/filaments`: Wäre dies die erste lebende Variante des Elternfilaments, während dieses noch eine eigene Farbe oder eigene Spulen trägt, wird der Import mit `409 parent_promotion_required` abgelehnt, bis er mit `"promoteParent": true` neben `slugs` und `parentId` wiederholt wird. Siehe Abschnitt **Filament-Vorlagen** im Filaments-Kapitel.

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

Beide Aktionen lehnen mit `400 template_no_spools` ab, wenn das Ziel-Filament eine Vorlage ist — `add-spool` bei der ID einer Vorlage, und `create`, wenn der Name bereits zu einer Vorlage gehört und die Spule stattdessen dort angehängt würde. Siehe Abschnitt **Filament-Vorlagen** im Filaments-Kapitel.

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
| `DELETE` | `/api/bed-types/:id` | Soft-Delete eines Druckbett-Typs (blockiert, wenn von einer Filament-Kalibrierung referenziert, auf einem Drucker installiert oder in einer Filament-Pro-Druckbett-Typ-Temperaturtabelle genannt) |

### GET /api/bed-types

Liefert ein Array von Druckbett-Typ-Dokumenten, sortiert nach Name. Unterstützt optionale Query-Parameter:

- `material` -- Filter nach Material (z. B. `PEI`, `Glass`)

### POST /api/bed-types

Legt einen neuen Druckbett-Typ an. Pflichtfelder: `name`, `material`.

### PUT /api/bed-types/:id

Aktualisiert einen Druckbett-Typ. Sende einen JSON-Body mit den zu aktualisierenden Feldern.

### DELETE /api/bed-types/:id

Soft-Delete eines Druckbett-Typs per ID (setzt den Zeitstempel `_deletedAt`). Liefert `400`, wenn der Druckbett-Typ noch in Verwendung ist — durch `calibrations[].bedType` eines aktiven Filaments, durch `installedBedTypes` eines Druckers oder namentlich durch die Pro-Druckbett-Typ-Temperaturtabelle eines aktiven Filaments (`bedTypeTemps[].bedType`); die Fehlermeldung zeigt, was das Löschen blockiert. Bei Erfolg liefert er `{ message: "Deleted" }`.

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
    "dryingTime": 240,
    "glassTempTransition": 60,
    "heatDeflectionTemp": 52
  }
}
```

Extrahierte Felder umfassen: Name, Hersteller, Typ, Dichte, Durchmesser, Temperaturen (Düse, Druckbett, Bereiche), Trocknungstemperatur/-zeit, Glasübergang (Tg), Heat Deflection (HDT), Shore-Härte (A/D), volumetrische Geschwindigkeit, Druckgeschwindigkeits-Bereiche und Gewichte. Felder, die im TDS nicht gefunden werden, werden aus der Antwort weggelassen. **`dryingTime` ist in Minuten** (z. B. `240` = 4 Stunden, `480` = 8 Stunden) — die kanonische Einheit der App für dieses Feld.

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

Lädt einen JSON-Snapshot der Kern-App-Daten herunter: Filamente, Düsen, Drucker, Druckbett-Typen, Locations, Druckverlauf und Shared Catalogs (inklusive soft-gelöschter Dokumente und Tombstones). Der Snapshot bewahrt `_id`-Werte, Zeitstempel und Referenzen, damit er exakt wiederhergestellt werden kann.

Die Snapshot-Schema-Version ist `6`. Die Historie: v2 ergänzte die Druckbett-Typen, v3 Locations + Druckverlauf, v4 die Shared Catalogs (v1.14.0), v5 das Top-Level-Provenance-Flag `legacyNozzleCleanupComplete` und v6 `Location.desiccantChangedAt`. Ältere Snapshots lassen sich weiterhin wiederherstellen — Collections, die eine v1-/v2-/v3-Datei nicht mitführt, kommen als leer zurück. Die Sprünge auf v5 und v6 existieren gerade deshalb, damit ein **älterer** Build die Datei ablehnt (siehe die Restore-Sperre weiter unten), statt sie anzunehmen und stillschweigend das Feld zu verwerfen, das sein Schema nicht kennt.

Liefert eine JSON-Datei mit `Content-Disposition: attachment`-Header.

### POST /api/snapshot

Stellt die Datenbank aus einem zuvor exportierten Snapshot wieder her. Dies ist eine destruktive Operation: Alle vorhandenen Snapshot-bezogenen Daten werden durch die Snapshot-Inhalte ersetzt.

Upload per `multipart/form-data` mit einem `file`-Feld, das das Snapshot-JSON enthält, oder sende das JSON direkt als Request-Body.

Ein Snapshot, dessen `version` **neuer** ist als die des laufenden Builds, wird mit `400` abgelehnt — *vor* dem destruktiven Leeren: `"This snapshot is from a newer version (v7). Update Filament DB to at least the version that created it before restoring."` Ihn wiederherzustellen würde alles verwerfen, was diese Version ergänzt hat, und trotzdem Erfolg melden; der Handler scheitert daher lieber sofort.

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
  "desiccantChangedAt": "2026-07-14T00:00:00.000Z",  // optional; für Dryboxes relevant
  "notes": "Kept in the garage"
}
```

`desiccantChangedAt` hält fest, wann das Trockenmittel zuletzt gewechselt wurde. Das Feld ist optional und standardmäßig `null`; relevant ist es bei `kind: "drybox"`, wo es die Zeile „DESICCANT CHANGED" auf einem gedruckten Drybox-Etikett speist. POST und PUT akzeptieren einen ISO-Datums-String oder `null` — alles andere (auch ein ISO-förmiges, aber unmögliches Datum) wird mit `400 "desiccantChangedAt must be an ISO date string or null"` abgelehnt, weil Mongoose ein unmögliches Datum sonst überrollen statt ablehnen würde.

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
| `DELETE` | `/api/print-history/{id}` | Macht einen Druckauftrag rückgängig — erstattet das Spulengewicht, entfernt die passenden `usageHistory`-Einträge, soft-löscht die Zeile. Hänge `?permanent=true` an, um einen bereits soft-gelöschten Eintrag zu purgen |

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

#### Endgültiges Löschen: `DELETE /api/print-history/{id}?permanent=true`

Markiert einen bereits soft-gelöschten Eintrag als endgültig entfernt, indem der `_purged`-Sync-Tombstone gesetzt wird (GH #524.5) — analog zum Filament-Pfad für endgültiges Löschen. **Nur erlaubt, wenn der Eintrag bereits soft-gelöscht ist** — ein aktiver Eintrag liefert `404` (`"Not found, or not in trash (permanent delete requires the entry to be soft-deleted first)"`), sodass ein Purge niemals den Erstattungs- und Soft-Delete-Schritt überspringen kann. Hier wird nichts erstattet — das Spulengewicht wurde bereits beim Soft-Delete zurückgebucht. Idempotent: Ein zweiter Purge liefert `404`. Liefert `200 { "message": "Permanently deleted" }`.

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
| `DELETE` | `/api/share/:slug`      | Veröffentlichung zurückziehen (soft-löschen). Hänge `?permanent=true` an, um einen bereits zurückgezogenen Catalog zu purgen |

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

#### Endgültiges Löschen: `DELETE /api/share/:slug?permanent=true`

Markiert einen bereits zurückgezogenen Catalog als endgültig entfernt, indem der `_purged`-Sync-Tombstone gesetzt wird (GH #524.5) — analog zum Filament-Pfad für endgültiges Löschen. **Nur erlaubt, wenn der Catalog bereits zurückgezogen (soft-gelöscht) ist** — andernfalls `404` (`"Not found, or not unpublished (permanent delete requires the catalog to be unpublished first)"`). Idempotent: Ein zweiter Purge liefert `404`. Liefert `200 { "message": "Permanently deleted" }`.

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

Beide Routen liefern `201` mit dem aktualisierten Filament-Dokument, und beide akzeptieren `?shape=spool`, um stattdessen nur `{ "spool": … }` zurückzubekommen — siehe Abschnitt **Antwortform bei Spulen-Mutationen** im Filaments-Kapitel.

---

## Bulk-Spulen-Import (CSV) (v1.11)

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `POST` | `/api/spools/import` | Bulk-Erstellung von Spulen aus CSV |

Akzeptiert eines von:
- `Content-Type: text/csv` mit dem rohen CSV-Body
- `Content-Type: application/json` mit `{ "csv": "…" }`
- `Content-Type: multipart/form-data` mit der CSV als `file`-Feld

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

Eine Zeile, deren Ziel-Filament eine **Vorlage** ist (es hat Farbvarianten), scheitert mit `"This filament is a template (it has color variants) and cannot hold spools — add the spool to one of its variants instead."` — allerdings nur, wenn die Zeile eine Spule ANLEGEN würde. Eine Zeile, deren `spoolId` ein vorhandenes Subdokument trifft, ist eine Aktualisierung, und die eigenen Spulen einer Alt-Vorlage bleiben bearbeitbar. Siehe Abschnitt **Filament-Vorlagen** im Filaments-Kapitel.

Eine einzelne Anfrage ist von `parseCsv` auf 10.000 Zeilen gedeckelt; darüber wird die Anfrage mit 400 abgelehnt.

### GET /api/spools/export-csv

Pendant zu `GET /api/filaments/export-csv` für das Spulen-Inventar. Streamt jede aktive Spule aus jedem aktiven Filament als eine einzelne CSV mit einer Zeile pro Spule. Spalten umfassen `filament`, `vendor`, `label`, `totalWeight`, `lotNumber`, `purchaseDate`, `openedDate`, `location` und `retired`. Soft-gelöschte Filamente und ausschließlich ausgemusterte Spulen werden standardmäßig ausgeschlossen. Geeignet für Round-Trip über `POST /api/spools/import` bei der Migration zwischen Instanzen.

Response-Header: `Content-Type: text/csv` und `Content-Disposition: attachment; filename="spools.csv"`.

---

## Spulen-Drucker-Slot-Zuweisung

Verfolgt, welchen AMS-/MMU-Slot eines Druckers eine Spule aktuell belegt. Dies ist **distinkt von** der Location der Spule (`locationId`): Die Location ist das semi-permanente Lager-„Zuhause" der Spule; der Slot ist ihre transiente Position, während sie in einem Drucker geladen ist. Eine Spule kann zu einem Zeitpunkt höchstens einen Slot belegen.

| Methode | Endpunkt | Beschreibung |
|--------|----------|-------------|
| `GET` | `/api/spools/:spoolId/assignment` | Ruft die aktuelle Drucker-Slot-Zuweisung der Spule ab |
| `PUT` | `/api/spools/:spoolId/assignment` | Weist die Spule einem Drucker-Slot zu |
| `DELETE` | `/api/spools/:spoolId/assignment` | Entfernt die Spule aus jedem Slot |

Diese Endpunkte schreiben `Printer.amsSlots[].spoolId` **und** `.filamentId` — ein Slot führt zwei parallele Referenzen (das geladene Filament und die verfolgte Spule), und das Druckerformular rendert Slots anhand von `filamentId`. Eine spulenseitige Zuweisung, die nur `spoolId` setzte, war deshalb zwar in den Daten vorhanden, wurde auf der Druckerseite aber als leerer Slot angezeigt (#1041). Die `locationId` der Spule ändern sie niemals.

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

### GET /api/spools/by-location (v1.32)

Versorgt die **Inventar**-Seite (`/inventory`). Einmalige Aggregation über die `spools[]`-Subdokumente der Filament-Collection, gruppiert nach `spools[].locationId`. Ein Self-`$lookup` auf `parentId` legt das `spoolWeight` / `netFilamentWeight` des Eltern-Filaments offen, damit der Client den Verbleibend-Prozentwert einer Variantenzeile ohne zweiten Abruf berechnen kann.

Query-Parameter:

| Parameter | Beschreibung |
|-----------|-------------|
| `kind` | Auf eine einzelne Standort-Art filtern (`shelf`, `drybox`, `printer`, …). |
| `type` | Auf einen einzelnen Filament-Typ filtern (`PLA`, `PETG`, …). |
| `vendor` | Auf einen einzelnen Hersteller filtern (exakte Übereinstimmung). |
| `includeRetired` | `1`, um ausgemusterte Spulen einzubeziehen (Standard: ausgeschlossen — sie sind nicht im Inventar). |

Eine synthetische Gruppe mit `locationId: null` trägt jede Spule, deren `locationId` nicht gesetzt ist. Die Aggregation sortiert sie ans ENDE der Antwort, sodass die Seite sie als „erfordert Aufmerksamkeit"-Anhang statt als ersten Eimer darstellt.

Antwort-Form:

```json
{
  "groups": [
    {
      "locationId": "…",
      "location": { "_id": "…", "name": "Drybox A", "kind": "drybox", "humidity": 20, "notes": "" },
      "spools": [
        {
          "_id": "…",
          "label": "",
          "totalWeight": 850,
          "lotNumber": null,
          "purchaseDate": "2026-03-12T00:00:00.000Z",
          "openedDate": null,
          "retired": false,
          "photoDataUrl": null,
          "dryCycleCount": 2,
          "lastDryAt": "2026-05-10T14:22:00.000Z",
          "filamentId": "…",
          "filamentName": "Galaxy Black PLA",
          "filamentVendor": "Sunlu",
          "filamentType": "PLA",
          "filamentColor": "#000000",
          "spoolWeight": null,
          "netFilamentWeight": null,
          "parentSpoolWeight": 250,
          "parentNetFilamentWeight": 1000
        }
      ],
      "count": 1,
      "totalGrams": 850
    }
  ],
  "totalSpools": 1
}
```

`totalSpools` ist die Summe der `count`-Werte aller Gruppen, sodass der Seitenkopf eine einzige Zahl anzeigen kann, ohne sie clientseitig neu zu summieren.

Soft-gelöschte Filamente und ihre Spulen werden unabhängig von `includeRetired` aus der Aggregation ausgeschlossen.

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
