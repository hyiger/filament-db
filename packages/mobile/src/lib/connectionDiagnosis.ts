import { caCertificateUrl, parseServerAddress, withScheme } from './serverAddress';

/**
 * Turning a failed connection into something the user can act on. Pure
 * (tests/mobile-connection-diagnosis.test.ts); `connectionCheck.ts` does the
 * network calls and hands the results here.
 *
 * HOW A CERTIFICATE FAILURE IS RECOGNISED, and why not by its error text
 * alone. The app's `fetch` is Expo's native one (SDK 56 installs it as the
 * global). When the TLS handshake fails it rejects with:
 *
 * - Android: `fetch failed: ` + the Java exception's `toString()`, e.g.
 *   `javax.net.ssl.SSLHandshakeException: java.security.cert.
 *   CertPathValidatorException: Trust anchor for certification path not
 *   found.` Class names are not translated, so this is recognisable.
 * - iOS: `fetch failed: ` + `NSError.localizedDescription` and nothing else —
 *   no error domain, no code. That sentence is in the PHONE'S language ("The
 *   certificate for this server is invalid…" on an English device), so no
 *   pattern can be relied on.
 *
 * So the text is only a hint. The evidence is a second request: the secure
 * gateway answers plain HTTP on its HTTPS port for exactly one useful thing,
 * its certificate authority (`/__filamentdb/ca.crt`). If `https://host:port`
 * could not be reached but `http://host:port/__filamentdb/ca.crt` returns a
 * certificate, the host is up, the port is a Filament DB gateway using its
 * own CA, and the HTTPS failure is this device not trusting it. That holds on
 * both platforms and in every language.
 */

/** What the plain-HTTP request for the CA certificate found. */
export type CaProbeResult =
  /** A certificate: a secure gateway with its own, generated CA. */
  | 'certificate'
  /** The port wants HTTPS and has no CA to offer: a gateway that was given a
   *  certificate (FILAMENTDB_TLS_CERT), or some other TLS port. */
  | 'https-only'
  /** A plain-HTTP server answered: not a secure gateway (an older desktop). */
  | 'plain-http'
  /** Nothing answered. */
  | 'unreachable'
  /** Not attempted (the address is not https). */
  | 'skipped';

/**
 * Read the CA request's status and body. Never fed anything secret. The
 * request is made WITHOUT following redirects, because the redirect is the
 * answer: a gateway that has no CA of its own sends every plain-HTTP GET to
 * `https://` (308), and following that would only fail the same handshake
 * again and look like "nothing answered".
 */
export function classifyCaProbe(status: number, body: string): CaProbeResult {
  if (status >= 200 && status < 300 && body.includes('-----BEGIN CERTIFICATE-----')) {
    return 'certificate';
  }
  // A redirect (the gateway's 308) or a web server's 400 "plain HTTP request
  // was sent to HTTPS port": TLS is spoken here, there is just no CA to fetch.
  if ((status >= 300 && status < 400) || status === 400) return 'https-only';
  // Anything else answered the path as an ordinary HTTP server would.
  return 'plain-http';
}

// Android: OkHttp/Conscrypt exception class names and messages (not localised).
// A bare SSLHandshakeException is deliberately NOT here: it is also what a
// protocol or cipher mismatch throws, and the trust failures all name one of
// the certificate classes below as their cause.
// iOS: the English `localizedDescription`s for NSURLErrorServerCertificate*
// and NSURLErrorSecureConnectionFailed — a hint only, see the file comment.
const CERTIFICATE_ERROR_RE =
  /SSLPeerUnverifiedException|CertPathValidatorException|Certificate\w*Exception|Trust anchor for certification path|Chain validation failed|certificate for this server is invalid|certificate is not trusted|not verified:/i;
const HOSTNAME_MISMATCH_RE = /SSLPeerUnverifiedException|Hostname .* not verified/i;
// TLS was offered to a port that answered in plain text.
const NOT_TLS_RE =
  /WRONG_VERSION_NUMBER|Unable to parse TLS packet header|not an SSL\/TLS record|SSLProtocolException/i;

/** Does a low-level error text say the certificate was refused? */
export function looksLikeCertificateError(detail: string | null | undefined): boolean {
  if (!detail) return false;
  if (NOT_TLS_RE.test(detail)) return false;
  return CERTIFICATE_ERROR_RE.test(detail);
}

