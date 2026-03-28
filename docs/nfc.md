# NFC Tag Read/Write

Filament DB supports reading and writing [OpenPrintTag](https://openprinttag.io/) NFC-V (ISO 15693) tags directly from the desktop app.

## Requirements

- **Reader**: ACS ACR1552U USB NFC reader/writer (or compatible PC/SC reader with ISO 15693 support)
- **Tags**: NXP ICODE SLIX2 (or compatible NFC-V / ISO 15693 tags with at least 320 bytes user memory)
- **Driver (macOS)**: [ifd-acsccid.bundle](https://www.acs.com.hk/en/drivers/) -- install via the ACS driver package
- **Desktop app**: NFC features are only available in the Electron desktop app, not the web version

## How It Works

### Auto-Read

When a tag is placed on the reader, the app automatically:

1. Reads all memory blocks from the tag via ISO 15693 Pass Through commands
2. Parses the NDEF message (type: `application/vnd.openprinttag`)
3. Decodes the CBOR payload into filament data
4. Searches the database for a matching filament

A dialog appears showing:

- **Match found**: The matched filament with a "View Filament" button to navigate to it
- **No match**: The decoded tag data with a "Create New Filament" button that pre-fills the form with all fields from the tag (name, vendor, type, color, temperatures, density, etc.)
- **Similar filaments**: If no exact match but the vendor or type matches, similar filaments are shown as clickable suggestions

### Writing Tags

From any filament's detail page:

1. Place a tag on the reader (the NFC status indicator turns green)
2. Click **"Write NFC"** (purple button)
3. The app encodes the filament data as OpenPrintTag CBOR, wraps it in an NDEF message, and writes it block-by-block
4. The button shows progress and success/failure feedback

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
- **Commands**: ACR1552U Pass Through (`FF FB`) wrapping ISO 15693 Read/Write Single Block commands
- **Fallback**: PCSC 2.0 Part 3 Transparent Exchange (`FF C2 00 01`) via `SCardControl` for DIRECT mode

### Data Format

- **Tag memory layout**: CC (4B) + NDEF TLV + NDEF Record (TNF=0x02, type=`application/vnd.openprinttag`) + Terminator (0xFE)
- **Payload**: CBOR-encoded OpenPrintTag data (meta map + main map with material info, temperatures, color, density, etc.)
- **Write optimization**: Only blocks containing actual data are written (not zero-padded tail), avoiding the potentially write-protected last block on SLIX2 tags

### Architecture

```
┌─ Electron Main Process ─────────────────┐
│  NfcService (electron/nfc-service.ts)    │
│  ├── PC/SC reader detection              │
│  ├── Tag presence monitoring             │
│  ├── Auto-read on tag placement          │
│  ├── Block-level read/write              │
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
