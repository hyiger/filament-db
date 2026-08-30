import { describe, it, expect } from "vitest";
import { createSyncCycleWatcher, seededCycleMayPostdate } from "@/lib/syncCycleWatcher";

/**
 * GH #1164: the Data health page refetches its own local scan whenever a sync
 * cycle ends, because a completed cycle can copy a remote-only conflict INTO
 * the local database. Missing an ending leaves the actionable list stale with
 * nothing to correct it, so each way of missing one is pinned here.
 */
describe("createSyncCycleWatcher", () => {
  const idle = (at: string | null) => ({ lastSyncAt: at, state: "idle" });
  const syncing = (at: string | null) => ({ lastSyncAt: at, state: "syncing" });

  it("the mount snapshot alone never reports an ending", () => {
    const w = createSyncCycleWatcher();
    w.seed(idle("T1"));
    expect(w.observe(idle("T1"))).toBe(false);
  });

  it("reports an ending when the stamp advances", () => {
    const w = createSyncCycleWatcher();
    w.seed(idle("T1"));
    expect(w.observe(idle("T2"))).toBe(true);
  });

  it("ignores progress ticks inside a running cycle", () => {
    const w = createSyncCycleWatcher();
    w.seed(idle("T1"));
    expect(w.observe(syncing("T1"))).toBe(false);
    expect(w.observe(syncing("T1"))).toBe(false);
  });

  it("reports an ending for a FAILED cycle, which keeps the previous stamp", () => {
    const w = createSyncCycleWatcher();
    w.seed(idle("T1"));
    expect(w.observe(syncing("T1"))).toBe(false);
    expect(w.observe({ lastSyncAt: "T1", state: "error" })).toBe(true);
  });

  it("treats a terminal event that BEATS the snapshot as an ending", () => {
    // The listener can deliver before `getSyncStatus()` resolves. Consuming
    // that event as the baseline swallowed the completion: the page's own
    // fetch had already returned, and the snapshot arriving afterwards
    // carried the same stamp, so nothing ever triggered a reload.
    const w = createSyncCycleWatcher();
    expect(w.observe(idle("T2"))).toBe(true);
  });

  it("an early SYNCING event is not an ending, but its completion is", () => {
    const w = createSyncCycleWatcher();
    expect(w.observe(syncing(null))).toBe(false);
    expect(w.observe(idle(null))).toBe(true);
  });

  it("a late snapshot does not rewind the baseline an event established", () => {
    // The promise can resolve with values captured BEFORE the event it lost
    // the race to; adopting them would re-report the same ending.
    const w = createSyncCycleWatcher();
    expect(w.observe(idle("T2"))).toBe(true);
    w.seed(syncing("T1"));
    expect(w.observe(idle("T2"))).toBe(false);
  });

  it("null is a real stamp, not 'unset' — the first completion still counts", () => {
    // Mounting mid-initial-sync leaves lastSyncAt null; conflating that with
    // "no baseline yet" made the first real completion look like the snapshot.
    const w = createSyncCycleWatcher();
    w.seed(syncing(null));
    expect(w.observe(idle(null))).toBe(true);
  });

  it("treats a missing state/stamp as a completed cycle with a null stamp", () => {
    const w = createSyncCycleWatcher();
    w.seed({});
    expect(w.observe({})).toBe(false);
    expect(w.observe(idle("T1"))).toBe(true);
  });
});

describe("seededCycleMayPostdate", () => {
  const T = Date.parse("2026-08-30T04:00:00.000Z");

  it("is false when no cycle has ever completed", () => {
    // A null stamp is not a missed ending — there is nothing to have missed.
    expect(seededCycleMayPostdate({ lastSyncAt: null }, T)).toBe(false);
    expect(seededCycleMayPostdate({}, T)).toBe(false);
  });

  it("is false for a cycle that ended before the scans went out", () => {
    expect(seededCycleMayPostdate({ lastSyncAt: "2026-08-30T03:59:59.000Z" }, T)).toBe(false);
  });

  it("treats an equal-millisecond stamp as possibly after the scan", () => {
    // Same clock, same resolution: equality cannot establish which came first,
    // and preferring the stale answer is the one outcome that costs anything.
    expect(seededCycleMayPostdate({ lastSyncAt: "2026-08-30T04:00:00.000Z" }, T)).toBe(true);
  });

  it("refetches after a terminal failure, which advances no stamp", () => {
    // A failed or partial cycle publishes the PREVIOUS lastSyncAt, and
    // per-collection isolation means earlier collections may already have
    // copied — so there is nothing to compare and no later event to wait for.
    const old = { lastSyncAt: "2026-08-30T03:00:00.000Z" };
    expect(seededCycleMayPostdate({ ...old, state: "error" }, T)).toBe(true);
    expect(seededCycleMayPostdate({ ...old, state: "partial" }, T)).toBe(true);
  });

  it("does not refetch merely because the app is offline or syncing", () => {
    // offline: no cycle ran. syncing: its ending will reach observe.
    const old = { lastSyncAt: "2026-08-30T03:00:00.000Z" };
    expect(seededCycleMayPostdate({ ...old, state: "offline" }, T)).toBe(false);
    expect(seededCycleMayPostdate({ ...old, state: "syncing" }, T)).toBe(false);
  });

  it("still catches a previous cycle that ended mid-window while a new one runs", () => {
    expect(seededCycleMayPostdate(
      { lastSyncAt: "2026-08-30T04:00:00.001Z", state: "syncing" }, T,
    )).toBe(true);
  });

  it("is true for a cycle that ended while the scans were in flight", () => {
    // The window no listener covers: too late for the scan, too early for
    // `observe`, and seeded as the baseline so no later event reports it.
    expect(seededCycleMayPostdate({ lastSyncAt: "2026-08-30T04:00:00.001Z" }, T)).toBe(true);
  });

  it("fails toward refetching on an unparseable stamp", () => {
    // One extra read at mount is bounded; a stale all-clear is not.
    expect(seededCycleMayPostdate({ lastSyncAt: "not a date" }, T)).toBe(true);
  });
});
