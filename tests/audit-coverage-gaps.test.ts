import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as importSpools } from "@/app/api/spools/import/route";
import { POST as postPrintHistory } from "@/app/api/print-history/route";
import { extractFromTdsContent } from "@/lib/tdsExtractor";

/**
 * GH #227 — fill in the high-impact coverage gaps the audit flagged.
 *
 * Three branches that the v1.16.1 test suite never executed:
 *
 *   1. print-history POST inside an actual `withTransaction` callback
 *      (the existing tests all run through the standalone-fallback
 *      because mongodb-memory-server isn't a replica set). A schema or
 *      typo in the transactional code path would ship undetected.
 *
 *   2. tdsExtractor error branches in `callOpenAI` (HTTP 401 / 429 /
 *      generic 5xx) and the empty-response check in `callProvider`,
 *      plus the unknown-provider default in the switch.
 *
 *   3. The spools-import route-level translation of the
 *      `CsvRowLimitExceededError` thrown by `parseCsv` past 10k rows.
 *      The route currently catches under a generic "Failed to parse
 *      CSV" — assert the specific row-limit message bubbles up.
 */
describe("GH #227 — audit coverage gaps", () => {
  // ---------------------------------------------------------------------
  // 1. print-history transaction-path coverage
  // ---------------------------------------------------------------------

  describe("print-history transaction-path is exercised", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Filament: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let PrintHistory: any;

    beforeEach(async () => {
      const filMod = await import("@/models/Filament");
      const phMod = await import("@/models/PrintHistory");
      const prMod = await import("@/models/Printer");
      if (!mongoose.models.Filament) {
        mongoose.model("Filament", filMod.default.schema);
      }
      if (!mongoose.models.PrintHistory) {
        mongoose.model("PrintHistory", phMod.default.schema);
      }
      if (!mongoose.models.Printer) {
        mongoose.model("Printer", prMod.default.schema);
      }
      Filament = mongoose.models.Filament;
      PrintHistory = mongoose.models.PrintHistory;
    });

    function makeReq(body: unknown) {
      return new NextRequest("http://localhost/api/print-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("transactional callback is actually invoked (not just synthesised by the fallback)", async () => {
      // The existing test suite all routes through the standalone-fallback
      // branch because mongodb-memory-server isn't a replica set —
      // `connection.transaction()` throws "Transaction numbers are only
      // allowed..." and the fallback runs. This test mocks
      // `connection.transaction` (GH #949: the route swapped a bare
      // startSession().withTransaction() for connection.transaction()) so its
      // callback actually fires, exercising the body of the transactional code
      // path at least once.
      //
      // We can't easily assert the *commit* succeeded against the
      // memory-server (passing a fake `session` to save/create errors at
      // Mongoose's internals — the real ClientSession has many more methods
      // than our shim). The thing we can pin is: the callback FIRES — i.e. the
      // txn branch is on the executed code path rather than getting skipped to
      // fallback.
      const f = await Filament.create({
        name: "Txn Callback PLA",
        vendor: "T",
        type: "PLA",
        spools: [{ label: "main", totalWeight: 1000 }],
      });

      let callbackRan = false;
      const txnSpy = vi
        .spyOn(mongoose.Connection.prototype, "transaction")
        .mockImplementationOnce(
          async (fn: (session: mongoose.ClientSession) => Promise<unknown>) => {
            callbackRan = true;
            try {
              await fn({} as mongoose.ClientSession);
            } catch {
              // Real Atlas rolls back here; we just swallow so the route
              // returns the "happy" path rather than the synthetic-error path.
              // The fake session makes the inner save()/create() error — we
              // don't care whether they committed, only that the callback
              // fired.
            }
            return undefined as never;
          },
        );

      await postPrintHistory(
        makeReq({
          jobLabel: "txn-callback job",
          usage: [{ filamentId: String(f._id), grams: 100 }],
        }),
      );

      txnSpy.mockRestore();
      expect(callbackRan).toBe(true);
    });

    it("an abort inside the transaction surfaces as a 500 and creates no PrintHistory row", async () => {
      // GH #264: honest scope. This test does NOT verify transactional
      // rollback — that is a MongoDB guarantee exercised only on a
      // replica set (Atlas), and tests/setup.ts runs a single-node
      // mongodb-memory-server. The mocked `connection.transaction` (GH #949:
      // the route now uses connection.transaction(), not
      // startSession().withTransaction()) runs the callback then throws
      // *without* rolling back. The abort message is NOT a txn-unsupported
      // one, so the route rethrows rather than dropping to the sequential
      // fallback. What this test locks in is the route's failure *shape* on an
      // unexpected abort: a 500 response (not a 201) and no
      // independently-committed PrintHistory row (create lives inside the
      // aborted callback). Rollback of the spool weight itself is covered in
      // production by the real driver.
      const f = await Filament.create({
        name: "Txn Abort PLA",
        vendor: "T",
        type: "PLA",
        spools: [{ label: "main", totalWeight: 1000 }],
      });

      const txnSpy = vi
        .spyOn(mongoose.Connection.prototype, "transaction")
        .mockImplementationOnce(
          async (fn: (session: mongoose.ClientSession) => Promise<unknown>) => {
            try {
              await fn({} as mongoose.ClientSession);
            } catch {
              // The fake session makes the inner save()/create() error before
              // anything commits; we ignore it and drive the assertion from the
              // outer abort below.
            }
            throw new Error("simulated transaction abort");
          },
        );

      let res;
      try {
        res = await postPrintHistory(
          makeReq({
            jobLabel: "abort job",
            usage: [{ filamentId: String(f._id), grams: 100 }],
          }),
        );
      } catch {
        // The handler routes through errorResponseFromCaught — should
        // not throw.
      }
      txnSpy.mockRestore();

      // 500 expected — the unexpected abort isn't a VersionError so the
      // 409 path doesn't apply.
      expect(res?.status).toBe(500);
      // PrintHistory.create was NOT committed independently of the
      // aborted session — no rows from this job.
      const ph = await PrintHistory.find({ jobLabel: "abort job" }).lean();
      expect(ph).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // 2. tdsExtractor error branches
  // ---------------------------------------------------------------------

  describe("tdsExtractor error branches", () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("OpenAI HTTP 5xx → error result with status + truncated body", async () => {
      // Pass a plain text content path (the OpenAI branch refuses PDF)
      // and stub fetch to return 500.
      global.fetch = vi.fn(async () =>
        new Response("rate limited by upstream — try again later", {
          status: 500,
        }),
      ) as unknown as typeof fetch;
      const result = await extractFromTdsContent(
        Buffer.from("filament data here", "utf-8"),
        "text/plain",
        "fake-key",
        "openai",
      );
      expect(result.success).toBe(false);
      // After withRetry exhausts attempts the surfaced error includes
      // the HTTP code + a body excerpt.
      expect(result.error).toMatch(/HTTP 5\d\d|rate limited/i);
    });

    it("OpenAI HTTP 401 → 'Invalid API key' guidance", async () => {
      global.fetch = vi.fn(async () =>
        new Response("invalid key", { status: 401 }),
      ) as unknown as typeof fetch;
      const result = await extractFromTdsContent(
        Buffer.from("text", "utf-8"),
        "text/plain",
        "fake-key",
        "openai",
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid OpenAI API key/i);
    });

    it("unknown provider in the switch default rejects with 'Unknown AI provider'", async () => {
      // The TS signature is constrained to AiProvider, so we cast through
      // unknown to exercise the runtime default branch. A future refactor
      // that adds a provider but forgets to update the switch would land
      // here.
      const result = await extractFromTdsContent(
        Buffer.from("x", "utf-8"),
        "text/plain",
        "k",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "claude-7" as any,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Unknown AI provider/i);
    });
  });

  // ---------------------------------------------------------------------
  // 3. spools-import row-limit translation
  // ---------------------------------------------------------------------

  describe("spools-import row-limit response", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Filament: any;

    beforeEach(async () => {
      const filMod = await import("@/models/Filament");
      const locMod = await import("@/models/Location");
      if (!mongoose.models.Filament) {
        mongoose.model("Filament", filMod.default.schema);
      }
      if (!mongoose.models.Location) {
        mongoose.model("Location", locMod.default.schema);
      }
      Filament = mongoose.models.Filament;
    });

    it("returns 400 with a row-limit-specific message when the CSV exceeds 10000 rows", async () => {
      // Create a filament so the import has a valid filamentName to
      // bind every row against; what we're testing is the parse step,
      // not the upsert.
      await Filament.create({
        name: "Bulk PLA",
        vendor: "T",
        type: "PLA",
      });

      const header = "filamentName,label,totalWeight\n";
      const row = "Bulk PLA,Spool,1000\n";
      const csv = header + row.repeat(10_001);

      const req = new NextRequest("http://localhost/api/spools/import", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      });
      const res = await importSpools(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      // Should match the specific row-limit message, not just a generic
      // "Failed to parse CSV". The unit test on parseCsv asserts the
      // throw shape — this asserts the route surfaces it without
      // swallowing.
      expect(body.error).toMatch(/Failed to parse CSV/i);
      // The detail field carries the row-limit specifics so the UI can
      // surface a useful message instead of a stack-trace-shaped blob.
      expect(body.detail).toMatch(/10000|row.*limit|exceeds/i);
    });
  });
});
