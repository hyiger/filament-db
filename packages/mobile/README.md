# Filament DB Scanner (mobile)

A lightweight iOS/Android companion for [Filament DB](../..) — a "remote control"
that scans a spool's **QR label** or **NFC tag** and lets you update its
inventory location and remaining filament. It does no business logic of its
own: it forwards scans and edits to the Filament DB REST API and renders the
responses. See [`docs/mobile-app-plan.md`](../../docs/mobile-app-plan.md) for the
full plan.

Built with Expo (SDK 56) + expo-router + TypeScript.

## Phase 1 scope (this MVP)

- **Connect** to a Filament DB server (base URL + optional API key), stored in
  the device keychain (`expo-secure-store`).
- **Scan a QR code** (`expo-camera`) — a Filament DB label deep-link or a bare
  `instanceId` — and open the matched filament.
- **Scan an OpenPrintTag** NFC tag (`react-native-nfc-manager`) — the raw bytes
  are sent to `POST /api/nfc/decode`, which decodes + matches server-side.
- **Update a spool**: set remaining filament (grams) and move it between
  locations, via `PUT /api/filaments/{id}/spools/{spoolId}`.

Not yet (later phases): **Bambu NFC** (MIFARE Classic — Android-only; iPhone's
Core NFC can't read those tags), and creating a new filament from a scan.

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

## Project layout

```
src/app/             expo-router screens
  _layout.tsx        root Stack + ServerConfigProvider
  index.tsx          scan home (QR + NFC)
  settings.tsx       server connection (base URL + API key)
  scan-qr.tsx        camera QR scanner (modal)
  filament/[id].tsx  filament detail + spool location / remaining-weight updates
src/lib/
  types.ts           REST DTOs (can later be generated from public/openapi.json)
  api.ts             typed fetch client (bearer key aware)
  serverConfig.tsx   base URL + API key in expo-secure-store
  nfc.ts             OpenPrintTag NDEF read → base64 payload for /api/nfc/decode
  base64.ts          dependency-free byte helpers
```

## Checks

```bash
npx tsc --noEmit     # type check
npx expo lint        # lint
```

On-device behavior (NFC reads, camera, live API calls) must be verified on a
real device with a development build — it can't be exercised from CI or a
simulator.
