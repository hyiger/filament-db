import { describe, it, expect } from "vitest";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import de from "../src/i18n/locales/de.json" with { type: "json" };
import { OPT_TAG } from "@/lib/openprinttag";
import { LEGACY_OPT_TAG, LEGACY_TO_SPEC } from "@/lib/optTagLegacy";
import {
  optTagLabelKey,
  legacyOptTagLabelKey,
  optTagLabel,
  legacyOptTagLabel,
  FORM_TAG_GROUPS,
} from "@/lib/optTagLabels";

/**
 * GH #1227: every tag id the app can show has a label in BOTH locales, and
 * the form's checkbox table is consistent with the enum. The i18n coverage
 * test only sees literal `t("…")` calls; these keys are looked up through a
 * table, so they are pinned here instead.
 */
const enKeys = en as Record<string, string>;
const deKeys = de as Record<string, string>;

describe("optTag.* label keys", () => {
  it("exist in en + de for every spec tag, plus the unknown placeholder", () => {
    for (const [name, id] of Object.entries(OPT_TAG)) {
      const key = optTagLabelKey(id);
      expect(key, name).toBe(`optTag.${name.toLowerCase()}`);
      expect(enKeys[key!], `en ${key}`).toBeTruthy();
      expect(deKeys[key!], `de ${key}`).toBeTruthy();
    }
    expect(enKeys["optTag.unknown"]).toContain("{id}");
    expect(deKeys["optTag.unknown"]).toContain("{id}");
  });

  it("returns null for an id the enum does not know", () => {
    expect(optTagLabelKey(18)).toBeNull();
    expect(optTagLabelKey(75)).toBeNull();
  });

  it("exist for every legacy concept the conversion can DROP (Data health names them)", () => {
    for (const [name, id] of Object.entries(LEGACY_OPT_TAG)) {
      if (LEGACY_TO_SPEC[id] !== null) continue;
      const key = legacyOptTagLabelKey(id);
      expect(key, name).toBe(`optTagLegacy.${name.toLowerCase()}`);
      expect(enKeys[key!], `en ${key}`).toBeTruthy();
      expect(deKeys[key!], `de ${key}`).toBeTruthy();
    }
    expect(legacyOptTagLabelKey(99)).toBeNull();
  });

  it("optTagLabel / legacyOptTagLabel translate through t() and fall back to the unknown placeholder", () => {
    const t = (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${params.id}` : key;
    expect(optTagLabel(t, 20)).toBe("optTag.transparent");
    expect(optTagLabel(t, 75)).toBe("optTag.unknown:75");
    expect(legacyOptTagLabel(t, 9)).toBe("optTagLegacy.flexible");
    expect(legacyOptTagLabel(t, 99)).toBe("optTag.unknown:99");
  });
});

describe("FORM_TAG_GROUPS", () => {
  it("lists only spec ids, each once, with its own label key, and group headings that exist", () => {
    const seen = new Set<number>();
    const specIds = new Set<number>(Object.values(OPT_TAG));
    for (const group of FORM_TAG_GROUPS) {
      expect(enKeys[group.labelKey], group.labelKey).toBeTruthy();
      expect(deKeys[group.labelKey], group.labelKey).toBeTruthy();
      for (const [id, labelKey] of group.tags) {
        expect(specIds.has(id), `id ${id}`).toBe(true);
        expect(seen.has(id), `duplicate ${id}`).toBe(false);
        seen.add(id);
        expect(labelKey).toBe(optTagLabelKey(id));
      }
    }
    // The arrangement tags are the multi-color editor's, not checkboxes.
    expect(seen.has(OPT_TAG.GRADUAL_COLOR_CHANGE)).toBe(false);
    expect(seen.has(OPT_TAG.COEXTRUDED)).toBe(false);
    // The abrasive/soluble pair the form keeps in sync with its booleans.
    expect(seen.has(OPT_TAG.ABRASIVE)).toBe(true);
    expect(seen.has(OPT_TAG.WATER_SOLUBLE)).toBe(true);
  });
});
