import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listFilaments } from "@/app/api/filaments/route";

/**
 * Verify the list endpoint projects to FilamentSummary shape (no
 * heavy spool subfields, presence of `hasCalibrations`) instead of
 * returning every field on every doc.
 *
 * Coupled to the noCalibration quick filter on the list page: the
 * page reads `hasCalibrations` to decide whether to count/show a
 * filament under that filter. Before this projection landed the field
 * didn't exist and the filter was a no-op.
 */
describe("GET /api/filaments — projection to FilamentSummary", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  async function seed() {
    const noCalNoSpools = await Filament.create({
      name: "Bare PLA",
      vendor: "Test",
      type: "PLA",
    });
    const withCalibration = await Filament.create({
      name: "Calibrated PLA",
      vendor: "Test",
      type: "PLA",
      calibrations: [
        { nozzle: new mongoose.Types.ObjectId(), extrusionMultiplier: 0.95 },
      ],
    });
    const withSpoolPhoto = await Filament.create({
      name: "Photo PLA",
      vendor: "Test",
      type: "PLA",
      spools: [
        {
          totalWeight: 800,
          // The big-blob field that should NOT make it into list output.
          photoDataUrl: "data:image/png;base64,AAAA",
        },
      ],
    });
    return { noCalNoSpools, withCalibration, withSpoolPhoto };
  }

  it("strips spool.photoDataUrl and other heavy subfields from the list payload", async () => {
    await seed();
    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const photoEntry = body.find((f: { name: string }) => f.name === "Photo PLA");
    expect(photoEntry).toBeDefined();
    expect(photoEntry.spools).toHaveLength(1);
    // Only summary fields per FilamentSummary
    expect(photoEntry.spools[0]).not.toHaveProperty("photoDataUrl");
    expect(photoEntry.spools[0]).not.toHaveProperty("usageHistory");
    expect(photoEntry.spools[0]).not.toHaveProperty("dryCycles");
    expect(photoEntry.spools[0]).toHaveProperty("totalWeight", 800);
    expect(photoEntry.spools[0]).toHaveProperty("_id");
  });

  it("includes spools[].label so PrinterForm's AMS slot picker doesn't degrade to short IDs", async () => {
    // PrinterForm renders each spool choice as `s.label || s._id.slice(-4)`,
    // so the projection must keep label even though the list page itself
    // doesn't render it.
    const Filament = (await import("@/models/Filament")).default;
    await Filament.create({
      name: "Labeled Spools",
      vendor: "Test",
      type: "PLA",
      spools: [
        { label: "AMS slot 1", totalWeight: 800 },
        { label: "Backup", totalWeight: 1000 },
      ],
    });

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();
    const entry = body.find((f: { name: string }) => f.name === "Labeled Spools");
    expect(entry.spools).toHaveLength(2);
    expect(entry.spools[0].label).toBe("AMS slot 1");
    expect(entry.spools[1].label).toBe("Backup");
  });

  it("hasCalibrations reflects effective state — a variant with no own calibrations inherits from parent", async () => {
    // Codex round-3 P2: variants with empty calibrations[] inherit from
    // their parent (see resolveFilament). The list projection used to
    // compute hasCalibrations from only the variant's own array, so
    // every inheriting variant was falsely flagged as missing calibration.
    const Filament = (await import("@/models/Filament")).default;
    const parent = await Filament.create({
      name: "Inheritance Parent",
      vendor: "Test",
      type: "PLA",
      calibrations: [
        { nozzle: new mongoose.Types.ObjectId(), extrusionMultiplier: 0.95 },
      ],
    });
    await Filament.create({
      name: "Inheriting Variant",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      // empty calibrations — inherits from parent
    });
    await Filament.create({
      name: "Override Variant",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      calibrations: [
        { nozzle: new mongoose.Types.ObjectId(), extrusionMultiplier: 1.0 },
      ],
    });
    await Filament.create({
      name: "Standalone Bare",
      vendor: "Test",
      type: "PLA",
    });

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();

    const find = (name: string) => body.find((f: { name: string }) => f.name === name);
    expect(find("Inheritance Parent").hasCalibrations).toBe(true);
    expect(find("Inheriting Variant").hasCalibrations).toBe(true); // <-- the bug fix
    expect(find("Override Variant").hasCalibrations).toBe(true);
    expect(find("Standalone Bare").hasCalibrations).toBe(false);
  });

  it("computes hasCalibrations true/false per row", async () => {
    await seed();
    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();

    const bare = body.find((f: { name: string }) => f.name === "Bare PLA");
    const cal = body.find((f: { name: string }) => f.name === "Calibrated PLA");
    expect(bare.hasCalibrations).toBe(false);
    expect(cal.hasCalibrations).toBe(true);
  });

  it("surfaces hasVariants true on parents with ≥1 non-deleted variant and false otherwise", async () => {
    // Parent-of-color-variants visual indicator: the list payload needs a
    // boolean so FilamentSwatch can render the cross-hatch on the right
    // row without each consumer re-querying. A filament is never a parent
    // unless it actually has variants — auto-detected from the lookup,
    // no schema field.
    const Filament = (await import("@/models/Filament")).default;
    const parent = await Filament.create({
      name: "Variant Parent",
      vendor: "Test",
      type: "PLA",
    });
    await Filament.create({
      name: "Black Variant",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      color: "#000000",
    });
    // A deleted variant must NOT count — a parent whose only child has
    // been trashed should fall back to a solid swatch.
    const trashedParent = await Filament.create({
      name: "Trashed-variant Parent",
      vendor: "Test",
      type: "PLA",
    });
    await Filament.create({
      name: "Trashed Variant",
      vendor: "Test",
      type: "PLA",
      parentId: trashedParent._id,
      _deletedAt: new Date(),
    });
    // Standalone with no children — should be a plain solid swatch.
    await Filament.create({
      name: "Lone Standalone",
      vendor: "Test",
      type: "PLA",
    });

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();
    const find = (name: string) => body.find((f: { name: string }) => f.name === name);

    expect(find("Variant Parent").hasVariants).toBe(true);
    expect(find("Black Variant").hasVariants).toBe(false);
    expect(find("Trashed-variant Parent").hasVariants).toBe(false);
    expect(find("Lone Standalone").hasVariants).toBe(false);
  });

  it("counts a legacy variant with NO _deletedAt field at all toward hasVariants (#625)", async () => {
    // Pre-v1.15 docs created before the soft-delete field existed (and
    // never re-saved) lack `_deletedAt` entirely. In aggregation,
    // `{ $eq: ["$_deletedAt", null] }` is FALSE for a missing field —
    // missing is its own BSON type and `$eq` does NOT collapse it into
    // null (the v1.32.2 quirk). The probe must wrap in `$ifNull`, or a
    // long-time user's parent reports hasVariants:false and the list page
    // loses the composite parent swatch (the likely root cause of the
    // #597 / #605 cross-hatch reports) even though find()-based routes
    // (whose query semantics DO match missing) treat the same variant as
    // active.
    const Filament = (await import("@/models/Filament")).default;
    const parent = await Filament.create({
      name: "Legacy Parent",
      vendor: "Test",
      type: "PLA",
    });
    const legacyVariant = await Filament.create({
      name: "Legacy Variant",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      color: "#112233",
    });
    // Strip the schema-defaulted field at the collection level to recreate
    // the genuine pre-v1.15 document shape (create() always materialises
    // the default, so a raw $unset is the only way to get "missing").
    await Filament.collection.updateOne(
      { _id: legacyVariant._id },
      { $unset: { _deletedAt: "" } },
    );
    const raw = await Filament.collection.findOne({ _id: legacyVariant._id });
    expect(raw).not.toHaveProperty("_deletedAt"); // precondition: truly missing

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();
    const find = (name: string) => body.find((f: { name: string }) => f.name === name);

    expect(find("Legacy Parent").hasVariants).toBe(true); // <-- the bug fix
    // The legacy variant itself still lists as an active row.
    expect(find("Legacy Variant")).toBeDefined();
  });

  it("does not include the full calibrations array (only the boolean)", async () => {
    await seed();
    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments"),
    );
    const body = await res.json();
    const cal = body.find((f: { name: string }) => f.name === "Calibrated PLA");
    // Verify the heavy field isn't in the list payload — detail endpoint
    // remains the source of truth for the array.
    expect(cal).not.toHaveProperty("calibrations");
  });

  it("variants with empty optTags inherit the parent's optTags in the list projection (matches resolveFilament)", async () => {
    // Codex round-1 P2 on PR #353. Variants inherit array fields from
    // the parent when their own array is empty (resolveFilament's
    // INHERIT-WHEN-EMPTY rule for compatibleNozzles / optTags /
    // calibrations / presets). The list aggregation must mirror that
    // rule, or a matte parent's variant with `optTags: []` would render
    // plain on the inventory list while its detail page (which goes
    // through resolveFilament) correctly renders matte.
    const Filament = (await import("@/models/Filament")).default;
    const parent = await Filament.create({
      name: "Matte Parent",
      vendor: "Test",
      type: "PLA",
      optTags: [16], // matte
    });
    await Filament.create({
      name: "Inheriting Variant",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      color: "#f0f0f0",
      // optTags intentionally omitted — must inherit [16] from parent
    });
    await Filament.create({
      name: "Override Variant",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      color: "#0a0a0a",
      optTags: [22], // sparkle — explicit override
    });

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments?vendor=Test"),
    );
    const body = await res.json();
    const find = (name: string) => body.find((f: { name: string }) => f.name === name);

    expect(find("Matte Parent").optTags).toEqual([16]);
    expect(find("Inheriting Variant").optTags).toEqual([16]); // <-- the bug fix
    expect(find("Override Variant").optTags).toEqual([22]);
  });

  it("surfaces optTags in the list projection so the row can derive finish without a detail fetch", async () => {
    // FilamentSwatch + FinishChip read deriveFinish(optTags) to render
    // the texture treatment + chip beside the name. Without optTags in
    // the list projection every row would need a follow-up GET to learn
    // its finish — defeating the purpose of the aggregation.
    const Filament = (await import("@/models/Filament")).default;
    await Filament.create({
      name: "Matte White",
      vendor: "Test",
      type: "PLA",
      color: "#f5f5f5",
      optTags: [16], // matte
    });
    await Filament.create({
      name: "Plain Red",
      vendor: "Test",
      type: "PLA",
      color: "#ef4444",
      optTags: [], // no finish-relevant tags
    });
    await Filament.create({
      name: "Sparkle Black",
      vendor: "Test",
      type: "PLA",
      color: "#0a0a0a",
      optTags: [22, 4], // sparkle + abrasive (abrasive shouldn't shadow sparkle)
    });

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments?vendor=Test"),
    );
    const body = await res.json();
    const find = (name: string) => body.find((f: { name: string }) => f.name === name);
    expect(find("Matte White").optTags).toEqual([16]);
    expect(find("Plain Red").optTags).toEqual([]);
    expect(find("Sparkle Black").optTags).toEqual([22, 4]);
  });

  it("includes tdsUrl in the projection so FilamentForm vendor suggestions still work", async () => {
    // FilamentForm calls /api/filaments?vendor=... and reads tdsUrl off
    // each row to populate vendor-keyed TDS suggestions. Codex flagged
    // that dropping the field silently empties the suggestion list.
    const Filament = (await import("@/models/Filament")).default;
    await Filament.create({
      name: "Has TDS",
      vendor: "Test",
      type: "PLA",
      tdsUrl: "https://example.com/tds.pdf",
    });
    await Filament.create({
      name: "No TDS",
      vendor: "Test",
      type: "PLA",
    });

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments?vendor=Test"),
    );
    const body = await res.json();
    const withTds = body.find((f: { name: string }) => f.name === "Has TDS");
    const withoutTds = body.find((f: { name: string }) => f.name === "No TDS");
    expect(withTds.tdsUrl).toBe("https://example.com/tds.pdf");
    expect(withoutTds.tdsUrl).toBeNull();
  });

  it("resolves inherited scalars on a variant search-result row even when the parent is filtered out (#553)", async () => {
    // A name search returns only the matching variant; its parent doesn't
    // match the regex and is dropped by `$match`. The list page used to
    // merge inherited nozzle/bed/cost/density/spool weights client-side
    // from the parent row, so when the parent wasn't in the result set the
    // variant rendered `—` for those columns. The aggregation now resolves
    // them server-side via the `_parent` lookup, which runs against the
    // full collection regardless of the search filter.
    const Filament = (await import("@/models/Filament")).default;
    const parent = await Filament.create({
      name: "Galaxy PLA",
      vendor: "Test",
      type: "PLA",
      temperatures: { nozzle: 215, bed: 60 },
      cost: 25,
      density: 1.24,
      spoolWeight: 200,
      netFilamentWeight: 1000,
    });
    await Filament.create({
      name: "Galaxy PLA Red",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      color: "#ef4444",
      // no own temperatures/cost/density/weights — must inherit from parent
    });

    // Search for the variant by name — the parent ("Galaxy PLA") does NOT
    // match "Red", so it's excluded from the result set.
    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments?search=Red"),
    );
    const body = await res.json();
    const variant = body.find((f: { name: string }) => f.name === "Galaxy PLA Red");
    const parentRow = body.find((f: { name: string }) => f.name === "Galaxy PLA");

    expect(parentRow).toBeUndefined(); // parent filtered out by the search
    expect(variant).toBeDefined();
    expect(variant.temperatures.nozzle).toBe(215);
    expect(variant.temperatures.bed).toBe(60);
    expect(variant.cost).toBe(25);
    expect(variant.density).toBe(1.24);
    expect(variant.spoolWeight).toBe(200);
    expect(variant.netFilamentWeight).toBe(1000);
  });

  it("a variant's own scalar values still win over the parent's (#553)", async () => {
    const Filament = (await import("@/models/Filament")).default;
    const parent = await Filament.create({
      name: "Override Galaxy",
      vendor: "Test",
      type: "PLA",
      temperatures: { nozzle: 215, bed: 60 },
      cost: 25,
    });
    await Filament.create({
      name: "Override Galaxy Blue",
      vendor: "Test",
      type: "PLA",
      parentId: parent._id,
      color: "#3b82f6",
      temperatures: { nozzle: 230, bed: 70 },
      cost: 40,
    });

    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments?search=Blue"),
    );
    const body = await res.json();
    const variant = body.find((f: { name: string }) => f.name === "Override Galaxy Blue");
    expect(variant.temperatures.nozzle).toBe(230);
    expect(variant.temperatures.bed).toBe(70);
    expect(variant.cost).toBe(40);
  });

  it("preserves type/vendor filters across the projection", async () => {
    await seed();
    const res = await listFilaments(
      new NextRequest("http://localhost/api/filaments?vendor=Test&type=PLA"),
    );
    const body = await res.json();
    expect(body).toHaveLength(3);
  });
});
