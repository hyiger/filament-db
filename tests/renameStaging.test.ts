import { describe, it, expect } from "vitest";
import {
  planRenameStaging,
  isStagingPlaceholder,
  placeholderFor,
  STAGING_PREFIX,
  type RenameIntent,
} from "@/lib/renameStaging";

/**
 * GH #1142. The graph reasoning is here so it can be pinned without two live
 * databases; `tests/sync-service-expansion.test.ts` covers the wiring.
 */

const row = (
  id: string,
  currentName: string,
  desiredName: string,
  willWrite = true,
): RenameIntent => ({ id, currentName, desiredName, willWrite });

describe("planRenameStaging", () => {
  it("stages nothing when no write contends for a held name", () => {
    const plan = planRenameStaging([row("a", "X", "X2"), row("b", "Y", "Y2")], "n1");
    expect(plan.staged).toEqual([]);
    expect(plan.unsatisfiable).toEqual([]);
  });

  it("breaks a CYCLE — the reported swap", () => {
    // A wants Y (held by B), B wants X (held by A). No ordering works.
    const plan = planRenameStaging([row("a", "X", "Y"), row("b", "Y", "X")], "n1");
    // Staging ONE of them is enough: once it holds a placeholder, the other's
    // write lands, and the staged row's own write then lands too.
    expect(plan.staged.length).toBeGreaterThanOrEqual(1);
    expect(plan.unsatisfiable).toEqual([]);
    for (const s of plan.staged) {
      expect(isStagingPlaceholder(s.placeholderName)).toBe(true);
      // The original is carried so the caller can restore it if the real
      // write never lands.
      expect(["X", "Y"]).toContain(s.originalName);
    }
  });

  it("breaks a CHAIN — A wants the name B is about to vacate", () => {
    const plan = planRenameStaging([row("a", "A", "B"), row("b", "B", "C")], "n1");
    expect(plan.staged.map((s) => s.id)).toEqual(["b"]);
    expect(plan.staged[0].originalName).toBe("B");
    expect(plan.unsatisfiable).toEqual([]);
  });

  it("reports UNSATISFIABLE when the holder is not moving", () => {
    // B is present and keeping its name; A wants it. Staging cannot help.
    const plan = planRenameStaging([row("a", "X", "Y"), row("b", "Y", "Y", false)], "n1");
    expect(plan.staged).toEqual([]);
    expect(plan.unsatisfiable).toEqual([{ id: "a", desiredName: "Y", heldBy: "b" }]);
  });

  it("reports UNSATISFIABLE when the holder is written WITHOUT a rename", () => {
    // B is being copied but keeps the same name — it is not vacating it.
    const plan = planRenameStaging([row("a", "X", "Y"), row("b", "Y", "Y", true)], "n1");
    expect(plan.staged).toEqual([]);
    expect(plan.unsatisfiable).toEqual([{ id: "a", desiredName: "Y", heldBy: "b" }]);
  });

  it("does not stage a row against itself", () => {
    // A row keeping its own name is not blocking itself.
    const plan = planRenameStaging([row("a", "X", "X")], "n1");
    expect(plan.staged).toEqual([]);
    expect(plan.unsatisfiable).toEqual([]);
  });

  it("ignores a row that is not being written", () => {
    const plan = planRenameStaging([row("a", "X", "Y", false), row("b", "Y", "Z")], "n1");
    // `a` isn't writing, so it needs nothing; `b`'s target Z is free.
    expect(plan.staged).toEqual([]);
    expect(plan.unsatisfiable).toEqual([]);
  });

  it("stages a holder only once even when two rows contend for it", () => {
    // Both A and C want B's name. B is staged once, not twice — a second
    // rename would move it off the placeholder the first one recorded.
    const plan = planRenameStaging(
      [row("a", "P", "B"), row("c", "Q", "B"), row("b", "B", "Z")],
      "n1",
    );
    expect(plan.staged.map((s) => s.id)).toEqual(["b"]);
    // The loser is reported rather than silently dropped... or rather: both
    // wanted B, and only one can have it. The second is NOT unsatisfiable here
    // because B is genuinely vacating; the index will reject the loser and the
    // per-row error path reports it.
    expect(plan.unsatisfiable).toEqual([]);
  });

  it("gives every staged row a distinct, recognisable placeholder", () => {
    const plan = planRenameStaging(
      [row("a", "X", "Y"), row("b", "Y", "X"), row("c", "Z", "W")],
      "nonce7",
    );
    const names = plan.staged.map((s) => s.placeholderName);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith(STAGING_PREFIX)).toBe(true);
  });

  it("the nonce separates concurrent passes", () => {
    expect(placeholderFor("a", "n1")).not.toBe(placeholderFor("a", "n2"));
  });
});

describe("isStagingPlaceholder", () => {
  it("recognises its own output and nothing else", () => {
    expect(isStagingPlaceholder(placeholderFor("abc", "n1"))).toBe(true);
    expect(isStagingPlaceholder("Drybox #1")).toBe(false);
    expect(isStagingPlaceholder("")).toBe(false);
    expect(isStagingPlaceholder(null)).toBe(false);
    expect(isStagingPlaceholder(42)).toBe(false);
  });
});
