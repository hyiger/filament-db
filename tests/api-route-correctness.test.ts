import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as getParents } from "@/app/api/filaments/parents/route";
import { GET as getCompare } from "@/app/api/filaments/compare/route";
import { GET as getAnalytics } from "@/app/api/analytics/route";
import { GET as getShare } from "@/app/api/share/[slug]/route";
import { GET as spoolCheck } from "@/app/api/filaments/[id]/spool-check/route";
import { PUT as putSpool } from "@/app/api/filaments/[id]/spools/[spoolId]/route";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
import { POST as scanPublish } from "@/app/api/scan/publish/route";
import { POST as slicerSync } from "@/app/api/filaments/[id]/route";
import { POST as orcaSync } from "@/app/api/filaments/[id]/orcaslicer/route";
import { GET as orcaBulkExport } from "@/app/api/filaments/orcaslicer/route";
import { GET as prusaBulkExport } from "@/app/api/filaments/prusaslicer/route";

/**
 * Code-review issues #265, #266, #267, #268, #269, #271, #272, #273,
 * #305, #306 — API route correctness. (#270, #277, #280, #281, #310 are
 * covered by their own unit tests or are pure documentation.)
 */
describe("API route correctness", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Printer: any;
  let Nozzle: any;
  let SharedCatalog: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const prtMod = await import("@/models/Printer");
    const nozMod = await import("@/models/Nozzle");
    const bedMod = await import("@/models/BedType");
    const phMod = await import("@/models/PrintHistory");
    const scMod = await import("@/models/SharedCatalog");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    if (!mongoose.models.PrintHistory) mongoose.model("PrintHistory", phMod.default.schema);
    if (!mongoose.models.SharedCatalog) mongoose.model("SharedCatalog", scMod.default.schema);
    Filament = mongoose.models.Filament;
    Printer = mongoose.models.Printer;
    Nozzle = mongoose.models.Nozzle;
    SharedCatalog = mongoose.models.SharedCatalog;
  });

  function getReq(url: string) {
    return new NextRequest(url, { method: "GET" });
  }
  function jsonReq(url: string, body: unknown, method = "POST") {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── #267: malformed ObjectId → 400, not 500 ────────────────────────

  describe("#267 — malformed ObjectId yields 400", () => {
    it("parents route rejects a non-ObjectId `exclude` with 400", async () => {
      const res = await getParents(
        getReq("http://localhost/api/filaments/parents?exclude=not-an-id"),
      );
      expect(res.status).toBe(400);
    });

    it("compare route rejects a non-ObjectId in `ids` with 400", async () => {
      const res = await getCompare(
        getReq("http://localhost/api/filaments/compare?ids=not-an-id"),
      );
      expect(res.status).toBe(400);
    });
  });

  // ── #268: retiring a slotted spool clears the AMS slot ─────────────

  it("#268 — retiring a spool clears it from any printer AMS slot", async () => {
    const f = await Filament.create({
      name: "Slot Host",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "Loaded", totalWeight: 1000 }],
    });
    const spoolId = String(f.spools[0]._id);
    const printer = await Printer.create({
      name: "MK4",
      manufacturer: "Prusa",
      printerModel: "MK4",
      amsSlots: [{ slotName: "Slot A", spoolId }],
    });

    const res = await putSpool(
      jsonReq(
        `http://localhost/api/filaments/${f._id}/spools/${spoolId}`,
        { retired: true },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(f._id), spoolId }) },
    );
    expect(res.status).toBe(200);

    const fresh = await Printer.findById(printer._id);
    expect(fresh.amsSlots[0].spoolId).toBeNull();
  });

  // ── #269: analytics survives a malformed usageHistory date ─────────

  it("#269 — analytics skips a malformed usageHistory date instead of 500", async () => {
    // Raw insert bypasses the schema cast so the date lands as a bad
    // string — the shape a bad import / snapshot restore can produce.
    await mongoose.connection.collection("filaments").insertOne({
      name: "Bad Date Filament",
      vendor: "T",
      type: "PLA",
      spools: [
        {
          label: "S1",
          usageHistory: [
            { grams: 25, date: "not-a-real-date", source: "manual" },
          ],
        },
      ],
    });

    const res = await getAnalytics(getReq("http://localhost/api/analytics"));
    expect(res.status).toBe(200);
  });

  // ── #271: scan/publish caps the candidates array ───────────────────

  it("#271 — scan/publish caps the candidates array at 25", async () => {
    const candidates = Array.from({ length: 60 }, (_, i) => ({
      _id: `cand-${i}`,
      name: `Candidate ${i}`,
    }));
    const res = await scanPublish(
      jsonReq("http://localhost/api/scan/publish", {
        filament: { _id: "match-1", name: "Matched" },
        candidates,
      }),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.event.candidates).toHaveLength(25);
  });

  // ── #272: expired catalogs don't accrue views ──────────────────────

  it("#272 — an expired shared catalog returns 410 without incrementing viewCount", async () => {
    const catalog = await SharedCatalog.create({
      title: "Old Share",
      payload: {
        version: 1,
        createdAt: new Date().toISOString(),
        filaments: [],
        nozzles: [],
        printers: [],
        bedTypes: [],
      },
      expiresAt: new Date(Date.now() - 60_000),
      viewCount: 5,
    });

    const res = await getShare(
      getReq(`http://localhost/api/share/${catalog.slug}`),
      { params: Promise.resolve({ slug: catalog.slug }) },
    );
    expect(res.status).toBe(410);

    const fresh = await SharedCatalog.findById(catalog._id);
    expect(fresh.viewCount).toBe(5); // not incremented
  });

  it("#272 — a live shared catalog increments viewCount exactly once", async () => {
    const catalog = await SharedCatalog.create({
      title: "Live Share",
      payload: {
        version: 1,
        createdAt: new Date().toISOString(),
        filaments: [],
        nozzles: [],
        printers: [],
        bedTypes: [],
      },
      viewCount: 0,
    });

    const res = await getShare(
      getReq(`http://localhost/api/share/${catalog.slug}`),
      { params: Promise.resolve({ slug: catalog.slug }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).viewCount).toBe(1);

    const fresh = await SharedCatalog.findById(catalog._id);
    expect(fresh.viewCount).toBe(1);
  });

  // ── #273: spool-check resolves a legacy-mode variant's parent ──────

  it("#273 — spool-check falls back to the parent's totalWeight for a legacy-mode variant", async () => {
    const parent = await Filament.create({
      name: "Galaxy Parent",
      vendor: "Prusa",
      type: "PLA",
      totalWeight: 1000,
      spoolWeight: 200,
      density: 1.24,
      diameter: 1.75,
    });
    const variant = await Filament.create({
      name: "Galaxy Black",
      vendor: "Prusa",
      type: "PLA",
      color: "#111111",
      parentId: parent._id,
    });

    const res = await spoolCheck(
      getReq(`http://localhost/api/filaments/${variant._id}/spool-check?weight=100`),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Pre-fix: empty spools + "no data" message. Now the parent's
    // legacy totalWeight is used, so the check actually runs.
    expect(body.spools.length).toBe(1);
    expect(body.ok).toBe(true);
  });

  it("#273 — spool-check excludes a retired parent spool from the fallback", async () => {
    // Codex review: the parent-fallback must not count retired spools —
    // a retired roll is out of service and shouldn't satisfy the check.
    const parent = await Filament.create({
      name: "Retired-Stock Parent",
      vendor: "Prusa",
      type: "PLA",
      spoolWeight: 200,
      density: 1.24,
      diameter: 1.75,
      spools: [{ label: "Old", totalWeight: 1000, retired: true }],
    });
    const variant = await Filament.create({
      name: "Retired-Stock Black",
      vendor: "Prusa",
      type: "PLA",
      color: "#111111",
      parentId: parent._id,
    });

    const res = await spoolCheck(
      getReq(`http://localhost/api/filaments/${variant._id}/spool-check?weight=100`),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // The only parent spool is retired → no usable stock. GH #954: this now
    // warns (ok:false) instead of silently passing with a "no data" message —
    // weight data EXISTS, it's just all retired, which is exactly the case the
    // retired exclusion is meant to surface to the slicer.
    expect(body.spools).toHaveLength(0);
    expect(body.ok).toBe(false);
    expect(body.warning).toMatch(/retired/i);
    expect(body.message).toBeUndefined();
  });

  it("#954 (Codex): all-retired stock warns even with a null tare (retired check runs before the tare guard)", async () => {
    // No spoolWeight anywhere (null tare, no parent) + the only weighed stock is
    // retired. The tare guard would return ok:true first; the retired detection
    // must run before it so PrusaSlicer still gets the warning.
    const f = await Filament.create({
      name: "Null-Tare Retired PLA",
      vendor: "Prusa",
      type: "PLA",
      density: 1.24,
      diameter: 1.75,
      // spoolWeight intentionally omitted (null) — no tare.
      spools: [{ label: "Old", totalWeight: 1000, retired: true }],
    });
    const res = await spoolCheck(
      getReq(`http://localhost/api/filaments/${f._id}/spool-check?weight=100`),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.warning).toMatch(/retired/i);
  });

  it("#954 (Codex): an UNWEIGHED active spool + a weighed retired spool stays ok:true (no false warning)", async () => {
    // Active stock exists — it's just unmeasured. The retired spool has weight but
    // is out of service. This must NOT warn (active stock exists), it's a no-data case.
    const f = await Filament.create({
      name: "Unweighed-Active PLA",
      vendor: "Prusa",
      type: "PLA",
      spoolWeight: 200,
      density: 1.24,
      diameter: 1.75,
      spools: [
        { label: "Fresh", retired: false }, // active but no totalWeight (unweighed)
        { label: "Old", totalWeight: 1000, retired: true }, // weighed but retired
      ],
    });
    const res = await spoolCheck(
      getReq(`http://localhost/api/filaments/${f._id}/spool-check?weight=100`),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true); // active stock exists (unmeasured) → no false warning
    expect(body.warning).toBeUndefined();
    expect(body.message).toMatch(/no spool weight data/i);
  });

  // ── #305: print history never debits a retired spool ───────────────

  it("#305 — print-history records spoolId:null rather than debiting a retired spool", async () => {
    const f = await Filament.create({
      name: "All Retired",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "Old", totalWeight: 500, retired: true }],
    });

    const res = await postPrintHistory(
      jsonReq("http://localhost/api/print-history", {
        jobLabel: "benchy",
        usage: [{ filamentId: String(f._id), grams: 40 }],
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.usage[0].spoolId).toBeNull();

    // The retired spool's preserved weight + history are untouched.
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools[0].totalWeight).toBe(500);
    expect(fresh.spools[0].usageHistory ?? []).toHaveLength(0);
  });

  // ── #306: print history rejects an invalid startedAt ───────────────

  it("#306 — print-history rejects a malformed startedAt with 400", async () => {
    const f = await Filament.create({
      name: "Date Host",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "S1", totalWeight: 1000 }],
    });
    const res = await postPrintHistory(
      jsonReq("http://localhost/api/print-history", {
        jobLabel: "benchy",
        startedAt: "garbage",
        usage: [{ filamentId: String(f._id), grams: 10 }],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/startedAt/);
  });

  // ── #265: variant calibration sync writes to the parent ────────────

  it("#265 — slicer calibration sync on a variant writes calibration to the parent", async () => {
    const nozzle = await Nozzle.create({
      name: "0.4 Brass",
      diameter: 0.4,
      type: "brass",
    });
    const parent = await Filament.create({
      name: "PC Parent",
      vendor: "Prusa",
      type: "PC",
      compatibleNozzles: [nozzle._id],
    });
    const variant = await Filament.create({
      name: "PC Black",
      vendor: "Prusa",
      type: "PC",
      color: "#222222",
      parentId: parent._id,
    });

    const res = await slicerSync(
      jsonReq(
        `http://localhost/api/filaments/${variant._id}?nozzle_diameter=0.4`,
        { config: { extrusion_multiplier: "1.05" } },
      ),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(res.status).toBe(200);

    // Calibration landed on the parent — the variant keeps inheriting it.
    const freshParent = await Filament.findById(parent._id);
    expect(freshParent.calibrations).toHaveLength(1);
    expect(freshParent.calibrations[0].extrusionMultiplier).toBe(1.05);
    expect(String(freshParent.calibrations[0].nozzle)).toBe(String(nozzle._id));

    const freshVariant = await Filament.findById(variant._id);
    expect(freshVariant.calibrations ?? []).toHaveLength(0);
  });

  it("#859 — slicer sync persists EM + maxVolumetricSpeed despite a legacy out-of-range stored temp", async () => {
    const nozzle = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "brass" });
    // Seed RAW (bypassing Mongoose validators) a filament whose STORED nozzle
    // temp is out of the schema range (max 600) — legacy data saved before the
    // #645 sync-write validators existed.
    const ins = await mongoose.connection.collection("filaments").insertOne({
      name: "Legacy PETG",
      vendor: "Prusa",
      type: "PETG",
      diameter: 1.75,
      compatibleNozzles: [nozzle._id],
      temperatures: { nozzle: 700, bed: 80 }, // 700 > schema max 600
      calibrations: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const id = ins.insertedId;

    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${id}?nozzle_diameter=0.4`, {
        config: {
          extrusion_multiplier: "1.08",
          filament_max_volumetric_speed: "15",
          bed_temperature: "60",
        },
      }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    // Pre-#859 the whole-`temperatures` $set re-validated the legacy nozzle:700
    // and 400'd the ENTIRE sync; now only the incoming `temperatures.bed` is
    // written + validated, so the sync succeeds and EM + maxVolumetricSpeed land.
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(id);
    expect(fresh.maxVolumetricSpeed).toBe(15);
    expect(fresh.temperatures.bed).toBe(60);
    // The untouched legacy value is preserved (dotted paths don't replace siblings).
    expect(fresh.temperatures.nozzle).toBe(700);
    expect(fresh.calibrations).toHaveLength(1);
    expect(fresh.calibrations[0].extrusionMultiplier).toBe(1.08);
  });

  it("#859 — a genuinely bad INCOMING temperature is still rejected (preserves #645)", async () => {
    const f = await Filament.create({ name: "Clean PLA", vendor: "Prusa", type: "PLA" });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        config: { temperature: "700" }, // 700 > max 600, and it's the INCOMING value
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(400);
    const fresh = await Filament.findById(f._id);
    expect(fresh.temperatures?.nozzle ?? null).toBe(null);
  });

  it("#859/PrusaSlicer — EM sync falls back to a UNIQUE global-catalog nozzle when the filament has no compatible nozzles", async () => {
    const hf = await Nozzle.create({ name: "0.4 HF", diameter: 0.4, type: "brass", highFlow: true });
    // A same-diameter standard nozzle exists too, so the high_flow filter must disambiguate.
    await Nozzle.create({ name: "0.4 std", diameter: 0.4, type: "brass", highFlow: false });
    // compatibleNozzles intentionally empty — the common case for a synced/imported filament.
    const f = await Filament.create({ name: "No-Compat PCTG", vendor: "CHCKX", type: "PCTG" });

    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}?nozzle_diameter=0.4&high_flow=1`, {
        config: { extrusion_multiplier: "1.07" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    // Pre-fix: 0 calibrations (the block was skipped on empty compatibleNozzles).
    expect(fresh.calibrations).toHaveLength(1);
    expect(fresh.calibrations[0].extrusionMultiplier).toBe(1.07);
    expect(String(fresh.calibrations[0].nozzle)).toBe(String(hf._id));
  });

  it("#859/PrusaSlicer — EM fallback does NOT guess when multiple global nozzles match", async () => {
    await Nozzle.create({ name: "0.4 HF A", diameter: 0.4, type: "brass", highFlow: true });
    await Nozzle.create({ name: "0.4 HF B", diameter: 0.4, type: "hardened", highFlow: true });
    const f = await Filament.create({ name: "Ambiguous PCTG", vendor: "X", type: "PCTG" });

    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}?nozzle_diameter=0.4&high_flow=1`, {
        config: { extrusion_multiplier: "1.07" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.calibrations ?? []).toHaveLength(0); // ambiguous → don't guess
  });

  it("#867 — a name-addressed sync whose filamentdb_id resolves to a DIFFERENT name returns 409 and does NOT mutate (Codex P1)", async () => {
    const f = await Filament.create({ name: "Fibreheart PPA", vendor: "Siraya Tech", type: "PPA" });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/SirayaTech%20Fibreheart%20PPA", {
        config: { filamentdb_id: String(f._id), filament_shrinkage_compensation_xy: "0.36%" },
      }),
      { params: Promise.resolve({ id: "SirayaTech Fibreheart PPA" }) }, // a DIFFERENT name (rename OR copied id)
    );
    // Ambiguous (renamed preset vs copied id) → surface, don't silently overwrite.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("name_id_mismatch");
    expect(body.filamentId).toBe(String(f._id));
    expect(body.matchedName).toBe("Fibreheart PPA");
    expect(body.sentName).toBe("SirayaTech Fibreheart PPA");
    const fresh = await Filament.findById(f._id);
    expect(fresh.shrinkageXY ?? null).toBeNull(); // NOT mutated
    expect(await Filament.countDocuments({ _deletedAt: null })).toBe(1); // and no orphan created
  });

  it("#867 — confirming via the ObjectId URL applies the update (reconcile path)", async () => {
    const f = await Filament.create({ name: "Fibreheart PPA", vendor: "Siraya Tech", type: "PPA" });
    // After a 409, the fork re-syncs addressing the resolved filament by id.
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        config: { filamentdb_id: String(f._id), filament_shrinkage_compensation_xy: "0.36%" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    expect((await Filament.findById(f._id)).shrinkageXY).toBe(0.36); // applied
  });

  it("#867 — falls back to the name match when no filamentdb_id is sent", async () => {
    const f = await Filament.create({ name: "PLA Basic", vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PLA%20Basic", { config: { filament_density: "1.24" } }),
      { params: Promise.resolve({ id: "PLA Basic" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchedBy).toBe("name");
    expect(body.filamentId).toBe(String(f._id));
  });

  it("#867 — a stale filamentdb_id gracefully falls back to the name match", async () => {
    const f = await Filament.create({ name: "PETG Pro", vendor: "X", type: "PETG" });
    const staleId = new mongoose.Types.ObjectId().toString(); // valid ObjectId, no such doc
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PETG%20Pro", {
        config: { filamentdb_id: staleId, filament_density: "1.27" },
      }),
      { params: Promise.resolve({ id: "PETG Pro" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchedBy).toBe("name");
    expect(body.filamentId).toBe(String(f._id));
  });

  it("#867 — filamentdb_id is consumed for routing, not stored in the settings bag", async () => {
    const f = await Filament.create({ name: "ABS X", vendor: "X", type: "ABS" });
    await slicerSync(
      jsonReq("http://localhost/api/filaments/ABS%20X", {
        config: { filamentdb_id: String(f._id), some_passthrough_key: "v" },
      }),
      { params: Promise.resolve({ id: "ABS X" }) },
    );
    const fresh = await Filament.findById(f._id);
    expect(fresh.settings?.filamentdb_id).toBeUndefined(); // routing hint, not persisted
    expect(fresh.settings?.some_passthrough_key).toBe("v"); // real passthrough keys still stored
  });

  it("#867 — an ObjectId-URL sync (no filamentdb_id) applies (no false 409 mismatch) (Codex P2)", async () => {
    const f = await Filament.create({ name: "Real Name", vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, { config: { filament_density: "1.24" } }),
      { params: Promise.resolve({ id: String(f._id) }) }, // URL param IS the ObjectId, not a name
    );
    expect(res.status).toBe(200); // applied — decodedName was the id, not a name, so never a 409 mismatch
    expect((await res.json()).matchedBy).toBe("id");
  });

  it("#867 — an ObjectId URL WITH a matching filamentdb_id applies (no false 409 mismatch) (Codex P2)", async () => {
    const f = await Filament.create({ name: "Real Name", vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        config: { filamentdb_id: String(f._id), filament_density: "1.24" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) }, // ObjectId addressing form
    );
    expect(res.status).toBe(200); // id addressing never 409s on a name mismatch — even with filamentdb_id
    expect((await res.json()).matchedBy).toBe("id");
  });

  it("#867 — an ObjectId URL is authoritative; a conflicting filamentdb_id does NOT redirect the write (Codex P2)", async () => {
    const target = await Filament.create({ name: "Target", vendor: "X", type: "PLA" });
    const other = await Filament.create({ name: "Other", vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${target._id}`, {
        // a copied/stale id pointing at a DIFFERENT filament — must not hijack the write
        config: { filamentdb_id: String(other._id), filament_density: "1.5" },
      }),
      { params: Promise.resolve({ id: String(target._id) }) }, // URL pins the target
    );
    expect(res.status).toBe(200);
    expect((await res.json()).filamentId).toBe(String(target._id)); // wrote to the URL target
    expect((await Filament.findById(target._id)).density).toBe(1.5); // target updated
    expect((await Filament.findById(other._id)).density ?? null).toBeNull(); // other untouched
  });

  it("#867 — a preset NAME that looks like an ObjectId still falls back to the name match (Codex P2)", async () => {
    const hexName = "abcdef012345678901234567"; // 24 hex chars, but not any filament's _id
    const f = await Filament.create({ name: hexName, vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${hexName}`, { config: { filament_density: "1.3" } }),
      { params: Promise.resolve({ id: hexName }) },
    );
    expect(res.status).toBe(200); // not a 404 — the ObjectId lookup missed, name matched
    const body = await res.json();
    expect(body.filamentId).toBe(String(f._id));
    expect(body.matchedBy).toBe("name");
  });

  it("#872 — a per-nozzle preset sync (filamentdb_nozzle) is NOT a name mismatch and routes calibration to that nozzle", async () => {
    const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      compatibleNozzles: [brass._id],
    });
    // The export names a multi-nozzle preset "<base> <Ø type>" but carries the
    // base filamentdb_id — without the hint this would 409 as a name mismatch.
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PLA%200.4%20Brass", {
        config: {
          filamentdb_id: String(f._id),
          filamentdb_nozzle: "0.4 Brass",
          extrusion_multiplier: "1.05",
        },
      }),
      { params: Promise.resolve({ id: "PLA 0.4 Brass" }) },
    );
    expect(res.status).toBe(200); // suffixed name is the EXPECTED per-nozzle export, not a rename
    const fresh = await Filament.findById(f._id);
    expect(fresh.name).toBe("PLA"); // base name untouched (no rename from a suffixed preset)
    expect(fresh.calibrations).toHaveLength(1);
    expect(fresh.calibrations[0].extrusionMultiplier).toBe(1.05);
    expect(String(fresh.calibrations[0].nozzle)).toBe(String(brass._id));
    expect(fresh.settings?.filamentdb_nozzle).toBeUndefined(); // routing hint, not stored
  });

  it("#872 — a per-nozzle preset disambiguates same-diameter nozzles by type", async () => {
    const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const diamond = await Nozzle.create({ name: "0.4 Diamondback", diameter: 0.4, type: "Diamondback" });
    const f = await Filament.create({
      name: "PA-CF",
      vendor: "X",
      type: "PA",
      compatibleNozzles: [brass._id, diamond._id],
    });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PA-CF%200.4%20Diamondback", {
        config: {
          filamentdb_id: String(f._id),
          filamentdb_nozzle: "0.4 Diamondback",
          extrusion_multiplier: "0.97",
        },
      }),
      { params: Promise.resolve({ id: "PA-CF 0.4 Diamondback" }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.calibrations).toHaveLength(1);
    expect(String(fresh.calibrations[0].nozzle)).toBe(String(diamond._id)); // Diamondback, not Brass
  });

  it("#872 — a suffixed-LOOKING name WITHOUT a filamentdb_nozzle hint still 409s (suppression is hint-gated)", async () => {
    const f = await Filament.create({ name: "PLA", vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PLA%200.4%20Brass", {
        // no filamentdb_nozzle → can't prove it's a per-nozzle export → stays a #867 mismatch
        config: { filamentdb_id: String(f._id), filament_density: "1.24" },
      }),
      { params: Promise.resolve({ id: "PLA 0.4 Brass" }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("name_id_mismatch");
  });

  it("#867 Phase 2 — an ObjectId-URL sync renames the record to the sent body.name", async () => {
    const f = await Filament.create({ name: "Old Name", vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        name: "My Renamed Preset",
        config: { filament_density: "1.3" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) }, // authoritative ObjectId form
    );
    expect(res.status).toBe(200);
    expect((await Filament.findById(f._id)).name).toBe("My Renamed Preset"); // "Update anyway" sticks
  });

  it("#867 Phase 2 — a NAME-addressed sync never renames the record", async () => {
    const f = await Filament.create({ name: "Keeper", vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/Keeper", {
        name: "Should Not Apply", // body.name is ignored on the name-addressed path
        config: { filament_density: "1.3" },
      }),
      { params: Promise.resolve({ id: "Keeper" }) },
    );
    expect(res.status).toBe(200);
    expect((await Filament.findById(f._id)).name).toBe("Keeper"); // name is the addressing key — unchanged
  });

  it("#872 — an id-addressed per-nozzle sync does NOT rename the base filament to the suffixed name", async () => {
    const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      compatibleNozzles: [brass._id],
    });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        name: "PLA 0.4 Brass", // the derived suffixed name — must NOT overwrite the base name
        config: {
          filamentdb_id: String(f._id),
          filamentdb_nozzle: "0.4 Brass",
          extrusion_multiplier: "1.02",
        },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    expect((await Filament.findById(f._id)).name).toBe("PLA"); // a filamentdb_nozzle hint suppresses the rename
  });

  it("#872 — a per-nozzle sync routes max-vol/temps/fan to the CALIBRATION entry, not the filament-wide top level", async () => {
    const brass = await Nozzle.create({ name: "0.6 Brass", diameter: 0.6, type: "Brass" });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      maxVolumetricSpeed: 12, // filament-wide default — must survive
      temperatures: { nozzle: 210, bed: 60 },
      compatibleNozzles: [brass._id],
    });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PLA%200.6%20Brass", {
        config: {
          filamentdb_id: String(f._id),
          filamentdb_nozzle: "0.6 Brass",
          filament_max_volumetric_speed: "25",
          temperature: "215",
          bed_temperature: "65",
          min_fan_speed: "40",
          max_fan_speed: "100",
          extrusion_multiplier: "1.05",
          filament_retract_length: "1.2",
        },
      }),
      { params: Promise.resolve({ id: "PLA 0.6 Brass" }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    // Filament-wide values UNTOUCHED — one nozzle's preset must not clobber the default.
    expect(fresh.maxVolumetricSpeed).toBe(12);
    expect(fresh.temperatures.nozzle).toBe(210);
    expect(fresh.temperatures.bed).toBe(60);
    expect(fresh.settings?.min_fan_speed).toBeUndefined(); // fan didn't leak into the settings bag
    // Codex P2: EM/retraction were captured into the calibration entry below, so they
    // must NOT also leak into the shared settings bag (which would make this nozzle's
    // values the default for the base filament + every other preset).
    expect(fresh.settings?.extrusion_multiplier).toBeUndefined();
    expect(fresh.settings?.filament_retract_length).toBeUndefined();
    // The per-nozzle calibration entry carries them instead.
    expect(fresh.calibrations).toHaveLength(1);
    const cal = fresh.calibrations[0];
    expect(cal.maxVolumetricSpeed).toBe(25);
    expect(cal.nozzleTemp).toBe(215);
    expect(cal.bedTemp).toBe(65);
    expect(cal.fanMinSpeed).toBe(40);
    expect(cal.fanMaxSpeed).toBe(100);
    expect(cal.extrusionMultiplier).toBe(1.05);
    expect(cal.retractLength).toBe(1.2);
  });

  it("#872 — an id-addressed per-nozzle sync routes calibration via the hint (no nozzle_diameter query) (Codex P2)", async () => {
    const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      compatibleNozzles: [brass._id],
    });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        // ObjectId URL (decodedName is the id, not the suffix) + a hint → still per-nozzle
        config: {
          filamentdb_id: String(f._id),
          filamentdb_nozzle: "0.4 Brass",
          extrusion_multiplier: "1.04",
        },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.calibrations).toHaveLength(1);
    expect(fresh.calibrations[0].extrusionMultiplier).toBe(1.04);
    expect(String(fresh.calibrations[0].nozzle)).toBe(String(brass._id));
  });

  it("#872 — a per-nozzle sync with NO resolvable nozzle falls back to the top level (no data loss)", async () => {
    // A 0.4 Brass exists, but the hint is "0.4 Carbide" — the type filter finds no
    // match (compatibleNozzles empty + global), so no calibration entry resolves.
    await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({ name: "PLA", vendor: "X", type: "PLA", maxVolumetricSpeed: 10 });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PLA%200.4%20Carbide", {
        config: {
          filamentdb_id: String(f._id),
          filamentdb_nozzle: "0.4 Carbide",
          filament_max_volumetric_speed: "20",
          temperature: "230",
          extrusion_multiplier: "1.09",
          filament_retract_length: "1.5",
        },
      }),
      { params: Promise.resolve({ id: "PLA 0.4 Carbide" }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.calibrations ?? []).toHaveLength(0); // no nozzle resolved → no calibration entry
    // The top-level-homed values are NOT lost — they fall back to the filament-wide fields.
    expect(fresh.maxVolumetricSpeed).toBe(20);
    expect(fresh.temperatures.nozzle).toBe(230);
    // Codex P2 round 3: EM/retraction have NO top-level home; for a per-nozzle preset
    // they must be DROPPED (not leaked into the shared settings bag) even when no
    // nozzle resolves — else one nozzle's EM becomes the base filament's default.
    expect(fresh.settings?.extrusion_multiplier).toBeUndefined();
    expect(fresh.settings?.filament_retract_length).toBeUndefined();
  });

  it("#883 — PrusaSlicer sync-back doesn't clobber a coextruded filament's null primary with the echoed secondary", async () => {
    const f = await Filament.create({
      name: "Coex PLA",
      vendor: "X",
      type: "PLA",
      color: null,
      secondaryColors: ["#112233", "#445566"],
    });
    // The export gives the slicer secondaryColors[0] as the single colour; the
    // slicer echoes it back (upper-cased). It must NOT become the primary.
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        config: { filamentdb_id: String(f._id), filament_colour: "#112233".toUpperCase() },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.color).toBeNull(); // null primary preserved
    expect(fresh.secondaryColors).toEqual(["#112233", "#445566"]); // untouched
  });

  it("#883 — a genuinely new color from the slicer IS written to a coextruded filament", async () => {
    const f = await Filament.create({
      name: "Coex PETG",
      vendor: "X",
      type: "PETG",
      color: null,
      secondaryColors: ["#112233"],
    });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        config: { filamentdb_id: String(f._id), filament_colour: "#ff0000" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    expect((await Filament.findById(f._id)).color).toBe("#ff0000"); // real edit applied
  });

  it("#885 — sync-back of a changed color clears the stale colorName", async () => {
    const f = await Filament.create({
      name: "Galaxy PLA",
      vendor: "X",
      type: "PLA",
      color: "#101010",
      colorName: "Galaxy Black",
    });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        config: { filamentdb_id: String(f._id), filament_colour: "#ff0000" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.color).toBe("#ff0000");
    expect(fresh.colorName ?? null).toBeNull(); // stale name cleared, not left as "Galaxy Black"
  });

  it("#885 — sync-back of the SAME color keeps the colorName", async () => {
    const f = await Filament.create({
      name: "Galaxy PLA 2",
      vendor: "X",
      type: "PLA",
      color: "#101010",
      colorName: "Galaxy Black",
    });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        config: { filamentdb_id: String(f._id), filament_colour: "#101010" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    expect((await Filament.findById(f._id)).colorName).toBe("Galaxy Black"); // no-op, name preserved
  });

  it("#885/#918 — a case-only hex difference is NOT a change; colorName preserved", async () => {
    const f = await Filament.create({
      name: "Case PLA",
      vendor: "X",
      type: "PLA",
      color: "#ff0000",
      colorName: "Red",
    });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        config: { filamentdb_id: String(f._id), filament_colour: "#FF0000" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    expect((await Filament.findById(f._id)).colorName).toBe("Red"); // no-op, name kept
  });

  it("#885 — coextruded echo suppression leaves colorName untouched", async () => {
    const f = await Filament.create({
      name: "Coex named",
      vendor: "X",
      type: "PLA",
      color: null,
      colorName: "Rainbow",
      secondaryColors: ["#112233", "#445566"],
    });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${f._id}`, {
        config: { filamentdb_id: String(f._id), filament_colour: "#112233" },
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.color).toBeNull(); // echo suppressed (resolvedColor undefined)
    expect(fresh.colorName).toBe("Rainbow"); // so name is NOT cleared
  });

  // ── #951: a variant sync must not pin parent-inherited values ──────
  // The bundle export flattens a variant through resolveFilament, so the fork
  // echoes the parent's density/cost/temps back on every sync. Blindly $set-ing
  // them onto the variant would sever GH #106 live inheritance.

  it("#951 — syncing a variant does NOT pin parent-equal inherited values (inheritance survives)", async () => {
    const parent = await Filament.create({
      name: "Sync PLA",
      vendor: "Acme",
      type: "PLA",
      cost: 25,
      density: 1.24,
      spoolWeight: 250,
      temperatures: { nozzle: 215, bed: 60 },
    });
    const variant = await Filament.create({
      name: "Sync PLA — Red",
      vendor: "Acme",
      type: "PLA",
      color: "#FF0000",
      parentId: parent._id,
      // fully inheriting
    });

    // The fork echoes the full (resolved) config — every value equals the parent.
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${variant._id}`, {
        config: {
          filamentdb_id: String(variant._id),
          filament_type: "PLA",
          filament_vendor: "Acme",
          filament_density: "1.24",
          filament_cost: "25",
          filament_spool_weight: "250",
          temperature: "215",
          bed_temperature: "60",
        },
      }),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(res.status).toBe(200);

    const fresh = await Filament.findById(variant._id).lean();
    // None of the parent-equal inherited fields were pinned as local overrides.
    expect(fresh.cost).toBeNull();
    expect(fresh.density).toBeNull();
    expect(fresh.spoolWeight ?? null).toBeNull();
    expect(fresh.temperatures?.nozzle ?? null).toBeNull();
    expect(fresh.temperatures?.bed ?? null).toBeNull();

    // A later parent edit still propagates to the variant (GH #106 intact).
    await Filament.updateOne({ _id: parent._id }, { $set: { cost: 30 } });
    const { resolveFilament } = await import("@/lib/resolveFilament");
    const freshParent = await Filament.findById(parent._id).lean();
    expect(resolveFilament(fresh, freshParent).cost).toBe(30);
  });

  it("#951 — a variant sync value that DIFFERS from the parent is written as a genuine override", async () => {
    const parent = await Filament.create({
      name: "Sync PETG",
      vendor: "Acme",
      type: "PETG",
      cost: 20,
      temperatures: { nozzle: 240 },
    });
    const variant = await Filament.create({
      name: "Sync PETG — Black",
      vendor: "Acme",
      type: "PETG",
      color: "#000000",
      parentId: parent._id,
    });

    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${variant._id}`, {
        config: {
          filamentdb_id: String(variant._id),
          filament_cost: "20", // == parent → not pinned
          temperature: "250", // ≠ parent 240 → genuine override
        },
      }),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(res.status).toBe(200);

    const fresh = await Filament.findById(variant._id).lean();
    expect(fresh.cost).toBeNull(); // inherited
    expect(fresh.temperatures.nozzle).toBe(250); // override written
  });

  it("#951 — a variant sync clears a stale local override once it matches the parent again ($unset)", async () => {
    const parent = await Filament.create({
      name: "Sync ASA",
      vendor: "Acme",
      type: "ASA",
      cost: 35,
    });
    const variant = await Filament.create({
      name: "Sync ASA — White",
      vendor: "Acme",
      type: "ASA",
      color: "#FFFFFF",
      parentId: parent._id,
      cost: 40, // stale divergence
    });

    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${variant._id}`, {
        config: { filamentdb_id: String(variant._id), filament_cost: "35" }, // == parent
      }),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(res.status).toBe(200);

    const fresh = await Filament.findById(variant._id).lean();
    expect(fresh.cost == null).toBe(true); // $unset → inheritance resumes
  });

  it("#951 (Codex F1) — a variant sync does not pin parent-inherited slicer settings", async () => {
    const parent = await Filament.create({
      name: "Settings PLA",
      vendor: "Acme",
      type: "PLA",
      settings: { some_passthrough_key: "parentval", shared_key: "same" },
    });
    const variant = await Filament.create({
      name: "Settings PLA — Green",
      vendor: "Acme",
      type: "PLA",
      color: "#00FF00",
      parentId: parent._id,
      // inherits settings from the parent
    });

    // The fork echoes the resolved settings (parent ∪ variant); shared_key ==
    // parent, some_passthrough_key == parent, and one genuine variant override.
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${variant._id}`, {
        config: {
          filamentdb_id: String(variant._id),
          some_passthrough_key: "parentval", // == parent → must not pin
          shared_key: "same", // == parent → must not pin
          variant_only_key: "mine", // ≠ parent → genuine override
        },
      }),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(res.status).toBe(200);

    const fresh = await Filament.findById(variant._id).lean();
    const vs = (fresh.settings ?? {}) as Record<string, unknown>;
    // Parent-equal keys are NOT stored on the variant → they keep inheriting.
    expect(vs.some_passthrough_key).toBeUndefined();
    expect(vs.shared_key).toBeUndefined();
    // The genuine override is stored.
    expect(vs.variant_only_key).toBe("mine");

    // A later parent settings edit still propagates to the variant.
    await Filament.updateOne(
      { _id: parent._id },
      { $set: { "settings.some_passthrough_key": "changed" } },
    );
    const { resolveFilament } = await import("@/lib/resolveFilament");
    const freshParent = await Filament.findById(parent._id).lean();
    const resolved = resolveFilament(fresh, freshParent);
    expect(resolved.settings.some_passthrough_key).toBe("changed");
  });

  it("#872 — a per-nozzle sync with an out-of-range baked calibration value is rejected with 400 (nothing persisted)", async () => {
    const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({
      name: "PLA",
      vendor: "X",
      type: "PLA",
      temperatures: { nozzle: 210 },
      compatibleNozzles: [brass._id],
    });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PLA%200.4%20Brass", {
        config: {
          filamentdb_id: String(f._id),
          filamentdb_nozzle: "0.4 Brass",
          temperature: "900", // schema max for calibration nozzleTemp is 600
        },
      }),
      { params: Promise.resolve({ id: "PLA 0.4 Brass" }) },
    );
    expect(res.status).toBe(400);
    const fresh = await Filament.findById(f._id);
    expect(fresh.calibrations ?? []).toHaveLength(0); // nothing written
    expect(fresh.temperatures.nozzle).toBe(210); // top-level untouched too
  });

  it("#872 — an out-of-range baked FAN value is rejected with 400 (calibration validators fire)", async () => {
    const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
    const f = await Filament.create({
      name: "PETG",
      vendor: "X",
      type: "PETG",
      compatibleNozzles: [brass._id],
    });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PETG%200.4%20Brass", {
        config: {
          filamentdb_id: String(f._id),
          filamentdb_nozzle: "0.4 Brass",
          max_fan_speed: "150", // schema max for calibration fanMaxSpeed is 100
        },
      }),
      { params: Promise.resolve({ id: "PETG 0.4 Brass" }) },
    );
    expect(res.status).toBe(400);
    expect((await Filament.findById(f._id)).calibrations ?? []).toHaveLength(0);
  });

  it("#872 — sync-back nozzle-type match is case-INSENSITIVE (symmetric with the read path)", async () => {
    // Stored nozzle is "Diamondback"; the hint is lowercased "0.4 diamondback"
    // (a user-edited / case-normalized preset name). The match must still resolve.
    const diamond = await Nozzle.create({ name: "0.4 DB", diameter: 0.4, type: "Diamondback" });
    const f = await Filament.create({
      name: "PA12-CF",
      vendor: "X",
      type: "PA12-CF",
      compatibleNozzles: [diamond._id],
    });
    const res = await slicerSync(
      jsonReq("http://localhost/api/filaments/PA12-CF%200.4%20diamondback", {
        config: {
          filamentdb_id: String(f._id),
          filamentdb_nozzle: "0.4 diamondback", // lowercased type
          extrusion_multiplier: "1.06",
        },
      }),
      { params: Promise.resolve({ id: "PA12-CF 0.4 diamondback" }) },
    );
    expect(res.status).toBe(200);
    const fresh = await Filament.findById(f._id);
    expect(fresh.calibrations).toHaveLength(1); // resolved despite the case mismatch
    expect(String(fresh.calibrations[0].nozzle)).toBe(String(diamond._id));
    expect(fresh.calibrations[0].extrusionMultiplier).toBe(1.06);
    expect(fresh.settings?.extrusion_multiplier).toBeUndefined(); // routed, not leaked
  });

  it("#867 Phase 2 — an ObjectId-URL rename to a TAKEN name returns 409 name_taken and does NOT rename", async () => {
    const a = await Filament.create({ name: "Alpha", vendor: "X", type: "PLA" });
    await Filament.create({ name: "Beta", vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${a._id}`, {
        name: "Beta", // collides with the other active filament
        config: { filament_density: "1.3" },
      }),
      { params: Promise.resolve({ id: String(a._id) }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("name_taken");
    expect((await Filament.findById(a._id)).name).toBe("Alpha"); // not renamed
  });

  it("#867 Phase 2 — a hex-NAMED preset (ObjectId-shaped URL, name match) is NOT renamed by body.name", async () => {
    const hexName = "abcdef012345678901234567"; // 24 hex chars, but a NAME, not any _id
    const f = await Filament.create({ name: hexName, vendor: "X", type: "PLA" });
    const res = await slicerSync(
      jsonReq(`http://localhost/api/filaments/${hexName}`, {
        name: "Renamed?",
        config: { filament_density: "1.3" },
      }),
      { params: Promise.resolve({ id: hexName }) },
    );
    expect(res.status).toBe(200);
    // urlIsObjectId is true (hex shape) but the _id lookup missed → matched by NAME,
    // so the rename must NOT fire (it's name-addressed semantics).
    expect((await Filament.findById(f._id)).name).toBe(hexName);
    // NOTE: the E11000 rename-race fallback (pre-check passes, the unique index
    // rejects a concurrent write → 409 name_taken) is covered by inspection + the
    // tested isDuplicateKeyError helper; it isn't unit-tested here because the only
    // way to trigger it deterministically is mocking findByIdAndUpdate, which is
    // fragile against this suite's between-test model re-registration.
  });

  it("#265 — calibration sync on a variant that OVERRIDES calibrations writes to the variant", async () => {
    // Codex P1: a variant with its own non-empty calibrations array
    // owns its calibrations (resolveFilament uses them, not the
    // parent's), so the sync must land on the variant — not the parent.
    const nozzle = await Nozzle.create({
      name: "0.4 Brass",
      diameter: 0.4,
      type: "brass",
    });
    const parent = await Filament.create({
      name: "PC Parent",
      vendor: "Prusa",
      type: "PC",
      compatibleNozzles: [nozzle._id],
    });
    const variant = await Filament.create({
      name: "PC Black",
      vendor: "Prusa",
      type: "PC",
      color: "#222222",
      parentId: parent._id,
      // Variant overrides both arrays — it is the calibration owner.
      compatibleNozzles: [nozzle._id],
      calibrations: [{ nozzle: nozzle._id, extrusionMultiplier: 0.9 }],
    });

    const res = await slicerSync(
      jsonReq(
        `http://localhost/api/filaments/${variant._id}?nozzle_diameter=0.4`,
        { config: { extrusion_multiplier: "1.2" } },
      ),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(res.status).toBe(200);

    // The override variant's own entry was updated...
    const freshVariant = await Filament.findById(variant._id);
    expect(freshVariant.calibrations).toHaveLength(1);
    expect(freshVariant.calibrations[0].extrusionMultiplier).toBe(1.2);

    // ...and the parent was left untouched.
    const freshParent = await Filament.findById(parent._id);
    expect(freshParent.calibrations ?? []).toHaveLength(0);
  });

  // ── #266: the slicer settings-bag merge is bounded ─────────────────

  it("#266 — orcaslicer sync rejects an over-large settings bag with 400", async () => {
    const f = await Filament.create({
      name: "Settings Host",
      vendor: "T",
      type: "PLA",
    });
    const body: Record<string, string> = {};
    for (let i = 0; i < 450; i++) body[`orca_key_${i}`] = "v";

    const res = await orcaSync(
      jsonReq(`http://localhost/api/filaments/${f._id}/orcaslicer`, body),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/settings/i);
  });

  // ── #618: slicer sync writes run validators + atomic calibration ────

  describe("#618 — slicer per-id sync validation and atomic calibration writes", () => {
    it("prusaslicer sync rejects a negative filament_cost with 400 and persists nothing", async () => {
      const f = await Filament.create({
        name: "Cost Host",
        vendor: "T",
        type: "PLA",
        cost: 25,
      });

      const res = await slicerSync(
        jsonReq(`http://localhost/api/filaments/${f._id}`, {
          config: { filament_cost: "-3" },
        }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      // Pre-fix: the write skipped the #337 validators, returned 200, and
      // cost: -3 persisted. The schema's min:0 must reject it as a 400.
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/cost/i);

      const fresh = await Filament.findById(f._id);
      expect(fresh.cost).toBe(25);
    });

    it("orcaslicer sync rejects a non-numeric cost with 400, not 500", async () => {
      const f = await Filament.create({
        name: "Orca Type Host",
        vendor: "T",
        type: "PLA",
        cost: 10,
      });

      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${f._id}/orcaslicer`, { cost: "abc" }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      // Pre-fix: "abc" rode into $set verbatim → CastError → generic 500.
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/cost/i);

      const fresh = await Filament.findById(f._id);
      expect(fresh.cost).toBe(10);
    });

    it("orcaslicer sync rejects a negative cost via the schema validators", async () => {
      const f = await Filament.create({
        name: "Orca Negative Host",
        vendor: "T",
        type: "PLA",
        cost: 10,
      });

      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${f._id}/orcaslicer`, { cost: -3 }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      // Pre-fix: the write skipped runValidators and -3 persisted silently.
      expect(res.status).toBe(400);

      const fresh = await Filament.findById(f._id);
      expect(fresh.cost).toBe(10);
    });

    it("orcaslicer sync rejects an inverted nozzle range with 400", async () => {
      const f = await Filament.create({
        name: "Orca Range Host",
        vendor: "T",
        type: "PLA",
      });

      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${f._id}/orcaslicer`, {
          temperatures: { nozzleRangeMin: 300, nozzleRangeMax: 200 },
        }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/minimum.*maximum/i);
    });

    it("orcaslicer sync rejects a lone min that inverts against the STORED max", async () => {
      // The sync merges incoming temps into the stored subdoc, so a body
      // carrying only nozzleRangeMin must be checked against the stored max.
      const f = await Filament.create({
        name: "Orca Stored-Max Host",
        vendor: "T",
        type: "PLA",
        temperatures: { nozzleRangeMax: 200 },
      });

      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${f._id}/orcaslicer`, {
          temperatures: { nozzleRangeMin: 300 },
        }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(400);
    });

    it("orcaslicer sync rejects a lone min that inverts against an INHERITED parent max", async () => {
      // A variant inherits any endpoint it leaves null from its parent
      // (resolveFilament: own ?? parent), so own min 300 + parent max 200
      // is an inverted effective range even though the body looks partial.
      const parent = await Filament.create({
        name: "Orca Range Parent",
        vendor: "T",
        type: "PLA",
        temperatures: { nozzleRangeMax: 200 },
      });
      const variant = await Filament.create({
        name: "Orca Range Variant",
        vendor: "T",
        type: "PLA",
        color: "#111111",
        parentId: parent._id,
      });

      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${variant._id}/orcaslicer`, {
          temperatures: { nozzleRangeMin: 300 },
        }),
        { params: Promise.resolve({ id: String(variant._id) }) },
      );
      expect(res.status).toBe(400);
    });

    it("orcaslicer sync still applies valid values (numeric-string coercion included)", async () => {
      const f = await Filament.create({
        name: "Orca Happy Host",
        vendor: "T",
        type: "PLA",
        temperatures: { bed: 60 },
      });

      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${f._id}/orcaslicer`, {
          cost: "12.5",
          temperatures: { nozzle: 215 },
        }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(200);

      const fresh = await Filament.findById(f._id);
      expect(fresh.cost).toBe(12.5);
      expect(fresh.temperatures.nozzle).toBe(215);
      // The merge preserves stored temps the sync didn't touch.
      expect(fresh.temperatures.bed).toBe(60);
    });

    it("sequential calibration syncs for different nozzles both persist (atomic per-entry writes)", async () => {
      const n04 = await Nozzle.create({
        name: "0.4 Brass",
        diameter: 0.4,
        type: "brass",
      });
      const n06 = await Nozzle.create({
        name: "0.6 Brass",
        diameter: 0.6,
        type: "brass",
      });
      const f = await Filament.create({
        name: "Cal Host",
        vendor: "T",
        type: "PLA",
        compatibleNozzles: [n04._id, n06._id],
      });

      // First sync calibrates the 0.4 nozzle...
      let res = await slicerSync(
        jsonReq(`http://localhost/api/filaments/${f._id}?nozzle_diameter=0.4`, {
          config: { extrusion_multiplier: "1.05" },
        }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(200);

      // ...the second calibrates the 0.6 — it must APPEND ($push), not
      // replace the array.
      res = await slicerSync(
        jsonReq(`http://localhost/api/filaments/${f._id}?nozzle_diameter=0.6`, {
          config: { extrusion_multiplier: "0.95" },
        }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(200);

      // A re-sync of the 0.4 nozzle updates its entry IN PLACE via the
      // $elemMatch-filtered positional $set — no duplicate entry.
      res = await slicerSync(
        jsonReq(`http://localhost/api/filaments/${f._id}?nozzle_diameter=0.4`, {
          config: { extrusion_multiplier: "1.1", pressure_advance: "0.045" },
        }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(200);

      const fresh = await Filament.findById(f._id);
      expect(fresh.calibrations).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cal04 = fresh.calibrations.find((c: any) => String(c.nozzle) === String(n04._id));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cal06 = fresh.calibrations.find((c: any) => String(c.nozzle) === String(n06._id));
      expect(cal04.extrusionMultiplier).toBe(1.1);
      expect(cal04.pressureAdvance).toBe(0.045);
      expect(cal06.extrusionMultiplier).toBe(0.95);
    });
  });

  // ── #671: route params are already URL-decoded — don't re-decode ──────

  describe("#671 — a filament name with a literal '%' resolves (no double-decode)", () => {
    it("spool-check GET resolves an 'ABS 100%' filament instead of 500ing", async () => {
      const f = await Filament.create({
        name: "ABS 100%",
        vendor: "Acme",
        type: "ABS",
        totalWeight: 1000,
      });
      const res = await spoolCheck(
        getReq("http://localhost/api/filaments/ABS%20100%25/spool-check?weight=10"),
        { params: Promise.resolve({ id: "ABS 100%" }) },
      );
      // Pre-fix: decodeURIComponent("ABS 100%") threw → caught → 500. The
      // route must actually RESOLVE the filament (200 + its name echoed back),
      // not merely avoid a 500 — so a regression to 404/400 also fails (Codex
      // P3 on PR #685).
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.filament).toBe("ABS 100%");
      expect(String(f._id)).toBeTruthy();
    });

    it("orcaslicer POST sync-back does not 500 on a '%' name from the decode", async () => {
      await Filament.create({ name: "PLA 50%off", vendor: "Acme", type: "PLA" });
      const res = await orcaSync(
        jsonReq("http://localhost/api/filaments/PLA%2050%25off/orcaslicer", {
          filament_settings_id: "PLA 50%off",
          name: "PLA 50%off",
        }),
        { params: Promise.resolve({ id: "PLA 50%off" }) },
      );
      expect(res.status).not.toBe(500);
    });
  });

  // ── #677: bulk slicer export ?ids= with a non-ObjectId → 400 not 500 ──

  describe("#677 — bulk slicer export rejects a non-ObjectId in ?ids= with 400", () => {
    it("orcaslicer GET", async () => {
      const res = await orcaBulkExport(
        getReq("http://localhost/api/filaments/orcaslicer?ids=not-an-id"),
      );
      expect(res.status).toBe(400);
    });
    it("prusaslicer GET", async () => {
      const res = await prusaBulkExport(
        getReq("http://localhost/api/filaments/prusaslicer?ids=not-an-id"),
      );
      expect(res.status).toBe(400);
    });
  });

  // ── #950: slicer round-trip fidelity + id-first addressing ──────────

  describe("#950 — slicer round-trip fidelity + id-first addressing", () => {
    it("950.1 — a per-id sync keeps filament_soluble/abrasive in the settings bag (no dead structured write)", async () => {
      const f = await Filament.create({ name: "PVA", vendor: "X", type: "PVA" });
      const res = await slicerSync(
        jsonReq("http://localhost/api/filaments/PVA", {
          config: { filament_soluble: "1", filament_abrasive: "0", filament_density: "1.23" },
        }),
        { params: Promise.resolve({ id: "PVA" }) },
      );
      expect(res.status).toBe(200);
      const fresh = await Filament.findById(f._id).lean();
      // The schema has no soluble/abrasive columns, so the old structured write
      // dropped them into the void. They now ride the settings bag, so a later
      // slicer export re-emits them (round-trip preserved).
      expect(fresh.settings?.filament_soluble).toBe("1");
      expect(fresh.settings?.filament_abrasive).toBe("0");
      // A genuinely structured key still lands on its top-level field.
      expect(fresh.density).toBe(1.23);
    });

    it("950.5 (sweep r8) — a per-nozzle sync PRESERVES a shared calibration default in the settings bag", async () => {
      // The per-id calibration sync adds context keys (extrusion_multiplier /
      // retraction / fans) to STRUCTURED_KEYS. A prior over-broad purge stripped
      // ALL structuredKeys from the existing bag, erasing a filament-wide shared EM
      // default on every per-nozzle sync. The purge is now narrow (never-baggable
      // only), so shared bag defaults the incoming preset didn't touch survive.
      const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
      const f = await Filament.create({
        name: "PLA",
        vendor: "X",
        type: "PLA",
        compatibleNozzles: [brass._id],
        settings: { extrusion_multiplier: "0.98", some_passthrough: "keep" },
      });
      const res = await slicerSync(
        jsonReq("http://localhost/api/filaments/PLA%200.4%20Brass", {
          config: {
            filamentdb_id: String(f._id),
            filamentdb_nozzle: "0.4 Brass",
            pressure_advance: "0.03", // routes to the calibration entry, not the bag
          },
        }),
        { params: Promise.resolve({ id: "PLA 0.4 Brass" }) },
      );
      expect(res.status).toBe(200);
      const fresh = await Filament.findById(f._id).lean();
      // The shared EM default (a structuredKey in calibration mode, but with no
      // top-level home) is NOT erased by the per-nozzle sync.
      expect(fresh.settings?.extrusion_multiplier).toBe("0.98");
      expect(fresh.settings?.some_passthrough).toBe("keep");
    });

    it("950.7 — a per-nozzle preset sync with an absent filamentdb_id falls back to the BASE name (no orphan)", async () => {
      const brass = await Nozzle.create({ name: "0.4 Brass", diameter: 0.4, type: "Brass" });
      const f = await Filament.create({
        name: "PLA",
        vendor: "X",
        type: "PLA",
        compatibleNozzles: [brass._id],
      });
      // Suffixed URL, filamentdb_nozzle hint, but NO filamentdb_id (DB-instance-
      // specific; stale/absent after a fresh install). Pre-fix the full suffixed
      // name missed → 404 → the fork spawned a "PLA 0.4 Brass" orphan.
      const res = await slicerSync(
        jsonReq("http://localhost/api/filaments/PLA%200.4%20Brass", {
          config: { filamentdb_nozzle: "0.4 Brass", extrusion_multiplier: "1.03" },
        }),
        { params: Promise.resolve({ id: "PLA 0.4 Brass" }) },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).matchedBy).toBe("name");
      const fresh = await Filament.findById(f._id);
      expect(fresh.name).toBe("PLA"); // base filament resolved + name untouched
      expect(fresh.calibrations).toHaveLength(1);
      expect(fresh.calibrations[0].extrusionMultiplier).toBe(1.03);
      expect(String(fresh.calibrations[0].nozzle)).toBe(String(brass._id));
      // No orphan created under the suffixed name.
      expect(await Filament.findOne({ name: "PLA 0.4 Brass" })).toBeNull();
    });

    it("950.7 — a suffixed name whose base ALSO misses still 404s (no false base match)", async () => {
      // No "PLA" filament exists; the base-name retry finds nothing → 404, and the
      // fork's create path is the correct outcome here (genuinely new preset).
      const res = await slicerSync(
        jsonReq("http://localhost/api/filaments/PLA%200.4%20Brass", {
          config: { filamentdb_nozzle: "0.4 Brass", extrusion_multiplier: "1.03" },
        }),
        { params: Promise.resolve({ id: "PLA 0.4 Brass" }) },
      );
      expect(res.status).toBe(404);
    });

    it("950.5 (sweep) — a per-id sync PURGES a stale structured key (filament_settings_id) from the existing settings bag", async () => {
      // Latent 950.5 leak on the merge path: a legacy bag carrying a structured
      // key would survive the merge (mergeSlicerSettings only skipped it from the
      // INCOMING config) and shadow the re-derived value on the next export. The
      // fix strips structured keys from the seeded existing bag too.
      const f = await Filament.create({
        name: "Sweep PLA",
        vendor: "X",
        type: "PLA",
        settings: { filament_settings_id: "Stale Old Name", some_passthrough: "keep" },
      });
      const res = await slicerSync(
        jsonReq(`http://localhost/api/filaments/${f._id}`, {
          config: { filament_density: "1.24" },
        }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(200);
      const fresh = await Filament.findById(f._id).lean();
      // Stale structured shadow purged (export re-derives filament_settings_id from name).
      expect(fresh.settings?.filament_settings_id).toBeUndefined();
      // Genuine passthrough keys survive.
      expect(fresh.settings?.some_passthrough).toBe("keep");
      expect(fresh.density).toBe(1.24); // structured field still applied
    });

    it("950.5 (sweep r9) — an orca sync does NOT persist an INCOMING filament_settings_id into the bag", async () => {
      // orca's STRUCTURED_KEYS omits filament_settings_id, so without skipping
      // never-baggable keys from incoming, the exported preset-name key would land
      // in the bag and shadow the re-derived name on the next export.
      const f = await Filament.create({ name: "Orca Incoming PLA", vendor: "X", type: "PLA" });
      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${f._id}/orcaslicer`, {
          type: "PLA",
          filament_settings_id: "Some Preset Name", // incoming never-baggable key
        }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(200);
      const fresh = await Filament.findById(f._id).lean();
      expect(fresh.settings?.filament_settings_id).toBeUndefined(); // not persisted
    });

    it("950.5 (sweep r5/r8) — an orca sync purges a stale filament_settings_id even with no new passthrough key, but preserves other bag keys", async () => {
      // The orca per-id route gates its settings write on `added`; without honoring
      // `removed`, a structured-only sync discards the purge and the stale
      // never-baggable key survives. And per r8 the purge must be NARROW — a
      // non-never-baggable stale shadow (density) must survive.
      const f = await Filament.create({
        name: "Orca Sweep PLA",
        vendor: "X",
        type: "PLA",
        settings: { filament_settings_id: "Stale Name", density: "9.9", filament_notes: "keep" },
      });
      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${f._id}/orcaslicer`, { type: "PETG" }),
        { params: Promise.resolve({ id: String(f._id) }) },
      );
      expect(res.status).toBe(200);
      const fresh = await Filament.findById(f._id).lean();
      // Never-baggable key purged despite no passthrough key being added...
      expect(fresh.settings?.filament_settings_id).toBeUndefined();
      // ...but a non-never-baggable shadow + real passthrough survive (narrow purge).
      expect(fresh.settings?.density).toBe("9.9");
      expect(fresh.settings?.filament_notes).toBe("keep");
      expect(fresh.type).toBe("PETG");
    });

    it("950.6 — spool-check resolves a 24-hex URL by _id FIRST, not a name that looks like an id", async () => {
      // The slicer-facing GET routes must resolve the same way as the id-first
      // sync/export routes, or a slicer addressing by id reads the WRONG row.
      const real = await Filament.create({
        name: "Real Spool PLA",
        vendor: "X",
        type: "PLA",
        totalWeight: 1000,
        spoolWeight: 200,
      });
      // A DIFFERENT filament NAMED with the real one's 24-hex _id, with NO stock.
      await Filament.create({
        name: String(real._id),
        vendor: "X",
        type: "ABS",
        totalWeight: 0,
        spoolWeight: 200,
      });
      const res = await spoolCheck(
        getReq(`http://localhost/api/filaments/${real._id}/spool-check?weight=100`),
        { params: Promise.resolve({ id: String(real._id) }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // The _id lookup wins: we check the real (stocked) filament, not the empty decoy.
      expect(body.ok).toBe(true);
      expect(body.spools.length).toBe(1);
    });

    it("950.6 — orcaslicer sync resolves a 24-hex URL by _id FIRST, not a name that looks like an id", async () => {
      const real = await Filament.create({ name: "Real PLA", vendor: "X", type: "PLA" });
      // A DIFFERENT filament whose NAME happens to be the real one's 24-hex _id.
      await Filament.create({ name: String(real._id), vendor: "X", type: "ABS" });
      const res = await orcaSync(
        jsonReq(`http://localhost/api/filaments/${real._id}/orcaslicer`, {
          filament_settings_id: String(real._id),
          name: String(real._id),
          type: "PETG",
        }),
        { params: Promise.resolve({ id: String(real._id) }) },
      );
      expect(res.status).toBe(200);
      // The _id lookup wins: the sync targets "Real PLA", not the hex-named decoy.
      expect((await res.json()).filament).toBe("Real PLA");
      expect((await Filament.findById(real._id)).type).toBe("PETG");
      expect((await Filament.findOne({ name: String(real._id) })).type).toBe("ABS"); // decoy untouched
    });
  });
});
