import { describe, it, expect } from "vitest";
import {
  planRenameStaging,
  isStagingPlaceholder,
  placeholderFor,
  strandedPlaceholderNotice,
  withStrandingNotice,
  pendingRenameCanFreeName,
  strandingNoticeOf,
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

  it("refuses BOTH rows contending for one name (Codex P1, fifth pass)", () => {
    // Both A and C want B's name. An earlier version staged B once and let
    // "the index reject the loser" — reasoning this test used to ENCODE as
    // intent. That rejection is exactly what strands the winner: the loser's
    // E11000 finds the winner as its blocker, the cached plan still authorized
    // staging it, and settlement could not restore a name the loser's retry
    // had just taken. There is no principled winner (write order is
    // incidental), so every contender is refused and B stays put.
    const plan = planRenameStaging(
      [row("a", "P", "B"), row("c", "Q", "B"), row("b", "B", "Z")],
      "n1",
    );
    expect(plan.staged).toEqual([]);
    expect(plan.unsatisfiable.map((u) => u.id).sort()).toEqual(["a", "c"]);
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

  /**
   * GH #1142 (Codex P1): a one-level check is not enough. With A->B, B->C and
   * C standing still, staging B for A lets A take B's name, but B can then
   * never take C — and settlement cannot restore B, because A owns its
   * original name. B would be stranded as a placeholder permanently.
   */
  it("refuses the whole CHAIN when its far end is blocked", () => {
    const plan = planRenameStaging(
      [row("a", "A", "B"), row("b", "B", "C"), row("c", "C", "C", false)],
      "n1",
    );
    // Nothing is moved aside...
    expect(plan.staged).toEqual([]);
    // ...and BOTH links are reported, not just the one touching C.
    expect(plan.unsatisfiable.map((u) => u.id).sort()).toEqual(["a", "b"]);
  });

  it("still resolves a chain whose far end IS free", () => {
    const plan = planRenameStaging([row("a", "A", "B"), row("b", "B", "C")], "n1");
    expect(plan.staged.map((s) => s.id)).toEqual(["b"]);
    expect(plan.unsatisfiable).toEqual([]);
  });

  it("a pure CYCLE survives the fixpoint", () => {
    // Each depends only on the other, so neither is ever knocked out —
    // correct, because staging one frees the whole cycle.
    const plan = planRenameStaging([row("a", "X", "Y"), row("b", "Y", "X")], "n1");
    expect(plan.staged.length).toBeGreaterThanOrEqual(1);
    expect(plan.unsatisfiable).toEqual([]);
  });

  it("a longer cycle also survives", () => {
    const plan = planRenameStaging(
      [row("a", "X", "Y"), row("b", "Y", "Z"), row("c", "Z", "X")],
      "n1",
    );
    expect(plan.staged.length).toBeGreaterThanOrEqual(1);
    expect(plan.unsatisfiable).toEqual([]);
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

/**
 * GH #1142 (Codex P1, fifth pass): a CONTESTED destination — two rows desiring
 * the same name — must poison the plan, not merely fail one of the writes.
 *
 * The state requires the SOURCE to hold duplicate active names, which the trim
 * pass refuses to index ("resolve them and restart") while the sync continues
 * paired-only. At most one contender can win; the loser then E11000s against
 * the WINNER, whose write has landed — and a cached plan that still authorized
 * staging the winner had it moved aside with no write ever coming, while its
 * original name was taken by the loser's retry. Settlement cannot restore it:
 * stranded permanently.
 */
describe("planRenameStaging with contested destinations", () => {
  it("refuses the whole cycle when a third row desires a name inside it", () => {
    // Codex's exact example: target A="X", B="Y", C="Z"; desires A→Y, B→X,
    // C→Y. Pre-fix this planned staged=[B, A] and let the A↔B swap resolve —
    // after which C collided with the now-final A and stranded it.
    const plan = planRenameStaging(
      [row("A", "X", "Y"), row("B", "Y", "X"), row("C", "Z", "Y")],
      "nonce",
    );
    expect(plan.staged).toEqual([]);
    expect(plan.unsatisfiable.map((u) => u.id).sort()).toEqual(["A", "B", "C"]);
  });

  it("refuses to stage a contender for an UNRELATED requester", () => {
    // D wants A's current name. A is moving — but A is contesting "Y" with C,
    // so A may lose the race and never vacate "X". Staging A for D's benefit
    // gambles a permanent placeholder on write order.
    const plan = planRenameStaging(
      [row("A", "X", "Y"), row("C", "Z", "Y"), row("D", "W", "X")],
      "nonce",
    );
    expect(plan.staged).toEqual([]);
    expect(plan.unsatisfiable.map((u) => u.id)).toEqual(["D"]);
  });

  it("still resolves a clean swap next to an uncontested rename", () => {
    // The refusal must be scoped to the contested name, not the whole pass.
    const plan = planRenameStaging(
      [row("A", "X", "Y"), row("B", "Y", "X"), row("E", "P", "Q")],
      "nonce",
    );
    expect(plan.staged.map((s) => s.id).sort()).toEqual(["A", "B"]);
    expect(plan.unsatisfiable).toEqual([]);
  });
});

/**
 * GH #1142 (Codex P1, sixth pass): the runtime staging predicate, judged
 * against a FRESH read of the blocker's source row — the same document its
 * pending write will hydrate. The mid-pass mutation that makes this matter (a
 * user reverting a source name between the snapshot and the write) cannot be
 * induced from the DB harness, so the decision table is pinned here and the
 * wiring is structural: sync-service passes `sourceFresh?.name` straight in.
 */
describe("pendingRenameCanFreeName", () => {
  it("authorizes when the pending write will genuinely rename the blocker", () => {
    expect(pendingRenameCanFreeName("Drybox 2", "Drybox 1")).toBe(true);
  });

  it("refuses when the fresh source name EQUALS the blocker's current name", () => {
    // One clause, three histories: the write already landed (it transferred
    // exactly this name), the write is a no-op rename, or the source was
    // reverted to match after the snapshot. In all three nothing will ever
    // move the blocker off this name, so a placeholder could not be settled.
    expect(pendingRenameCanFreeName("Drybox 1", "Drybox 1")).toBe(false);
  });

  it("refuses when the source is gone or malformed — no rename provably coming", () => {
    expect(pendingRenameCanFreeName(undefined, "Drybox 1")).toBe(false);
    expect(pendingRenameCanFreeName(null, "Drybox 1")).toBe(false);
    expect(pendingRenameCanFreeName(42, "Drybox 1")).toBe(false);
  });

  it("refuses when the source itself holds a staging placeholder", () => {
    // The pending write would transfer the placeholder text verbatim onto
    // this peer — the exact propagation this module exists to prevent.
    expect(
      pendingRenameCanFreeName(`${STAGING_PREFIX}abc123-def`, "Drybox 1"),
    ).toBe(false);
  });
});

/**
 * GH #1142 (Codex P2, twice). The rollback-failed path is a genuine race — a
 * third party has to claim the original name between staging and rollback — so
 * it cannot be induced from a sync test. What CAN be pinned is the structure
 * that carries it to the user, and the structure is the whole fix: the notice
 * is CAUSE-FREE so it can be re-attached after `wrapSyncErrorMessage` has
 * decided what kind of error this is, and the factory composes and tags in one
 * expression so an untagged stranding message cannot be written.
 *
 * `tests/sync-service.test.ts` pins the other half — that the wrapper actually
 * re-attaches it — which is where the previous attempt failed: it asserted
 * ORDERING inside a string the wrapper discards wholesale.
 */
describe("stranded placeholder reporting", () => {
  const info = {
    collection: "bedtypes",
    id: "64b7f0000000000000000001",
    originalName: "Textured PEI",
    placeholderName: "__sync-staging-64b7f0000000000000000001-abc",
  };

  it("names the row, both names, and what the user has to do", () => {
    const notice = strandedPlaceholderNotice(info);
    expect(notice).toContain("bedtypes 64b7f0000000000000000001");
    expect(notice).toContain('"Textured PEI"');
    expect(notice).toContain('"__sync-staging-64b7f0000000000000000001-abc"');
    expect(notice).toMatch(/rename it back manually/i);
  });

  it("keeps the notice free of the cause — the property the wrapper relies on", () => {
    // If the cause leaked in here, an auth-shaped one would make the notice
    // itself match wrapSyncErrorMessage's regex on re-attachment, and the
    // stranding would vanish exactly as it did before.
    const err = withStrandingNotice(
      new Error("user is not allowed to do action [update] on [db.bedtypes]"),
      strandedPlaceholderNotice(info),
    );
    expect(strandingNoticeOf(err)).not.toContain("user is not allowed");
    // ...while the composed message still carries both halves.
    expect(err.message).toContain("user is not allowed");
    expect(err.message).toContain("bedtypes 64b7f0000000000000000001");
  });

  it("tags exactly what it composed, and keeps the cause attached", () => {
    // The cause has to survive as an OBJECT, not just as text: it is where a
    // driver error's `code` lives, and `new Error(msg, {cause})` does not
    // inherit it.
    const cause = Object.assign(new Error("Unauthorized"), { code: 13 });
    const err = withStrandingNotice(cause, strandedPlaceholderNotice(info));
    expect(err.cause).toBe(cause);
    expect(strandingNoticeOf(err)).toBe(strandedPlaceholderNotice(info));
  });

  it("survives a non-Error rejection", () => {
    expect(
      withStrandingNotice("socket hang up", strandedPlaceholderNotice(info)).message,
    ).toContain("socket hang up");
  });

  it("ACCUMULATES notices — one pass can strand several rows at once", () => {
    // A failure late in a pass abandons every row moved aside earlier, so
    // reporting only the last would be a quieter version of reporting none.
    const first = withStrandingNotice(new Error("boom"), "ROW-A stranded.");
    const both = withStrandingNotice(first, "ROW-B stranded.");
    expect(strandingNoticeOf(both)).toBe("ROW-A stranded. ROW-B stranded.");
    expect(both.cause).toBe(first);
  });

  it("reads no notice off anything that is not a tagged error", () => {
    for (const value of [null, undefined, "a string", 42, {}, new Error("plain")]) {
      expect(strandingNoticeOf(value)).toBeNull();
    }
    // ...including a lookalike whose key holds the wrong type.
    expect(strandingNoticeOf({ strandingNotice: 42 })).toBeNull();
  });
});