export type ConnectionProblemKind =
  /** The device does not trust the server's certificate. */
  | 'untrusted-certificate'
  /** An https:// address whose port answers plain HTTP (an older desktop). */
  | 'not-https'
  /** An http:// address on the secure gateway's port. */
  | 'https-required'
  | 'key-required'
  | 'key-rejected'
  | 'too-many-attempts'
  /** Something answered, but not like Filament DB's API. */
  | 'not-filament-db'
  /** Filament DB answered and reported a problem of its own. */
  | 'server-error'
  | 'timeout'
  | 'unreachable';

export interface ConnectionProblem {
  kind: ConnectionProblemKind;
  title: string;
  message: string;
  /** Numbered steps to fix it, when there are any. */
  steps: string[];
  /** The CA certificate download, when installing it is the fix. */
  caUrl: string | null;
  /** An address that is likely the right one, to offer as a one-tap change. */
  suggestedAddress: string | null;
}

export type DevicePlatform = 'ios' | 'android' | 'other';

export interface ConnectionFailure {
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  /** The message to show when nothing better is known (the server's, or the client's). */
  message: string;
  /** The low-level error text behind a status-0 failure. */
  detail?: string | null;
  timedOut?: boolean;
}

const FINGERPRINT_PLACE = 'Settings → Network on the Filament DB desktop';

function installSteps(platform: DevicePlatform, caUrl: string): string[] {
  if (platform === 'ios') {
    return [
      `Open ${caUrl} in Safari and allow the download.`,
      `In the Settings app, tap "Profile Downloaded" (or General → VPN & Device Management), ` +
        `open the profile's details and check that its SHA-256 fingerprint matches the one ` +
        `shown in ${FINGERPRINT_PLACE}. Then install it.`,
      'Turn it on under Settings → General → About → Certificate Trust Settings.',
      'Come back here and check the connection again.',
    ];
  }
  if (platform === 'android') {
    return [
      `Open ${caUrl} in your browser to download filament-db-ca.crt.`,
      'Install it: Settings → Security → Encryption & credentials → Install a certificate → ' +
        'CA certificate. (The path differs between phones; searching Settings for ' +
        '"CA certificate" finds it.)',
      `Under Trusted credentials → User, tap the new certificate and check that its SHA-256 ` +
        `fingerprint matches the one shown in ${FINGERPRINT_PLACE}. Remove it if it does not.`,
      'Come back here and check the connection again.',
    ];
  }
  return [
    `Download ${caUrl} and install it as a trusted certificate authority on this device.`,
    `Check that its SHA-256 fingerprint matches the one shown in ${FINGERPRINT_PLACE}.`,
    'Check the connection again.',
  ];
}

function problem(
  kind: ConnectionProblemKind,
  title: string,
  message: string,
  extra: Partial<Pick<ConnectionProblem, 'steps' | 'caUrl' | 'suggestedAddress'>> = {},
): ConnectionProblem {
  return { kind, title, message, steps: [], caUrl: null, suggestedAddress: null, ...extra };
}

/**
 * Explain a failed request to `baseUrl`.
 *
 * `caProbe` is the outcome of the plain-HTTP certificate request, made only
 * after an `https://` address produced no response at all.
 */
