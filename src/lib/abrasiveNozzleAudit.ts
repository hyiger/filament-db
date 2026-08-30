/**
 * Data-health check: abrasive filament that can reach a nozzle unfit for it,
 * or whose abrasive flag contradicts its material.
 *
 * Fibre-, metal- and glow-filled filaments erode a soft nozzle. Brass goes in
 * hours; a nitrocarburized or nitrided steel nozzle has a hardened case
 * measured in microns and fares little better. Only a through-hardened,
 * carbide or ruby-tipped nozzle survives them.
 *
 * WHY THIS EXISTS. `compatibleNozzles` is the app's RECORD of which nozzles a
 * filament may run on — read by the form's nozzle picker, by calibration
 * reachability, and by the printer-scoped export. What it is NOT is a baked
 * restriction: GH #1021 removed the derived `compatible_printers_condition`,
 * so an ordinary export limits nothing at print time, and a slicer only gets a
 * filtered bundle when it asks for a named printer (`?printer=`). Either way
 * the list is a statement of intent maintained by hand, so it goes stale in
 * silence. A filament typed `PC` when its nozzles were assigned keeps
 * that permissive set after being retyped `PC-CF`; nothing errors, nothing
 * warns, and the wrong nozzle stays on the list. A stale entry is therefore a
 * wrong record rather than an open door — which is still worth reporting,
 * because the record is what the user reasons from.
 *
 * WHY THE `filament_abrasive` FLAG IS NOT TRUSTED AS A NEGATIVE. The flag is a
 * second line of defence — Prusa's INDX start G-code passes it to `M862.1`, so
 * the firmware itself can refuse the print. But it is written from only half of
 * the app's own abrasive predicate: `FilamentForm` computes
 * `form.abrasive || form.optTags.includes(4)` when filtering the nozzle picker,
 * then persists `form.abrasive ? "1" : "0"`. A filament marked abrasive by the
 * OPT tag is therefore stored, and exported, as `"0"` — a positive assertion of
 * safety. So a `"0"` here is evidence of nothing, and this audit treats it as
 * suppressing only the weakest heuristic. Reporting that contradiction is one
 * of the findings.
 *
 * The check is ADVISORY. It never blocks a write and never edits an assignment.
 * Abrasiveness is inferred, and inference is not certainty — a 4% cosmetic
 * fibre loading and a 20% structural one are both "CF". Reporting is honest;
 * deciding is the user's.
 */

import { settingFlagScalar } from "@/lib/slicerSettings";

/**
 * Fibre reinforcement, in the two spellings this codebase actually accepts:
 * as a whole token (`PA6-CF20`, `PET-GF`, `PP CF`) and as a separator-free
 * suffix (`PETGCF`, `PA6GF20`). The second is not hypothetical —
 * `stripReinforcement` in `referenceChapter.ts` handles it and its test pins
 * `PETGCF`, so a type in that form resolves to a reference chapter while going
 * unrecognised here would leave the filament out of the scan entirely.
 */
const FIBRE_TOKEN_RE = /(^|[-_ ])(CF|GF)\d*($|[-_ ])/i;
const FIBRE_SUFFIX_RE = /[-_ ]?(CF|GF)\d*$/i;

const isFibreType = (type: string): boolean =>
  FIBRE_TOKEN_RE.test(type) || FIBRE_SUFFIX_RE.test(type);

/**
 * Fills that are abrasive without a CF/GF token. Matched against type AND name
 * because these are product naming rather than a type suffix. Deliberately the
 * weakest signal — "Metallic Grey" is a pigment, not metal fill — so it alone
 * is suppressed by an explicit `filament_abrasive = "0"`.
 */
const FILLED_RE =
  /(^|[^a-z])(glow|metallic|metal[- ]?fill|steel[- ]?fill|bronze|iron[- ]?fill|marble|sparkle|glitter|wood)([^a-z]|$)/i;

/** OPT tag id 4 marks a filament abrasive; the form treats it as authoritative. */
export const OPT_TAG_ABRASIVE = 4;

