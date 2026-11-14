/**
 * Parsing and comparing Filament DB server addresses. Pure: no React Native
 * import, so the root test suite covers it (tests/mobile-server-address.test.ts).
 *
 * Parsed by hand rather than with `URL`: the answer decides whether a stored
 * API key may be sent somewhere, and it must be the same on Hermes, on the
 * web build and in the Node test run.
 */

/** A desktop sharing through its secure gateway (Settings → Network). */
export const ADDRESS_EXAMPLE = 'https://192.168.1.50:3457';
/** A desktop older than the secure gateway. */
export const LEGACY_ADDRESS_EXAMPLE = 'http://192.168.1.50:3456';

/** Where the secure gateway serves its certificate authority, relative to the
 *  address. Answered over plain HTTP on the HTTPS port, because a phone needs
 *  the certificate before it can trust the HTTPS address. */
export const CA_CERTIFICATE_PATH = '/__filamentdb/ca.crt';

export interface ServerAddress {
  scheme: 'http' | 'https';
  /** Lower-cased, without a trailing dot; an IPv6 literal keeps its brackets. */
  host: string;
  /** Always set: the scheme's default (80 / 443) when the address names none. */
  port: number;
  /** `scheme://host:port` with the port always spelled out. Two addresses
   *  reach the same server exactly when their origins are equal. */
  origin: string;
}

/** Trim, drop trailing slashes, and read a blank field as "not set". */
export function normalizeServerAddress(input: string | null | undefined): string | null {
  const url = (input ?? '').trim().replace(/\/+$/, '');
  return url === '' ? null : url;
}

const ADDRESS_RE = /^(https?):\/\/([^/?#]*)/i;
// A name or IPv4 literal: no characters that could start another URL part.
const PLAIN_HOST_RE = /^[^\s/?#@\\[\]:]+$/;
const IPV6_HOST_RE = /^\[[0-9a-f:.]+\]$/i;

/**
 * Read the scheme, host and port out of an address. Null when it is not an
 * `http://` or `https://` address with a host, and null for one that carries
 * credentials (`https://user@host`): the part before the `@` reads like the
 * server's name while the request goes to what follows it.
 */
export function parseServerAddress(input: string | null | undefined): ServerAddress | null {
  const url = normalizeServerAddress(input);
  if (!url) return null;
  const m = ADDRESS_RE.exec(url);
  if (!m) return null;
  const scheme = m[1].toLowerCase() as 'http' | 'https';
  const authority = m[2];

  let host: string;
  let portText: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    host = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    if (rest !== '' && !rest.startsWith(':')) return null;
    portText = rest.slice(1);
    if (rest === ':') return null;
    if (!IPV6_HOST_RE.test(host)) return null;
  } else {
    const colon = authority.indexOf(':');
    host = colon < 0 ? authority : authority.slice(0, colon);
    portText = colon < 0 ? '' : authority.slice(colon + 1);
    if (colon >= 0 && portText === '') return null;
    host = host.replace(/\.$/, '');
    if (!PLAIN_HOST_RE.test(host)) return null;
  }

  let port = scheme === 'https' ? 443 : 80;
  if (portText !== '') {
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65535) return null;
  }

  host = host.toLowerCase();
  return { scheme, host, port, origin: `${scheme}://${host}:${port}` };
}

/** What to tell the user about an address that cannot be saved. */
export const INVALID_ADDRESS_MESSAGE =
  `Enter a full https:// or http:// address, e.g. ${ADDRESS_EXAMPLE} ` +
  `(or ${LEGACY_ADDRESS_EXAMPLE} for a desktop older than the secure gateway).`;

/** True when both addresses parse and name the same scheme, host and port. */
export function sameServer(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const pa = parseServerAddress(a);
  const pb = parseServerAddress(b);
  return pa !== null && pb !== null && pa.origin === pb.origin;
}

/**
 * Where an `https://` address's certificate authority can be downloaded:
 * plain HTTP, same host and port. Null for an `http://` address (nothing to
 * trust) or one that does not parse.
 */
export function caCertificateUrl(address: string | null | undefined): string | null {
  const parsed = parseServerAddress(address);
  if (!parsed || parsed.scheme !== 'https') return null;
  return `http://${parsed.host}:${parsed.port}${CA_CERTIFICATE_PATH}`;
}

/** The same host and port under the other scheme, for "did you mean" hints. */
export function withScheme(
  address: string | null | undefined,
  scheme: 'http' | 'https',
): string | null {
  const parsed = parseServerAddress(address);
  if (!parsed) return null;
  return `${scheme}://${parsed.host}:${parsed.port}`;
}
