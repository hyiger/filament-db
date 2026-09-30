import { createHash } from "node:crypto";
import mongoose from "mongoose";

/**
 * GH #1209: spool identity across an Atlas re-import.
 *
 * The import used to REPLACE a local filament's whole `spools` array with the
 * source's, carrying the local `instanceId`s over by array position. Every
 * local spool `_id` was swapped for the source's, so printer AMS slots,
 * print-history refund targets and `?spool=` deep links went on naming a
 * subdocument that no longer existed. Position was never an identity either:
 * a reordered source moved labels and NFC tags onto the wrong roll.
 *
 * Identity is now the spool `_id` — the one key a source sharing lineage with
 * this database actually shares (an earlier Atlas import, a snapshot restore
 * and hybrid sync all preserve spool `_id`s):
 *   - a source spool whose `_id` is already on THIS local filament updates it
 *     in place, keeping the local `_id`, `instanceId` and location;
 *   - any other source spool is added, keeping its `_id` so the next re-import
 *     matches it, unless another local filament already owns that `_id` —
 *     then it is skipped rather than creating a second owner of one roll;
 *   - a local spool the source doesn't carry is kept: nothing proves it was
 *     deleted upstream, and deleting it would strand its references.
 *
 * DB-free; the route supplies the local spools, the ownership set and the
 * `instanceId` minter.
 */

/** Whether the write will store `value` as `retired: true`. The schema casts
 *  "true", 1, "1" and "yes" to true, so a strict `=== true` check would miss a
 *  retirement the write then records — and leave the spool in a printer slot.
 *  Uses Mongoose's own set, so the two can't disagree. */
function castsToTrue(value: unknown): boolean {
  return mongoose.Schema.Types.Boolean.convertToTrue.has(value);
}

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** A source spool's identity as lowercase ObjectId hex. A spool with no usable
 *  `_id` (hand-inserted source data) gets one DERIVED from the source filament
 *  and its position, so re-importing the same source matches it instead of
 *  appending another copy on every run. */
export function remoteSpoolId(
  spool: Record<string, unknown>,
  remoteFilamentId: string,
  index: number,
): string {
  const raw = spool._id;
  let hex = "";
  if (typeof raw === "string") {
    hex = raw;
  } else if (raw && typeof (raw as { toHexString?: unknown }).toHexString === "function") {
    hex = (raw as { toHexString(): string }).toHexString();
  }
  if (OBJECT_ID_HEX.test(hex)) return hex.toLowerCase();
  return createHash("sha1")
    .update(`atlas-spool:${remoteFilamentId}:${index}`)
    .digest("hex")
    .slice(0, 24);
}

export interface KeyedRemoteSpool {
  id: string;
  spool: Record<string, unknown>;
}

/** Key each source spool by `remoteSpoolId`. A non-object entry, or a repeat
 *  of an id already seen in the same array, is dropped and counted. */
export function keyRemoteSpools(
  remoteSpools: readonly unknown[],
  remoteFilamentId: string,
): { entries: KeyedRemoteSpool[]; dropped: number } {
  const entries: KeyedRemoteSpool[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  remoteSpools.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      dropped++;
      return;
    }
    const spool = raw as Record<string, unknown>;
    const id = remoteSpoolId(spool, remoteFilamentId, index);
    if (seen.has(id)) {
      dropped++;
      return;
    }
    seen.add(id);
    entries.push({ id, spool });
  });
  return { entries, dropped };
}

export interface LocalSpool {
  _id: unknown;
  instanceId?: string | null;
  locationId?: unknown;
  retired?: boolean | null;
  [key: string]: unknown;
}

export interface ReconcileResult {
  spools: Record<string, unknown>[];
  matched: number;
  added: number;
  /** Local spools the source doesn't carry, kept as they are. */
  keptLocal: number;
  /** Source spools skipped because another local filament owns their `_id`. */
  skippedOwned: number;
  /** Local spool ids the source just retired (their printer slots must be
   *  cleared — a retired spool can't stay loaded, GH #268). */
  newlyRetired: string[];
}

/**
 * Merge keyed source spools into a local filament's spools. Local order is
 * kept (matched spools updated in place), new spools are appended in source
 * order. `ownedElsewhere` holds the ids of spools on OTHER non-purged local
 * filaments; `localSpools` is empty on a create.
 */
export function reconcileImportedSpools(
  entries: readonly KeyedRemoteSpool[],
  localSpools: readonly LocalSpool[],
  ownedElsewhere: ReadonlySet<string>,
  mintInstanceId: () => string,
): ReconcileResult {
  const spools: Record<string, unknown>[] = localSpools.map((s) => ({ ...s }));
  const indexById = new Map(spools.map((s, i) => [String(s._id).toLowerCase(), i]));
  const matchedIds = new Set<string>();
  const newlyRetired: string[] = [];
  let added = 0;
  let skippedOwned = 0;

  for (const { id, spool } of entries) {
    const at = indexById.get(id);
    if (at !== undefined) {
      const local = spools[at];
      if (local.retired !== true && castsToTrue(spool.retired)) newlyRetired.push(id);
      spools[at] = {
        ...local,
        ...spool,
        _id: local._id,
        instanceId: local.instanceId ?? mintInstanceId(),
        // The source's location is a ref into the SOURCE database; the local
        // spool's own location still holds.
        locationId: local.locationId ?? null,
      };
      matchedIds.add(id);
    } else if (ownedElsewhere.has(id)) {
      skippedOwned++;
    } else {
      spools.push({
        ...spool,
        _id: id,
        // Never trust the source's instanceId (GH #255/#732 anti-spoofing).
        instanceId: mintInstanceId(),
        locationId: null,
      });
      added++;
    }
  }

  return {
    spools,
    matched: matchedIds.size,
    added,
    keptLocal: localSpools.length - matchedIds.size,
    skippedOwned,
    newlyRetired,
  };
}
