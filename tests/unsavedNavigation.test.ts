import { describe, it, expect } from "vitest";
import {
  buildGuardState,
  decideLeaveMode,
  isUnsavedGuardState,
} from "@/lib/unsavedNavigation";

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

describe("buildGuardState", () => {
  it("carries Next's markers forward so its popstate handler doesn't hard-reload", () => {
    // A state without `__NA` makes Next's own popstate handler call
    // window.location.reload() — it reads as an entry from the pages router.
    const tree = { tree: ["", {}], renderedSearch: "" };
    const built = buildGuardState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: tree });
    expect(built).toEqual({
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: tree,
      unsavedGuard: true,
    });
  });

  it("does not mutate the state the browser handed us", () => {
    const original = { __NA: true };
    const built = buildGuardState(original);
    expect(original).toEqual({ __NA: true });
    expect(built).not.toBe(original);
  });

  it("still marks the guard when there is no prior state", () => {
    // A hard load starts with history.state === null.
    expect(buildGuardState(null)).toEqual({ unsavedGuard: true });
    expect(buildGuardState(undefined)).toEqual({ unsavedGuard: true });
  });

  it("ignores a primitive state rather than spreading it", () => {
    // Spreading a string would splat its characters as indexed keys.
    expect(buildGuardState("pages-router-junk")).toEqual({ unsavedGuard: true });
    expect(buildGuardState(7)).toEqual({ unsavedGuard: true });
  });

  it("produces a state its own predicate recognizes", () => {
    // Round-trip: whatever we push must be what decideLeaveMode later sees.
    expect(isUnsavedGuardState(buildGuardState({ __NA: true }))).toBe(true);
    expect(decideLeaveMode(true, buildGuardState(null))).toBe("replace");
  });
});
