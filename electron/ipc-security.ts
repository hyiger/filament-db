import type { IpcMainInvokeEvent } from "electron";

/**
 * Shared IPC hardening helpers (GH #299, #300).
 *
 * Privileged ipcMain.handle handlers — save-config, reset-config,
 * test-connection, nfc-write-tag, nfc-format-tag, update-install — can
 * rewrite the Mongo connection string, erase NFC tags, or restart the
 * app. Without a sender check, any frame loaded in the renderer
 * (including a sub-frame such as an embedded TDS document, or an XSS
 * payload in a user-supplied filament field) could invoke them.
 */

/** The renderer is always served from the embedded Next.js server on
 * this port (see getAppURL in main.ts), in both dev and production. */
const PORT = parseInt(process.env.PORT || "3456", 10);
const APP_ORIGIN = `http://localhost:${PORT}`;

/**
 * Reject an IPC invocation that doesn't originate from the app's own
 * top-level frame at the expected origin. Throws — the thrown error
 * propagates back to the renderer as a rejected `invoke` promise.
 */
export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  channel: string,
): void {
  const frame = event.senderFrame;
  if (!frame) {
    throw new Error(`IPC "${channel}" rejected: no sender frame`);
  }
  // A sub-frame (embedded document, iframe) has a non-null parent.
  // Privileged handlers may only be reached from the top-level frame.
  if (frame.parent !== null) {
    throw new Error(`IPC "${channel}" rejected: sender is a sub-frame`);
  }
  let origin: string;
  try {
    origin = new URL(frame.url).origin;
  } catch {
    throw new Error(`IPC "${channel}" rejected: unparseable sender URL`);
  }
  if (origin !== APP_ORIGIN) {
    throw new Error(`IPC "${channel}" rejected: untrusted origin "${origin}"`);
  }
}

/**
 * MongoDB connection-string options that can reference a local
 * filesystem path. A renderer-supplied URI must not set these — they
 * would let a compromised page read arbitrary local files through the
 * TLS handshake (GH #300). Compared case-insensitively.
 */
const FILESYSTEM_URI_OPTIONS = [
  "tlscafile",
  "tlscertificatekeyfile",
  "tlscrlfile",
  "sslca",
  "sslcert",
  "sslkey",
];

/**
 * Validate a renderer-supplied MongoDB connection string. Returns null
 * when the URI is safe to use, or a human-readable rejection reason.
 *
 * Guards against:
 *  - non-mongodb schemes (an SSRF pivot, or file:/http: probes)
 *  - TLS options that point at local files (arbitrary file read)
 *
 * The scheme check is a regex rather than `new URL()` because a valid
 * multi-host mongodb URI (`mongodb://h1,h2,h3/db`) doesn't always
 * round-trip through the WHATWG URL parser.
 *
 * GH #1071: the filesystem-option check runs in TWO passes. The MongoDB
 * driver percent-decodes query-parameter NAMES (its ConnectionString is
 * backed by WHATWG URLSearchParams), so `?tlsCAFil%65=/etc/passwd`
 * reaches the driver as `tlsCAFile` while a raw substring match never
 * sees it — a full bypass of the GH #300 file-read guard. Pass 1 parses
 * the query string and compares each DECODED (and `+`-as-space, per
 * URLSearchParams) parameter name; pass 2 keeps the original raw
 * substring loop as belt-and-braces for anything the hand parse misses.
 */
export function validateMongoUri(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.trim() === "") {
    return "MongoDB URI must be a non-empty string";
  }
  const trimmed = uri.trim();
  if (!/^mongodb(\+srv)?:\/\//i.test(trimmed)) {
    return "MongoDB URI must start with mongodb:// or mongodb+srv://";
  }

  // Pass 1: decoded query-parameter names (GH #1071). The driver treats
  // the first `?` as the start of the options; anything after a `#` is
  // never a parameter name.
  const q = trimmed.indexOf("?");
  if (q !== -1) {
    for (const pair of trimmed.slice(q + 1).split("#")[0].split("&")) {
      if (!pair) continue;
      let name = pair.split("=")[0];
      try {
        // URLSearchParams decodes `+` as space before percent-decoding.
        name = decodeURIComponent(name.replace(/\+/g, " "));
      } catch {
        // Malformed percent-encoding — keep the raw name; the substring
        // pass below still sees the original bytes.
      }
      const canonical = name.trim().toLowerCase();
      if (FILESYSTEM_URI_OPTIONS.includes(canonical)) {
        return `MongoDB URI option "${canonical}" is not allowed — it can reference a local file`;
      }
    }
  }

  // Pass 2: raw substring match (the original GH #300 check).
  const lower = trimmed.toLowerCase();
  for (const opt of FILESYSTEM_URI_OPTIONS) {
    if (lower.includes(`${opt}=`)) {
      return `MongoDB URI option "${opt}" is not allowed — it can reference a local file`;
    }
  }
  return null;
}
