/**
 * The five `Location.kind` values the UI picker offers and that have
 * `locations.kind.*` translations (see LocationForm's LOCATION_KINDS).
 *
 * `Location.kind` is intentionally a free-form string (no schema enum), and
 * `POST /api/locations` stores it unvalidated, so a kind created via the REST
 * API can be anything. The render sites translate it with `t(\`locations.kind.${kind}\`)`,
 * and the i18n provider returns the raw key string when a key is missing — so
 * an unknown kind would render the literal `locations.kind.garage`. Guard with
 * `isKnownLocationKind` before translating so an unknown kind falls back to its
 * raw value instead. (#822)
 */
export const KNOWN_LOCATION_KINDS = [
  "shelf",
  "drybox",
  "cabinet",
  "printer",
  "other",
] as const;

export type KnownLocationKind = (typeof KNOWN_LOCATION_KINDS)[number];

export function isKnownLocationKind(
  kind: string | null | undefined,
): kind is KnownLocationKind {
  return kind != null && (KNOWN_LOCATION_KINDS as readonly string[]).includes(kind);
}
