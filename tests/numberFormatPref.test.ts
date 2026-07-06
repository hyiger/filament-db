import { describe, it, expect } from "vitest";
import {
  DEFAULT_NUMBER_FORMAT,
  GROUP_SPACE,
  PRESET_SEPARATORS,
  isValidSeparators,
  normalizeNumberFormat,
  resolveSeparators,
  formatWithSeparators,
} from "@/lib/numberFormatPref";

describe("isValidSeparators", () => {
  it("accepts distinct single non-digit chars", () => {
    expect(isValidSeparators(",", ".")).toBe(true);
    expect(isValidSeparators(".", ",")).toBe(true);
    expect(isValidSeparators(GROUP_SPACE, ",")).toBe(true);
    expect(isValidSeparators("'", ".")).toBe(true);
  });
  it("rejects equal, empty, multi-char, or digit separators", () => {
    expect(isValidSeparators(",", ",")).toBe(false);
    expect(isValidSeparators("", ".")).toBe(false);
    expect(isValidSeparators(",", "")).toBe(false);
    expect(isValidSeparators(",,", ".")).toBe(false);
    expect(isValidSeparators("1", ".")).toBe(false);
    expect(isValidSeparators(",", "9")).toBe(false);
  });
});

describe("normalizeNumberFormat", () => {
  it("falls back to system for non-object / unknown mode", () => {
    expect(normalizeNumberFormat(null)).toEqual({ mode: "system" });
    expect(normalizeNumberFormat("usuk")).toEqual({ mode: "system" });
    expect(normalizeNumberFormat(7)).toEqual({ mode: "system" });
    expect(normalizeNumberFormat({ mode: "bogus" })).toEqual({ mode: "system" });
    expect(normalizeNumberFormat({ mode: 5 })).toEqual({ mode: "system" });
  });
  it("keeps a known mode and string separators; drops non-strings", () => {
    expect(normalizeNumberFormat({ mode: "european" })).toEqual({ mode: "european" });
    expect(normalizeNumberFormat({ mode: "custom", group: " ", decimal: "," })).toEqual({
      mode: "custom",
      group: " ",
      decimal: ",",
    });
    // Preserved across a preset so toggling back to custom keeps them.
    expect(normalizeNumberFormat({ mode: "usuk", group: "'", decimal: "." })).toEqual({
      mode: "usuk",
      group: "'",
      decimal: ".",
    });
    expect(normalizeNumberFormat({ mode: "custom", group: 5, decimal: "," })).toEqual({
      mode: "custom",
      decimal: ",",
    });
  });
});

describe("resolveSeparators", () => {
  it("returns null for system (use Intl)", () => {
    expect(resolveSeparators({ mode: "system" })).toBeNull();
    expect(resolveSeparators(DEFAULT_NUMBER_FORMAT)).toBeNull();
  });
  it("returns the fixed pair for each preset", () => {
    expect(resolveSeparators({ mode: "usuk" })).toEqual(PRESET_SEPARATORS.usuk);
    expect(resolveSeparators({ mode: "european" })).toEqual(PRESET_SEPARATORS.european);
    expect(resolveSeparators({ mode: "space" })).toEqual(PRESET_SEPARATORS.space);
    expect(resolveSeparators({ mode: "none" })).toEqual(PRESET_SEPARATORS.none);
  });
  it("returns a valid custom pair and null for an invalid/missing one", () => {
    expect(resolveSeparators({ mode: "custom", group: " ", decimal: "," })).toEqual({
      group: " ",
      decimal: ",",
    });
    expect(resolveSeparators({ mode: "custom", group: ",", decimal: "," })).toBeNull();
    expect(resolveSeparators({ mode: "custom" })).toBeNull();
    expect(resolveSeparators({ mode: "custom", group: "12", decimal: "." })).toBeNull();
  });
});

describe("formatWithSeparators", () => {
  const usuk = PRESET_SEPARATORS.usuk;
  const eu = PRESET_SEPARATORS.european;
  const sp = PRESET_SEPARATORS.space;

  it("groups large numbers per the chosen separators", () => {
    expect(formatWithSeparators(1245414.45, usuk)).toBe("1,245,414.45");
    expect(formatWithSeparators(1245414.45, eu)).toBe("1.245.414,45");
    expect(formatWithSeparators(1245414.45, sp)).toBe(`1${GROUP_SPACE}245${GROUP_SPACE}414,45`);
  });
  it("the None preset renders no thousands grouping, dot decimal", () => {
    const none = PRESET_SEPARATORS.none;
    expect(formatWithSeparators(12345689.56, none)).toBe("12345689.56");
    expect(formatWithSeparators(1000, none)).toBe("1000");
    expect(formatWithSeparators(1234.5, none)).toBe("1234.5");
  });
  it("groups on 4- and 7-digit boundaries correctly", () => {
    expect(formatWithSeparators(1000, usuk)).toBe("1,000");
    expect(formatWithSeparators(999, usuk)).toBe("999");
    expect(formatWithSeparators(1234567, usuk)).toBe("1,234,567");
  });
  it("trims trailing zeros by default (formatGrams look)", () => {
    expect(formatWithSeparators(210.0, usuk)).toBe("210");
    expect(formatWithSeparators(39.5, usuk)).toBe("39.5");
    expect(formatWithSeparators(1.005, usuk)).toBe("1.01"); // tie rounds up
  });
  it("honors minDecimals (currency-style 2dp) and maxDecimals", () => {
    expect(formatWithSeparators(5, usuk, { minDecimals: 2, trimTrailingZeros: false })).toBe("5.00");
    expect(formatWithSeparators(1234.5, eu, { minDecimals: 2, trimTrailingZeros: false })).toBe(
      "1.234,50",
    );
    expect(formatWithSeparators(1.239, usuk, { maxDecimals: 2 })).toBe("1.24");
    // trim removes the zeros, then the pad loop restores them up to minDecimals
    expect(formatWithSeparators(2, usuk, { minDecimals: 2 })).toBe("2.00");
    expect(formatWithSeparators(1.5, eu, { minDecimals: 2 })).toBe("1,50");
  });
  it("supports zero-decimal (JPY-style) via maxDecimals:0", () => {
    expect(formatWithSeparators(1234.9, usuk, { maxDecimals: 0 })).toBe("1,235");
  });
  it("can disable grouping for small config numbers", () => {
    expect(formatWithSeparators(1234.56, eu, { useGrouping: false })).toBe("1234,56");
    expect(formatWithSeparators(1.24, eu, { useGrouping: false })).toBe("1,24");
  });
  it("handles negatives (and never renders a signed zero)", () => {
    expect(formatWithSeparators(-1234.5, usuk)).toBe("-1,234.5");
    expect(formatWithSeparators(-0.001, usuk, { maxDecimals: 2 })).toBe("0");
    expect(formatWithSeparators(0, usuk)).toBe("0");
  });
  it("survives absurdly large finite values via the defensive fallback", () => {
    // >= 1e21 stringifies in exponential form, so the parser-trick rounding
    // yields NaN and the formatter falls back to the raw magnitude rather than
    // rendering "NaN". Absurd for a weight/price, but must not crash.
    const out = formatWithSeparators(1e21, usuk);
    expect(out).not.toBe("");
    expect(out).not.toMatch(/NaN/);
  });

  it("returns empty string for null / NaN / Infinity", () => {
    // @ts-expect-error runtime guard
    expect(formatWithSeparators(null, usuk)).toBe("");
    expect(formatWithSeparators(NaN, usuk)).toBe("");
    expect(formatWithSeparators(Infinity, usuk)).toBe("");
  });
});
