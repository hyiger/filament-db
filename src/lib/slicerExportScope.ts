/**
 * Scoping a slicer bundle to one printer.
 *
 * The reported symptom: abrasive filaments — carbon- and glass-filled grades
 * that erode a soft nozzle — appear as selectable presets when the active
 * printer carries a nitrocarburized nozzle they must never touch.
 *
 * WHY THIS IS SERVER-SIDE AND NOT A `compatible_printers_condition`.
 * PrusaSlicer's condition language exposes `nozzle_diameter`,
 * `nozzle_high_flow`, `printer_model`, `printer_variant` and `printer_notes`.
 * There is NO variable for nozzle material or hardness. Two nozzles can be
 * identical on (diameter, high-flow) and differ only in that one is hardened,
 * which is exactly the case that bites here — so no condition can separate
 * them. Worse, when every hardened nozzle lives on a printer the slicer never
 * sees, a truthful "hardened only" condition and a blanket hide are the same
 * string. And deriving conditions from nozzle ticks is precisely what GH #1021
 * removed, because it silently hid presets with no visible cause; the one-shot
 * `legacyNozzleConditions` migration and the permanent ingestion strip exist to
 * keep that from coming back.
 *
 * So the answer is to narrow the RESPONSE, on request, using the join the
 * database already has: a printer owns nozzles, a filament lists the nozzles it
 * may run on.
 *
 * FAIL OPEN, ALWAYS. Two rules keep this from becoming #1021 relocated to the
 * server: it is opt-in (no `printer` param means the response is unchanged),
 * and a filament that lists NO nozzles is INCLUDED rather than filtered out.
 * Unknown compatibility is not the same as known incompatibility, and a
 * silently missing preset is the failure mode this whole area is scarred by.
 */

/** A nozzle ref as it arrives — populated doc, raw ObjectId, or string. */
type NozzleRef = { _id?: unknown } | string | null | undefined;

/**
 * Deliberately `unknown` at the boundary rather than a narrow interface.
 *
 * Callers pass either a lean Mongoose doc or a `resolveFilament` result, whose
 * types differ and neither of which declares `compatibleNozzles` in a shape TS
 * will match against an all-optional interface (weak-type detection rejects
 * it). Reading defensively here is honest about that and costs nothing.
 */

function refId(ref: NozzleRef): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  return ref._id == null ? null : String(ref._id);
}

/**
 * The nozzle ids a filament may run on, as strings.
 *
 * Call this on a RESOLVED filament: `compatibleNozzles` is whole-array
 * fallback, so a variant with an empty own array inherits the template's, and
 * only the resolved doc carries the effective set. Filtering the stored value
 * would drop every inheriting variant.
 */
export function nozzleIdsOf(filament: unknown): Set<string> {
  const raw = (filament as { compatibleNozzles?: unknown } | null | undefined)?.compatibleNozzles;
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const ref of raw as NozzleRef[]) {
    const id = refId(ref);
    if (id) out.add(id);
  }
  return out;
}

/**
 * Whether a resolved filament may be offered for a printer carrying
 * `printerNozzleIds`.
 *
 * A filament with no nozzles listed is offered — see FAIL OPEN above. It is the
 * difference between "we know this cannot go here" and "nobody has said yet".
 */
export function isOfferableOnPrinter(
  filament: unknown,
  printerNozzleIds: ReadonlySet<string>,
): boolean {
  const own = nozzleIdsOf(filament);
  if (own.size === 0) return true;
  for (const id of own) {
    if (printerNozzleIds.has(id)) return true;
  }
  return false;
}

/** Outcome of reading the `printer` query parameter. */
export type PrinterScope =
  | { kind: "none" }
  | { kind: "not-found"; raw: string }
  | { kind: "scoped"; printerId: string; printerName: string; nozzleIds: Set<string> };

/**
 * Resolve `?printer=` to the set of nozzles that printer carries.
 *
 * Identity rules mirror the `?printer=` scope on
 * `GET /api/filaments/{id}/calibration` (GH #1047), so the two behave the same:
 * a 24-hex value is an ObjectId and is AUTHORITATIVE — printer names are
 * unrestricted, so one printer could be NAMED as another's id and must not
 * shadow it. Names then match verbatim, then trimmed, then case-folded, and
 * only a LIVE printer is addressable.
 *
 * The VERBATIM rung compares the caller's parameter UNTRIMMED, and that is the
 * whole point of it: hybrid sync writes through the raw driver and bypasses the
 * `trim` setter, so live printers named `"X"` and `"X "` can both exist, and
 * this is the only rung that can tell them apart. Trimming before it — the
 * obvious tidy-up — silently redirects `?printer=X%20` to `X`, and the bundle
 * is then filtered against the wrong printer's nozzles. Only the emptiness
 * check, the ObjectId test and the looser rungs may see the trimmed value.
 *
 * An unknown printer returns `not-found` rather than an empty scope. Treating
 * a typo as "this printer has no nozzles" would filter the bundle down to
 * nothing, which is the silent-emptiness failure this design exists to avoid;
 * the caller turns it into a 400 that names the value.
 */
export async function resolvePrinterScope(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PrinterModel: any,
  rawParam: string | null,
): Promise<PrinterScope> {
  const original = rawParam ?? "";
  const raw = original.trim();
  if (!raw) return { kind: "none" };

  let printer: { _id: unknown; name?: string; installedNozzles?: NozzleRef[] } | null = null;

  if (/^[0-9a-fA-F]{24}$/.test(raw)) {
    printer = await PrinterModel.findOne({ _id: raw, _deletedAt: null })
      .select("name installedNozzles")
      .lean();
  }

  if (!printer) {
    // Verbatim (UNTRIMMED — see the docblock), then trimmed, then case-folded.
    // The name index is case-SENSITIVE and hybrid sync writes through the raw
    // driver bypassing the trim setter, so "X" and "X " can both exist — go
    // strictest first rather than letting document order decide.
    const live = await PrinterModel.find({ _deletedAt: null })
      .select("name installedNozzles")
      .lean();
    printer =
      live.find((p: { name?: string }) => p.name === original) ??
      live.find((p: { name?: string }) => (p.name ?? "").trim() === raw) ??
      live.find(
        (p: { name?: string }) => (p.name ?? "").trim().toLowerCase() === raw.toLowerCase(),
      ) ??
      null;
  }

  if (!printer) return { kind: "not-found", raw };

  const nozzleIds = new Set<string>();
  for (const ref of printer.installedNozzles ?? []) {
    const id = refId(ref);
    if (id) nozzleIds.add(id);
  }
  return {
    kind: "scoped",
    printerId: String(printer._id),
    printerName: printer.name ?? "",
    nozzleIds,
  };
}

/** The 400 body for an unresolvable `?printer=` value. */
export function unknownPrinterBody(raw: string) {
  return {
    error: "printer_not_found",
    message:
      `No live printer matches "${raw}". Pass a printer id or its exact name, ` +
      `or omit the parameter to export every filament.`,
  };
}
