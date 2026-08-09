import { describe, it, expect } from "vitest";
import {
  MAX_NAMED_BLOCKERS,
  summarizeLocationBlockers,
  locationBlockerMessage,
  type LocationBlockerDoc,
} from "@/lib/locationDeleteBlockers";

const doc = (over: Partial<LocationBlockerDoc> = {}): LocationBlockerDoc => ({
  name: "PLA",
  trashed: false,
  activeSpoolsHere: 1,
  retiredSpoolsHere: 0,
  ...over,
});

describe("summarizeLocationBlockers", () => {
  it("reports nothing blocking for an empty set", () => {
    const s = summarizeLocationBlockers([]);
    expect(s.blocked).toBe(false);
    expect(s).toMatchObject({
      activeSpools: 0,
      retiredSpools: 0,
      trashedSpools: 0,
      activeFilaments: 0,
      trashedFilaments: 0,
      moreFilaments: 0,
    });
  });

  it("counts active spools on active filaments", () => {
    const s = summarizeLocationBlockers([doc({ activeSpoolsHere: 2 }), doc({ name: "PETG" })]);
    expect(s.blocked).toBe(true);
    expect(s.activeSpools).toBe(3);
    expect(s.activeFilaments).toBe(2);
    expect(s.filamentNames).toEqual(["PLA", "PETG"]);
  });

  it("counts a retired-only filament as a blocker (the #1106 case)", () => {
    // This is the whole bug: the /locations row shows "Spools 0" because the
    // list excludes retired spools, but the delete guard still refuses.
    const s = summarizeLocationBlockers([
      doc({ name: "Fiberon PA6-CF20", activeSpoolsHere: 0, retiredSpoolsHere: 1 }),
    ]);
    expect(s.blocked).toBe(true);
    expect(s.activeSpools).toBe(0);
    expect(s.retiredSpools).toBe(1);
    expect(s.activeFilaments).toBe(1);
  });

  it("separates trashed filaments from active ones", () => {
    // Spools on a trashed filament are invisible in /inventory at ANY setting,
    // so they need their own bucket and their own remedy.
    const s = summarizeLocationBlockers([
      doc({ name: "Live", activeSpoolsHere: 1 }),
      doc({ name: "Trashed", trashed: true, activeSpoolsHere: 2, retiredSpoolsHere: 1 }),
    ]);
    expect(s.activeFilaments).toBe(1);
    expect(s.trashedFilaments).toBe(1);
    expect(s.trashedSpools).toBe(3);
    // A trashed filament's spools must NOT inflate the active/retired counts,
    // which describe what /inventory can show.
    expect(s.activeSpools).toBe(1);
    expect(s.retiredSpools).toBe(0);
    expect(s.filamentNames).toEqual(["Live"]);
    expect(s.trashedFilamentNames).toEqual(["Trashed"]);
  });

  it("ignores a row with no spool at this location", () => {
    // The route's aggregation shouldn't emit one, but a wider caller must not
    // produce a phantom blocker (which would make the location undeletable
    // with nothing to point at).
    const s = summarizeLocationBlockers([doc({ activeSpoolsHere: 0, retiredSpoolsHere: 0 })]);
    expect(s.blocked).toBe(false);
    expect(s.activeFilaments).toBe(0);
  });

  it("caps the names it emits and reports the overflow", () => {
    const docs = Array.from({ length: 8 }, (_, i) => doc({ name: `F${i}` }));
    const s = summarizeLocationBlockers(docs);
    expect(s.filamentNames).toHaveLength(MAX_NAMED_BLOCKERS);
    expect(s.activeFilaments).toBe(8);
    expect(s.moreFilaments).toBe(3);
  });

  it("counts the overflow across BOTH buckets", () => {
    const docs = [
      ...Array.from({ length: 4 }, (_, i) => doc({ name: `A${i}` })),
      ...Array.from({ length: 4 }, (_, i) => doc({ name: `T${i}`, trashed: true })),
    ];
    const s = summarizeLocationBlockers(docs);
    // 4 active names + 4 trashed names = 8 named, none over the per-bucket cap
    expect(s.moreFilaments).toBe(0);
    expect(s.filamentNames).toHaveLength(4);
    expect(s.trashedFilamentNames).toHaveLength(4);
  });

  it("substitutes a placeholder for a blank or missing name", () => {
    const s = summarizeLocationBlockers([
      doc({ name: "   " }),
      doc({ name: null }),
      doc({ name: undefined }),
    ]);
    expect(s.filamentNames).toEqual(["(unnamed)", "(unnamed)", "(unnamed)"]);
  });
});

describe("locationBlockerMessage", () => {
  it('keeps the "referenced by spools" phrase the route tests pin', () => {
    const s = summarizeLocationBlockers([doc()]);
    expect(locationBlockerMessage(s)).toMatch(/referenced by spools/);
  });

  it('mentions the trash whenever a trashed filament blocks', () => {
    const s = summarizeLocationBlockers([doc({ trashed: true })]);
    const msg = locationBlockerMessage(s);
    expect(msg).toMatch(/trash/);
    // Still carries the phrase, since the route tests assert it unconditionally.
    expect(msg).toMatch(/referenced by spools/);
  });

  it("names the retired count so the user knows why they can't see them", () => {
    const s = summarizeLocationBlockers([doc({ activeSpoolsHere: 0, retiredSpoolsHere: 2 })]);
    expect(locationBlockerMessage(s)).toMatch(/2 of those spool\(s\) are retired/);
  });

  it("omits the retired and trash clauses when neither applies", () => {
    const msg = locationBlockerMessage(summarizeLocationBlockers([doc()]));
    expect(msg).not.toMatch(/retired/);
    expect(msg).not.toMatch(/trash/);
  });
});
