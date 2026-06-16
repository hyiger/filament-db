/**
 * #732 Phase 3 — pick which id a tag/label writer should encode.
 *
 * The 5-byte hex identity is moving from the filament to the spool, so every
 * writer (the browser `.bin` route, the Electron NFC write, and the label QR
 * dialog) must agree on WHICH spool's `instanceId` to stamp — otherwise a
 * downloaded `.bin` and a written tag could carry different ids for the same
 * action. Centralise the selection here (pure, unit-tested).
 *
 * Selection order:
 *   1. the explicitly requested spool (even if retired — the caller chose it);
 *      an unknown id is an error so the route can 400 rather than silently
 *      writing the wrong spool.
 *   2. otherwise the first NON-retired spool (array order = creation order);
 *   3. otherwise the first spool of any state (all retired);
 *   4. otherwise (no spools at all) fall back to the FILAMENT-level instanceId —
 *      the transitional legacy id, so a spool-less filament still gets a tag.
 *
 * Returns a discriminated result so callers can distinguish "you asked for a
 * spool that doesn't exist" (400) from "there's nothing to encode" (no id
 * anywhere — should not happen once Phase 1's per-spool default is in place).
 */

export interface SpoolLike {
  _id: unknown;
  instanceId?: string | null;
  retired?: boolean | null;
}

export interface FilamentLike {
  instanceId?: string | null;
  spools?: SpoolLike[] | null;
}

export type SpoolWriteSelection =
  | { ok: true; instanceId: string; spoolId: string | null; source: "spool" | "filament" }
  | { ok: false; reason: "spool-not-found" | "no-id-available" };

function fromSpool(s: SpoolLike): SpoolWriteSelection | null {
  if (typeof s.instanceId === "string" && s.instanceId) {
    return { ok: true, instanceId: s.instanceId, spoolId: String(s._id), source: "spool" };
  }
  return null;
}

export function selectSpoolForWrite(
  filament: FilamentLike,
  requestedSpoolId?: string | null,
): SpoolWriteSelection {
  const spools = filament.spools ?? [];

  if (requestedSpoolId) {
    const s = spools.find((sp) => String(sp._id) === requestedSpoolId);
    if (!s) return { ok: false, reason: "spool-not-found" };
    return fromSpool(s) ?? { ok: false, reason: "no-id-available" };
  }

  if (spools.length > 0) {
    const chosen = spools.find((sp) => !sp.retired) ?? spools[0];
    const r = fromSpool(chosen);
    if (r) return r;
    // chosen spool somehow has no id (legacy data) — fall through to the
    // filament-level fallback below rather than failing.
  }

  if (typeof filament.instanceId === "string" && filament.instanceId) {
    return { ok: true, instanceId: filament.instanceId, spoolId: null, source: "filament" };
  }

  return { ok: false, reason: "no-id-available" };
}
