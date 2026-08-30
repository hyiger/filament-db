import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { GET } from "@/app/api/abrasive-nozzles/route";

/**
 * The audit has to see what the PRINTER sees, which means resolved values.
 * These pin the two things a pure-function test cannot: that inheritance is
 * resolved before the scan, and that a soft-deleted nozzle reference reads as
 * a stale assignment rather than silently vanishing.
 */
describe("GET /api/abrasive-nozzles", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any, Nozzle: any;
  let softId: string, hardId: string;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    Filament = mongoose.models.Filament;
    Nozzle = mongoose.models.Nozzle;

    const soft = await Nozzle.create({
      name: "INDX 0.4 HF", diameter: 0.4, type: "Other", highFlow: true, hardened: false,
    });
    const hard = await Nozzle.create({
      name: "WC HF 0.4", diameter: 0.4, type: "Tungsten Carbide", highFlow: true, hardened: true,
    });
    softId = String(soft._id);
    hardId = String(hard._id);
  });

  const scan = async () => (await GET()).json();

  it("reports an abrasive filament assigned a soft nozzle", async () => {
    await Filament.create({
      name: "Fiberon PA6-CF20", vendor: "Fiberon", type: "PA6-CF", color: "#111111",
      settings: { filament_abrasive: "1" },
      compatibleNozzles: [hardId, softId],
    });
    const { findings } = await scan();
    expect(findings).toHaveLength(1);
    expect(findings[0].filamentName).toBe("Fiberon PA6-CF20");
    expect(findings[0].softNozzles).toEqual([{ id: softId, name: "INDX 0.4 HF" }]);
  });

  it("says nothing about a correctly restricted, correctly flagged abrasive", async () => {
    await Filament.create({
      name: "Siraya Tech PET-CF", vendor: "Siraya Tech", type: "PET-CF", color: "#222222",
      settings: { filament_abrasive: "1" },
      compatibleNozzles: [hardId],
    });
    expect((await scan()).findings).toEqual([]);
  });

  it("reports the flag contradiction that ships in the exported preset", async () => {
    // `FilamentForm` persists `form.abrasive ? "1" : "0"` while its own
    // predicate also honours OPT tag 4, so a tag-marked abrasive exports
    // `filament_abrasive = 0` — telling the INDX firmware's M862.1 check the
    // filament is safe. Nozzles right, flag lying.
    await Filament.create({
      name: "Polymaker HT-PLA-GF Black", vendor: "Polymaker", type: "HT-PLA-GF",
      color: "#333333", optTags: [4], settings: { filament_abrasive: "0" },
      compatibleNozzles: [hardId],
    });
    const [finding] = (await scan()).findings;
    expect(finding.flagMismatch).toBe(true);
    expect(finding.reasons).toEqual(expect.arrayContaining(["tagged", "fibre"]));
    expect(finding.softNozzles).toEqual([]);
  });

  it("resolves an inherited nozzle set and names the template to fix", async () => {
    // The variant stores nothing; its effective set is the template's. Auditing
    // the stored array would clear every variant of a wrongly-assigned family.
    const template = await Filament.create({
      name: "Acme PPS-CF", vendor: "Acme", type: "PPS-CF",
      settings: { filament_abrasive: "1" },
      compatibleNozzles: [softId],
    });
    await Filament.create({
      name: "Acme PPS-CF Black", vendor: "Acme", type: "PPS-CF", color: "#000000",
      parentId: template._id,
    });
    const { findings } = await scan();
    const variant = findings.find(
      (f: { filamentName: string }) => f.filamentName === "Acme PPS-CF Black",
    );
    expect(variant.softNozzles).toEqual([{ id: softId, name: "INDX 0.4 HF" }]);
    expect(variant.inheritedFrom).toBe("Acme PPS-CF");
  });

  it("does not blame the template for a variant's own assignment", async () => {
    const template = await Filament.create({
      name: "Acme PA-CF", vendor: "Acme", type: "PA-CF",
      settings: { filament_abrasive: "1" }, compatibleNozzles: [hardId],
    });
    await Filament.create({
      name: "Acme PA-CF Grey", vendor: "Acme", type: "PA-CF", color: "#888888",
      parentId: template._id, compatibleNozzles: [softId],
    });
    const { findings } = await scan();
    const variant = findings.find(
      (f: { filamentName: string }) => f.filamentName === "Acme PA-CF Grey",
    );
    expect(variant.inheritedFrom).toBeNull();
  });

  it("reports a reference to a soft-deleted nozzle as a stale assignment", async () => {
    const gone = await Nozzle.create({
      name: "Retired Diamondback", diameter: 0.4, type: "Other", hardened: true,
      _deletedAt: new Date(),
    });
    await Filament.create({
      name: "Prusament PP CF", vendor: "Prusa", type: "PP-CF", color: "#444444",
      settings: { filament_abrasive: "1" }, compatibleNozzles: [gone._id],
    });
    const [finding] = (await scan()).findings;
    expect(finding.softNozzles).toEqual([
      { id: String(gone._id), name: "(unknown nozzle)" },
    ]);
  });

  it("does not audit a template alongside the variants that inherit from it", async () => {
    // A template is not printable stock, so a finding against it is a card for
    // a filament nobody can load — and a duplicate of the variant's own.
    const template = await Filament.create({
      name: "Acme PA-CF", vendor: "Acme", type: "PA-CF",
      settings: { filament_abrasive: "1" }, compatibleNozzles: [softId],
    });
    await Filament.create({
      name: "Acme PA-CF Red", vendor: "Acme", type: "PA-CF", color: "#ff0000",
      parentId: template._id,
    });
    const { findings } = await scan();
    expect(findings.map((f: { filamentName: string }) => f.filamentName))
      .toEqual(["Acme PA-CF Red"]);
    expect(findings[0].inheritedFrom).toBe("Acme PA-CF");
  });

  it("still audits a standalone, and a parent whose only variant is trashed", async () => {
    // Template-ness is derived from LIVE variants, so a trashed-only parent is
    // a standalone again — and printable, so it must stay in the scan.
    const parent = await Filament.create({
      name: "Acme PPA-CF", vendor: "Acme", type: "PPA-CF", color: "#00ff00",
      settings: { filament_abrasive: "1" }, compatibleNozzles: [softId],
    });
    await Filament.create({
      name: "Acme PPA-CF Blue", vendor: "Acme", type: "PPA-CF", color: "#0000ff",
      parentId: parent._id, _deletedAt: new Date(),
    });
    const { findings } = await scan();
    expect(findings.map((f: { filamentName: string }) => f.filamentName))
      .toEqual(["Acme PPA-CF"]);
  });

  it("ignores trashed and purged filaments", async () => {
    await Filament.create({
      name: "Trashed CF", vendor: "Acme", type: "PA-CF", color: "#555555",
      compatibleNozzles: [softId], _deletedAt: new Date(),
    });
    await Filament.create({
      name: "Purged CF", vendor: "Acme", type: "PA-CF", color: "#666666",
      compatibleNozzles: [softId], _purged: true,
    });
    expect((await scan()).findings).toEqual([]);
  });

  it("returns an empty list rather than erroring on an empty database", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).findings).toEqual([]);
  });
});
