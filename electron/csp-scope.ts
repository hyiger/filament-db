/**
 * Pure helper extracted so the "should this response receive the
 * app CSP?" decision can be unit-tested in isolation. Lives in its
 * own module because `electron/main.ts` is excluded from tsconfig
 * and not directly importable from `tests/`.
 *
 * Background (Codex P1 on PR #462): the `onHeadersReceived` handler
 * runs for EVERY response in the default session — including the
 * vendor TDS document loaded inside the `<iframe>` (the
 * `frame-src https:` flow added in GH #250). The app CSP carries
 * `frame-ancestors 'none'`, which on a vendor response tells
 * Chromium the document may not be embedded by ANY parent. Without
 * scoping the CSP write to app responses only, every vendor TDS
 * preview is broken in desktop builds.
 *
 * Pin the decision by origin match: if the response URL's origin
 * matches the embedded Next server's origin, apply the app CSP;
 * otherwise leave the response's own CSP untouched.
 */
export function shouldApplyAppCsp(
  responseUrl: string,
  appOrigin: string,
): boolean {
  try {
    return new URL(responseUrl).origin === appOrigin;
  } catch {
    // Malformed URL → don't touch the headers. Better to fall
    // through than to apply the app CSP to something we can't
    // reason about.
    return false;
  }
}
