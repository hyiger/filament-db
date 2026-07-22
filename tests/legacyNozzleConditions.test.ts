import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  clearLegacyNozzleConditionsOnce,
  deriveLegacyNozzleCondition,
  isLegacyMachineNozzleCondition,
  LegacyCleanupInProgressError,
  LEGACY_NOZZLE_CONDITION_RE,
  type MinimalDb,
} from "@/lib/legacyNozzleConditions";

/**
 * GH #1021 (#1022) — the one-shot, per-DB, claim-first cleanup of
 * machine-derived nozzle compatibility conditions. Exercised directly against
 * the shared in-memory MongoDB (tests/setup.ts) plus thin wrappers to reach
 * the failure branches. Selection is PROVENANCE-based: a candidate is cleared
 * only when its stored value byte-equals the legacy derivation from its
 * effective compatibleNozzles — ObjectId REFS resolved against the nozzles
 * collection (mirroring the populate() the removed exporter did), own list
 * else the parent's.
 */
describe("clearLegacyNozzleConditionsOnce", () => {
  const db = () => mongoose.connection.db! as unknown as MinimalDb;
  const rawDb = () => mongoose.connection.db!;
  const MARKER = { _id: "legacyNozzleConditions" as never };
  let nozzleSeq = 0;

  beforeEach(async () => {
    await rawDb().collection("_migrations").deleteMany({});
    await rawDb().collection("filaments").deleteMany({ name: /^LNC / });
    await rawDb().collection("nozzles").deleteMany({ name: /^LNC / });
  });

  async function seedNozzle(diameter: unknown) {
    const res = await rawDb()
      .collection("nozzles")
      .insertOne({ name: `LNC noz ${++nozzleSeq}`, diameter, _deletedAt: null });
    return res.insertedId;
  }

  async function seed(
    name: string,
    condition: string | undefined,
    extra: Record<string, unknown> = {},
  ) {
    const res = await rawDb()
      .collection("filaments")
      .insertOne({
        name: `LNC ${name}`,
        vendor: "T",
        type: "PLA",
        settings:
          condition === undefined
            ? { cooling: "1" }
            : { compatible_printers_condition: condition, cooling: "1" },
        ...extra,
      });
    return res.insertedId;
  }
  const conditionOf = async (name: string) =>
    (await rawDb().collection("filaments").findOne({ name: `LNC ${name}` }))!.settings
      .compatible_printers_condition;

  it("clears provenance-matched machine values (refs → nozzles join); preserves user pins and human expressions", async () => {
    const noz04 = await seedNozzle(0.4);
    const noz06 = await seedNozzle(0.6);
    const noz025 = await seedNozzle(0.25);
    const nozJunk = await seedNozzle("not-a-number"); // populate found it, derivation filtered it
    const danglingRef = new mongoose.Types.ObjectId(); // populate → null → contributed nothing

    // updatedAt present → the clear predicate matches on its exact value
    // (rows without one exercise the null fallback).
    await seed("machine-single", "nozzle_diameter[0]==0.4", {
      compatibleNozzles: [noz04],
      updatedAt: new Date(),
    });
    // Unordered, duplicated, junk-diameter, and dangling entries — the join +
    // frozen derivation dedupe, filter, and sort exactly like populate did.
    await seed("machine-multi", "nozzle_diameter[0]==0.25 or nozzle_diameter[0]==0.6", {
      compatibleNozzles: [noz06, noz025, noz025, nozJunk, danglingRef],
    });
    // THE round-6 P1 case: a pre-upgrade USER-authored pure nozzle pin — same
    // syntax, but it does not match the derivation from the row's ticks.
    await seed("user-pin-mismatch", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz06] });
    // Shape match but NO tick provenance at all — nothing to attribute it to.
    await seed("user-pin-no-ticks", "nozzle_diameter[0]==0.4", { compatibleNozzles: [] });
    // Refs that all dangle derive to nothing → preserved.
    await seed("user-pin-dangling", "nozzle_diameter[0]==0.4", {
      compatibleNozzles: [danglingRef],
    });
    await seed("human-compound", "printer_model==MK4 and nozzle_diameter[0]==0.4");
    await seed("human-comparison", "nozzle_diameter[0]>=0.4");
    await seed("no-condition", undefined);

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: true, cleared: 2 });

    expect(await conditionOf("machine-single")).toBe("");
    expect(await conditionOf("machine-multi")).toBe("");
    expect(await conditionOf("user-pin-mismatch")).toBe("nozzle_diameter[0]==0.4");
    expect(await conditionOf("user-pin-no-ticks")).toBe("nozzle_diameter[0]==0.4");
    expect(await conditionOf("user-pin-dangling")).toBe("nozzle_diameter[0]==0.4");
    expect(await conditionOf("human-compound")).toBe("printer_model==MK4 and nozzle_diameter[0]==0.4");
    expect(await conditionOf("human-comparison")).toBe("nozzle_diameter[0]>=0.4");
    expect(await conditionOf("no-condition")).toBeUndefined();
    const doc = await rawDb().collection("filaments").findOne({ name: "LNC machine-single" });
    expect(doc!.settings.cooling).toBe("1"); // sibling key untouched

    const marker = await rawDb().collection("_migrations").findOne(MARKER);
    expect(marker).not.toBeNull();
    expect(marker!.completed).toBe(true);
  });

  it("resolves a variant's provenance through its PARENT's compatibleNozzles refs (the exporter's resolution)", async () => {
    const noz04 = await seedNozzle(0.4);
    const parentId = await seed("parent", undefined, { compatibleNozzles: [noz04] });
    // Variant inherited the parent's ticks at export time (GH #106 rule), so
    // its persisted machine value derives from the PARENT's populated list.
    await seed("variant-inherited", "nozzle_diameter[0]==0.4", {
      compatibleNozzles: [],
      parentId,
    });
    // A variant whose pin does NOT match the parent's derivation is a user pin.
    await seed("variant-user-pin", "nozzle_diameter[0]==0.8", {
      compatibleNozzles: [],
      parentId,
    });

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: true, cleared: 1 });
    expect(await conditionOf("variant-inherited")).toBe("");
    expect(await conditionOf("variant-user-pin")).toBe("nozzle_diameter[0]==0.8");
  });

  it("a machine-grammar pin authored AFTER completion survives every later run", async () => {
    await clearLegacyNozzleConditionsOnce(db()); // completes on an empty DB
    const noz04 = await seedNozzle(0.4);
    await seed("post-upgrade-pin", "nozzle_diameter[0]==0.4", {
      compatibleNozzles: [noz04], // even provenance-matching!
    });

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: false, reason: "already-done" });
    expect(await conditionOf("post-upgrade-pin")).toBe("nozzle_diameter[0]==0.4"); // NOT erased
  });

  it("leaves a row alone when its condition changes between scan and write (concurrent ordinary writer)", async () => {
    // Claiming serializes CLEANUP runners only — an Atlas DB keeps serving
    // other clients mid-clear. The destructive write must therefore re-assert
    // the scanned value (Codex P1 r7).
    const noz04 = await seedNozzle(0.4);
    const rowId = await seed("toctou", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "filaments") return col;
        return {
          findOne: col.findOne.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: col.updateOne.bind(col),
          find: (filter: Record<string, unknown>, opts?: Record<string, unknown>) => {
            const cursor = col.find(filter, opts);
            const isCandidateScan = "settings.compatible_printers_condition" in filter;
            return {
              toArray: async () => {
                const rows = await cursor.toArray();
                if (isCandidateScan) {
                  // Another client rewrites the condition AFTER the scan…
                  await rawDb().collection("filaments").updateOne(
                    { _id: rowId },
                    { $set: { "settings.compatible_printers_condition": "nozzle_diameter[0]==0.9" } },
                  );
                }
                return rows;
              },
            };
          },
        };
      },
    };
    const res = await clearLegacyNozzleConditionsOnce(wrapper);
    // …so the conditional clear matches nothing and the new pin survives.
    expect(res).toEqual({ ran: true, cleared: 0 });
    expect(await conditionOf("toctou")).toBe("nozzle_diameter[0]==0.9");
  });

  it("re-scans until dry: a candidate written MID-CLEANUP is examined before completion (r21)", async () => {
    const noz04 = await seedNozzle(0.4);
    await seed("first-wave", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    let arrived = false;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "filaments") return col;
        return {
          findOne: col.findOne.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: col.updateOne.bind(col),
          find: (filter: Record<string, unknown>, opts?: Record<string, unknown>) => {
            const isCandidateScan = "settings.compatible_printers_condition" in filter;
            return {
              toArray: async () => {
                const rows = await col.find(filter, opts).toArray();
                if (isCandidateScan && !arrived) {
                  // Another client (a pre-#1022 peer) lands a stamped row
                  // right after this scan — the next pass must catch it.
                  arrived = true;
                  await rawDb().collection("filaments").insertOne({
                    name: "LNC mid-window",
                    vendor: "T",
                    type: "PLA",
                    compatibleNozzles: [noz04],
                    settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4" },
                  });
                }
                return rows;
              },
            };
          },
        };
      },
    };
    const res = await clearLegacyNozzleConditionsOnce(wrapper);
    expect(res).toEqual({ ran: true, cleared: 2 }); // first wave + the mid-window arrival
    expect(await conditionOf("first-wave")).toBe("");
    expect(await conditionOf("mid-window")).toBe("");
    expect((await rawDb().collection("_migrations").findOne(MARKER))!.completed).toBe(true);
  });

  it("throws (transient) instead of completing when new candidates keep arriving at the pass cap (r21)", async () => {
    const noz04 = await seedNozzle(0.4);
    await seed("wave-0", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    let wave = 0;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "filaments") return col;
        return {
          findOne: col.findOne.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: col.updateOne.bind(col),
          find: (filter: Record<string, unknown>, opts?: Record<string, unknown>) => {
            const isCandidateScan = "settings.compatible_printers_condition" in filter;
            return {
              toArray: async () => {
                const rows = await col.find(filter, opts).toArray();
                if (isCandidateScan) {
                  // A pathological continuous writer: every pass finds one more.
                  wave += 1;
                  await rawDb().collection("filaments").insertOne({
                    name: `LNC wave-${wave}`,
                    vendor: "T",
                    type: "PLA",
                    compatibleNozzles: [noz04],
                    settings: { compatible_printers_condition: "nozzle_diameter[0]==0.4" },
                  });
                }
                return rows;
              },
            };
          },
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toBeInstanceOf(
      LegacyCleanupInProgressError,
    );
    // Not completed — released for a later retry once the writer stops.
    const marker = await rawDb().collection("_migrations").findOne(MARKER);
    expect(marker!.completed).toBeUndefined();
    expect(marker!.released).toBe(true);
  });

  it("preserves a deliberately re-pinned IDENTICAL condition via the updatedAt predicate (r9)", async () => {
    // The text-only predicate can't see a save that re-pins the byte-same
    // expression — the observed updatedAt in the clear filter can.
    const noz04 = await seedNozzle(0.4);
    const rowId = await seed("same-text-repin", "nozzle_diameter[0]==0.4", {
      compatibleNozzles: [noz04],
      updatedAt: new Date(Date.now() - 60_000),
    });
    const real = db();
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "filaments") return col;
        return {
          findOne: col.findOne.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: col.updateOne.bind(col),
          find: (filter: Record<string, unknown>, opts?: Record<string, unknown>) => {
            const cursor = col.find(filter, opts);
            const isCandidateScan = "settings.compatible_printers_condition" in filter;
            return {
              toArray: async () => {
                const rows = await cursor.toArray();
                if (isCandidateScan) {
                  // A user SAVES the identical pin after the scan — same text,
                  // fresh updatedAt (every app save bumps it).
                  await rawDb().collection("filaments").updateOne(
                    { _id: rowId },
                    { $set: { "settings.compatible_printers_condition": "nozzle_diameter[0]==0.4", updatedAt: new Date() } },
                  );
                }
                return rows;
              },
            };
          },
        };
      },
    };
    const res = await clearLegacyNozzleConditionsOnce(wrapper);
    expect(res).toEqual({ ran: true, cleared: 0 });
    expect(await conditionOf("same-text-repin")).toBe("nozzle_diameter[0]==0.4"); // pin survives
  });

  it("a runner fenced out by a takeover aborts BEFORE any destructive write (r9)", async () => {
    const noz04 = await seedNozzle(0.4);
    await seed("fenced", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          findOne: col.findOne.bind(col),
          find: col.find.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
            // Right before OUR per-row progress record lands, another process
            // takes the claim over (a run that outlived staleMs) — new token.
            if (JSON.stringify(u).includes("$addToSet")) {
              await col.updateOne(MARKER, { $set: { claimToken: "someone-else" } });
            }
            return col.updateOne(f, u);
          },
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toBeInstanceOf(
      LegacyCleanupInProgressError,
    );
    expect(await conditionOf("fenced")).toBe("nozzle_diameter[0]==0.4"); // fenced runner cleared nothing
    // Its release write no-oped too — the new holder's claim is untouched.
    const marker = await rawDb().collection("_migrations").findOne(MARKER);
    expect(marker!.claimToken).toBe("someone-else");
    expect(marker!.released).toBeUndefined();
  });

  it("a TRANSIENT completion-write failure releases the claim — no wait-until-stale outage (r10)", async () => {
    const noz04 = await seedNozzle(0.4);
    await seed("almost-done", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    let failCompletion = true;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          findOne: col.findOne.bind(col),
          find: col.find.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
            if (failCompletion && JSON.stringify(u).includes("completed")) {
              failCompletion = false;
              throw new Error("completion blip");
            }
            return col.updateOne(f, u);
          },
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toThrow("completion blip");
    // The row work is DONE and the claim was released — not left live-shaped
    // (which would make every dbConnect wait waitMs and fail until staleMs).
    expect(await conditionOf("almost-done")).toBe("");
    const marker = await rawDb().collection("_migrations").findOne(MARKER);
    expect(marker!.released).toBe(true);
    expect(marker!.completed).toBeUndefined();
    // The resumed retry finds no candidates left and just completes.
    expect(await clearLegacyNozzleConditionsOnce(wrapper)).toEqual({ ran: true, cleared: 0 });
    expect((await rawDb().collection("_migrations").findOne(MARKER))!.completed).toBe(true);
  });

  it("completion-crash worst case: completion AND its release both fail → waiters throw, stale takeover completes (r10)", async () => {
    const noz04 = await seedNozzle(0.4);
    await seed("done-but-stuck", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          findOne: col.findOne.bind(col),
          find: col.find.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
            const body = JSON.stringify(u);
            if (body.includes("completed")) throw new Error("completion blip");
            if (body.includes("released")) throw new Error("release blip");
            return col.updateOne(f, u);
          },
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toThrow("completion blip");
    // Row work done, but the claim stayed live-shaped → contenders throw…
    expect(await conditionOf("done-but-stuck")).toBe("");
    await expect(
      clearLegacyNozzleConditionsOnce(db(), { waitMs: 40, pollMs: 10 }),
    ).rejects.toBeInstanceOf(LegacyCleanupInProgressError);
    // …until the stale takeover resumes: nothing left to clear, completes.
    await new Promise((r) => setTimeout(r, 5));
    const res = await clearLegacyNozzleConditionsOnce(db(), { waitMs: 40, pollMs: 10, staleMs: 0 });
    expect(res).toEqual({ ran: true, cleared: 0 });
    expect((await rawDb().collection("_migrations").findOne(MARKER))!.completed).toBe(true);
  });

  it("re-asserts ownership at the destructive-write boundary (r10 P2)", async () => {
    const noz04 = await seedNozzle(0.4);
    await seed("boundary", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    // _migrations findOne call order in a fresh run: (1) claim-loop observe,
    // (2) progress re-read, (3+) the per-row ownership re-check.
    let findOneCalls = 0;
    let mode: "swap" | "vanish" = "swap";
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          insertOne: col.insertOne.bind(col),
          find: col.find.bind(col),
          updateOne: col.updateOne.bind(col),
          findOne: async (filter) => {
            findOneCalls += 1;
            if (findOneCalls === 3) {
              if (mode === "vanish") return null; // marker hard-deleted mid-run
              // A takeover lands between the record and the clear.
              await col.updateOne(MARKER, { $set: { claimToken: "someone-else" } });
            }
            return col.findOne(filter);
          },
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toBeInstanceOf(
      LegacyCleanupInProgressError,
    );
    expect(await conditionOf("boundary")).toBe("nozzle_diameter[0]==0.4"); // clear never ran

    // Same abort when the marker is GONE at the boundary.
    await rawDb().collection("_migrations").deleteMany({});
    findOneCalls = 0;
    mode = "vanish";
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toBeInstanceOf(
      LegacyCleanupInProgressError,
    );
    expect(await conditionOf("boundary")).toBe("nozzle_diameter[0]==0.4");
  });

  it("a takeover between the last clear and completion surfaces the in-progress error (r9)", async () => {
    // No candidate rows, so the completion write is the first fenced write.
    const real = db();
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          findOne: col.findOne.bind(col),
          find: col.find.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
            if (JSON.stringify(u).includes("completed")) {
              await col.updateOne(MARKER, { $set: { claimToken: "someone-else" } });
            }
            return col.updateOne(f, u);
          },
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toBeInstanceOf(
      LegacyCleanupInProgressError,
    );
    // The taken-over claim was not marked completed by the fenced runner.
    const marker = await rawDb().collection("_migrations").findOne(MARKER);
    expect(marker!.completed).toBeUndefined();
  });

  it("WAITS on a live claim and resolves already-done when the claimant completes", async () => {
    await rawDb().collection("_migrations").insertOne({ ...MARKER, claimedAt: new Date() });
    const noz04 = await seedNozzle(0.4);
    await seed("would-be-cleared", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });

    const pending = clearLegacyNozzleConditionsOnce(db(), { waitMs: 3000, pollMs: 10 });
    // Simulate the winner finishing while we poll.
    await new Promise((r) => setTimeout(r, 50));
    await rawDb().collection("_migrations").updateOne(MARKER, { $set: { completed: true } });

    expect(await pending).toEqual({ ran: false, reason: "already-done" });
    // The waiter never cleared anything itself.
    expect(await conditionOf("would-be-cleared")).toBe("nozzle_diameter[0]==0.4");
  });

  it("takes over when a live claim is RELEASED mid-wait (winner hit a transient failure)", async () => {
    await rawDb().collection("_migrations").insertOne({ ...MARKER, claimedAt: new Date(), processed: [] });
    const noz04 = await seedNozzle(0.4);
    await seed("retry-target", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });

    const pending = clearLegacyNozzleConditionsOnce(db(), { waitMs: 3000, pollMs: 10 });
    await new Promise((r) => setTimeout(r, 50));
    // Winner durably marked its failed attempt released (progress kept).
    await rawDb().collection("_migrations").updateOne(MARKER, { $set: { released: true } });

    expect(await pending).toEqual({ ran: true, cleared: 1 });
    expect(await conditionOf("retry-target")).toBe("");
  });

  it("THROWS (does not skip) when a live claim outlasts waitMs — callers must not treat the DB as clean", async () => {
    await rawDb().collection("_migrations").insertOne({ ...MARKER, claimedAt: new Date() });
    const noz04 = await seedNozzle(0.4);
    await seed("still-dirty", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });

    await expect(
      clearLegacyNozzleConditionsOnce(db(), { waitMs: 60, pollMs: 10 }),
    ).rejects.toBeInstanceOf(LegacyCleanupInProgressError);
    expect(await conditionOf("still-dirty")).toBe("nozzle_diameter[0]==0.4");
  });

  it("RESUMES a stale claim (crashed claimer) via CAS takeover — progress makes takeover safe", async () => {
    // Malformed observation entries (from whatever wrote them) are ignored,
    // never crashed on.
    await rawDb()
      .collection("_migrations")
      .insertOne({
        ...MARKER,
        claimedAt: new Date(Date.now() - 60 * 60 * 1000),
        processed: [null, "junk", { i: 42 }],
      });
    const noz04 = await seedNozzle(0.4);
    await seed("crash-residue", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: true, cleared: 1 });
    expect(await conditionOf("crash-residue")).toBe("");
    expect((await rawDb().collection("_migrations").findOne(MARKER))!.completed).toBe(true);

    // A malformed claim (unreadable claimedAt) is likewise taken over.
    await rawDb().collection("_migrations").deleteMany({});
    await rawDb().collection("_migrations").insertOne({ ...MARKER, claimedAt: "not-a-date" });
    expect(await clearLegacyNozzleConditionsOnce(db())).toEqual({ ran: true, cleared: 0 });

    // …as is one with NO claimedAt at all (the CAS filter's null fallback
    // matches the missing field under Mongo's null query semantics).
    await rawDb().collection("_migrations").deleteMany({});
    await rawDb().collection("_migrations").insertOne({ ...MARKER, released: true });
    expect(await clearLegacyNozzleConditionsOnce(db())).toEqual({ ran: true, cleared: 0 });
  });

  it("a RESUMED attempt skips any recorded row the user TOUCHED since (r8+r11: authored values survive)", async () => {
    const noz04 = await seedNozzle(0.4);
    const machineText = "nozzle_diameter[0]==0.4";
    // Row A: examined-and-cleared by attempt 1 (observation = the machine
    // value); the user then authored a byte-identical pin — every app save
    // sets/bumps updatedAt, so the observation mismatches.
    const idA = await seed("repinned-after-clear", machineText, {
      compatibleNozzles: [noz04],
      updatedAt: new Date(),
    });
    // Row B (Codex P1 r11): examined but NOT a provenance match in attempt 1
    // (its recorded ticks derivation differed); between attempts the user
    // edited it — the app save bumped updatedAt — into something that NOW
    // provenance-matches. Still untouchable: the observation mismatches.
    const idB = await seed("changed-since-examined", machineText, {
      compatibleNozzles: [noz04],
      updatedAt: new Date(),
    });
    // Row C: examined by attempt 1 and untouched since (identical
    // observation) — the resume may finish the interrupted clear.
    const idC = await seed("untouched-machine", machineText, { compatibleNozzles: [noz04] });
    // Row D: same, but with PARENT-provenance (inherited ticks, unchanged).
    const parentId = await seed("untouched-parent", undefined, { compatibleNozzles: [noz04] });
    const idD = await seed("untouched-variant", machineText, { compatibleNozzles: [], parentId });
    await rawDb().collection("_migrations").insertOne({
      ...MARKER,
      claimedAt: new Date(),
      released: true,
      processed: [
        { i: String(idA), c: machineText, u: null, d: machineText }, // pre-clear observation
        { i: String(idB), c: "nozzle_diameter[0]==0.8", u: null, d: machineText }, // old non-match
        { i: String(idC), c: machineText, u: null, d: machineText },
        { i: String(idD), c: machineText, u: null, d: machineText },
        // A legacy-shaped entry with no recorded derivation (never verifiable)
        // must load without crashing and never make its row eligible.
        { i: "000000000000000000000000", c: "x", u: null },
      ],
    });

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: true, cleared: 2 });
    expect(await conditionOf("repinned-after-clear")).toBe(machineText); // pin SURVIVES
    expect(await conditionOf("changed-since-examined")).toBe(machineText); // authored value SURVIVES
    expect(await conditionOf("untouched-machine")).toBe(""); // interrupted work finished
    expect(await conditionOf("untouched-variant")).toBe(""); // parent-provenance work finished too
    expect((await rawDb().collection("_migrations").findOne(MARKER))!.completed).toBe(true);
  });

  it("a RESUMED attempt skips recorded rows whose PARENT ticks drifted since examination (r15)", async () => {
    const machineText = "nozzle_diameter[0]==0.4";
    const noz04 = await seedNozzle(0.4);
    const noz08 = await seedNozzle(0.8);
    // Case A: at examination the parent derived ==0.4 (machine match,
    // recorded d); the parent's ticks then moved to 0.8 — the CHILD is
    // untouched, but the value is no longer clearable under current ticks.
    const parentA = await seed("drift-parent-a", undefined, { compatibleNozzles: [noz08] });
    const idA = await seed("drift-variant", machineText, { compatibleNozzles: [], parentId: parentA });
    // Case B: at examination the parent derived ==0.8 (so the stored ==0.4
    // was judged a USER PIN, recorded d = ==0.8); the parent's ticks then
    // moved to 0.4 — the pin now coincidentally matches the derivation, but
    // the recorded d mismatch proves the judgment context changed: skip.
    const parentB = await seed("drift-parent-b", undefined, { compatibleNozzles: [noz04] });
    const idB = await seed("drift-pin", machineText, { compatibleNozzles: [], parentId: parentB });
    await rawDb().collection("_migrations").insertOne({
      ...MARKER,
      claimedAt: new Date(),
      released: true,
      processed: [
        { i: String(idA), c: machineText, u: null, d: machineText },
        { i: String(idB), c: machineText, u: null, d: "nozzle_diameter[0]==0.8" },
      ],
    });

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: true, cleared: 0 });
    expect(await conditionOf("drift-variant")).toBe(machineText); // survives
    expect(await conditionOf("drift-pin")).toBe(machineText); // pin survives
    expect((await rawDb().collection("_migrations").findOne(MARKER))!.completed).toBe(true);
  });

  it("skips a variant whose provenance parent is soft-DELETED (r15: unresolvable at export)", async () => {
    const noz04 = await seedNozzle(0.4);
    const parentId = await seed("deleted-parent", undefined, {
      compatibleNozzles: [noz04],
      _deletedAt: new Date(),
    });
    await seed("orphaned-variant", "nozzle_diameter[0]==0.4", {
      compatibleNozzles: [],
      parentId,
    });

    const res = await clearLegacyNozzleConditionsOnce(db());
    expect(res).toEqual({ ran: true, cleared: 0 });
    // The export path can't resolve a deleted parent, so its ticks prove
    // nothing — the value is preserved as a possible user pin.
    expect(await conditionOf("orphaned-variant")).toBe("nozzle_diameter[0]==0.4");
  });

  it("re-derives through the ACTIVE parent right before the clear — a mid-run parent tick edit skips the row (r15)", async () => {
    const noz04 = await seedNozzle(0.4);
    const noz08 = await seedNozzle(0.8);
    const parentId = await seed("hot-parent", undefined, { compatibleNozzles: [noz04] });
    await seed("hot-variant", "nozzle_diameter[0]==0.4", { compatibleNozzles: [], parentId });
    const real = db();
    let parentEdited = false;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "filaments") return col;
        return {
          find: col.find.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: col.updateOne.bind(col),
          findOne: async (filter: Record<string, unknown>) => {
            // The pre-clear parent revalidation is the only filaments.findOne
            // in the flow — edit the parent's ticks just before it reads, as
            // a concurrent client would between the scan and the write.
            if (!parentEdited) {
              parentEdited = true;
              await rawDb()
                .collection("filaments")
                .updateOne(
                  { _id: parentId },
                  { $set: { compatibleNozzles: [noz08], updatedAt: new Date() } },
                );
            }
            return col.findOne(filter);
          },
        };
      },
    };
    const res = await clearLegacyNozzleConditionsOnce(wrapper);
    expect(res).toEqual({ ran: true, cleared: 0 });
    expect(parentEdited).toBe(true);
    expect(await conditionOf("hot-variant")).toBe("nozzle_diameter[0]==0.4"); // not cleared under drifted ticks
  });

  it("re-derives OWN-tick rows from fresh nozzle docs before the clear — a mid-run diameter edit skips the row (r16)", async () => {
    // A nozzle DOC edit (diameter change / purge) changes the derivation
    // without touching the filament row, so the child's condition+updatedAt
    // predicate cannot see it — only the fresh-doc re-derivation can.
    const noz04 = await seedNozzle(0.4);
    await seed("own-tick-drift", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    let nozzleFinds = 0;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "nozzles") return col;
        return {
          findOne: col.findOne.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: col.updateOne.bind(col),
          find: (filter: Record<string, unknown>, opts?: Record<string, unknown>) => {
            nozzleFinds += 1;
            const isRevalidation = nozzleFinds >= 2; // 1 = scan join, 2+ = pre-clear re-read
            return {
              toArray: async () => {
                if (isRevalidation) {
                  // The nozzle's diameter is edited between the scan and the
                  // destructive write.
                  await rawDb()
                    .collection("nozzles")
                    .updateOne({ _id: noz04 }, { $set: { diameter: 0.8 } });
                }
                return col.find(filter, opts).toArray();
              },
            };
          },
        };
      },
    };
    const res = await clearLegacyNozzleConditionsOnce(wrapper);
    expect(res).toEqual({ ran: true, cleared: 0 });
    expect(nozzleFinds).toBeGreaterThanOrEqual(2);
    expect(await conditionOf("own-tick-drift")).toBe("nozzle_diameter[0]==0.4"); // preserved
  });

  it("skips the clear when the provenance parent is DELETED mid-run (r15 revalidation)", async () => {
    const noz04 = await seedNozzle(0.4);
    const parentId = await seed("vanishing-parent", undefined, { compatibleNozzles: [noz04] });
    await seed("vanishing-variant", "nozzle_diameter[0]==0.4", { compatibleNozzles: [], parentId });
    const real = db();
    let parentDeleted = false;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "filaments") return col;
        return {
          find: col.find.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: col.updateOne.bind(col),
          findOne: async (filter: Record<string, unknown>) => {
            // Soft-delete the parent just before the pre-clear revalidation
            // reads it — the _deletedAt:null re-read then finds nothing.
            if (!parentDeleted) {
              parentDeleted = true;
              await rawDb()
                .collection("filaments")
                .updateOne({ _id: parentId }, { $set: { _deletedAt: new Date() } });
            }
            return col.findOne(filter);
          },
        };
      },
    };
    const res = await clearLegacyNozzleConditionsOnce(wrapper);
    expect(res).toEqual({ ran: true, cleared: 0 });
    expect(await conditionOf("vanishing-variant")).toBe("nozzle_diameter[0]==0.4"); // preserved
  });

  it("loses a takeover CAS race and falls back to observing the new holder", async () => {
    await rawDb().collection("_migrations").insertOne({
      ...MARKER,
      claimedAt: new Date(Date.now() - 60 * 60 * 1000),
      released: true,
      processed: [],
    });
    const real = db();
    let casIntercepted = false;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          findOne: col.findOne.bind(col),
          find: col.find.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
            // Just before OUR takeover CAS lands, a racer takes over AND
            // completes — so our CAS matches nothing and we must re-observe.
            if (!casIntercepted && "claimedAt" in f) {
              casIntercepted = true;
              await col.updateOne(MARKER, {
                $set: { claimedAt: new Date(), completed: true },
                $unset: { released: "" },
              });
            }
            return col.updateOne(f, u);
          },
        };
      },
    };
    const res = await clearLegacyNozzleConditionsOnce(wrapper, { waitMs: 500, pollMs: 10 });
    expect(res).toEqual({ ran: false, reason: "already-done" });
    expect(casIntercepted).toBe(true);
  });

  it("loses the claim-insert race and falls back to observing the winner", async () => {
    const noz04 = await seedNozzle(0.4);
    await seed("race-victim", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    let findOneCalls = 0;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          findOne: async (filter) => {
            findOneCalls += 1;
            // First observation sees no marker; by insert time a racer claimed
            // AND completed, so the re-observe loop resolves already-done.
            if (findOneCalls === 1) return null;
            return col.findOne(filter);
          },
          insertOne: async (docToInsert) => {
            await rawDb()
              .collection("_migrations")
              .insertOne({ ...MARKER, claimedAt: new Date(), completed: true });
            return rawDb().collection("_migrations").insertOne(docToInsert as never); // duplicate _id → E11000
          },
          find: col.find.bind(col),
          updateOne: col.updateOne.bind(col),
        };
      },
    };
    const res = await clearLegacyNozzleConditionsOnce(wrapper, { waitMs: 500, pollMs: 10 });
    expect(res).toEqual({ ran: false, reason: "already-done" });
    expect(await conditionOf("race-victim")).toBe("nozzle_diameter[0]==0.4"); // loser never cleared
  });

  it("releases the claim and rethrows on a transient clear failure, so a retry succeeds", async () => {
    const noz04 = await seedNozzle(0.4);
    await seed("retry-me", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    let failNext = true;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "filaments") return col;
        return {
          findOne: col.findOne.bind(col),
          find: col.find.bind(col),
          insertOne: col.insertOne.bind(col),
          updateOne: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
            if (failNext) {
              failNext = false;
              throw new Error("transient");
            }
            return col.updateOne(f, u);
          },
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toThrow("transient");
    // Claim kept, durably marked RELEASED; the row's OBSERVATION is recorded,
    // which is exactly what lets the retry finish it while untouched.
    const failedMarker = await rawDb().collection("_migrations").findOne(MARKER);
    expect(failedMarker).not.toBeNull();
    expect(failedMarker!.released).toBe(true);
    expect(failedMarker!.completed).toBeUndefined();
    expect(failedMarker!.processed).toHaveLength(1);
    const res = await clearLegacyNozzleConditionsOnce(wrapper);
    expect(res).toEqual({ ran: true, cleared: 1 });
    expect(await conditionOf("retry-me")).toBe("");
  });

  it("hard-crash worst case: clear AND release writes fail → waiters throw, stale takeover finishes the untouched row", async () => {
    // Clear fails and the release mark fails too. The original error still
    // propagates, the claim stays live-shaped with the row's OBSERVATION
    // recorded, contenders THROW until it goes stale — and the eventual
    // takeover may finish the interrupted clear precisely because the row is
    // byte-identical to its recorded observation (any user save in between
    // would mismatch and skip it forever).
    const noz04 = await seedNozzle(0.4);
    await seed("stuck", "nozzle_diameter[0]==0.4", { compatibleNozzles: [noz04] });
    const real = db();
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name === "filaments") {
          return {
            findOne: col.findOne.bind(col),
            find: col.find.bind(col),
            insertOne: col.insertOne.bind(col),
            updateOne: async () => {
              throw new Error("clear failed");
            },
          };
        }
        if (name === "_migrations") {
          return {
            findOne: col.findOne.bind(col),
            find: col.find.bind(col),
            insertOne: col.insertOne.bind(col),
            updateOne: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
              if (JSON.stringify(u).includes("released")) {
                throw new Error("marker write failed");
              }
              return col.updateOne(f, u);
            },
          };
        }
        return col;
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toThrow("clear failed");
    // Claim still held and LIVE → a bounded-wait contender throws in-progress…
    await expect(
      clearLegacyNozzleConditionsOnce(db(), { waitMs: 40, pollMs: 10 }),
    ).rejects.toBeInstanceOf(LegacyCleanupInProgressError);
    // …and once stale, the takeover resumes and completes the untouched row.
    await new Promise((r) => setTimeout(r, 5));
    const res = await clearLegacyNozzleConditionsOnce(db(), { waitMs: 40, pollMs: 10, staleMs: 0 });
    expect(res).toEqual({ ran: true, cleared: 1 });
    expect(await conditionOf("stuck")).toBe("");
    expect((await rawDb().collection("_migrations").findOne(MARKER))!.completed).toBe(true);
  });

  it("a non-duplicate claim-insert failure propagates (not swallowed as a race)", async () => {
    const real = db();
    let rejection: unknown = new Error("network down");
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          findOne: async () => null,
          insertOne: async () => {
            throw rejection;
          },
          find: col.find.bind(col),
          updateOne: col.updateOne.bind(col),
        };
      },
    };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toThrow("network down");
    // Non-object / message-less rejections must not be misread as a race either.
    rejection = "boom";
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toBe("boom");
    rejection = null;
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toBe(null);
    rejection = { code: 999 };
    await expect(clearLegacyNozzleConditionsOnce(wrapper)).rejects.toEqual({ code: 999 });
  });

  it("recognizes a message-shaped E11000 without the numeric code as losing the race", async () => {
    const real = db();
    let findOneCalls = 0;
    const wrapper: MinimalDb = {
      collection(name) {
        const col = real.collection(name);
        if (name !== "_migrations") return col;
        return {
          findOne: async (filter) => {
            findOneCalls += 1;
            if (findOneCalls === 1) return null;
            return col.findOne(filter);
          },
          insertOne: async () => {
            await rawDb()
              .collection("_migrations")
              .insertOne({ ...MARKER, claimedAt: new Date(), completed: true });
            throw new Error("E11000 duplicate key error collection: _migrations");
          },
          find: col.find.bind(col),
          updateOne: col.updateOne.bind(col),
        };
      },
    };
    expect(await clearLegacyNozzleConditionsOnce(wrapper, { waitMs: 500, pollMs: 10 })).toEqual({
      ran: false,
      reason: "already-done",
    });
  });

  it("deriveLegacyNozzleCondition reproduces the removed exporter derivation byte-for-byte", () => {
    expect(deriveLegacyNozzleCondition([{ diameter: 0.4 }])).toBe("nozzle_diameter[0]==0.4");
    expect(
      deriveLegacyNozzleCondition([{ diameter: 0.6 }, { diameter: 0.25 }, { diameter: 0.25 }]),
    ).toBe("nozzle_diameter[0]==0.25 or nozzle_diameter[0]==0.6");
    expect(deriveLegacyNozzleCondition([{ diameter: 1 }])).toBe("nozzle_diameter[0]==1");
    expect(deriveLegacyNozzleCondition([{ diameter: 0 }, { diameter: -0.4 }, { diameter: "x" }, null])).toBeNull();
    expect(deriveLegacyNozzleCondition([])).toBeNull();
    expect(deriveLegacyNozzleCondition(undefined)).toBeNull();
    expect(deriveLegacyNozzleCondition("0.4")).toBeNull();
  });

  it("isLegacyMachineNozzleCondition = machine grammar AND byte-equal derivation (the ingestion predicate)", () => {
    const nozzles = [{ diameter: 0.4 }, { diameter: 0.6 }];
    expect(
      isLegacyMachineNozzleCondition("nozzle_diameter[0]==0.4 or nozzle_diameter[0]==0.6", nozzles),
    ).toBe(true);
    // Grammar match but wrong ticks → user pin.
    expect(isLegacyMachineNozzleCondition("nozzle_diameter[0]==0.8", nozzles)).toBe(false);
    // Right value but not the machine grammar → never condemned.
    expect(
      isLegacyMachineNozzleCondition("printer_model==MK4 and nozzle_diameter[0]==0.4", nozzles),
    ).toBe(false);
    // No derivable ticks → nothing provable.
    expect(isLegacyMachineNozzleCondition("nozzle_diameter[0]==0.4", [])).toBe(false);
    expect(isLegacyMachineNozzleCondition("nozzle_diameter[0]==0.4", undefined)).toBe(false);
    // Non-string values.
    expect(isLegacyMachineNozzleCondition(null, nozzles)).toBe(false);
    expect(isLegacyMachineNozzleCondition(42, nozzles)).toBe(false);
  });

  it("regex matches only the machine grammar", () => {
    for (const yes of [
      "nozzle_diameter[0]==0.4",
      "nozzle_diameter[0]==0.4 or nozzle_diameter[0]==0.6",
      "nozzle_diameter[0]==1",
    ]) expect(LEGACY_NOZZLE_CONDITION_RE.test(yes)).toBe(true);
    for (const no of [
      "",
      "printer_model==MK4 and nozzle_diameter[0]==0.4",
      "nozzle_diameter[0]>=0.4",
      "nozzle_diameter[0]==0.4 or printer_model==MK4",
      "printer_notes=~/.*PRUSA.*/",
    ]) expect(LEGACY_NOZZLE_CONDITION_RE.test(no)).toBe(false);
  });
});
