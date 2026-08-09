/**
 * Scope key handling + reachability for the FilamentForm calibration grid
 * (GH #1101 / #1102).
 *
 * ## The bug
 *
 * The form rebuilt `calibrations` from form state on every save and dropped
 * any row whose nozzle wasn't in `form.compatibleNozzles`. `[].includes(x)` is
 * always false, so a filament with an EMPTY tick list had every calibration
 * deleted — and empty is exactly the state the slicer sync-back produces: the
 * GH #859 fallback resolves a nozzle from the global catalog and never writes
 * `compatibleNozzles`. The rows were loaded into form state, never rendered
 * (the section itself was gated on the tick list), and destroyed on the next
 * save of any field. Editing a TEMPLATE was worst: every inheriting variant
 * lost the calibration at once.
 *
 * ## Why the old prune existed, and what replaces it
 *
 * The nozzle filter dates to v1.1.0, when this form was the only writer of
 * calibrations, so "nozzle not ticked" reliably meant "the user just unticked
 * it". Slicer sync-back broke that premise. A second filter (PR #358) dropped
 * printer-scoped rows whose printer no longer owns the nozzle, with an
 * explicit and still-valid goal: a row the UI can't show "would persist
 * forever as an orphan… the data becomes undeletable".
 *
 * That goal is real, but auto-delete is the wrong remedy — it destroys data to
 * avoid hiding it. The remedy here is to make the row VISIBLE: the save keeps
 * everything that still carries data, and the form surfaces any row the normal
 * grid can't reach so it can be inspected and removed deliberately.
 *
 * Deleting is still possible and still explicit: blank every field in a card
 * (unchanged), or use the Remove action on an unreachable row.
 */

/** Sentinel for "applies to any printer" in a scope key. */
export const CAL_DEFAULT_PRINTER = "default";
/** Sentinel for "applies to any bed surface" in a scope key. */
export const CAL_ANY_BED = "any";

export interface CalibrationScope {
  printerId: string | null;
  nozzleId: string;
  bedTypeId: string | null;
}

/**
 * Encode a scope key. Byte-identical to the form's historical local helper —
 * the keys are the identity of rows already sitting in component state, so the
 * encoding must not drift. ObjectIds and both sentinels are `:`-free, which is
 * what makes the split in `parseCalibrationKey` unambiguous.
 */
export function calibrationKey(
  printerId: string | null,
  nozzleId: string,
  bedTypeId?: string | null,
): string {
  return `${printerId || CAL_DEFAULT_PRINTER}:${nozzleId}:${bedTypeId || CAL_ANY_BED}`;
}

export function parseCalibrationKey(key: string): CalibrationScope {
  const [printerId, nozzleId, bedTypeId] = key.split(":");
  return {
    printerId: printerId === CAL_DEFAULT_PRINTER ? null : printerId,
    nozzleId,
    bedTypeId: bedTypeId === CAL_ANY_BED || bedTypeId === undefined ? null : bedTypeId,
  };
}

/**
 * True when a card still holds any value. Blanking every field is — and stays —
 * the way to delete a calibration, so this is the ONE predicate that may drop a
 * row on save.
 */
// Takes `object` rather than Record<string, string> so a declared interface
// (CalibrationEntry) is assignable — an interface without an index signature
// is not.
export function hasCalibrationData(values: object): boolean {
  return Object.values(values).some((v) => v !== "");
}

/** What the grid can currently render, mirrored from the form's own inputs. */
export interface CalibrationGridContext {
  /** `form.compatibleNozzles` — the ticked list. */
  compatibleNozzleIds: readonly string[];
  /** Nozzle id → the printer ids that physically own it. A MISSING key from a
   *  LOADED catalog means the nozzle is gone. */
  nozzleOwnership: ReadonlyMap<string, readonly string[]>;
  /** Printer ids that get a tab. */
  relevantPrinterIds: readonly string[];
  /** Bed type ids that get a tab (the "any" tab is always present). */
  bedTypeIds: readonly string[];
  /**
   * Whether each catalog has finished loading.
   *
   * These MUST be explicit rather than inferred from an empty array: a user
   * can legitimately own zero printers, in which case a printer-scoped row
   * really is orphaned — indistinguishable from "the fetch hasn't landed yet"
   * if you only look at the length. The three fetches are independent, so
   * /api/nozzles routinely resolves first (Codex P2 on PR #1130).
   */
  nozzlesLoaded: boolean;
  printersLoaded: boolean;
  bedTypesLoaded: boolean;
}