export function diagnoseConnectionFailure(input: {
  baseUrl: string;
  hasKey: boolean;
  failure: ConnectionFailure;
  caProbe: CaProbeResult;
  platform: DevicePlatform;
}): ConnectionProblem {
  const { baseUrl, hasKey, failure, caProbe, platform } = input;
  const address = parseServerAddress(baseUrl);
  const https = address?.scheme === 'https';
  const shown = address?.origin ?? baseUrl;

  if (failure.status === 0) {
    if (https) {
      const caUrl = caCertificateUrl(baseUrl);
      const mismatch = HOSTNAME_MISMATCH_RE.test(failure.detail ?? '');
      if (caProbe === 'certificate' && caUrl) {
        return problem(
          'untrusted-certificate',
          "This device doesn't trust the server's certificate",
          mismatch
            ? `Filament DB at ${shown} answered, but its certificate is not valid for this ` +
                `address. Use the address shown in ${FINGERPRINT_PLACE}; if that is this one, ` +
                `install its certificate authority as below. Nothing was sent.`
            : `Filament DB at ${shown} uses a certificate from its own certificate authority, ` +
                `which this device has not been told to trust yet. Nothing was sent, including ` +
                `the API key. Install the certificate authority once:`,
          { steps: installSteps(platform, caUrl), caUrl },
        );
      }
      if (caProbe === 'https-only') {
        return problem(
          'untrusted-certificate',
          "This device couldn't make a secure connection",
          `${shown} expects HTTPS, but this device does not accept its certificate` +
            (mismatch ? ' for this address' : '') +
            `. Nothing was sent. A Filament DB that was given its own certificate offers no ` +
            `certificate authority to download: that certificate may be self-signed, expired, ` +
            `or issued for a different name than the one in this address. Use the name it was ` +
            `issued for, or install the authority that issued it on this device. If this is ` +
            `not Filament DB's secure address at all, check the port.`,
        );
      }
      if (caProbe === 'plain-http') {
        const suggestedAddress = withScheme(baseUrl, 'http');
        return problem(
          'not-https',
          'This address does not use HTTPS',
          `${shown} answers, but in plain HTTP. A Filament DB desktop older than the secure ` +
            `gateway is reached at an http:// address` +
            (suggestedAddress ? ` (${suggestedAddress})` : '') +
            `; a current one shows its https:// address and port under Settings → Network.`,
          { suggestedAddress },
        );
      }
      if (looksLikeCertificateError(failure.detail)) {
        return problem(
          'untrusted-certificate',
          "This device doesn't trust the server's certificate",
          `${shown} answered, but this device does not accept its certificate` +
            (mismatch ? ' for this address' : '') +
            `. Nothing was sent. If this is a Filament DB that generated its own certificate, ` +
            `install its certificate authority once:`,
          caUrl ? { steps: installSteps(platform, caUrl), caUrl } : {},
        );
      }
    }
    if (failure.timedOut) {
      return problem(
        'timeout',
        "The server didn't respond",
        `Nothing answered at ${shown} in time. Check the address and port, that Filament DB is ` +
          `running with "Share on local network" on, and that this device is on the same network.`,
      );
    }
    return problem(
      'unreachable',
      "Can't reach the server",
      `Nothing answered at ${shown}. Check the address and port, that Filament DB is running ` +
        `with "Share on local network" on, and that this device is on the same network.` +
        (failure.detail ? ` (${failure.detail})` : ''),
    );
  }

  if (failure.status === 400 && /only accepts HTTPS/i.test(failure.message)) {
    const suggestedAddress = withScheme(baseUrl, 'https');
    return problem(
      'https-required',
      'This address needs https://',
      `${shown} is a Filament DB secure gateway: it only accepts HTTPS.` +
        (suggestedAddress ? ` Use ${suggestedAddress} instead.` : ''),
      { suggestedAddress },
    );
  }
  if (failure.status === 401) {
    return hasKey
      ? problem(
          'key-rejected',
          'The server refused the API key',
          `Check the key against the one shown under Settings → Network on the Filament DB ` +
            `desktop. A key that was rolled there stops working everywhere else.`,
        )
      : problem(
          'key-required',
          'This server needs an API key',
          `Enter the key shown under Settings → Network on the Filament DB desktop.`,
        );
  }
  if (failure.status === 429) {
    return problem('too-many-attempts', 'Too many attempts with a wrong key', failure.message);
  }
  if (failure.status === 404) {
    return problem(
      'not-filament-db',
      "This doesn't look like Filament DB",
      `${shown} answered, but not the way Filament DB does. Check the address and port.`,
    );
  }
  return problem(
    'server-error',
    'The server reported a problem',
    `${shown} answered: ${failure.message}`,
  );
}

/**
 * The one-line message for a failed request made outside the Server
 * connection screen, where there is no room for steps and no second request
 * is made. Certificate trouble that the error text does not reveal (iOS in a
 * language other than English) still gets pointed at the screen that checks.
 */
export function unreachableMessage(input: {
  baseUrl: string;
  detail: string | null;
  timedOut: boolean;
}): string {
  const https = parseServerAddress(input.baseUrl)?.scheme === 'https';
  if (input.timedOut) {
    return `The server didn't respond. Check the address and that this device is on the same network.`;
  }
  if (https && looksLikeCertificateError(input.detail)) {
    return `This device doesn't trust the server's certificate. Open Server connection and tap Save to see how to fix it.`;
  }
  const hint = https
    ? ` If the server uses its own certificate, open Server connection and tap Save to check that this device trusts it.`
    : '';
  return `Can't reach the server. Check the address and that this device is on the same network.${hint}${input.detail ? ` (${input.detail})` : ''}`;
}
