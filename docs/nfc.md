# NFC Tag Read/Write

[< Back to README](../README.md)

Filament DB is a neutral multi-standard NFC tag reader/writer. It reads and writes [OpenPrintTag](https://openprinttag.org/) NFC-V (ISO 15693) tags and [OpenTag3D](https://opentag3d.info/) NTAG (NFC-A / ISO 14443 Type 2) tags, and reads Bambu Lab MIFARE Classic spool tags, directly from the desktop app.

## Requirements

- **Reader**: ACS ACR1552U USB NFC reader/writer (or compatible PC/SC reader with ISO 15693 and ISO 14443 support)
- **OpenPrintTag tags**: NXP ICODE SLIX2 (or compatible NFC-V / ISO 15693 tags with at least 320 bytes user memory) — read/write
- **OpenTag3D tags**: NTAG213/215/216 (NFC-A / ISO 14443 Type 2) — read/write (auto-detected). NTAG215/216 hold the full image; NTAG213 fits core fields only
- **Bambu Lab spools**: MIFARE Classic 1K tags on Bambu Lab filament spools — read-only (auto-detected)
- **Desktop app**: NFC features are only available in the Electron desktop app, not the web version

### Driver Setup

**macOS**: Install `ifd-acsccid.bundle` from the [ACS driver package](https://www.acs.com.hk/en/drivers/). A restart may be required.

**Linux / Raspberry Pi**: Install the PC/SC daemon and development headers. The standard `ccid` driver included in the kernel handles the ACR1552U — no additional ACS driver is needed.

```bash
sudo apt install pcscd libpcsclite-dev
```

Verify the reader is detected:

```bash
pcsc_scan
```

**Windows**: No additional driver is needed — the built-in Microsoft CCID driver works out of the box.

## How It Works

### Auto-Read

When a tag is placed on the reader, the app automatically detects the tag type and reads it:

**OpenPrintTag (NFC-V / ISO 15693)**:
1. Reads all memory blocks via ISO 15693 Pass Through commands
2. Parses the NDEF message (type: `application/vnd.openprinttag`)
3. Decodes the CBOR payload into filament data

**Bambu Lab (MIFARE Classic / ISO 14443-3A)**:
1. Detects the tag as MIFARE Classic via Get UID command
2. Derives per-sector encryption keys from the tag UID using HKDF-SHA256
3. Authenticates and reads sectors 0–9 (filament data)
4. Parses the proprietary binary format (material type, color, temperatures, weight, production date)

In both cases, the app then searches the database for a matching filament. A dialog appears showing:

- **Match found**: The matched filament with a "View Filament" button to navigate to it
- **No match**: The decoded tag data with a "Create New Filament" button that pre-fills the form with all fields from the tag (name, vendor, type, color, temperatures, density, etc.)
- **Similar filaments**: If no exact match but the vendor or type matches, similar filaments are shown as clickable suggestions

For Bambu tags, a "Bambu Lab spool (read-only)" badge is shown since these tags cannot be written (they are RSA-2048 signed).

### Live scan stream (slicer integration)

Every successful auto-read is also pushed onto a Server-Sent Events stream at `GET /api/scan/stream`, so a subscribed slicer can switch its active filament preset to match each scan. The slicer doesn't have to live on the same machine as Filament DB — anything that can reach the server over HTTP works (LAN, Tailscale, reverse tunnel), so a headless Filament DB on a Raspberry Pi can drive PrusaSlicer on a Mac across the room. The renderer publishes via `POST /api/scan/publish` after the match step; consumers receive a `scan` event per read, plus an initial `replay` event carrying the most recent scan so a slicer opened just after a tag read still picks it up.

Event payload shape (same for `scan` and `replay`):

```json
{
  "timestamp": 1700000000000,
  "filament": { "_id": "…", "name": "Prusament PLA Galaxy Black", "vendor": "Prusament", "type": "PLA", "color": "#000000" },
  "candidates": [],
  "decoded": { "materialName": "…", "brandName": "…", "materialType": "PLA", "tagSource": "openprinttag" }
}
```

Consumers should switch presets on `filament.name` when non-null and ignore the event otherwise. Add `?replay=0` to suppress the on-connect replay. See [API Reference -- Scan Stream](api.md#scan-stream) for the full endpoint contract.

The bus is in-process: one `EventEmitter` shared by all subscribers of the same Filament DB instance. That's the only "single" — subscribers can be on different machines as long as they all connect to the same instance. The constraint that actually pins to a single machine is on the *publisher* side: scans are emitted from the Electron renderer's `NfcProvider`, so the NFC reader has to be plugged into whichever machine runs the Electron app. A headless Docker / web-only deploy has no `NfcProvider` and never publishes — the stream would just stay idle. A horizontally-scaled multi-process Filament DB deployment would need an external broker (Redis pub/sub or similar) behind the bus.

If you do go cross-machine, note that the API is unauthenticated by design (see the README warning) so be deliberate about what network you expose port 3456 on. The Electron-bundled Next.js binds based on the `HOSTNAME` env var; if cross-machine subscribers can't connect, try `HOSTNAME=0.0.0.0`.

### Writing Tags

From any filament's detail page:

1. Place a tag on the reader (the NFC status indicator turns green)
2. Click **"Write NFC"** (purple button)
3. The app **auto-detects the loaded chip** and encodes the right standard — an **OpenPrintTag** (SLIX2 / NFC-V) tag gets OpenPrintTag CBOR; an **OpenTag3D** (NTAG213/215/216) tag gets the OpenTag3D binary image — wraps it in an NDEF message, and writes it page/block-by-block
4. The button shows progress and success/failure feedback

> An NTAG215/216 holds the full OpenTag3D image; a smaller NTAG213 only fits the core fields (you'll get a notice that the spool ID and remaining weight were omitted). A combined filament type like `PA12-CF` is split into OpenTag3D's separate base (`PA12`) + modifier (`CF`) slots.

**Before overwriting, the app checks the tag** (v1.34.8 / #583):

- If the tag **already holds data**, you get a confirmation prompt naming what's on it before it's overwritten.
- A **Bambu Lab** tag (read-only) is refused with a friendly message rather than a raw write error.
- A tag you've marked **read-only** (see below) is refused — erase it or make it writable first.
- A genuinely **blank** tag is written straight through.

### Read-only (soft lock) *(v1.34.8 / #583)*

You can mark an OpenPrintTag **read-only** so the app won't accidentally overwrite a finished spool's tag. From **Settings → Devices** (the **NFC Tools** card), with a tag on the reader:

- **Set Read-Only** — locks the tag. "Write NFC" then refuses it.
- **Make Writable** — clears the lock.

This is a *reversible* soft lock (it flips the NFC-Forum CC write-access bits, not a permanent hardware lock), so **Erase** also clears it. Bambu tags always report as read-only (they're RSA-signed). The read dialog shows a lock badge for a read-only tag.

> **Read-only is OpenPrintTag (SLIX2) only.** It is **not** available for OpenTag3D/NTAG tags: an NTAG's capability container is one-time-programmable (a read-only bit can be set but never cleared), so a read-only flag could never be undone — the read-only buttons disable when an NTAG is loaded. (True NTAG read-only would need the chip's lock bytes, which are likewise permanent, so the app never writes them.)

### Erasing / Formatting Tags

From **Settings → Devices** (the **NFC Tools** card, Electron only):

1. Place a tag on the reader (the NFC status indicator turns green)
2. Click **"Erase Tag"** (red button)
3. Confirm the action in the inline confirmation prompt
4. The app writes a blank NFC Forum Type 5 header (CC bytes) to block 0, a terminator to block 1, and zeroes all remaining user memory blocks
5. A success or error message appears when complete

Erase works for both **OpenPrintTag** (SLIX2) and **OpenTag3D** (NTAG) tags — the app detects the chip and writes the matching blank capability container + empty NDEF message. If you remove the tag before confirming, the confirmation prompt automatically dismisses. Erasing a **Bambu Lab** tag is refused with a clear "read-only" message (these tags are RSA-signed and can't be erased).

### OpenPrintTag Binary Export

Click **"Export OPT"** on any filament's detail page to download the OpenPrintTag binary as a `.bin` file. This file can be written to a tag using external NFC writing software.

## NFC Status Indicator

The status pill appears in the header when running in the desktop app:

| Color | Label | State |
|-------|-------|-------|
| Gray | "No NFC reader" | No reader detected |
| Yellow | "Ready — place tag" | Reader connected, waiting for tag |
| Green | "Loaded: \<filament name\>" | Tag detected and decoded; name matched against the DB (or the tag's declared material name when no DB match exists) |
| Green | "Tag detected (\<uid\>)" | Tag detected but not yet decoded — brief transition window |
| Green | "Tag detected" | Tag detected, reader hasn't reported a UID yet |

The "Loaded" label persists after the tag-read dialog is dismissed (so you can still see which spool is on the reader after closing the popup) and updates immediately after a successful **Write NFC** — no need to lift and replace the tag. The label resets the moment the reader reports the tag has been lifted, so swapping tag A for tag B briefly shows the "Tag detected (\<uid\>)" intermediate state rather than the previous tag's name.

## Technical Details

### Communication Protocol

The app communicates with the ACR1552U via PC/SC using `@pokusew/pcsclite`:

- **Connection**: Always connects with `SCARD_SHARE_SHARED`. On macOS the built-in `ifd-ccid` driver and Apple's `ifd-acsccid` driver both register an instance of the ACR1552U, but only the ACS driver handles ISO 15693 — the app tries a SHARED connect on each registered reader instance and uses whichever succeeds (it also waits briefly on hot-plug for both driver instances to register).
- **Tag detection**: Tries MIFARE Classic read first (Bambu); then NTAG / NFC-Forum Type 2 (OpenTag3D) via `FF B0` READ BINARY; on failure, falls through to ISO 15693 (OpenPrintTag). Read AND write/erase auto-detect the chip the same way.
- **OpenPrintTag commands**: ACR1552U Pass Through (`FF FB`) wrapping ISO 15693 Read/Write Single Block commands
- **OpenTag3D commands**: NTAG Type-2 pseudo-APDUs — Read Binary (`FF B0`), Update Binary (`FF D6`, 4-byte pages), and `GET_VERSION` (`60h`) to size a blank tag. The NDEF record is TNF=0x02, type=`application/opentag3d`. Note the NTAG capability container (page 3) is one-time-programmable, which is why NTAG read-only isn't offered (see above).
- **Bambu commands**: Standard PC/SC pseudo-APDUs for MIFARE Classic — Get UID (`FF CA`), Load Key (`FF 82`), Authenticate (`FF 86`), Read Binary (`FF B0`)

### Data Format

**OpenPrintTag (NFC-V)**:
- **Tag memory layout**: CC (4B) + NDEF TLV + NDEF Record (TNF=0x02, type=`application/vnd.openprinttag`) + Terminator (0xFE)
- **Payload**: CBOR-encoded OpenPrintTag data (meta map + main map with material info, temperatures, color, density, instance ID, drying temperature/time, transmission distance, tags, etc.)
- **Write optimization**: Only blocks containing actual data are written (not zero-padded tail), avoiding the potentially write-protected last block on SLIX2 tags

**Bambu Lab (MIFARE Classic)**:
- **Tag**: MIFARE Classic 1K — 16 sectors × 4 blocks × 16 bytes, encrypted with per-sector keys
- **Key derivation**: HKDF-SHA256 with master key `9a759cf2c4f7caff222cb9769b41bc96`, UID as IKM, info `"RFID-A\0"` → 16 sector keys × 6 bytes
- **Data layout**: The app reads sectors 0–9 as data (filament fields — material type, color RGBA, temperatures, weight, diameter, production date, tray UID — live in sectors 0–4); sectors 10–15 hold an RSA-2048 signature and are skipped
- **Encoding**: All numbers are little-endian (uint16 LE, float32 LE); strings are null-padded ASCII
- **Read-only**: Tags are RSA-2048 signed — changing any byte invalidates the signature

### Architecture

```
┌─ Electron Main Process ─────────────────┐
│  NfcService (electron/nfc-service.ts)    │
│  ├── PC/SC reader detection              │
│  ├── Tag presence monitoring             │
│  ├── Auto-read on tag placement          │
│  ├── Tag type auto-detection             │
│  ├── OpenPrintTag: ISO 15693 read/write  │
│  ├── Bambu: MIFARE Classic read (HKDF)   │
│  └── NDEF wrap/parse, CBOR encode/decode │
│                                          │
│  IPC handlers: nfc-get-status,           │
│    nfc-read-tag, nfc-write-tag           │
│  Events: nfc-status-changed,             │
│    nfc-tag-detected                      │
└──────────────────────────────────────────┘
         │ IPC
┌─ Renderer ───────────────────────────────┐
│  NfcProvider (global context)            │
│  ├── Status tracking                     │
│  ├── Auto-read event handling            │
│  ├── Filament matching via API           │
│  ├── NfcReadDialog (match/create flow)   │
│  └── POST /api/scan/publish (fan-out)    │
│                                          │
│  Filament detail page                    │
│  └── Write NFC button                    │
└──────────────────────────────────────────┘
         │ HTTP
┌─ Scan Stream (Next.js server) ───────────┐
│  scanBus (Node EventEmitter on global)   │
│  ├── POST /api/scan/publish              │
│  └── GET  /api/scan/stream (SSE)         │
│         └── PrusaSlicer / OrcaSlicer     │
│             FilamentDB module subscribes │
│             and switches active preset   │
└──────────────────────────────────────────┘
```

### OpenPrintTag Fields Written

The following fields are encoded into each NFC tag:

CBOR keys below are the actual values from `OPT_KEY` in `src/lib/openprinttag.ts`.

| Field | CBOR Key | Description |
|-------|----------|-------------|
| Material type | 9 | Numeric enum (NOT a string) — the encoder maps names like PLA/PETG/ABS through `MATERIAL_TYPE_MAP` and writes the integer value |
| Material name | 10 | Filament name |
| Brand name | 11 | Vendor name |
| Nominal net full weight | 16 | Nominal net filament weight when full, grams |
| Actual net weight | 17 | Current **remaining** filament, grams (`max(0, totalWeight − spoolWeight)`); the read dialog shows it as "actual remaining" |
| Empty container weight | 18 | Empty spool weight, grams |
| Primary color | 19 | RGB color bytes (Filament DB emits 3 bytes from `#RRGGBB`; the spec also allows 4 = RGBA) |
| Secondary colors | 20–24 | `secondary_color_0..4` (multi-color filaments) |
| Transmission distance | 27 | HueForge TD value |
| Tags | 28 | Flags array (abrasive, soluble, matte, silk, sparkle, coextruded, gradual color change, etc.) |
| Density | 29 | g/cm³ |
| Filament diameter | 30 | mm |
| Shore hardness A | 31 | Flexible materials (TPU/TPE/PEBA) |
| Shore hardness D | 32 | Rigid materials |
| Print temperatures | 34–35 | Min / max print (nozzle) temperature |
| Preheat temperature | 36 | °C |
| Bed temperatures | 37–38 | Min / max bed temperature |
| Chamber temperature | 41 | °C |
| Drying temperature | 57 | °C |
| Drying time | 58 | Minutes |
| Instance ID | 5 | `brand_specific_instance_id` (main region) — 5-byte hex string, max 16 chars |
| Consumed weight | aux 0 | The one auxiliary-region key — tracked consumed weight (if set) |

Instance IDs are auto-generated for each filament (matching Prusament's 5-byte hex format, e.g. `2acc21072a`) and are written as the `brand_specific_instance_id` field per the OpenPrintTag specification.

### Bambu Lab Fields Read

The following fields are extracted from Bambu Lab spool tags:

| Field | Block | Description |
|-------|-------|-------------|
| Material Variant ID | 1 (bytes 0–7) | Bambu material code (e.g., "A50-K0") |
| Material ID | 1 (bytes 8–15) | Bambu material identifier (e.g., "GFA50") |
| Filament Type | 2 | Material type string (e.g., "PLA Basic") |
| Detailed Type | 4 | Detailed variant (e.g., "PLA Matte") |
| Color | 5 (bytes 0–3) | RGBA color bytes |
| Spool Weight | 5 (bytes 4–5) | Net weight in grams (uint16 LE) |
| Diameter | 5 (bytes 8–11) | Filament diameter in mm (float32 LE) |
| Drying Temp | 6 (bytes 0–1) | Drying temperature in °C |
| Drying Time | 6 (bytes 2–3) | Drying time in hours |
| Bed Temperature | 6 (bytes 6–7) | Bed temperature in °C |
| Max Hotend Temp | 6 (bytes 8–9) | Maximum nozzle temperature |
| Min Hotend Temp | 6 (bytes 10–11) | Minimum nozzle temperature |
| Tray UID | 9 | Spool instance identifier |
| Production Date | 12 | ASCII "YYYY_MM_DD_HH_MM" |
| Filament Length | 14 (bytes 4–5) | Length in meters |

These are mapped to the same data model as OpenPrintTag fields, so the matching, create, and import workflows work identically.

## Troubleshooting

### "No NFC reader" (gray indicator)

- Check the reader is plugged in via USB
- On macOS, ensure `ifd-acsccid.bundle` is installed (restart may be required)
- Check `pcsc_scan` output to verify the reader is detected by PC/SC

### Read/write fails intermittently

- Ensure the tag is centered on the reader and not moving
- SLIX2 tags have a small antenna -- position matters
- On macOS, two driver instances claim the ACR1552U but only Apple's `ifd-acsccid` handles ISO 15693; the app tries a SHARED connect on each reader instance and uses whichever works, so a transient failure on one instance is recovered automatically

### Write fails on last block (SW 640F)

- Block 79 on SLIX2 tags is write-protected (configuration/password area)
- The app automatically skips zero-padded blocks at the end of tag memory
- If your payload is unusually large, it may reach the protected area
