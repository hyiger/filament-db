import type {
  DecodedOpenPrintTag,
  Filament,
  Location,
  MatchResult,
  NfcDecodeResponse,
  Spool,
} from './types';

/**
 * Thin typed client over the Filament DB REST API. The app does no business
 * logic — it forwards scans/edits and renders responses. Every request carries
 * the bearer key when one is configured (required only if the server sets
 * FILAMENTDB_API_KEY; harmless otherwise).
 */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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

async function request<T>(cfg: ApiConfig, path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers['content-type'] = 'application/json';
  if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;

  let res: Response;
  // Fail fast on an unreachable/wrong host instead of hanging the UI forever —
  // RN's fetch has no default timeout. clearTimeout in finally avoids a late
  // abort firing on a slow-but-successful response. (GH #693 review.)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    throw new ApiError(
      0,
      aborted
        ? `The server didn't respond. Check the address and that this device is on the same network.`
        : `Can't reach the server. Check the address and that this device is on the same network. (${(e as Error).message})`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
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
    /** Update a spool — location, remaining weight, and/or retired (server converts). */
    updateSpool: (filamentId: string, spoolId: string, patch: Record<string, unknown>) =>
      request<Filament>(
        cfg,
        `/api/filaments/${encodeURIComponent(filamentId)}/spools/${encodeURIComponent(spoolId)}`,
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
    /** Log filament usage — decrements the spool's remaining weight by `grams`. */
    logUsage: (filamentId: string, spoolId: string, grams: number, jobLabel?: string) =>
      request<Filament>(
        cfg,
        `/api/filaments/${encodeURIComponent(filamentId)}/spools/${encodeURIComponent(spoolId)}/usage`,
        { method: 'POST', body: JSON.stringify({ grams, ...(jobLabel ? { jobLabel } : {}) }) },
      ),
    /** Log a dry-box cycle for a spool (temperature / duration / notes). */
    logDryCycle: (
      filamentId: string,
      spoolId: string,
      cycle: { tempC?: number; durationMin?: number; notes?: string },
    ) =>
      request<Filament>(
        cfg,
        `/api/filaments/${encodeURIComponent(filamentId)}/spools/${encodeURIComponent(spoolId)}/dry-cycles`,
        { method: 'POST', body: JSON.stringify(cycle) },
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
