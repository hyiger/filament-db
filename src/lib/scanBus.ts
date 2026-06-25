import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for NFC scan events. The NfcProvider POSTs to
 * /api/scan/publish after decoding a tag and matching it against the DB;
 * /api/scan/stream holds long-lived SSE connections and forwards each
 * published event.
 *
 * The bus is module-scoped and stored on globalThis so Next.js hot reload
 * doesn't create a fresh emitter that drops existing SSE subscribers. This
 * is in-memory only — it works for the Electron desktop app and a single
 * Docker container, but a scaled multi-process deployment would need an
 * external broker (Redis pub/sub etc.). The user-facing feature (push a
 * scan into the slicer running on the same machine) only needs single-
 * process delivery.
 */

export interface ScanEventFilament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
}

export interface ScanEventDecoded {
  materialName?: string;
  brandName?: string;
  materialType?: string;
  color?: string;
  spoolUid?: string;
  tagSource?: "openprinttag" | "bambu" | "opentag3d";
}

/** #732: the specific spool a scan resolved to, when the tag's spool_uid matched
 * a spools[].instanceId. Null for a filament-level / heuristic match. */
export interface ScanEventSpool {
  _id: string;
  instanceId: string;
  label: string;
}

export interface ScanEvent {
  /** Epoch ms when the scan was published. */
  timestamp: number;
  /** Resolved filament if the tag matched a row, else null. */
  filament: ScanEventFilament | null;
  /** Other plausible filaments (vendor+type or vendor-only candidates). */
  candidates: ScanEventFilament[];
  /** #732: the spool the tag's spool_uid resolved to, or null. */
  matchedSpool?: ScanEventSpool | null;
  /** Subset of the decoded tag fields useful to consumers. */
  decoded: ScanEventDecoded;
}

interface ScanBusState {
  emitter: EventEmitter;
  last: ScanEvent | null;
}

const GLOBAL_KEY = "__filamentDbScanBus__";
type GlobalWithBus = typeof globalThis & { [GLOBAL_KEY]?: ScanBusState };

function getState(): ScanBusState {
  const g = globalThis as GlobalWithBus;
  if (!g[GLOBAL_KEY]) {
    const emitter = new EventEmitter();
    // SSE clients (PrusaSlicer + the desktop renderer + any dev tools) all
    // listen at once. Default cap of 10 is too low and triggers a noisy
    // MaxListenersExceededWarning under normal use.
    emitter.setMaxListeners(0);
    g[GLOBAL_KEY] = { emitter, last: null };
  }
  return g[GLOBAL_KEY]!;
}

const SCAN_EVENT = "scan";

export function publishScan(event: ScanEvent): void {
  const state = getState();
  state.last = event;
  state.emitter.emit(SCAN_EVENT, event);
}

export function subscribeScans(handler: (event: ScanEvent) => void): () => void {
  const state = getState();
  state.emitter.on(SCAN_EVENT, handler);
  return () => {
    state.emitter.off(SCAN_EVENT, handler);
  };
}

export function getLastScan(): ScanEvent | null {
  return getState().last;
}

/** Test-only: drop the last cached scan and any active listeners. */
export function resetScanBusForTests(): void {
  const state = getState();
  state.emitter.removeAllListeners(SCAN_EVENT);
  state.last = null;
}
