# Filament DB Mobile Scanner — Plan

> Status: **SHIPPED.** Phase 0 (server prep) + Phase 1 (MVP scanner) + Phase 2 create-from-tag are
> done, plus what were "Phase 3 niceties" — mDNS auto-discovery and the offline write queue — now ship.
> The remaining gap is **Bambu NFC** (Android MIFARE Classic read path). Owner decisions captured 2026-06-12.
> A lightweight "remote control" for Filament DB. Primary function: a **scanner**.

## 1. Goal & scope

A cross-platform iPhone + Android app that acts as a thin remote control for an existing
Filament DB instance over its REST API.

**v1 (must-have)**

- Scan an **NFC RFID tag** (OpenPrintTag and Bambu) or **photograph a QR / barcode**, and pull the
  matching filament/spool from Filament DB.
- Display the scanned spool and let the user **update inventory location** and/or **remaining
  filament weight**.
- If a freshly-scanned roll (OpenPrintTag or Bambu RFID) is **not yet in the DB**, let the user
  **create a new filament** from the decoded tag.

**Later (nice-to-have)**

- ✅ **Shipped:** mDNS/Bonjour server discovery (v1.47.0), offline write queue (`writeQueue.ts`).
- Still open: broader inventory management.

### Hard design rules (from the product brief)

1. **The app does no logic that already exists — or could exist — in the REST API.** No client-side
   calculations, no business rules. Anything missing is added to the *Filament DB source* as a REST
   endpoint, not reimplemented on the phone.
2. **As lightweight as possible.** The phone reads bytes and renders JSON; the server does the work.
3. **One language, maximum code sharing.** TypeScript on both ends (matches the Filament DB codebase).

## 2. The one constraint that shapes everything

> **iPhone physically cannot read Bambu Lab tags.**

Bambu tags are **MIFARE Classic** (ISO 14443-3A), which uses NXP's proprietary CRYPTO1 cipher and is
**not** an NFC Forum standard. Apple Core NFC has never supported MIFARE Classic (it supports
DESFire / Plus / Ultralight only) and there is no framework or library workaround — it is an OS
limit. OpenPrintTag tags are **ISO 15693 / NFC-V** and read fine on **both** platforms.

On **Android**, MIFARE Classic support is **chipset-dependent**: only NXP-based NFC controllers can
authenticate + read sectors. Many Broadcom/Qualcomm-based phones (various Samsung, some Pixel, older
Nexus/LG) expose only the tag UID and cannot read MIFARE Classic blocks.