/**
 * Tags that say the filament is abrasive, whether or not tag 4 is also set.
 *
 * Tag 4 is the generic marker, but the OPT vocabulary also has SPECIFIC tags
 * for the things that make a filament abrasive, and they are selectable in the
 * form. A record tagged `31` carbon fibre is stating the same fact more
 * precisely than tag 4 does, so reading only tag 4 discards the better
 * evidence: a plainly-typed `PLA` with `optTags: [31]`, no flag and a soft
 * nozzle went unreported entirely.
 *
 * Everything here abrades a soft nozzle in ordinary use — mineral and metal
 * fills, glass and carbon fibre, aramid, and the strontium-aluminate pigments
 * behind glow and sparkle. Deliberately NOT here: tags describing thermal or
 * mechanical behaviour, which say nothing about wear.
 */
const ABRASIVE_OPT_TAGS: ReadonlySet<number> = new Set([
  0, // CONTAINS_GLASS_FIBER
  1, // CONTAINS_ARAMID_FIBER
  4, // ABRASIVE
  19, // WOOD_FILL
  20, // METAL_FILL
  21, // STONE_FILL
  22, // SPARKLE
  23, // PHOSPHORESCENT
  24, // GLOW_IN_THE_DARK
  31, // CONTAINS_CARBON_FIBER
  32, // CONTAINS_KEVLAR
]);

export type AbrasiveReason = "flagged" | "tagged" | "fibre" | "filled";

export interface AuditNozzle {
  _id: unknown;
  name?: string | null;
  hardened?: boolean | null;
}

/** Pass the RESOLVED filament — `compatibleNozzles` and `optTags` both inherit. */
export interface AuditFilament {
  _id: unknown;
  name?: string | null;
  type?: string | null;
  optTags?: readonly number[] | null;
  settings?: Record<string, unknown> | null;
  compatibleNozzles?: readonly unknown[] | null;
}

export interface AbrasiveFinding {
  filamentId: string;
  filamentName: string;
  filamentType: string | null;
  /** Why this reads as abrasive — shown so a false positive can be judged. */
  reasons: AbrasiveReason[];
  /** Assigned nozzles that are not hardened. */
  softNozzles: { id: string; name: string }[];
  /**
   * No nozzles listed at all. Not benign: with nothing recorded, nothing can
   * hold this filament back from a soft nozzle — an empty list reads as "no
   * restriction", not as "unknown", everywhere it is consumed.
   */
  unassigned: boolean;
  /**
   * Material says abrasive but `filament_abrasive` is not effectively on. The
   * exported preset then asserts the filament is safe, and a firmware check
   * reading it (`M862.1 … A{filament_abrasive}`) will not refuse the print.
   *
   * Covers a value that is SET but unusable — a boolean `true`, say — not only
   * an absent or explicitly-off one. Downstream those are the same thing.
   */
  flagMismatch: boolean;
}

function idOf(ref: unknown): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  const v = (ref as { _id?: unknown })._id;
  return v == null ? null : String(v);
}

/**
 * Tri-state read of `filament_abrasive`.
 *
 * Borrows the GH #678 per-extruder collapse from `settingFlagScalar` — an
 * Orca/Bambu round-trip can store `["1","1"]`, and reading that shape locally
 * is exactly what that module's docblock forbids. It does NOT use
 * `settingFlagIsOn`: that answers a two-state question, and this one needs
 * three. Collapsing "unset" into "off" would let the `filled` name heuristic be
 * suppressed on every filament that simply never set the flag.
 */
function flagValue(filament: AuditFilament): "on" | "off" | "unset" | "unusable" {
  const raw = settingFlagScalar((filament.settings ?? {})["filament_abrasive"]);
  if (raw == null) return "unset";
  // Only what the rest of the app reads as ON counts as on. `settingFlagIsOn`
  // is `String(scalar) === "1"`, and the export writes the bag value through
  // verbatim, so a boolean `true` — which the generic API will happily store —
  // is read as OFF by the form, ships to the slicer as the literal `true`, and
  // is not `1` to a firmware `M862.1` check. Accepting it here would have this
  // audit call a record healthy that every consumer treats as unflagged, which
  // is the false all-clear the whole check exists to prevent.
  if (String(raw) === "1") return "on";
  if (raw === "0" || raw === 0 || raw === false) return "off";
  // Present but not a value anything downstream acts on. Someone set this
  // field, so it is evidence about the filament AND a defect in its own right.
  return "unusable";
}

