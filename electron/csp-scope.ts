/**
 * "Should this response receive the app CSP?" — in its own module
 * because `electron/main.ts` is excluded from tsconfig and not
 * importable from `tests/`.
 *
 * The `onHeadersReceived` handler runs for EVERY response in the
 * default session — including the vendor TDS document loaded inside
 * the `<iframe>` (`frame-src https:`, GH #250). The app CSP carries
 * `frame-ancestors 'none'`, so applying it to a vendor response tells
 * Chromium the document may not be embedded by ANY parent — breaking
 * every vendor TDS preview in desktop builds. Apply the app CSP only
 * when the response URL's origin matches the embedded Next server's;
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
