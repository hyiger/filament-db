/**
 * GH #641 — src/lib/nozzleTypes.ts had no direct coverage. Pins the three
 * `nozzleTypeLabel` branches (empty → "", known value → translated via
 * i18n key, unknown legacy value → raw passthrough) plus the catalog
 * invariants the module docblock promises: every `i18nKey` must exist in
 * BOTH locale files (the i18n-key-coverage test can't see these keys —
 * they're resolved dynamically, never as a literal `t("…")` call).
 */
import { describe, it, expect } from "vitest";
import { NOZZLE_TYPES, nozzleTypeLabel } from "@/lib/nozzleTypes";
import en from "@/i18n/locales/en.json";
import de from "@/i18n/locales/de.json";

const t = (key: string) => `T(${key})`;

describe("nozzleTypeLabel", () => {
  it("returns empty string for null / undefined / empty value", () => {
    expect(nozzleTypeLabel(null, t)).toBe("");
    expect(nozzleTypeLabel(undefined, t)).toBe("");
    expect(nozzleTypeLabel("", t)).toBe("");
  });

  it("translates known stored values through their i18n key", () => {
    expect(nozzleTypeLabel("Brass", t)).toBe("T(nozzleType.Brass)");
    expect(nozzleTypeLabel("Hardened Steel", t)).toBe(
      "T(nozzleType.HardenedSteel)",
    );
  });

  it("passes unknown legacy values through raw (never an empty cell)", () => {
    expect(nozzleTypeLabel("Unobtainium", t)).toBe("Unobtainium");
  });
});

describe("NOZZLE_TYPES catalog invariants", () => {
  it("has unique stored values", () => {
    const values = NOZZLE_TYPES.map((n) => n.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("every i18nKey resolves in both en and de locales", () => {
    for (const { i18nKey } of NOZZLE_TYPES) {
      expect((en as Record<string, string>)[i18nKey], `${i18nKey} in en`).toBeTruthy();
      expect((de as Record<string, string>)[i18nKey], `${i18nKey} in de`).toBeTruthy();
    }
  });
});
