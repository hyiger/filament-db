# Filament DB Scanner (mobile)

A lightweight iOS/Android companion for [Filament DB](../..) — a "remote control"
that scans a spool's **QR label** or **NFC tag** and lets you update its
inventory location and remaining filament. It keeps the business logic on the
server: it forwards scans and edits to the Filament DB REST API and renders the
responses, holding only a little client-side state (a few input defaults plus an
idempotent offline write queue). See
[`docs/mobile-app-plan.md`](../../docs/mobile-app-plan.md) for the full plan.

Built with Expo (SDK 56) + expo-router + TypeScript.

## Phase 1 scope (this MVP)

- **Connect** to a Filament DB server (base URL + optional API key), stored in
  the device keychain (`expo-secure-store`).
- **Scan a QR code** (`expo-camera`) — a Filament DB label deep-link or a bare
  `instanceId` — and open the matched filament.
- **Scan an OpenPrintTag** NFC tag (`react-native-nfc-manager`) — the raw bytes
  are sent to `POST /api/nfc/decode`, which decodes + matches server-side.
- **Create a filament from a scan**: when a decoded tag doesn't match anything in
  the DB, confirm a name/vendor/type and `POST /api/filaments` to create it (the
  server maps the tag's fields — the phone does no mapping). See
  `src/app/create-from-tag.tsx`.
- **Update a spool**: set remaining filament (grams), move it between locations,
  and retire / un-retire it, via `PUT /api/filaments/{id}/spools/{spoolId}`. Log
  filament usage (`POST …/spools/{spoolId}/usage`) and dry-box cycles
  (`POST …/spools/{spoolId}/dry-cycles`).
- **Spool deep links**: a label QR's `?spool=<id>` opens straight to that spool
  via `GET /api/spools/{spoolId}` without knowing the parent filament up front.
- **Offline support**: spool edits made while the server is unreachable are
  queued and replayed FIFO once it's back (see "Offline support" below).

Not yet (later phases): **Bambu NFC** (MIFARE Classic — Android-only; iPhone's
Core NFC can't read those tags).

## Requirements

> **This app cannot run in Expo Go.** `react-native-nfc-manager` needs custom
> native code (config plugin), so you must use a **development build** (EAS or a
> local prebuild). NFC also requires a physical device — simulators have no NFC.

- Node 20+, and the Expo tooling (`npx expo`).
- For builds: an [Expo / EAS](https://docs.expo.dev/build/introduction/) account,
  or local native toolchains (Xcode / Android Studio) for `expo run:*`.

## Setup

```bash
cd packages/mobile
npm install
```

This package is self-contained (its own `node_modules`); it is **not** an npm
workspace of the root project, so installing it never touches the web/Electron
app's dependency tree.

## Run (development build)

Local native build onto a connected device/simulator:

```bash
npx expo run:ios       # or: npx expo run:android
```

Or build a dev client with EAS and start the bundler:

```bash
npx eas build --profile development --platform ios   # one-time, per platform
npx expo start --dev-client
```

### Free Apple ID? Build QR-only (no NFC)

iOS NFC needs the Core NFC "Tag Reading" entitlement, which a **free Apple ID
can't provision** — a normal build will fail to sign. Set
`EXPO_PUBLIC_ENABLE_NFC=0` to build a **QR-only** version: it omits the NFC
config plugin/entitlement (so free-account signing works) and hides the
"Scan NFC tag" button. Camera/QR scanning + spool updates work fully.

```bash
EXPO_PUBLIC_ENABLE_NFC=0 npx expo run:ios --device
```

When your paid Apple Developer account is active, just drop the flag and rebuild
to turn NFC back on. The flag is read in both `app.config.ts` (build-time plugin
gate) and `src/lib/features.ts` (runtime UI gate). Free provisioning certs also
expire after ~7 days, so re-run the build weekly.

Then in the app: open **Server connection**, enter your Filament DB address
(e.g. `http://192.168.1.50:3456`) and, if the server sets `FILAMENTDB_API_KEY`,
the API key. Scan away.

### Find your server automatically (mDNS)

Instead of typing an IP, tap **Find on your network → Scan** on the Server
connection screen. The phone discovers desktop instances advertising
`_filamentdb._tcp` over mDNS/Bonjour and fills in the address for you. This
requires the desktop app to have **"Share on local network"** turned on
(Settings → Connection) and both devices on the same Wi-Fi. (Discovery uses a
native module, so it works only in a development/standalone build, not Expo Go.)

### Offline support

Spool edits (move location, set remaining weight, retire / un-retire) made while
the server is unreachable are saved to an on-device queue (`src/lib/writeQueue.ts`)
and replayed FIFO once the server is reachable again — a scan-and-update on a
flaky shop network isn't lost. The queue persists across app restarts
(AsyncStorage) and is safe to replay because only idempotent absolute-SET edits
are queued. Usage / dry-cycle logging decrements/appends, so those require live
connectivity and are never queued.

## Project layout

```
src/app/               expo-router screens
  _layout.tsx          root Stack + ServerConfigProvider
  index.tsx            scan home (QR + NFC)
  settings.tsx         server connection (base URL + API key + LAN discovery)
  scan-qr.tsx          camera QR scanner (modal)
  create-from-tag.tsx  confirm + create a filament from an unmatched scan
  filament/[id].tsx    filament detail + spool updates (location, weight, retire, usage, dry cycle)
src/lib/
  types.ts             REST DTOs (can later be generated from public/openapi.json)
  api.ts               typed fetch client (bearer key aware)
  serverConfig.tsx     base URL + API key in expo-secure-store
  nfc.ts               OpenPrintTag NDEF read → base64 payload for /api/nfc/decode
  base64.ts            dependency-free byte helpers
  features.ts          build-time feature flags (EXPO_PUBLIC_ENABLE_NFC gate)
  pendingScan.ts       scan → create-from-tag hand-off (module ref, not URL params)
  theme.ts             system light/dark color set (useColors)
  writeQueue.ts        offline write queue — idempotent, survives restart
  zeroconf.ts          mDNS / Bonjour discovery of desktop instances on the LAN
```

## Checks

```bash
npx tsc --noEmit     # type check
npx expo lint        # lint
```

On-device behavior (NFC reads, camera, live API calls) must be verified on a
real device with a development build — it can't be exercised from CI or a
simulator.
