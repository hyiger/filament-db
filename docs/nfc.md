# NFC Tag Read/Write

[< Back to README](../README.md)

Filament DB supports reading and writing [OpenPrintTag](https://openprinttag.io/) NFC-V (ISO 15693) tags and reading Bambu Lab MIFARE Classic spool tags directly from the desktop app.

## Requirements

- **Reader**: ACS ACR1552U USB NFC reader/writer (or compatible PC/SC reader with ISO 15693 and ISO 14443 support)
- **OpenPrintTag tags**: NXP ICODE SLIX2 (or compatible NFC-V / ISO 15693 tags with at least 320 bytes user memory) — read/write
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

### Writing Tags

From any filament's detail page:

1. Place a tag on the reader (the NFC status indicator turns green)
2. Click **"Write NFC"** (purple button)
3. The app encodes the filament data as OpenPrintTag CBOR, wraps it in an NDEF message, and writes it block-by-block
4. The button shows progress and success/failure feedback

### Erasing / Formatting Tags

From the **Settings** page (Electron only):

1. Place a tag on the reader (the NFC status indicator turns green)
2. Click **"Erase Tag"** (red button)
3. Confirm the action in the inline confirmation prompt
4. The app writes a blank NFC Forum Type 5 header (CC bytes) to block 0, a terminator to block 1, and zeroes all remaining user memory blocks
5. A success or error message appears when complete

If you remove the tag before confirming, the confirmation prompt automatically dismisses.

### OpenPrintTag Binary Export

Click **"Export OPT"** on any filament's detail page to download the OpenPrintTag binary as a `.bin` file. This file can be written to a tag using external NFC writing software.

## NFC Status Indicator

The status pill appears in the header when running in the desktop app:

| Color | State |
|-------|-------|
| Gray | No NFC reader detected |
| Yellow | Reader connected, waiting for tag |
| Green | Tag detected on reader |

## Technical Details

### Communication Protocol

The app communicates with the ACR1552U via PC/SC using `@pokusew/pcsclite`:

- **Connection**: Tries `SCARD_SHARE_SHARED` first (Windows/Linux), falls back to `SCARD_SHARE_DIRECT` (macOS workaround for ISO 15693)
- **Tag detection**: Tries MIFARE Classic read first (Bambu); on failure, falls through to ISO 15693 (OpenPrintTag)
- **OpenPrintTag commands**: ACR1552U Pass Through (`FF FB`) wrapping ISO 15693 Read/Write Single Block commands
- **Bambu commands**: Standard PC/SC pseudo-APDUs for MIFARE Classic — Get UID (`FF CA`), Load Key (`FF 82`), Authenticate (`FF 86`), Read Binary (`FF B0`)
- **Fallback**: PCSC 2.0 Part 3 Transparent Exchange (`FF C2 00 01`) via `SCardControl` for DIRECT mode

### Data Format

**OpenPrintTag (NFC-V)**:
- **Tag memory layout**: CC (4B) + NDEF TLV + NDEF Record (TNF=0x02, type=`application/vnd.openprinttag`) + Terminator (0xFE)
- **Payload**: CBOR-encoded OpenPrintTag data (meta map + main map with material info, temperatures, color, density, instance ID, drying temperature/time, transmission distance, tags, etc.)
- **Write optimization**: Only blocks containing actual data are written (not zero-padded tail), avoiding the potentially write-protected last block on SLIX2 tags

**Bambu Lab (MIFARE Classic)**:
- **Tag**: MIFARE Classic 1K — 16 sectors × 4 blocks × 16 bytes, encrypted with per-sector keys
- **Key derivation**: HKDF-SHA256 with master key `9a759cf2c4f7caff222cb9769b41bc96`, UID as IKM, info `"RFID-A\0"` → 16 sector keys × 6 bytes
- **Data layout**: Sectors 0–4 contain filament data (material type, color RGBA, temperatures, weight, diameter, production date, tray UID); sectors 5–9 are empty; sectors 10–15 contain an RSA-2048 signature
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
│  └── NfcReadDialog (match/create flow)   │
│                                          │
│  Filament detail page                    │
│  └── Write NFC button                    │
└──────────────────────────────────────────┘
```

### OpenPrintTag Fields Written

The following fields are encoded into each NFC tag:

| Field | CBOR Key | Description |
|-------|----------|-------------|
| Material name | 8 | Filament name |
| Brand name | 9 | Vendor name |
| Material type | 10 | PLA, PETG, ABS, etc. (numeric enum) |
| Primary color | 11 | RGB color bytes |
| Density | 17 | g/cm³ (float16) |
| Filament diameter | 22 | mm (float16) |
| Temperatures | 12–16, 18 | Nozzle (min/max), bed (min/max), chamber, preheat |
| Weights | 19–21 | Net weight, actual weight, empty spool weight |
| Instance ID | 5 | Brand-specific instance identifier (5-byte hex string, max 16 chars) |
| Drying temperature | 57 | °C |
| Drying time | 58 | Minutes |
| Transmission distance | 27 | HueForge TD value |
| Shore hardness A | 31 | Flexible materials (TPU/TPE/PEBA) |
| Shore hardness D | 32 | Rigid materials |
| Tags | 28 | Flags array (42 supported tags: abrasive, soluble, matte, silk, carbon fiber, high speed, recycled, etc.) |
| Consumed weight | aux 0 | Tracked in auxiliary region (if set) |

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
- On macOS, `SCARD_SHARE_SHARED` can be intermittent for ISO 15693; the app falls back to DIRECT mode automatically

### Write fails on last block (SW 640F)

- Block 79 on SLIX2 tags is write-protected (configuration/password area)
- The app automatically skips zero-padded blocks at the end of tag memory
- If your payload is unusually large, it may reach the protected area