/**
 * Why this filament reads as abrasive, strongest signal first.
 *
 * An explicit `"0"` suppresses only the `filled` name heuristic. It cannot
 * override a fibre-reinforced type or the OPT abrasive tag, because those are
 * statements about the material while the flag is a field the app itself
 * writes incorrectly (see the module docblock).
 */
export function abrasiveReasons(filament: AuditFilament): AbrasiveReason[] {
  const flag = flagValue(filament);
  const reasons: AbrasiveReason[] = [];

  if (flag === "on" || flag === "unusable") reasons.push("flagged");
  if ((filament.optTags ?? []).some((t) => ABRASIVE_OPT_TAGS.has(t))) reasons.push("tagged");
  if (isFibreType(filament.type ?? "")) reasons.push("fibre");
  if (flag !== "off" && FILLED_RE.test(`${filament.type ?? ""} ${filament.name ?? ""}`)) {
    reasons.push("filled");
  }
  return reasons;
}

/**
 * Scan for abrasive filaments that can reach an unfit nozzle, or whose flag
 * contradicts their material.
 *
 * A referenced nozzle missing from the catalogue counts as UNSAFE: a dangling
 * ref is not evidence of hardness.
 */
export function auditAbrasiveNozzles(
  filaments: readonly AuditFilament[],
  nozzles: readonly AuditNozzle[],
): AbrasiveFinding[] {
  const byId = new Map<string, AuditNozzle>();
  for (const n of nozzles) {
    const id = idOf(n);
    if (id) byId.set(id, n);
  }

  const findings: AbrasiveFinding[] = [];
  for (const f of filaments) {
    const reasons = abrasiveReasons(f);
    if (reasons.length === 0) continue;

    const refs = (f.compatibleNozzles ?? []).map(idOf).filter((x): x is string => !!x);
    const soft = refs
      .map((id) => ({ id, nozzle: byId.get(id) }))
      .filter(({ nozzle }) => nozzle?.hardened !== true)
      .map(({ id, nozzle }) => ({ id, name: nozzle?.name ?? "(unknown nozzle)" }));

    const unassigned = refs.length === 0;
    const flagMismatch = flagValue(f) !== "on";

    // Only report a filament that actually has a problem. An abrasive filament
    // correctly restricted to hardened nozzles AND correctly flagged is fine.
    //
    // NOT a reason to fire here: an ordinary export bakes an EMPTY
    // `compatible_printers_condition` (GH #1021), so on an UNSCOPED request
    // this list does not stop a soft-nozzle printer selecting the preset.
    // True — and uniformly true of every filament, which is the point. No edit
    // a user can make would clear such a finding, so raising it per row would
    // report every correctly-configured abrasive filament forever and bury the
    // two findings that ARE actionable. It is also no longer the whole story:
    // a request naming a printer IS filtered on this list, so keeping it
    // accurate has a direct effect and a correct list deserves silence here. The enforceable lever is
    // `filament_abrasive`, which does ride the settings bag into the export and
    // into the firmware's `M862.1` check — which is why `flagMismatch` is part
    // of this condition. The disclosure that assignments are advisory belongs
    // once, in the page copy, where it also covers the rows suppressed here.
    if (soft.length === 0 && !unassigned && !flagMismatch) continue;

    findings.push({
      filamentId: String(f._id),
      filamentName: f.name ?? "",
      filamentType: f.type ?? null,
      reasons,
      softNozzles: soft,
      unassigned,
      flagMismatch,
    });
  }

  // Worst first: reachable soft nozzle, then unassigned, then flag-only.
  const severity = (x: AbrasiveFinding) =>
    x.softNozzles.length > 0 ? 0 : x.unassigned ? 1 : 2;
  findings.sort(
    (a, b) => severity(a) - severity(b) || a.filamentName.localeCompare(b.filamentName),
  );
  return findings;
}
