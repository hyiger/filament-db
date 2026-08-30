/**
 * Data-health check: abrasive filament that can reach a nozzle unfit for it,
 * or whose abrasive flag contradicts its material.
 *
 * Fibre-, metal- and glow-filled filaments erode a soft nozzle. Brass goes in
 * hours; a nitrocarburized or nitrided steel nozzle has a hardened case
 * measured in microns and fares little better. Only a through-hardened,
 * carbide or ruby-tipped nozzle survives them.
 *
 * WHY THIS EXISTS. `compatibleNozzles` is what every consumer trusts to keep an
 * abrasive filament away from a nozzle it would ruin, and it is maintained by
 * hand, so it goes stale silently. A filament typed `PC` when its nozzles were
 * assigned keeps that permissive set after being retyped `PC-CF`; nothing
 * errors, nothing warns, and the wrong nozzle stays on the list.
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

/** Fibre reinforcement as a whole token: `PA6-CF20`, `PET-GF`, `PP CF`. */
const FIBRE_RE = /(^|[-_ ])(CF|GF)\d*($|[-_ ])/i;

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
   * Material says abrasive but `filament_abrasive` is not `"1"`. The exported
   * preset then asserts the filament is safe, and a firmware check reading it
   * (`M862.1 … A{filament_abrasive}`) will not refuse the print.
   */
  flagMismatch: boolean;
}

function idOf(ref: unknown): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  const v = (ref as { _id?: unknown })._id;
  return v == null ? null : String(v);
}

function flagValue(filament: AuditFilament): "on" | "off" | "unset" {
  const raw = (filament.settings ?? {})["filament_abrasive"];
  if (raw === "1" || raw === 1 || raw === true) return "on";
  if (raw === "0" || raw === 0 || raw === false) return "off";
  return "unset";
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

  if (flag === "on") reasons.push("flagged");
  if ((filament.optTags ?? []).includes(OPT_TAG_ABRASIVE)) reasons.push("tagged");
  if (FIBRE_RE.test(filament.type ?? "")) reasons.push("fibre");
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
