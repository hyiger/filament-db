/**
 * Synchronous scheme check for URLs that get rendered as `<a href>` /
 * `<iframe src>` / passed to `shell.openExternal`. Returns true only for
 * http and https URLs.
 *
 * This is an XSS / Electron-safety guard, not an SSRF guard. SSRF (DNS
 * resolution + private-IP block) lives in `externalUrlGuard.ts` and is
 * async + only relevant for server-side fetches. Here we just need to
 * stop `javascript:`, `file:`, `data:` and friends from reaching the
 * browser/Electron — those can either execute script in the page origin
 * or trick the OS shell into opening a local resource.
 */
export function isHttpUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Convenience: returns the URL if safe, otherwise null. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  return isHttpUrl(url) ? (url as string) : null;
}