**Decision:** Bambu NFC scanning is **Android-only**, with runtime detection of MIFARE Classic
support and graceful degradation. On iPhone (and on Android phones that can't read the sectors), a
Bambu spool is handled via its **QR label** or **manual entry** instead. OpenPrintTag NFC + QR are
the cross-platform core.

Sources (verified):
- https://developer.apple.com/documentation/corenfc/nfcmifaretag
- https://developer.apple.com/documentation/corenfc/nfciso15693tag
- https://gototags.com/articles/how-to-use-nfc-tags-with-an-iphone-ios ("compatible with all NFC tag types … excluding MIFARE Classic")
- https://www.nxp.com/products/rfid-nfc/nfc-hf/nfc-with-ios-13-:NFC_IOS_13
- https://github.com/ikarus23/MifareClassicTool/blob/master/COMPATIBLE_DEVICES.md (Android chipset list)

This is almost certainly why the earlier abandoned `packages/mobile/` Expo attempt stalled.

## 3. Architecture — thin client, server-side decode

The phone reads raw tag/QR bytes and talks to the API. Every read/write reuses an existing endpoint;
a few small server additions keep the app from having to do any decoding or math.

```
Phone (Expo / RN)                         Filament DB (Next.js REST API)
  NFC reader  ──raw bytes──▶  POST /api/nfc/decode  (NEW)  ──▶ decoded tag + DB match
  QR camera   ──text───────▶  GET  /api/filaments/match     ──▶ filament / candidates
  screens     ──reads───────▶ GET  /api/filaments/{id}      ──▶ detail + spools
              ──writes──────▶ PUT  /api/filaments/{id}/spools/{spoolId}
              ──picker──────▶ GET/POST /api/locations
```

### Why decode lives on the server (the linchpin)

The decoders already exist in this repo and split cleanly by portability:

| File | Portability | Note |
|---|---|---|
| `src/lib/openprinttag-decode.ts` | **pure TS, zero deps** | could run on-device |
| `src/lib/openprinttag.ts` | **pure TS** | CBOR encode + enums |
| `electron/ndef.ts` | **pure TS** | NDEF wrap/unwrap |
| `electron/bambu-tag.ts` | **node-native** | hard dep on Node `crypto` `hkdfSync` + `Buffer` — **cannot** run in RN without fragile polyfills |

Decoding both tag types on the server (rather than maintaining a client decode path + fighting RN
crypto polyfills) is the design that best satisfies design rule #1. The payoff is large:

> Because decode is server-side, the mobile app shares only TypeScript **types** with Filament DB —
> **no runtime code crosses the boundary**, which sidesteps the entire Metro / Buffer / crypto
> monorepo headache. The phone's whole job: read bytes → POST → render.

## 4. Server-side work (Phase 0, in this repo)

All of this lands in `filament-db` before the app needs it.

### 4.1 Relocate decoders into `src/lib/` so an API route can import them

`electron/` is excluded from the route tsconfig, so the route can't import `electron/bambu-tag.ts` /
`electron/ndef.ts` directly. Move the pure decode/parse functions into `src/lib/` (e.g.
`src/lib/bambuTag.ts`, `src/lib/ndef.ts`), keep `electron/` re-exporting them so the desktop app is
unchanged, and move the existing `tests/bambu-tag.test.ts` coverage with them.

### 4.2 `POST /api/nfc/decode` (NEW)

```
POST /api/nfc/decode
  body: { tagType: "openprinttag" | "bambu", payload: <hex|base64>, uid?: <hex> }
  →     { decoded: DecodedOpenPrintTag, match: Filament | null, candidates: Filament[] }
```

- `openprinttag`: run `decodeOpenPrintTagBinary` on the NDEF record payload (or `parseNdefFromTag`
  first if raw memory is sent).
- `bambu`: run `deriveBambuKeys` + `parseBambuBlocks` + `bambuToDecodedTag`.
- Attach a DB match by reusing the extracted `matchFilament()` helper (shared with
  `/api/filaments/match`) so the priority order can't drift between the two routes.
- **Not** behind `assertSameOriginRequest`, by design: the route performs no mutation (decode +
  read-only lookup) and must be reachable cross-origin like `/api/filaments/match`. Off-device
  access is gated by the optional `FILAMENTDB_API_KEY` (§4.5), not the CSRF guard.

**Bambu read nuance (decide when building the Android Bambu feature):** MIFARE Classic requires
authenticating each sector with the HKDF-derived key *before* reading blocks, so Bambu decode is not
a clean one-shot. Two options:
- **(a) Two round-trips, thin client (preferred):** phone reads UID → `POST /api/nfc/bambu-keys
  {uid}` → server returns the 16 derived keys → phone authenticates + reads blocks → `POST
  /api/nfc/decode {tagType:"bambu", blocks}`. All crypto stays server-side.
- **(b) On-device HKDF** via `react-native-quick-crypto` (Android build only) → one round-trip but
  reintroduces a crypto dependency.

OpenPrintTag has no such issue (unencrypted NDEF; the phone POSTs the CBOR payload directly).

### 4.3 Absolute remaining weight on the spool PUT (NEW field)

`PUT /api/filaments/{id}/spools/{spoolId}` today accepts `totalWeight` (gross = filament + tare).
A scanner user thinks in **remaining grams**; converting remaining → gross needs the spool tare
(`spoolWeight`) with variant inheritance — exactly the kind of calculation design rule #1 says to
keep on the server. Add an optional **`remainingWeight`** field to the PUT body; the server computes
`totalWeight = remainingWeight + effectiveSpoolWeight` using the same `$lookup` the inventory
aggregation already uses (`/api/spools/by-location`, `/api/locations?stats=true`).

The existing `POST /api/filaments/{id}/spools/{spoolId}/usage` (JSON body
`{ grams, jobLabel?, date? }`) already covers the "I used X grams" delta case
(with a ledger entry) — use it for relative decrements.

### 4.4 Create-from-decoded-tag (reuse existing mapper)

Today the desktop assembles the create body client-side (`FilamentForm.handleSubmit`). To avoid
replicating that in RN, have the create path accept the decoded tag and run the existing
`mapToFilamentPayload` (`src/lib/openprinttagBrowser.ts`) server-side — e.g. `POST /api/filaments`
accepting `{ tagData, overrides }`, or fold a "create" option into the `/api/nfc/decode` response
flow. The app shows prefilled fields, the user confirms, the **server** builds the document. Spool
subdocs / usage history are never touched on create.

### 4.5 Optional API-key auth (NEW — security)

**The API currently has zero authentication.** `assertSameOriginRequest` is a CSRF guard, not auth,
and a React Native `fetch` sends no `Origin` / `Sec-Fetch-Site` headers — so it passes straight
through like `curl`. Fine for single-user localhost; not fine for a phone over Wi-Fi, where anyone on
the LAN can also hit every endpoint including DELETE.

Add an **optional, env-gated API key**: `FILAMENTDB_API_KEY`, enforced by Next 16's Proxy
(`src/proxy.ts`, the renamed Middleware) over `/api/:path*`. When unset, behavior is unchanged so the
desktop app stays frictionless. When set, **every** `/api` request must present
`Authorization: Bearer <key>` — there is deliberately **no same-origin / `Sec-Fetch-Site` exemption**.
An earlier draft tried to let the first-party web UI through keyless by trusting those headers, but
they're only unforgeable *from a browser*; the gate's adversary is a non-browser client (the mobile
app, curl, an attacker tool) that can set any header, so a forged `Sec-Fetch-Site: none` or
`Origin: <host>` would have bypassed the key. Bearer-only is the only header scheme that actually
authenticates an off-device caller.

Consequence: the key is for **headless / exposed deployments** the mobile app (or curl / slicer
integrations / `/api/scan/stream` consumers) talk to — all of which must then send the key. It is
**not** meant for the desktop app serving its own browser renderer keyless; giving the browser UI a
keyless session needs a real login/cookie flow (out of scope here). The mobile app stores the key +
base URL in **`expo-secure-store`** (iOS Keychain / Android Keystore). Recommend HTTPS / trusted LAN
for any non-localhost use. ✅ **Shipped:** auth is `src/lib/apiAuth.ts` + `src/proxy.ts`; mDNS
auto-discovery moved out of "Phase 3 nicety" and now ships (see §8).

## 5. Scanner data flows

### 5.1 QR / barcode (no new server code)

The app's own printed labels (`src/lib/labelDeepLink.ts`) encode one of:
- **bare instanceId** (5-byte hex) → `GET /api/filaments/match?instanceId=…`
- **deep-link URL** `/filaments/{id}?spool={spoolId}` → the app parses path + query locally and
  fetches `GET /api/filaments/{id}`, then focuses that spool.

Use `expo-camera`'s built-in `CameraView` scanner (note: `expo-barcode-scanner` is **removed** as of
Expo SDK 52 — do not add it). Arbitrary vendor barcodes only resolve if decoded to name/vendor/type —
low priority, deferred.

