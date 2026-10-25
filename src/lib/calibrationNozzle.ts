/**
 * Which nozzle a per-nozzle calibration belongs to (audit finding N041).
 *
 * The PrusaSlicer sync-back (`POST /api/filaments/{id}`) writes EM, pressure
 * advance, retraction and, for a #872 per-nozzle preset, temps / max-vol / fan
 * onto one calibration row, and `GET /api/filaments/{id}/calibration` reads it
 * back. Both used to pick that nozzle by accident: the write took
 * `Nozzle.findOne(...)` with no sort among the filament's compatible nozzles,
 * so with two 0.4 mm high-flow nozzles ticked (a Core One INDX nozzle and an
 * H2D's "WC HF 0.4") the row landed on whichever the collection returned
 * first, and the read answered from whichever row sat first in the array.
 * Nothing tied the two together, and nothing guaranteed either.
 *
 * This module is the ONE nozzle choice both routes make, so for the same
 * inputs they agree. The rules, in order:
 *
 *   1. ONE candidate: it. (The single-match case behaves as it always did.)
 *   2. The caller named its printer (`?printer=`): the candidate that printer
 *      has installed. Two or more installed narrow the pool; none installed
 *      leaves it alone, so naming a printer can only sharpen an answer.
 *   3. The candidate that already carries one of this filament's calibration
 *      rows the read would serve: a printer-less row (the row the sync writes),
 *      or a row scoped to the named printer. A sync then keeps updating the
 *      row it updated last time instead of starting a parallel one on a
 *      sibling nozzle.
 *   4. Anything else is AMBIGUOUS, and the write refuses rather than guessing.
 *      The GH #859 catalog fallback already refused to guess (exactly-one
 *      rule); the compatible-nozzle path never had that guard.
 *
 * A printer that was asked for but matches no live printer stops at rule 2:
 * the caller said which machine it is, and rule 3 might hand the row to a
 * different one.
 *
 * The candidate pool is tiered like the write always was: the filament's
 * effective `compatibleNozzles` first, and only when none of those match, the
 * whole catalog. A tie in the compatible tier never falls through to the
 * catalog: the catalog is a superset, so it would tie too.
 */
import { escapeRegex } from "@/lib/matchFilament";
import type { PrinterScope } from "@/lib/slicerExportScope";

/** How a nozzle won. */
export type NozzleResolvedBy = "only" | "printer" | "calibrated";

/** Where the candidates came from. */
export type NozzleCandidateScope = "compatible" | "catalog";

export type CalibrationNozzlePick =
  | { kind: "resolved"; nozzleId: string; by: NozzleResolvedBy }
  | { kind: "ambiguous"; candidateIds: string[] }
  | { kind: "printer-not-found"; candidateIds: string[] }
  | { kind: "none" };

export type CalibrationNozzleResolution =
  | {
      kind: "resolved";
      nozzleId: string;
      by: NozzleResolvedBy;
      scope: NozzleCandidateScope;
      candidates: NozzleSummary[];
    }
  | { kind: "ambiguous" | "printer-not-found"; scope: NozzleCandidateScope; candidates: NozzleSummary[] }
  | { kind: "none" };

export interface NozzleSummary {
  _id: string;
  name: string;
  type: string;
}

/** The query side of the match, shared so both routes filter identically. */
export interface NozzleCriteria {
  diameter: number;
  /**
   * `true` / `false` match exactly. `"not-high-flow"` is the #872 non-HF hint:
   * false OR unset, so a legacy nozzle without the field still resolves.
   * Omitted = either.
   */
  highFlow?: boolean | "not-high-flow";
  /** Nozzle type, matched exactly but case-insensitively (the #872 hint). */
  type?: string;
}

/** A calibration row as either route holds it: raw ids or populated docs. */
interface CalibrationRowRef {
  nozzle?: unknown;
  printer?: unknown;
}

/** A ref's id: a populated doc's `_id`, else the ObjectId or string itself. */
function refId(ref: unknown): string | null {
  if (ref == null) return null;
  const id = typeof ref === "object" ? (ref as { _id?: unknown })._id : undefined;
  return String(id ?? ref);
}

/** The Mongo filter for `criteria`, excluding soft-deleted nozzles. */
export function nozzleCriteriaQuery(criteria: NozzleCriteria): Record<string, unknown> {
  const query: Record<string, unknown> = { diameter: criteria.diameter, _deletedAt: null };
  if (criteria.highFlow === "not-high-flow") query.highFlow = { $ne: true };
  else if (criteria.highFlow !== undefined) query.highFlow = criteria.highFlow;
  if (criteria.type) query.type = { $regex: `^${escapeRegex(criteria.type)}$`, $options: "i" };
  return query;
}

/**
 * The nozzles carrying a row the read would serve for `printerId`: every
 * printer-less row, plus rows scoped to that printer.
 */
