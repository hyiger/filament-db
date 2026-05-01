import { describe, it, expect } from "vitest";
import {
  addCustomCurrency,
  normaliseCode,
  normaliseSymbol,
  parseCustomCurrencies,
  removeCustomCurrency,
  serializeCustomCurrencies,
  validateCustomCurrency,
  type CustomCurrency,
} from "@/lib/customCurrency";

/**
 * GH #140 — pure-logic guards for the user-defined currency list. Keeping
 * these tests off the hook (which depends on React + window) lets us pin
 * down validation, parsing, and dedup behaviour without jsdom.
 */

const BUILT_IN = ["USD", "EUR", "GBP", "JPY", "SEK", "NOK", "DKK", "CHF", "CAD", "AUD", "CNY", "PLN", "CZK"];

describe("normaliseCode", () => {
  it("trims whitespace and uppercases", () => {
    expect(normaliseCode("  sek  ")).toBe("SEK");
  });

  it("leaves already-uppercase input alone", () => {
    expect(normaliseCode("SEK")).toBe("SEK");
  });
});

describe("normaliseSymbol", () => {
  it("trims whitespace but keeps casing (symbols are case-significant)", () => {
    expect(normaliseSymbol("  kr  ")).toBe("kr");
    expect(normaliseSymbol("Fr")).toBe("Fr");
  });
});

describe("validateCustomCurrency", () => {
  it("returns null for a valid entry", () => {
    expect(
      validateCustomCurrency(
        { code: "INR", symbol: "₹", name: "Indian Rupee" },
        BUILT_IN,
        [],
      ),
    ).toBeNull();
  });

  it("flags empty / too-short / too-long codes", () => {
    expect(validateCustomCurrency({ code: "", symbol: "$" }, BUILT_IN, [])).toBe("code-empty");
    expect(validateCustomCurrency({ code: "X", symbol: "$" }, BUILT_IN, [])).toBe("code-too-short");
    expect(validateCustomCurrency({ code: "TOOLONG", symbol: "$" }, BUILT_IN, [])).toBe("code-too-long");
  });

  it("flags codes with invalid characters or wrong shape", () => {
    expect(validateCustomCurrency({ code: "us d", symbol: "$" }, BUILT_IN, [])).toBe("code-invalid-chars");
    expect(validateCustomCurrency({ code: "9XY", symbol: "$" }, BUILT_IN, [])).toBe("code-invalid-chars"); // must start with a letter
    expect(validateCustomCurrency({ code: "u$d", symbol: "$" }, BUILT_IN, [])).toBe("code-invalid-chars");
  });

  it("flags collisions with the built-in list", () => {
    expect(
      validateCustomCurrency({ code: "USD", symbol: "$" }, BUILT_IN, []),
    ).toBe("code-collides-builtin");
    expect(
      validateCustomCurrency({ code: "SEK", symbol: "kr" }, BUILT_IN, []),
    ).toBe("code-collides-builtin");
  });

  it("flags duplicates against the existing custom list", () => {
    const existing: CustomCurrency[] = [{ code: "INR", symbol: "₹", name: "Indian Rupee" }];
    expect(
      validateCustomCurrency({ code: "INR", symbol: "₹" }, BUILT_IN, existing),
    ).toBe("code-duplicate");
  });

  it("flags empty / too-long symbols", () => {
    expect(validateCustomCurrency({ code: "INR", symbol: "" }, BUILT_IN, [])).toBe("symbol-empty");
    expect(
      validateCustomCurrency({ code: "INR", symbol: "TooManyChars" }, BUILT_IN, []),
    ).toBe("symbol-too-long");
  });
});

