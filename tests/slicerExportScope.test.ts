import { describe, it, expect } from "vitest";
import {
  nozzleIdsOf,
  isOfferableOnPrinter,
  resolvePrinterScope,
  unknownPrinterBody,
} from "@/lib/slicerExportScope";

/** Stand-in Printer model — only findOne/find with .select().lean() are used. */
function printerModel(rows: Array<Record<string, unknown>>) {
  const chain = (value: unknown) => ({ select: () => ({ lean: async () => value }) });
  return {
    findOne: (q: Record<string, unknown>) =>
      chain(rows.find((r) => String(r._id) === String(q._id) && r._deletedAt == null) ?? null),
    find: () => chain(rows.filter((r) => r._deletedAt == null)),
  };
}

const OID_A = "507f1f77bcf86cd799439011";
const OID_B = "507f1f77bcf86cd799439012";

describe("nozzleIdsOf", () => {
  it("reads populated docs, raw ids and strings alike", () => {
    expect(nozzleIdsOf({ compatibleNozzles: [{ _id: "n1" }, "n2", { _id: { toString: () => "n3" } }] }))
      .toEqual(new Set(["n1", "n2", "n3"]));
  });

  it("is empty for a filament with no nozzles, and tolerates junk", () => {
    expect(nozzleIdsOf({ compatibleNozzles: [] })).toEqual(new Set());
    expect(nozzleIdsOf({})).toEqual(new Set());
    expect(nozzleIdsOf(null)).toEqual(new Set());
    expect(nozzleIdsOf({ compatibleNozzles: "not-an-array" })).toEqual(new Set());
    expect(nozzleIdsOf({ compatibleNozzles: [null, undefined, { }] })).toEqual(new Set());
  });
});

describe("isOfferableOnPrinter", () => {
  const hardened = new Set(["dbk04", "wc04"]);

  it("offers a filament that shares a nozzle with the printer", () => {
    expect(isOfferableOnPrinter({ compatibleNozzles: ["dbk04"] }, hardened)).toBe(true);
  });

  it("withholds a filament with no nozzle in common — the reported bug", () => {
    // An abrasive filament assigned only hardened nozzles must not be offered
    // for a printer carrying the soft INDX.
    expect(isOfferableOnPrinter({ compatibleNozzles: ["dbk04", "wc04"] }, new Set(["indx"])))
      .toBe(false);
  });

  it("FAILS OPEN for a filament that lists no nozzles", () => {
    // Unknown compatibility is not known incompatibility. Filtering these out
    // would silently hide presets, which is the failure this design avoids.
    expect(isOfferableOnPrinter({ compatibleNozzles: [] }, new Set(["indx"]))).toBe(true);
    expect(isOfferableOnPrinter({}, new Set(["indx"]))).toBe(true);
  });

  it("withholds everything nozzle-bearing from a printer with no nozzles", () => {
    // A printer with nothing installed can run nothing that names a nozzle —
    // but the fail-open rule above still lets unassigned filaments through.
    expect(isOfferableOnPrinter({ compatibleNozzles: ["dbk04"] }, new Set())).toBe(false);
    expect(isOfferableOnPrinter({ compatibleNozzles: [] }, new Set())).toBe(true);
  });
});

describe("resolvePrinterScope", () => {
  const rows = [
    { _id: OID_A, name: "Bambu Labs H2D", installedNozzles: ["dbk04", { _id: "wc04" }] },
    { _id: OID_B, name: "Prusa Core One INDX", installedNozzles: ["indx"] },
    { _id: "507f1f77bcf86cd799439013", name: "Retired", _deletedAt: new Date() },
  ];

  it("returns 'none' for an absent or blank param — the response is unchanged", async () => {
    expect((await resolvePrinterScope(printerModel(rows), null)).kind).toBe("none");
    expect((await resolvePrinterScope(printerModel(rows), "   ")).kind).toBe("none");
  });

  it("resolves by ObjectId and collects the installed nozzles", async () => {
    const s = await resolvePrinterScope(printerModel(rows), OID_A);
    expect(s.kind).toBe("scoped");
    if (s.kind !== "scoped") return;
    expect(s.nozzleIds).toEqual(new Set(["dbk04", "wc04"]));
    expect(s.printerName).toBe("Bambu Labs H2D");
  });

  it("resolves by exact name", async () => {
    const s = await resolvePrinterScope(printerModel(rows), "Prusa Core One INDX");
    expect(s.kind === "scoped" && s.nozzleIds).toEqual(new Set(["indx"]));
  });

  it("falls back to a case-folded name match", async () => {
    const s = await resolvePrinterScope(printerModel(rows), "prusa core one indx");
    expect(s.kind === "scoped" && s.printerId).toBe(OID_B);
  });

  it("distinguishes an untrimmed twin — the verbatim rung, untrimmed", async () => {
    // Hybrid sync bypasses the trim setter, so "X" and "X " can both be live.
    // Trimming the parameter before this rung would silently answer with "X"
    // and filter the whole bundle against the wrong printer's nozzles.
    const twins = [
      { _id: OID_A, name: "Core One", installedNozzles: ["soft"] },
      { _id: OID_B, name: "Core One ", installedNozzles: ["hard"] },
    ];
    const spaced = await resolvePrinterScope(printerModel(twins), "Core One ");
    expect(spaced.kind === "scoped" && spaced.printerId).toBe(OID_B);
    const bare = await resolvePrinterScope(printerModel(twins), "Core One");
    expect(bare.kind === "scoped" && bare.printerId).toBe(OID_A);
  });

  it("still tolerates stray whitespace when there is no untrimmed twin", async () => {
    // The forgiving rung has to survive the strict one being added above.
    const s = await resolvePrinterScope(printerModel(rows), "  Prusa Core One INDX  ");
    expect(s.kind === "scoped" && s.printerId).toBe(OID_B);
  });

  it("prefers an exact name over a case-folded one", async () => {
    const dupes = [
      { _id: OID_A, name: "xl", installedNozzles: ["a"] },
      { _id: OID_B, name: "XL", installedNozzles: ["b"] },
    ];
    const s = await resolvePrinterScope(printerModel(dupes), "XL");
    expect(s.kind === "scoped" && s.printerId).toBe(OID_B);
  });

  it("does not resolve a soft-deleted printer", async () => {
    const s = await resolvePrinterScope(printerModel(rows), "Retired");
    expect(s.kind).toBe("not-found");
  });

  it("reports not-found for an unknown value rather than an empty scope", async () => {
    // An empty scope would filter the bundle to nothing — silent emptiness is
    // exactly what this must never do, so the caller can 400 instead.
    const s = await resolvePrinterScope(printerModel(rows), "No Such Printer");
    expect(s).toEqual({ kind: "not-found", raw: "No Such Printer" });
  });

  it("reports not-found for a well-formed id that matches nothing", async () => {
    const s = await resolvePrinterScope(printerModel(rows), "507f1f77bcf86cd7994390ff");
    expect(s.kind).toBe("not-found");
  });

  it("treats a printer with no installedNozzles as scoped-but-empty, not not-found", async () => {
    const s = await resolvePrinterScope(printerModel([{ _id: OID_A, name: "Bare" }]), "Bare");
    expect(s.kind).toBe("scoped");
    expect(s.kind === "scoped" && s.nozzleIds.size).toBe(0);
  });
});

describe("unknownPrinterBody", () => {
  it("names the offending value and says the param is optional", () => {
    const b = unknownPrinterBody("Prsua");
    expect(b.error).toBe("printer_not_found");
    expect(b.message).toContain("Prsua");
    expect(b.message).toMatch(/omit the parameter/i);
  });
});
