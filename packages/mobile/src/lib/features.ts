/**
 * Build-time feature flags exposed to the runtime via EXPO_PUBLIC_ env vars
 * (inlined into the JS bundle by Expo).
 *
 * NFC_ENABLED mirrors the EXPO_PUBLIC_ENABLE_NFC gate in app.config.ts: when a
 * QR-only build is produced (e.g. for a free Apple ID that can't get the Core
 * NFC entitlement), the NFC entry points in the UI are hidden so the build
 * looks intentional rather than broken. Default: enabled.
 */
export const NFC_ENABLED = process.env.EXPO_PUBLIC_ENABLE_NFC !== '0';