### 5.2 OpenPrintTag NFC (both platforms)

Read via `Iso15693IOS` (iOS) / `NfcV` (Android) with `react-native-nfc-manager`, extract the NDEF
record payload (CBOR), `POST /api/nfc/decode` → render decoded + match, or offer "create".

### 5.3 Bambu NFC (Android only; degrade elsewhere)

Runtime-detect `MifareClassic` tech support. If present: read UID → derive keys (server round-trip,
§4.2a) → authenticate + read blocks → `POST /api/nfc/decode`. If absent (iOS, unsupported Android):
fall back to QR / manual entry with a clear message.

## 6. API surface — exists vs. new

| Mobile need | Endpoint | Status |
|---|---|---|
| Resolve scan (instanceId / name / vendor+type) | `GET /api/filaments/match` | exists |
| Filament detail + spools | `GET /api/filaments/{id}` | exists |
| Browse / search list (lightweight) | `GET /api/filaments?search=&type=&vendor=` | exists |
| Update spool location | `PUT /api/filaments/{id}/spools/{spoolId}` `{locationId}` | exists |
| Log filament used (delta + ledger) | `POST /api/filaments/{id}/spools/{spoolId}/usage` `{grams, jobLabel?, date?}` | exists |
| Location picker / create | `GET` + `POST /api/locations` | exists |
| Create from OpenPrintTag slug | `POST /api/openprinttag/import` | exists |
| Create from Bambu Studio preset | `POST /api/filaments/bambustudio` | exists |
| **Decode raw tag bytes → decoded + match** | `POST /api/nfc/decode` | **new (§4.2)** |
| **Derive Bambu sector keys from UID** | `POST /api/nfc/bambu-keys` | **new (§4.2a, when Bambu lands)** |
| **Set absolute remaining weight** | `PUT …/spools/{spoolId}` `{remainingWeight}` | **new field (§4.3)** |
| **Create from decoded tag** | `POST /api/filaments` `{tagData, overrides}` | **new variant (§4.4)** |
| **Optional API-key auth** | `src/proxy.ts` (Next 16 Proxy), `FILAMENTDB_API_KEY` | **new (§4.5)** |
| Single-spool GET (avoid full filament fetch) | `GET …/spools/{spoolId}` | **shipped** (v1.43; used by `api.getSpool` for `?spool=` deep links) |

