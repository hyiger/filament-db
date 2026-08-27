import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

/**
 * GH #1168 — GET /api/spools/usage-search (the /history page's ledger tab).
 *
 * Pins:
 *   - label substring match is case-insensitive and treats regex
 *     metacharacters LITERALLY (escapeRegex);
 *   - the 128-char label cap and source/limit validation return 400;
 *   - source filtering, date-desc ordering, limit clamping;
 *   - soft-deleted filaments are excluded;
 *   - the response never carries photoDataUrl bytes (the #1005 posture).
 */
describe("GET /api/spools/usage-search (GH #1168)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const PHOTO_MARKER = "data:image/png;base64,USAGESEARCHBLOBMARKER";

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    Filament = mongoose.models.Filament;
  });

  function makeRequest(query = ""): NextRequest {
    return new NextRequest(`http://localhost/api/spools/usage-search${query}`);
  }

  async function run(query = "") {
    const { GET } = await import("@/app/api/spools/usage-search/route");
    const res = await GET(makeRequest(query));
    const body = await res.json();
    return { res, body };
  }

  async function seed() {
    await Filament.create({
      name: "Ledger PLA",
      vendor: "QA",
      type: "PLA",
      diameter: 1.75,
      spools: [
        {
          label: "roll-1",
          totalWeight: 500,
          photoDataUrl: PHOTO_MARKER,
          usageHistory: [
            { date: new Date("2026-01-05T00:00:00Z"), grams: 12, jobLabel: "Benchy (v2)", source: "manual" },
            { date: new Date("2026-01-07T00:00:00Z"), grams: 30, jobLabel: "Calibration cube", source: "job" },
          ],
        },
        {
          label: "roll-2",
          totalWeight: 800,
          usageHistory: [
            { date: new Date("2026-01-06T00:00:00Z"), grams: 5, jobLabel: "benchy keel", source: "manual" },
          ],
        },
      ],
    });
    await Filament.create({
      name: "Trashed PETG",
      vendor: "QA",
      type: "PETG",
      diameter: 1.75,
      _deletedAt: new Date(),
      spools: [
        {
          label: "gone",
          totalWeight: 100,
          usageHistory: [
            { date: new Date("2026-01-08T00:00:00Z"), grams: 99, jobLabel: "Benchy ghost", source: "manual" },
          ],
        },
      ],
    });
  }

  it("returns all entries date-desc with flat row fields", async () => {
    await seed();
    const { res, body } = await run();
    expect(res.status).toBe(200);
    expect(body.entries).toHaveLength(3);
    expect(body.entries.map((e: { grams: number }) => e.grams)).toEqual([30, 5, 12]);
    const first = body.entries[0];
    expect(first.filamentName).toBe("Ledger PLA");
    expect(first.vendor).toBe("QA");
    expect(first.spoolLabel).toBe("roll-1");
    expect(first.jobLabel).toBe("Calibration cube");
    expect(first.source).toBe("job");
    expect(typeof first.filamentId).toBe("string");
    expect(typeof first.spoolId).toBe("string");
  });

  it("label search is case-insensitive substring across spools", async () => {
    await seed();
    const { body } = await run("?label=benchy");
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((e: { spoolLabel: string }) => e.spoolLabel).sort()).toEqual([
      "roll-1",
      "roll-2",
    ]);
  });

  it("regex metacharacters in the label are literal (escapeRegex)", async () => {
    await seed();
    const { body } = await run("?label=" + encodeURIComponent("(v2)"));
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].jobLabel).toBe("Benchy (v2)");
    // A would-be wildcard matches nothing rather than everything.
    const { body: dotStar } = await run("?label=" + encodeURIComponent(".*"));
    expect(dotStar.entries).toHaveLength(0);
  });

  it("filters by source", async () => {
    await seed();
    const { body } = await run("?source=manual");
    expect(body.entries).toHaveLength(2);
    expect(body.entries.every((e: { source: string }) => e.source === "manual")).toBe(true);
  });

  it("excludes soft-deleted filaments", async () => {
    await seed();
    const { body } = await run("?label=ghost");
    expect(body.entries).toHaveLength(0);
  });

  it("clamps via validation: bad limit, bad source, over-long label all 400", async () => {
    const { res: badLimit } = await run("?limit=0");
    expect(badLimit.status).toBe(400);
    const { res: hugeLimit } = await run("?limit=1001");
    expect(hugeLimit.status).toBe(400);
    const { res: fracLimit } = await run("?limit=2.5");
    expect(fracLimit.status).toBe(400);
    const { res: badSource } = await run("?source=telepathy");
    expect(badSource.status).toBe(400);
    const { res: longLabel } = await run("?label=" + "x".repeat(129));
    expect(longLabel.status).toBe(400);
  });

  it("applies the limit after date-desc ordering", async () => {
    await seed();
    const { body } = await run("?limit=2");
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((e: { grams: number }) => e.grams)).toEqual([30, 5]);
    expect(body.limit).toBe(2);
  });

  it("never leaks photoDataUrl bytes into the response (#1005 posture)", async () => {
    await seed();
    const { body } = await run();
    expect(body.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("USAGESEARCHBLOBMARKER");
  });
});