/**
 * Can the user navigate to a card for this row and edit (or blank) it?
 *
 * Every clause mirrors a real gate in the grid:
 *  - the nozzle must be ticked (the card loop iterates `compatibleNozzles`);
 *  - the nozzle must be in the catalog (the loop `return null`s otherwise —
 *    the case that would otherwise reintroduce #358's undeletable orphan);
 *  - a printer-scoped row needs a tab for that printer AND that printer must
 *    own the nozzle (the tab's own filter);
 *  - a bed-scoped row needs a tab for that bed type.
 *
 * Fail-open while a catalog is still loading is deliberate and load-bearing
 * (PR #358 round 2, extended per Codex P2 on PR #1130): all three catalogs are
 * fetched async and independently. Judging a row against one that hasn't
 * landed would dump valid rows into the orphan list — where they carry an
 * active Remove button — so each clause is skipped until ITS catalog is ready.
 */
export function isCalibrationRowReachable(
  key: string,
  ctx: CalibrationGridContext,
): boolean {
  const { printerId, nozzleId, bedTypeId } = parseCalibrationKey(key);

  // Decide every INDEPENDENTLY-KNOWN negative first, then fail open on what is
  // genuinely unknown. Ordering matters: an early `return true` for one
  // unloaded catalog would skip clauses another, healthy catalog can already
  // answer — leaving a row that the grid demonstrably cannot render out of the
  // orphan list, i.e. invisible AND without the Remove action, for the rest of
  // the session. Each clause below is therefore gated on its OWN catalog.

  // Needs no catalog at all — this is form state.
  if (!ctx.compatibleNozzleIds.includes(nozzleId)) return false;
  // Needs only the bed catalog.
  if (bedTypeId !== null && ctx.bedTypesLoaded && !ctx.bedTypeIds.includes(bedTypeId)) {
    return false;
  }
  // Needs only the printer catalog.
  if (printerId !== null && ctx.printersLoaded && !ctx.relevantPrinterIds.includes(printerId)) {
    return false;
  }

  // Everything remaining depends on the nozzle catalog.
  if (!ctx.nozzlesLoaded) return true;
  const owners = ctx.nozzleOwnership.get(nozzleId);
  // Absent from a LOADED catalog → the card loop would `return null`.
  if (owners === undefined) return false;
  if (printerId === null) return true;
  return owners.includes(printerId);
}

/**
 * Split stored rows into the ones the grid can reach and the ones it can't.
 *
 * The caller renders `orphanKeys` as an explicit list with a Remove action, so
 * nothing is both invisible and undeletable — the property PR #358 was
 * protecting, achieved without destroying data.
 */
export function partitionCalibrationKeys(
  keys: Iterable<string>,
  ctx: CalibrationGridContext,
): { reachableKeys: string[]; orphanKeys: string[] } {
  const reachableKeys: string[] = [];
  const orphanKeys: string[] = [];
  for (const key of keys) {
    (isCalibrationRowReachable(key, ctx) ? reachableKeys : orphanKeys).push(key);
  }
  return { reachableKeys, orphanKeys };
}

/**
 * The rows to persist.
 *
 * Deliberately the ONLY filter: a row survives iff it still carries data. The
 * two scope filters this replaces are gone — see the module docblock. A row the
 * form never rendered keeps its loaded values in state and therefore survives,
 * which is precisely the #1101 fix.
 */
export function keepCalibrationEntries<T extends object>(
  entries: readonly (readonly [string, T])[],
): (readonly [string, T])[] {
  return entries.filter(([, cal]) => hasCalibrationData(cal));
}