## 7. Stack & repo layout

- **Expo + React Native + TypeScript**, **expo-router** (mirrors the App Router model), **EAS
  dev/prod builds** — *not* Expo Go (`react-native-nfc-manager` needs custom native code via its
  config plugin). Plan the EAS build pipeline from day one.
- **`react-native-nfc-manager`** (revtel) for NFC: `Iso15693IOS` / `NfcV` (OpenPrintTag, both),
  `MifareClassic` (Bambu, Android-only, runtime-detected).
- **`expo-camera` `CameraView`** for QR.
- **`expo-secure-store`** for base URL + API key.
- **Repo layout: standalone in-repo package (NOT an npm workspace).** Keep `filament-db` at the repo
  root unchanged (moving it into `apps/web` would disrupt the Electron release CI + version-bump
  process). The Expo app lives under **`packages/mobile`** as a **self-contained package** with its
  own `node_modules` + `package-lock.json` — the repo root deliberately has **no `workspaces`**
  field, so installing the mobile app never touches the web/Electron dependency tree (see
  `packages/mobile/README.md`). Types are restated client-side (DTOs in `packages/mobile/src/lib/types.ts`), ideally
  later generated from `public/openapi.json`. No decoder, no `Buffer`, no crypto crosses the boundary
  — and avoiding workspaces also sidesteps the classic Expo-monorepo Metro/symlink pain.
  - Keep the EAS build pipeline isolated from the Electron release CI (`release.yml` / `docker.yml`).
  - Note: `packages/mobile/node_modules` is already gitignored; stage explicit paths (never
    `git add -A`) given the 1.3 GB tree.

## 8. Phased roadmap

- ✅ **Phase 0 — server prep (this repo) — Shipped:** relocate decoders to `src/lib/`; `POST
  /api/nfc/decode`; `remainingWeight` on spool PUT; create-from-decoded-tag; env-gated API-key auth
  (`src/lib/apiAuth.ts` + `src/proxy.ts`); tests.
- ✅ **Phase 1 — MVP scanner (cross-platform) — Shipped:** connect/settings (base URL + key); QR scan
  → resolve → spool detail; OpenPrintTag NFC → decode → match; update location; update remaining
  weight / log usage. iOS + Android. (NFC gated behind `EXPO_PUBLIC_ENABLE_NFC`.)
- ✅ **Phase 2 — create new filament — Shipped:** decode → prefilled confirm → create
  (`packages/mobile/src/app/create-from-tag.tsx`), OpenPrintTag both platforms. **Bambu NFC (Android
  MIFARE Classic) is the remaining gap** — QR/manual is the fallback on iOS and unsupported Android.
- ✅ **mDNS discovery — Shipped (v1.47.0):** desktop advertises `_filamentdb._tcp` via
  `bonjour-service` (`electron/mdns-service.ts`) while "Share on local network" is on; the app finds
  it via `react-native-zeroconf` (`packages/mobile/src/lib/zeroconf.ts`). Pairs with the "Share on
  local network" desktop toggle (v1.45.0, electron-store key `exposeToLan`).
- ✅ **Offline write queue — Shipped:** `packages/mobile/src/lib/writeQueue.ts` — idempotent, survives
  app restart.
- **Phase 3 — remaining niceties:** broader inventory management. (The single-spool endpoint shipped — `GET /api/spools/{spoolId}`.)

## 9. Open items

- Pick Bambu read strategy §4.2 (a vs b) when Phase 2 Bambu work begins — (a) preferred.
- Decide types-sharing mechanism: hand-written shared package vs. generated from OpenAPI.
- Confirm minimum iOS target (DataScannerViewController path in `CameraView` needs iOS 16+).
- HTTPS posture for non-LAN use (self-signed cert trust flow vs. require trusted network).
