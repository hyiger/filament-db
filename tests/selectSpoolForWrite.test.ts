import { describe, it, expect } from "vitest";
import { selectSpoolForWrite } from "@/lib/selectSpoolForWrite";

/**
 * #732 Phase 3 — the shared writer-target selector. Every tag/label writer
 * must pick the SAME spool id, so these branches are pinned here.
 */
describe("selectSpoolForWrite (#732)", () => {
  const spool = (id: string, instanceId: string | null, retired = false) => ({
    _id: id,
    instanceId,
    retired,
  });

  it("uses the explicitly requested spool, even if retired", () => {
    const f = {
      instanceId: "fila000000",
      spools: [spool("s1", "aaaaaaaaaa"), spool("s2", "bbbbbbbbbb", true)],
    };
    expect(selectSpoolForWrite(f, "s2")).toEqual({
      ok: true,
      instanceId: "bbbbbbbbbb",
      spoolId: "s2",
      source: "spool",
    });
  });

  it("errors when the requested spool id is unknown", () => {
    const f = { instanceId: "fila000000", spools: [spool("s1", "aaaaaaaaaa")] };
    expect(selectSpoolForWrite(f, "nope")).toEqual({ ok: false, reason: "spool-not-found" });
  });

  it("picks the sole spool when none is requested (single-spool filament)", () => {
    const f = { instanceId: "fila000000", spools: [spool("s1", "aaaaaaaaaa")] };
    expect(selectSpoolForWrite(f)).toEqual({
      ok: true,
      instanceId: "aaaaaaaaaa",
      spoolId: "s1",
      source: "spool",
    });
  });

  it("picks the first NON-retired spool when none is requested", () => {
    const f = {
      instanceId: "fila000000",
      spools: [spool("s1", "aaaaaaaaaa", true), spool("s2", "bbbbbbbbbb"), spool("s3", "cccccccccc")],
    };
    const r = selectSpoolForWrite(f);
    expect(r).toEqual({ ok: true, instanceId: "bbbbbbbbbb", spoolId: "s2", source: "spool" });
  });

  it("falls back to the first spool when all are retired", () => {
    const f = {
      instanceId: "fila000000",
      spools: [spool("s1", "aaaaaaaaaa", true), spool("s2", "bbbbbbbbbb", true)],
    };
    const r = selectSpoolForWrite(f);
    expect(r).toEqual({ ok: true, instanceId: "aaaaaaaaaa", spoolId: "s1", source: "spool" });
  });

  it("falls back to the FILAMENT instanceId when there are no spools", () => {
    const f = { instanceId: "fila000000", spools: [] };
    expect(selectSpoolForWrite(f)).toEqual({
      ok: true,
      instanceId: "fila000000",
      spoolId: null,
      source: "filament",
    });
  });

  it("handles a missing spools array (filament fallback)", () => {
    const f = { instanceId: "fila000000" };
    expect(selectSpoolForWrite(f)).toEqual({
      ok: true,
      instanceId: "fila000000",
      spoolId: null,
      source: "filament",
    });
  });

  it("falls back to the filament id when the chosen spool has no id (legacy)", () => {
    const f = { instanceId: "fila000000", spools: [spool("s1", null)] };
    expect(selectSpoolForWrite(f)).toEqual({
      ok: true,
      instanceId: "fila000000",
      spoolId: null,
      source: "filament",
    });
  });

  it("reports no-id-available when nothing carries an id", () => {
    const f = { instanceId: null, spools: [spool("s1", null)] };
    expect(selectSpoolForWrite(f)).toEqual({ ok: false, reason: "no-id-available" });
  });

  it("a requested spool with no id surfaces no-id-available (degenerate)", () => {
    const f = { instanceId: "fila000000", spools: [spool("s1", null)] };
    expect(selectSpoolForWrite(f, "s1")).toEqual({ ok: false, reason: "no-id-available" });
  });
});
