import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createFilament } from "@/app/api/filaments/route";
import type { DecodedOpenPrintTag } from "@/lib/openprinttag-decode";

/**
 * Create-from-decoded-tag (mobile Phase 2, plan §4.4). The scanner POSTs the
 * tag exactly as POST /api/nfc/decode returned it (`tagData`) plus the user's
 * confirmed identity edits (`overrides`); the server maps it via
 * decodedTagToFilamentPayload and runs the normal create path. The pure mapping
 * is unit-tested in decodedTagToFilament.test.ts — here we pin the route wiring:
 * overrides win, required fields are still enforced, and mass-assignment strips
 * still apply to the merged body.
 */
describe("POST /api/filaments — create from decoded tag (#4.4)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  function postReq(body: unknown) {
    return new NextRequest("http://localhost/api/filaments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function tag(overrides: Partial<DecodedOpenPrintTag> = {}): DecodedOpenPrintTag {
    return { meta: {}, main: {}, ...overrides };
  }

  it("creates a filament from a decoded tag, mapping fields server-side", async () => {
    const res = await createFilament(
      postReq({
        tagData: tag({
          brandName: "Prusament",
          materialName: "PETG Jet Black",
          materialType: "PETG",
          color: "#101010",
          density: 1.27,
          diameter: 1.75,
          nozzleTemp: 250,
          nozzleTempMin: 240,
          bedTemp: 90,
          weightGrams: 1000,
          emptySpoolWeight: 215,
          tags: [4],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.name).toBe("Prusament PETG Jet Black");
    expect(created.vendor).toBe("Prusament");
    expect(created.type).toBe("PETG");
    expect(created.color).toBe("#101010");
    expect(created.temperatures.nozzle).toBe(250);
    expect(created.temperatures.nozzleRangeMin).toBe(240);
    expect(created.optTags).toEqual([4]);
    // Tag roll weight + tare land on filament-level fields (no spool subdoc).
    expect(created.netFilamentWeight).toBe(1000);
    expect(created.spoolWeight).toBe(215);
    // No spool fabricated on create (plan §4.4).
    expect(created.spools ?? []).toHaveLength(0);
  });

  it("lets user overrides win over the tag (the confirm-screen edits)", async () => {
    const res = await createFilament(
      postReq({
        tagData: tag({ brandName: "Generic", materialName: "PLA", materialType: "PLA", color: "#ffffff" }),
        overrides: { name: "My Custom White PLA", vendor: "HouseBrand", colorName: "Snow" },
      }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.name).toBe("My Custom White PLA");
    expect(created.vendor).toBe("HouseBrand");
    // Type still comes from the tag (not overridden).
    expect(created.type).toBe("PLA");
    // Color from the tag survives; the override only added a name.
    expect(created.color).toBe("#ffffff");
  });

  it("still enforces required identity fields (tag without vendor, no override → 400)", async () => {
    const res = await createFilament(
      postReq({ tagData: tag({ materialName: "Mystery Roll", materialType: "PLA" }) }),
    );
    expect(res.status).toBe(400);
    expect(await Filament.countDocuments({ name: "Mystery Roll" })).toBe(0);
  });

  it("preserves a null primary color for a coextruded tag", async () => {
    const res = await createFilament(
      postReq({
        tagData: tag({
          brandName: "Rainbow Co",
          materialName: "Coextruded PLA",
          materialType: "PLA",
          color: undefined,
          secondaryColors: ["#ff0000", "#0000ff"],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.color).toBeNull();
    expect(created.secondaryColors).toEqual(["#ff0000", "#0000ff"]);
  });

  it("does NOT adopt the tag's spool_uid as instanceId (stays system-assigned)", async () => {
    // The tag is unsigned client JSON; adopting its spool_uid as instanceId
    // would re-open the client-writable-instanceId hole the POST handler strips
    // (and could 409 on the partial-unique index). instanceId is auto-generated.
    const res = await createFilament(
      postReq({
        tagData: tag({ brandName: "B", materialName: "SystemId", materialType: "PLA", spoolUid: "abc123def0" }),
      }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.instanceId).not.toBe("abc123def0");
    expect(typeof created.instanceId).toBe("string");
  });

  it("applies mass-assignment strips to the merged body (overrides can't inject _purged/instanceId)", async () => {
    const res = await createFilament(
      postReq({
        tagData: tag({ brandName: "B", materialName: "Strip Test", materialType: "PLA" }),
        overrides: { _purged: true, instanceId: "hack-me", __v: 99 },
      }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created._purged).not.toBe(true);
    expect(created.instanceId).not.toBe("hack-me");
  });
});
