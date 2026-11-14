import { ApiError, createApi, type ApiConfig } from './api';
import {
  classifyCaProbe,
  diagnoseConnectionFailure,
  type CaProbeResult,
  type ConnectionFailure,
  type ConnectionProblem,
  type DevicePlatform,
} from './connectionDiagnosis';
import { caCertificateUrl } from './serverAddress';

/**
 * The Server connection screen's "does this address work?" check. The
 * decisions live in connectionDiagnosis.ts; this file only makes the calls.
 */

const CA_PROBE_TIMEOUT_MS = 6000;
// A certificate is ~1 KB; anything this long is not one, so stop reading.
const CA_PROBE_MAX_CHARS = 16_384;

/**
 * Ask the address's port, over plain HTTP, for the secure gateway's CA
 * certificate. Only ever called after HTTPS produced no response.
 *
 * NEVER carries the API key: this request is unencrypted by design. It sends
 * no credentials of any kind and its answer is only compared, never trusted.
 */
export async function probeCaCertificate(baseUrl: string): Promise<CaProbeResult> {
  const url = caCertificateUrl(baseUrl);
  if (!url) return 'skipped';
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, CA_PROBE_TIMEOUT_MS);
  });
  try {
    const read = (async () => {
      // `redirect: 'manual'`: a redirect to https:// is itself the answer
      // (classifyCaProbe), and following it would repeat the failed handshake.
      const res = await fetch(url, {
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
      });
      const body = await res.text();
      return classifyCaProbe(res.status, body.slice(0, CA_PROBE_MAX_CHARS));
    })();
    // A rejection after the deadline won must not surface as unhandled.
    read.catch(() => undefined);
    return (await Promise.race([read, deadline])) ?? 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

export type ConnectionCheck = { ok: true } | { ok: false; problem: ConnectionProblem };

/**
 * Make one authenticated read against the address and, if it fails, work out
 * why. `GET /api/locations` is small, exists on every desktop version the app
 * supports, and passes through the same key check as everything else.
 *
 * The caller has already decided the key may go to this address
 * (serverKeyPolicy.planSave) — this function sends it.
 */
export async function checkConnection(
  cfg: ApiConfig,
  platform: DevicePlatform,
): Promise<ConnectionCheck> {
  const diagnose = (failure: ConnectionFailure, caProbe: CaProbeResult): ConnectionCheck => ({
    ok: false,
    problem: diagnoseConnectionFailure({
      baseUrl: cfg.baseUrl,
      hasKey: Boolean(cfg.apiKey),
      failure,
      caProbe,
      platform,
    }),
  });
  try {
    // A 2xx is not enough: the API client reads a body that is not JSON as
    // null, so a captive portal's or a proxy's HTML page would pass. The route
    // has returned a bare array in every version.
    const locations: unknown = await createApi(cfg).getLocations();
    if (!Array.isArray(locations)) {
      return diagnose(
        { status: 200, message: 'The reply was not a list of locations.', unexpectedReply: true },
        'skipped',
      );
    }
    return { ok: true };
  } catch (e) {
    const failure: ConnectionFailure =
      e instanceof ApiError
        ? {
            status: e.status,
            message: e.message,
            detail: e.detail,
            timedOut: e.timedOut,
            responseReceived: e.responseReceived,
          }
        : { status: 0, message: (e as Error).message, detail: (e as Error).message };
    // Ask the port what it is only when HTTPS produced no response at all. A
    // lost body means the handshake worked: there is nothing to ask.
    const caProbe =
      failure.status === 0 && !failure.responseReceived
        ? await probeCaCertificate(cfg.baseUrl)
        : 'skipped';
    return diagnose(failure, caProbe);
  }
}
