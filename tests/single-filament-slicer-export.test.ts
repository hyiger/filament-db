import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as exportPrusa } from "@/app/api/filaments/[id]/prusaslicer/route";
import { GET as exportOrca } from "@/app/api/filaments/[id]/orcaslicer/route";
import { GET as exportBambu } from "@/app/api/filaments/[id]/bambustudio/route";
import { exportFilenameStem } from "@/lib/singleFilamentExport";

/**
 * Per-filament slicer export — the detail-page "Export for slicer"
 * dropdown downloads one filament as a PrusaSlicer `.ini` bundle or an
 * OrcaSlicer / Bambu Studio `.json` preset.
 *
 * Distinct from the bundle routes (`/api/filaments/prusaslicer` etc.)
 * which export every filament. These routes:
 *   - return exactly one filament
 *   - set a `Content-Disposition: attachment` download header
 *   - resolve variant inheritance so the preset carries full values
 */
describe("single-filament slicer export routes", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const nozMod = await import("@/models/Nozzle");
    const prtMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  function req(id: string) {
    return new NextRequest(`http://localhost/api/filaments/${id}/export`);
  }

  // ── exportFilenameStem ────────────────────────────────────────────

  describe("exportFilenameStem", () => {
    it("collapses whitespace and strips illegal filename chars", () => {
      expect(exportFilenameStem("Prusament PLA Galaxy Black")).toBe(
        "Prusament_PLA_Galaxy_Black",
      );
      expect(exportFilenameStem('PETG "Carbon" / v2')).toBe("PETG_Carbon_v2");
    });
    it("falls back to 'filament' when the name reduces to nothing", () => {
      expect(exportFilenameStem("")).toBe("filament");
      expect(exportFilenameStem("///")).toBe("filament");
    });
  });

  // ── PrusaSlicer ───────────────────────────────────────────────────

  describe("GET /api/filaments/{id}/prusaslicer", () => {
    it("returns a single-filament INI with an attachment download header", async () => {
      const f = await Filament.create({
        name: "Export PLA",
        vendor: "TestCo",
        type: "PLA",
        temperatures: { nozzle: 215, bed: 60 },
      });
      const res = await exportPrusa(req(String(f._id)), {
        params: Promise.resolve({ id: String(f._id) }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/text\/plain/);
      expect(res.headers.get("Content-Disposition")).toBe(
        'attachment; filename="Export_PLA.ini"',
      );
      const body = await res.text();
      // PrusaSlicer INI sections are [filament:Name]
      expect(body).toContain("[filament:Export PLA]");
      expect(body).toContain("filament_type = PLA");
      expect(body).toContain("temperature = 215");
    });

    it("404s for a non-existent filament", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await exportPrusa(req(fakeId), {
        params: Promise.resolve({ id: fakeId }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── OrcaSlicer ────────────────────────────────────────────────────

  describe("GET /api/filaments/{id}/orcaslicer", () => {
    it("returns a single JSON preset object (not an array) with a download header", async () => {
      const f = await Filament.create({
        name: "Export PETG",
        vendor: "TestCo",
        type: "PETG",
        temperatures: { nozzle: 240, bed: 85 },
      });
      const res = await exportOrca(req(String(f._id)), {
        params: Promise.resolve({ id: String(f._id) }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
      expect(res.headers.get("Content-Disposition")).toBe(
        'attachment; filename="Export_PETG.json"',
      );
      const body = JSON.parse(await res.text());
      // A single object — not the [obj] array the bundle route returns.
      expect(Array.isArray(body)).toBe(false);
      expect(body.name).toBe("Export PETG");
      expect(body.type).toBe("filament");
      // OrcaSlicer values are single-element arrays.
      expect(body.filament_type).toEqual(["PETG"]);
      expect(body.nozzle_temperature).toEqual(["240"]);
      // The OrcaSlicer export keeps the custom DB marker on `from`.
      expect(body.from).toBe("filament_db");
    });

    it("404s for a non-existent filament", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await exportOrca(req(fakeId), {
        params: Promise.resolve({ id: fakeId }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Bambu Studio ──────────────────────────────────────────────────

  describe("GET /api/filaments/{id}/bambustudio", () => {
    it("returns a JSON preset with `from: User` so Bambu Studio files it as a user preset", async () => {
      const f = await Filament.create({
        name: "Export ASA",
        vendor: "TestCo",
        type: "ASA",
        temperatures: { nozzle: 260, bed: 100 },
      });
      const res = await exportBambu(req(String(f._id)), {
        params: Promise.resolve({ id: String(f._id) }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toBe(
        'attachment; filename="Export_ASA.json"',
      );
      const body = JSON.parse(await res.text());
      expect(Array.isArray(body)).toBe(false);
      // The one Bambu-specific tweak vs the OrcaSlicer export.
      expect(body.from).toBe("User");
      expect(body.filament_type).toEqual(["ASA"]);
    });
  });

  // ── Lookup by name with special characters ────────────────────────

  it("exports a filament whose name contains a literal '%' (no double-decode)", async () => {
    // Codex P2 on PR #247: Next.js route params are already URL-decoded,
    // so a name like "ABS 100%" arrives decoded. A second
    // decodeURIComponent would throw URIError on the dangling '%' and
    // 500 the request. Look the filament up by its (already-decoded)
    // name and confirm it exports cleanly.
    const f = await Filament.create({
      name: "ABS 100%",
      vendor: "TestCo",
      type: "ABS",
      temperatures: { nozzle: 255, bed: 100 },
    });
    const res = await exportPrusa(req("ABS 100%"), {
      params: Promise.resolve({ id: "ABS 100%" }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("[filament:ABS 100%]");
    // Sanity: the id-based lookup still works for the same filament.
    const byId = await exportPrusa(req(String(f._id)), {
      params: Promise.resolve({ id: String(f._id) }),
    });
    expect(byId.status).toBe(200);
  });

  // ── Variant inheritance ───────────────────────────────────────────

  it("resolves variant inheritance — an exported variant carries the parent's values", async () => {
    const parent = await Filament.create({
      name: "Base PLA",
      vendor: "TestCo",
      type: "PLA",
      temperatures: { nozzle: 210, bed: 60 },
      density: 1.24,
    });
    const variant = await Filament.create({
      name: "Base PLA - Red",
      vendor: "TestCo",
      type: "PLA",
      color: "#cc0000",
      parentId: parent._id,
      // temperatures + density intentionally omitted → inherit from parent
    });

    const res = await exportPrusa(req(String(variant._id)), {
      params: Promise.resolve({ id: String(variant._id) }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // The variant's INI section carries the parent's inherited temps.
    expect(body).toContain("[filament:Base PLA - Red]");
    expect(body).toContain("temperature = 210");
    expect(body).toContain("bed_temperature = 60");
  });

  it("exports a variant whose parent is missing using only its own values (no resolve)", async () => {
    // singleFilamentExport.ts line 74: `if (parent)` — the FALSE branch.
    // A variant carries a parentId, but the parent lookup returns null
    // (parent purged / soft-deleted). resolveFilamentForExport must skip
    // resolveFilament() and fall through to the raw variant, so the
    // export still succeeds with the variant's own values.
    const orphanVariant = await Filament.create({
      name: "Orphan Variant",
      vendor: "TestCo",
      type: "PLA",
      parentId: new mongoose.Types.ObjectId(), // points at nothing
      temperatures: { nozzle: 205, bed: 55 },
    });

    const res = await exportPrusa(req(String(orphanVariant._id)), {
      params: Promise.resolve({ id: String(orphanVariant._id) }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("[filament:Orphan Variant]");
    // The variant's OWN temps — nothing was inherited (no parent doc).
    expect(body).toContain("temperature = 205");
    expect(body).toContain("bed_temperature = 55");
  });

  it("skips resolve when the parent is soft-deleted (still the false branch)", async () => {
    // A parent that exists but is trashed (_deletedAt set) is filtered
    // out by the `_deletedAt: null` query, so the parent lookup returns
    // null and the variant exports its own values unresolved.
    const trashedParent = await Filament.create({
      name: "Trashed Parent",
      vendor: "TestCo",
      type: "PETG",
      temperatures: { nozzle: 245, bed: 90 },
      _deletedAt: new Date(),
    });
    const variant = await Filament.create({
      name: "Variant Of Trashed",
      vendor: "TestCo",
      type: "PETG",
      parentId: trashedParent._id,
      temperatures: { nozzle: 230, bed: 80 },
    });

    const res = await exportPrusa(req(String(variant._id)), {
      params: Promise.resolve({ id: String(variant._id) }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("[filament:Variant Of Trashed]");
    // Own temps, not the trashed parent's 245/90.
    expect(body).toContain("temperature = 230");
    expect(body).toContain("bed_temperature = 80");
  });
});