describe("addCustomCurrency / removeCustomCurrency", () => {
  it("appends without mutating the input", () => {
    const base: CustomCurrency[] = [{ code: "INR", symbol: "₹", name: "Indian Rupee" }];
    const next = addCustomCurrency(base, { code: "BRL", symbol: "R$", name: "Brazilian Real" });
    expect(next).toHaveLength(2);
    expect(base).toHaveLength(1); // unchanged
    expect(next[1].code).toBe("BRL");
  });

  it("removes by code (uppercase-normalised) without mutating input", () => {
    const base: CustomCurrency[] = [
      { code: "INR", symbol: "₹", name: "" },
      { code: "BRL", symbol: "R$", name: "" },
    ];
    const next = removeCustomCurrency(base, "  inr  ");
    expect(next.map((c) => c.code)).toEqual(["BRL"]);
    expect(base).toHaveLength(2); // unchanged
  });

  it("removeCustomCurrency is a no-op for codes that aren't present", () => {
    const base: CustomCurrency[] = [{ code: "INR", symbol: "₹", name: "" }];
    expect(removeCustomCurrency(base, "ZZZ")).toEqual(base);
  });
});

describe("parseCustomCurrencies", () => {
  it("returns [] for null / undefined / empty input", () => {
    expect(parseCustomCurrencies(null, BUILT_IN)).toEqual([]);
    expect(parseCustomCurrencies(undefined, BUILT_IN)).toEqual([]);
    expect(parseCustomCurrencies("", BUILT_IN)).toEqual([]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseCustomCurrencies("{not json", BUILT_IN)).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseCustomCurrencies('{"code": "INR"}', BUILT_IN)).toEqual([]);
  });

  it("drops malformed entries (missing fields, wrong types)", () => {
    const json = JSON.stringify([
      { code: "INR", symbol: "₹", name: "Indian Rupee" }, // valid
      { code: "BRL" }, // missing symbol
      { code: 123, symbol: "$" }, // wrong type
      null, // not an object
      "string", // not an object
    ]);
    const result = parseCustomCurrencies(json, BUILT_IN);
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe("INR");
  });

  it("drops entries colliding with built-ins (defensive against poisoned prefs)", () => {
    const json = JSON.stringify([
      { code: "USD", symbol: "$", name: "" },
      { code: "INR", symbol: "₹", name: "" },
    ]);
    const result = parseCustomCurrencies(json, BUILT_IN);
    expect(result.map((c) => c.code)).toEqual(["INR"]);
  });

  it("drops duplicate codes within the persisted list", () => {
    const json = JSON.stringify([
      { code: "INR", symbol: "₹", name: "first" },
      { code: "INR", symbol: "Rs", name: "second" },
    ]);
    const result = parseCustomCurrencies(json, BUILT_IN);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("first"); // first wins
  });

  it("normalises codes from storage (lowercase → uppercase)", () => {
    const json = JSON.stringify([{ code: "inr", symbol: "₹", name: "" }]);
    const result = parseCustomCurrencies(json, BUILT_IN);
    expect(result[0].code).toBe("INR");
  });

  it("drops entries with too-long symbols (matches addCustomCurrency contract)", () => {
    const json = JSON.stringify([
      { code: "BAD", symbol: "TooMany", name: "" },
      { code: "INR", symbol: "₹", name: "" },
    ]);
    const result = parseCustomCurrencies(json, BUILT_IN);
    expect(result.map((c) => c.code)).toEqual(["INR"]);
  });
});

describe("serializeCustomCurrencies + parseCustomCurrencies round-trip", () => {
  it("preserves a valid list across a write/read cycle", () => {
    const list: CustomCurrency[] = [
      { code: "INR", symbol: "₹", name: "Indian Rupee" },
      { code: "BRL", symbol: "R$", name: "Brazilian Real" },
    ];
    const json = serializeCustomCurrencies(list);
    expect(parseCustomCurrencies(json, BUILT_IN)).toEqual(list);
  });

  it("round-trips an empty list", () => {
    const json = serializeCustomCurrencies([]);
    expect(parseCustomCurrencies(json, BUILT_IN)).toEqual([]);
  });
});
