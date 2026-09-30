import type {
  DecodedOpenPrintTag,
  Filament,
  Location,
  MatchResult,
  NfcDecodeResponse,
  Spool,
  SpoolMutationResponse,
} from './types';

/**
 * Thin typed client over the Filament DB REST API. The app does no business
 * logic — it forwards scans/edits and renders responses. Every request carries
 * the bearer key when one is configured (required only if the server sets
 * FILAMENTDB_API_KEY; harmless otherwise).
 */

export class ApiError extends Error {
  status: number;
  /** GH #1211: the server answered a write with 2xx — so it was APPLIED — but
   *  the reply body never arrived. Treat the change as done: retrying (or
   *  queueing it) would apply it twice or replay it over a newer edit. */
  committed: boolean;
  constructor(status: number, message: string, committed = false) {
    super(message);
    this.status = status;
    this.committed = committed;
    this.name = 'ApiError';
  }
}

export interface ApiConfig {
  baseUrl: string;
  apiKey: string | null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Fail fast on an unreachable/wrong host instead of hanging the UI forever —
// RN's fetch has no default timeout. (GH #693.)
const HEADERS_TIMEOUT_MS = 15000;
// GH #1211: the body gets its own, longer bound. A large reply (an older
// desktop returns every spool's photo) on slow Wi-Fi can outlast the headers
// legitimately, but it must not hang forever — Expo's native `text()` only
// settles once the body completes, so a connection that drops or stalls
// mid-body never settles at all.
const BODY_TIMEOUT_MS = 60000;
const TIMED_OUT = Symbol('timed-out');

async function request<T>(cfg: ApiConfig, path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers['content-type'] = 'application/json';
  if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race each phase against this rather than relying on the abort alone
  // (aborting doesn't settle a native body read). It RESOLVES to TIMED_OUT
  // — a rejection would surface as unhandled whenever the other side won.
  const deadline = (ms: number) =>
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, ms);
    });

  let res: Response;
  try {
    const out = await Promise.race([
      fetch(`${cfg.baseUrl}${path}`, { ...init, headers, signal: controller.signal }),
      deadline(HEADERS_TIMEOUT_MS),
    ]);
    if (out === TIMED_OUT) throw new Error('timed out');
    res = out;
  } catch (e) {
    // `signal.aborted`, not `e.name === 'AbortError'`: Expo's fetch rejects
    // an abort with an error named plain 'Error'.
    throw new ApiError(
      0,
      controller.signal.aborted
        ? `The server didn't respond. Check the address and that this device is on the same network.`
        : `Can't reach the server. Check the address and that this device is on the same network. (${(e as Error).message})`,
    );
  } finally {
    clearTimeout(timer);
  }

  // GH #1211: the body read used to run outside both the timeout and the
  // error normalization — a stalled body hung the caller (and, mid-flush,
  // every later flush), and a dropped one escaped as a plain Error that the
  // offline queue read as permanent and deleted.
  let text: string;
  try {
    const out = await Promise.race([res.text(), deadline(BODY_TIMEOUT_MS)]);
    if (out === TIMED_OUT) throw new Error('timed out');
    text = out;
  } catch {
    // The status line already arrived, so classify by it: an error status
    // keeps its meaning (retryable or not) without its message.
    if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`);
    const method = (init?.method ?? 'GET').toUpperCase();
    // A read has nothing to lose — report it like any network failure.
    if (method === 'GET') {
      throw new ApiError(
        0,
        `The connection dropped while reading the server's reply. Check that this device is on the same network.`,
      );
    }
    throw new ApiError(
      res.status,
      'The server accepted the change, but the connection dropped before its reply arrived. Refresh to see the latest before changing it again.',
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export function createApi(cfg: ApiConfig) {
  return {
    /** Resolve a scanned QR/label instanceId to a filament. */
    matchByInstanceId: (instanceId: string) =>
      request<MatchResult>(
        cfg,
        `/api/filaments/match?instanceId=${encodeURIComponent(instanceId)}`,
      ),
    /** Full filament detail incl. its spools. */
    getFilament: (id: string) =>
      request<Filament>(cfg, `/api/filaments/${encodeURIComponent(id)}`),
    /** Locations for the move-to picker. */
    getLocations: () => request<Location[]>(cfg, '/api/locations'),
    /** Decode raw NFC bytes server-side and get back the tag + a DB match. */
    decodeNfc: (body: unknown) =>
      request<NfcDecodeResponse>(cfg, '/api/nfc/decode', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /**
     * Create a filament from a decoded tag (mobile Phase 2). The server maps
     * `tagData` (a DecodedOpenPrintTag from decodeNfc) into a filament payload;
     * `overrides` (the user's confirmed name/vendor/type) win. The phone does
     * no field mapping — design rule #1.
     */
    createFromTag: (
      tagData: DecodedOpenPrintTag,
      overrides: Record<string, unknown>,
      // Grams of filament remaining for the spool to create (default = the
      // tag's net weight). null = don't create a spool (catalog-only). The
      // server converts this to the spool's gross weight using the tag tare.
      spoolRemainingGrams: number | null,
    ) =>
      request<Filament>(cfg, '/api/filaments', {
        method: 'POST',
        body: JSON.stringify({ tagData, overrides, spoolRemainingGrams }),
      }),
    /** Update a spool — location, remaining weight, and/or retired (server converts).
     * GH #1027: ?shape=spool asks for just the affected spool back (~200 bytes
     * instead of every sibling spool's photo blob + usage ledger); an older
     * server ignores the param and returns the full filament — see
     * SpoolMutationResponse. */
    updateSpool: (filamentId: string, spoolId: string, patch: Record<string, unknown>) =>
      request<SpoolMutationResponse>(
        cfg,
        `/api/filaments/${encodeURIComponent(filamentId)}/spools/${encodeURIComponent(spoolId)}?shape=spool`,
        { method: 'PUT', body: JSON.stringify(patch) },
      ),
    /**
     * Resolve a single spool by id to its (inheritance-resolved) filament + the
     * spool itself. Powers spool-level deep links — a label QR's `?spool=` link
     * opens straight to that spool without knowing the parent filament up front.
     */
    getSpool: (spoolId: string) =>
      request<{ filament: Filament; spool: Spool }>(
        cfg,
        `/api/spools/${encodeURIComponent(spoolId)}`,
      ),
    /** Log filament usage — decrements the spool's remaining weight by `grams`.
     * GH #1027: ?shape=spool — see updateSpool. */
    logUsage: (filamentId: string, spoolId: string, grams: number, jobLabel?: string) =>
      request<SpoolMutationResponse>(
        cfg,
        `/api/filaments/${encodeURIComponent(filamentId)}/spools/${encodeURIComponent(spoolId)}/usage?shape=spool`,
        { method: 'POST', body: JSON.stringify({ grams, ...(jobLabel ? { jobLabel } : {}) }) },
      ),
    /** Log a dry-box cycle for a spool (temperature / duration / notes).
     * GH #1027: ?shape=spool — see updateSpool. */
    logDryCycle: (
      filamentId: string,
      spoolId: string,
      cycle: { tempC?: number; durationMin?: number; notes?: string },
    ) =>
      request<SpoolMutationResponse>(
        cfg,
        `/api/filaments/${encodeURIComponent(filamentId)}/spools/${encodeURIComponent(spoolId)}/dry-cycles?shape=spool`,
        { method: 'POST', body: JSON.stringify(cycle) },
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
