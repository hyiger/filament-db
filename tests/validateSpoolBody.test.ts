import { describe, it, expect } from "vitest";
import { validateSpoolBody } from "@/lib/validateSpoolBody";

describe("validateSpoolBody (POST semantics)", () => {
  it("accepts an empty body and defaults label/totalWeight", () => {
    const r = validateSpoolBody({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBe("");
    expect(r.totalWeight).toBe(null);
  });

  it("accepts a well-formed body", () => {
    const r = validateSpoolBody({ label: "Spool A", totalWeight: 1250 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBe("Spool A");
    expect(r.totalWeight).toBe(1250);
  });

  it("accepts totalWeight: null explicitly", () => {
    const r = validateSpoolBody({ label: "X", totalWeight: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalWeight).toBe(null);
  });

  it("rejects non-string label", () => {
    const r = validateSpoolBody({ label: 123, totalWeight: 100 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/label/);
  });

  it("rejects non-numeric totalWeight", () => {
    const r = validateSpoolBody({ label: "X", totalWeight: "abc" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/totalWeight/);
  });

  it("rejects NaN and Infinity totalWeight", () => {
    expect(validateSpoolBody({ totalWeight: NaN }).ok).toBe(false);
    expect(validateSpoolBody({ totalWeight: Infinity }).ok).toBe(false);
    expect(validateSpoolBody({ totalWeight: -Infinity }).ok).toBe(false);
  });

  it("rejects negative totalWeight", () => {
    const r = validateSpoolBody({ totalWeight: -50 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/non-negative/);
  });

  it("rejects a non-object body", () => {
    expect(validateSpoolBody(null).ok).toBe(false);
    expect(validateSpoolBody("not an object").ok).toBe(false);
    expect(validateSpoolBody([1, 2, 3]).ok).toBe(false);
    expect(validateSpoolBody(42).ok).toBe(false);
  });

  it("passes through optional string fields", () => {
    const r = validateSpoolBody({
      lotNumber: "L123",
      purchaseDate: "2025-01-01",
      openedDate: "2025-02-01",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lotNumber).toBe("L123");
    expect(r.purchaseDate).toBe("2025-01-01");
    expect(r.openedDate).toBe("2025-02-01");
  });

  it("accepts null for optional string fields", () => {
    const r = validateSpoolBody({ lotNumber: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lotNumber).toBe(null);
  });

  it("rejects non-string optional fields", () => {
    expect(validateSpoolBody({ lotNumber: 12345 }).ok).toBe(false);
    expect(validateSpoolBody({ purchaseDate: { invalid: true } }).ok).toBe(false);
  });
});

describe("validateSpoolBody (PUT semantics with partial: true)", () => {
  it("does not default missing fields", () => {
    const r = validateSpoolBody({}, { partial: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBeUndefined();
    expect(r.totalWeight).toBeUndefined();
  });

  it("validates only fields that are present", () => {
    const r = validateSpoolBody({ totalWeight: 500 }, { partial: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalWeight).toBe(500);
    expect(r.label).toBeUndefined();
  });

  it("still rejects invalid types in partial mode", () => {
    expect(validateSpoolBody({ totalWeight: "x" }, { partial: true }).ok).toBe(false);
    expect(validateSpoolBody({ label: false }, { partial: true }).ok).toBe(false);
  });
});
