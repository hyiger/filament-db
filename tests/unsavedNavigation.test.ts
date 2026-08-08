import { describe, it, expect } from "vitest";
import { decideLeaveMode, isUnsavedGuardState } from "@/lib/unsavedNavigation";

describe("isUnsavedGuardState", () => {
  it("recognizes our synthetic guard entry", () => {
    expect(isUnsavedGuardState({ unsavedGuard: true })).toBe(true);
  });

  it("rejects the states the browser actually hands back", () => {
    // A hard load, and Next's own App Router state after any navigation —
    // neither carries our marker, and both reach this predicate for real.
    expect(isUnsavedGuardState(null)).toBe(false);
    expect(isUnsavedGuardState(undefined)).toBe(false);
    expect(isUnsavedGuardState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {} })).toBe(false);
  });

  it("rejects non-object states without throwing", () => {
    // history.state is `any` at runtime and a page can pushState a primitive,
    // so the predicate must not assume an object.
    expect(isUnsavedGuardState("unsavedGuard")).toBe(false);
    expect(isUnsavedGuardState(42)).toBe(false);
    expect(isUnsavedGuardState(true)).toBe(false);
  });

  it("requires the marker to be exactly true, not merely truthy", () => {
    expect(isUnsavedGuardState({ unsavedGuard: 1 })).toBe(false);
    expect(isUnsavedGuardState({ unsavedGuard: "true" })).toBe(false);
    expect(isUnsavedGuardState({ unsavedGuard: false })).toBe(false);
    expect(isUnsavedGuardState({})).toBe(false);
  });
});

describe("decideLeaveMode", () => {
  it("replaces when our guard is live and current", () => {
    // The normal exit: save (or Discard) while the guard we pushed on mount is
    // still the top of the stack. Replacing it consumes the guard AND lands on
    // the destination in one operation.
    expect(decideLeaveMode(true, { unsavedGuard: true })).toBe("replace");
  });

  it("pushes when the guard was already spent by a Back press", () => {
    // handlePopState's not-dirty branch clears guardActiveRef: the user's Back
    // consumed the entry. There is nothing left to overwrite, so replacing
    // would eat a legitimate history entry.
    expect(decideLeaveMode(false, { unsavedGuard: true })).toBe("push");
  });

  it("pushes when the browser no longer reports our marker", () => {
    // guardActiveRef can be stale — e.g. a navigation buried the guard. Trust
    // the browser over our own bookkeeping.
    expect(decideLeaveMode(true, { __NA: true })).toBe("push");
    expect(decideLeaveMode(true, null)).toBe("push");
  });

  it("pushes when neither signal holds", () => {
    expect(decideLeaveMode(false, null)).toBe("push");
  });
});
