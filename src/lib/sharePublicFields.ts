/**
 * What a published shared catalog exposes (GH #1122).
 *
 * `/share/{slug}` is an UNAUTHENTICATED URL, so this is a publishing boundary.
 * It used to be a deny-list — strip four fields, publish everything else —
 * which leaks by default: every field added to the Filament schema since is
 * public unless someone remembers to deny it. That already put `cost` (what
 * the user paid per kg) and a handful of internal fields (`syncId`,
 * `openprinttagSnapshot`, `promotedByToken`, `_purged`, the promotion marker)
 * on a public page.
 *
 * Inverted to an allow-list, so a new field is private until it is
 * deliberately added here.
 *
 * ## What belongs on the list
 *
 * A shared catalog is a PRODUCT PROFILE: what the filament is and how to print
 * it. The recipient populates their own inventory. So the list carries
 * identity, appearance, material properties, temperatures, speeds, drying, the
 * slicer settings bag, and the calibration scaffolding — and deliberately not:
 *
 *  - inventory + PII — `spools` (lot numbers, purchase/open dates, photos,
 *    location refs, usage + dry history), `totalWeight`, `lowStockThreshold`,
 *    `instanceId`;
 *  - `cost` — what THIS user paid, not a property of the filament. It is also
 *    the field a reader is least likely to expect to be publishing;
 *  - sync/internal bookkeeping — `syncId`, `_purged`, `_deletedAt`,
 *    `promotionInFlight`, `promotedByToken`, `openprinttagSnapshot`,
 *    `createdAt`, `updatedAt`, `__v`.
 *
 * `_id` and `parentId` DO ship: `src/lib/shareImport.ts` builds its
 * source→local id map from `_id` and reparents variants through `parentId`.
 * They are source-DB ObjectIds — meaningless off that instance and not
 * sensitive — and dropping them would silently flatten every variant.
 */

import { NEVER_BAGGED_KEYS } from "@/lib/slicerSettings";
import { INI_TOP_LEVEL_SETTING_KEYS } from "@/lib/parseIni";

/**
 * Settings-bag keys that must never be published, even though the bag itself
 * is (GH #1122, Codex P1).
 *
 * The bag is arbitrary passthrough, so an allow-list on top-level fields alone
 * isn't enough: a filament imported by older INI code can still carry a
 * `filament_cost` SHADOW of the top-level field. `src/lib/iniImportApply.ts`
 * documents that those legacy shadows survive until a later import purges
 * them — so dropping top-level `cost` while copying the bag verbatim would
 * publish the purchase price anyway, exactly the leak this change is for.
 *
 * Reuses the two exported sets that already define "this key is a shadow of a
 * structured field" and "this key is a routing/id hint", so the strip can't
 * drift from the import side that creates them. Every shadow is redundant with
 * a top-level field we have already decided about, and every hint is
 * source-instance-specific, so nothing of value is lost.
 */
export const SHARED_SETTINGS_KEY_DENYLIST: ReadonlySet<string> = new Set<string>([
  ...NEVER_BAGGED_KEYS,
  ...INI_TOP_LEVEL_SETTING_KEYS,
]);

/**
 * Filament fields a published catalog may carry.
 *
 * Keep this in sync with `src/models/Filament.ts` when adding a field that is
 * genuinely part of the product profile. Anything not listed is private, which
 * is the point — the default must be "don't publish".
 */
export const SHARED_FILAMENT_FIELDS = [
  // Identity + structure (see the docblock on why the two ids ship).
  "_id",
  "parentId",
  "name",
  "vendor",
  "type",
  // Appearance
  "color",
  "secondaryColors",
  "colorName",
  "optTags",
  // Material properties
  "density",
  "diameter",
  "spoolType",
  "spoolWeight",
  "netFilamentWeight",
  "transmissionDistance",
  "glassTempTransition",
  "heatDeflectionTemp",
  "shoreHardnessA",
  "shoreHardnessD",
  "shrinkageXY",
  "shrinkageZ",
  // Print profile
  "temperatures",
  "bedTypeTemps",
  "maxVolumetricSpeed",
  "minPrintSpeed",
  "maxPrintSpeed",
  "dryingTemperature",
  "dryingTime",
  // Slicer scaffolding
  "compatibleNozzles",
  "calibrations",
  "presets",
  "settings",
  "inherits",
  "tdsUrl",
] as const;

export type SharedFilamentField = (typeof SHARED_FILAMENT_FIELDS)[number];

/**
 * Project a lean filament document down to the publishable fields.
 *
 * Absent keys are omitted rather than emitted as `undefined`, so the stored
 * payload stays the same shape a reader would expect from the API.
 */
export function pickSharedFilamentFields(
  doc: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SHARED_FILAMENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(doc, field)) out[field] = doc[field];
  }
  if (out.settings) out.settings = sanitizeSharedSettings(out.settings);
  return out;
}

/**
 * Drop the deny-listed keys from a settings bag.
 *
 * Returns the value untouched when it isn't a plain object — the bag is
 * passthrough and a malformed one shouldn't throw on the publish path.
 */
export function sanitizeSharedSettings(settings: unknown): unknown {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return settings;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings as Record<string, unknown>)) {
    if (SHARED_SETTINGS_KEY_DENYLIST.has(k)) continue;
    out[k] = v;
  }
  return out;
}
