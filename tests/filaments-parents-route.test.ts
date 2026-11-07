import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listParents } from "@/app/api/filaments/parents/route";

/**
 * Sister to the filament list-route test. The parents endpoint feeds the
 * FilamentForm parent picker. Each option needs `hasVariants` so the
 * picker can render the cross-hatched swatch on options that *currently*
 * have variants, and a solid swatch on parent candidates that don't yet.
 */
describe("GET /api/filaments/parents — hasVariants annotation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  it("annotates each parent option with hasVariants based on live (non-deleted) variant count", async () => {
    const parentWithVariant = await Filament.create({
      name: "Has Variant",
      vendor: "Test",
      type: "PLA",
    });
    await Filament.create({
      name: "Live Variant",
      vendor: "Test",
      type: "PLA",
      parentId: parentWithVariant._id,
      color: "#ff0000",
    });

    const parentWithTrashedVariant = await Filament.create({
      name: "Has Trashed Variant Only",
      vendor: "Test",
      type: "PLA",
    });
    await Filament.create({
      name: "Trashed Variant",
      vendor: "Test",
      type: "PLA",
      parentId: parentWithTrashedVariant._id,
      _deletedAt: new Date(),
    });

    await Filament.create({
      name: "Solo Standalone",
      vendor: "Test",
      type: "PLA",
    });

    const res = await listParents(
      new NextRequest("http://localhost/api/filaments/parents"),
    );
    const body = (await res.json()) as Array<{ name: string; hasVariants: boolean }>;
    const find = (name: string) => body.find((p) => p.name === name);

    expect(find("Has Variant")?.hasVariants).toBe(true);
    // Trashed variant must not count — parent candidates with only deleted
    // children should render as solid swatches, not cross-hatch.
    expect(find("Has Trashed Variant Only")?.hasVariants).toBe(false);
    expect(find("Solo Standalone")?.hasVariants).toBe(false);
  });

  it("excludes variants from the parent candidate list (only top-level filaments are eligible parents)", async () => {
    // Sanity check that the existing parentId === null filter still
    // applies — a variant of a parent must not show up as a parent option.
    const top = await Filament.create({
      name: "Top",
      vendor: "Test",
      type: "PLA",
    });
    await Filament.create({
      name: "Variant of Top",
      vendor: "Test",
      type: "PLA",
      parentId: top._id,
    });
    const res = await listParents(
      new NextRequest("http://localhost/api/filaments/parents"),
    );
    const body = (await res.json()) as Array<{ name: string }>;
    expect(body.find((p) => p.name === "Variant of Top")).toBeUndefined();
    expect(body.find((p) => p.name === "Top")).toBeDefined();
  });

  it("carries each candidate's four flag-checkbox settings and nothing else of its bag", async () => {
    // FilamentForm seeds a variant's flag checkboxes from the parent it is
    // linked to; a parent picked in the form or reached through the
    // Duplicate flow has no `_parent`, so the candidate carries the keys.
    await Filament.create({
      name: "Flagged",
      vendor: "Test",
      type: "PET-GF",
      settings: {
        filament_abrasive: "1",
        filament_wipe: ["1", "0"],
        filament_notes: "stays off the wire",
        start_filament_gcode: "M572 S0.04",
      },
    });
    await Filament.create({ name: "No bag", vendor: "Test", type: "PLA" });
    const res = await listParents(
      new NextRequest("http://localhost/api/filaments/parents"),
    );
    const body = (await res.json()) as Array<{ name: string; settings?: Record<string, unknown> }>;
    expect(body.find((p) => p.name === "Flagged")?.settings).toEqual({
      filament_abrasive: "1",
      filament_wipe: ["1", "0"],
    });
    expect(body.find((p) => p.name === "No bag")?.settings ?? {}).toEqual({});
  });
});