export function calibratedNozzleIds(
  calibrations: readonly CalibrationRowRef[] | null | undefined,
  printerId: string | null,
): Set<string> {
  const out = new Set<string>();
  for (const cal of calibrations ?? []) {
    const nozzleId = refId(cal?.nozzle);
    if (!nozzleId) continue;
    const rowPrinter = refId(cal.printer);
    if (rowPrinter === null || (printerId !== null && rowPrinter === printerId)) out.add(nozzleId);
  }
  return out;
}

/**
 * Rules 1–4 over a candidate set. Pure, and independent of the order the
 * candidates arrive in: it only ever returns a UNIQUE survivor, and reports a
 * tie sorted, so document order can never decide.
 */
export function pickCalibrationNozzle(
  candidateIds: readonly string[],
  options: { printer: PrinterScope; calibrated: ReadonlySet<string> },
): CalibrationNozzlePick {
  const ids = Array.from(new Set(candidateIds)).sort();
  if (ids.length === 0) return { kind: "none" };
  if (ids.length === 1) return { kind: "resolved", nozzleId: ids[0], by: "only" };

  const { printer, calibrated } = options;
  if (printer.kind === "not-found") return { kind: "printer-not-found", candidateIds: ids };

  let pool = ids;
  if (printer.kind === "scoped") {
    const installed = pool.filter((id) => printer.nozzleIds.has(id));
    if (installed.length === 1) return { kind: "resolved", nozzleId: installed[0], by: "printer" };
    if (installed.length > 1) pool = installed;
  }

  const withRow = pool.filter((id) => calibrated.has(id));
  if (withRow.length === 1) return { kind: "resolved", nozzleId: withRow[0], by: "calibrated" };
  return { kind: "ambiguous", candidateIds: pool };
}

type CalibrationRows = readonly CalibrationRowRef[] | null | undefined;

/**
 * Resolve the calibration nozzle for a filament. `compatibleNozzleIds` and
 * `calibrations` must be the EFFECTIVE values (a variant with an empty own
 * array inherits its parent's), the same documents the write targets.
 *
 * `calibrations` must carry the STORED refs, not populated ones: a populate
 * turns a row scoped to a printer that no longer exists into `printer: null`,
 * which reads as a printer-less row here and as a scoped one to the write,
 * and the two routes would then disagree under rule 3. A caller holding only
 * populated rows passes a loader, which runs only when there is a tie to break.
 */
export async function resolveCalibrationNozzle(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  NozzleModel: any,
  input: {
    criteria: NozzleCriteria;
    compatibleNozzleIds: Iterable<string>;
    calibrations: CalibrationRows | (() => Promise<CalibrationRows>);
    printer: PrinterScope;
  },
): Promise<CalibrationNozzleResolution> {
  const query = nozzleCriteriaQuery(input.criteria);
  const printerId = input.printer.kind === "scoped" ? input.printer.printerId : null;
  // Called at most once: the first tier with any candidate decides.
  const loadCalibrated = async () =>
    calibratedNozzleIds(
      typeof input.calibrations === "function" ? await input.calibrations() : input.calibrations,
      printerId,
    );
  const compatIds = Array.from(new Set(input.compatibleNozzleIds));

  const tiers: Array<{ scope: NozzleCandidateScope; filter: Record<string, unknown> }> = [];
  if (compatIds.length > 0) tiers.push({ scope: "compatible", filter: { ...query, _id: { $in: compatIds } } });
  tiers.push({ scope: "catalog", filter: query });

  for (const { scope, filter } of tiers) {
    // `name` and `type` are required on the schema.
    const docs: Array<{ _id: unknown; name: string; type: string }> = await NozzleModel.find(filter)
      .select("name type")
      .lean();
    if (docs.length === 0) continue;
    const summaries = docs
      .map((d) => ({ _id: String(d._id), name: d.name, type: d.type }))
      .sort((a, b) => a._id.localeCompare(b._id));
    const pick = pickCalibrationNozzle(summaries.map((s) => s._id), {
      printer: input.printer,
      // A lone candidate never reaches rule 3, so don't load rows for it.
      calibrated: summaries.length > 1 ? await loadCalibrated() : new Set<string>(),
    });
    if (pick.kind === "resolved") {
      return { kind: "resolved", nozzleId: pick.nozzleId, by: pick.by, scope, candidates: summaries };
    }
    // `none` only answers an empty set and `docs` is non-empty, so what is
    // left is a tie.
    const tie = pick as Extract<CalibrationNozzlePick, { candidateIds: string[] }>;
    const tied = new Set(tie.candidateIds);
    return { kind: tie.kind, scope, candidates: summaries.filter((s) => tied.has(s._id)) };
  }
  return { kind: "none" };
}
