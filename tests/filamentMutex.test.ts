import { describe, it, expect } from "vitest";
import { runExclusive, lockedKeyCount, filamentLockKey } from "@/lib/filamentMutex";

/**
 * src/lib/filamentMutex.ts — the process-local keyed mutex that serializes
 * the GH #605 template-model critical sections (promotion gate, /promote,
 * the totalWeight strip+write, the spool-push guard).
 *
 * Contracts pinned here:
 *   - strict per-key serialization, even across await points inside a
 *     section (the second section never starts before the first settles);
 *   - independent keys interleave freely;
 *   - a thrown section releases the key for the next waiter and the
 *     rejection reaches only its own caller;
 *   - drained chains are removed from the map (lockedKeyCount → 0), so the
 *     singleton never leaks keys across a long-lived process.
 */

/** A promise plus its out-of-band resolve handle. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled continuation run. */
async function drainMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("filamentMutex.runExclusive", () => {
  it("serializes two sections on one key — the second never starts until the first settles, even while the first awaits", async () => {
    const events: string[] = [];
    const gate = deferred();

    const first = runExclusive("k", async () => {
      events.push("first:start");
      await gate.promise; // hold the key across an await
      events.push("first:end");
      return "one";
    });
    const second = runExclusive("k", async () => {
      events.push("second:start");
      return "two";
    });

    await drainMicrotasks();
    // The first section is parked on its await — the second must NOT have
    // started (the naive check-then-act interleaving this module forbids).
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    expect(await first).toBe("one");
    expect(await second).toBe("two");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("independent keys interleave — key B completes while key A is still held", async () => {
    const events: string[] = [];
    const gateA = deferred();

    const a = runExclusive("a", async () => {
      events.push("a:start");
      await gateA.promise;
      events.push("a:end");
    });
    const b = runExclusive("b", async () => {
      events.push("b:run");
      return 42;
    });

    expect(await b).toBe(42); // b finished; a is still parked
    expect(events).toEqual(["a:start", "b:run"]);

    gateA.resolve();
    await a;
    expect(events).toEqual(["a:start", "b:run", "a:end"]);
  });

  it("a throw releases the key for the next waiter and rejects only its own caller", async () => {
    const events: string[] = [];

    const first = runExclusive("k", async () => {
      events.push("first");
      throw new Error("boom");
    });
    const second = runExclusive("k", async () => {
      events.push("second");
      return "fine";
    });

    await expect(first).rejects.toThrow("boom");
    // The rejection did not poison the chain — the waiter still ran.
    expect(await second).toBe("fine");
    expect(events).toEqual(["first", "second"]);
  });

  it("cleans up drained chains — lockedKeyCount returns to 0 after resolution, rejection, and queued waiters", async () => {
    expect(lockedKeyCount()).toBe(0);

    // Single resolved section.
    await runExclusive("solo", async () => "ok");
    await drainMicrotasks();
    expect(lockedKeyCount()).toBe(0);

    // Queued waiters on one key + a parallel key, mid-flight the map holds
    // both keys; fully drained it holds none.
    const gate = deferred();
    const q1 = runExclusive("q", () => gate.promise);
    const q2 = runExclusive("q", async () => "second");
    const p = runExclusive("p", async () => "parallel");
    expect(lockedKeyCount()).toBe(2);

    gate.resolve();
    await Promise.all([q1, q2, p]);
    await drainMicrotasks();
    expect(lockedKeyCount()).toBe(0);

    // A rejected section also drains its key.
    await expect(
      runExclusive("bad", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    await drainMicrotasks();
    expect(lockedKeyCount()).toBe(0);
  });

  it("returns the section's value and accepts synchronous (non-promise) sections", async () => {
    expect(await runExclusive("sync", () => 7)).toBe(7);
    await drainMicrotasks();
    expect(lockedKeyCount()).toBe(0);
  });

  it("filamentLockKey canonicalizes hex ObjectId casing so one document maps to one key", () => {
    // Mongo casts hex ObjectIds case-insensitively; the Map must too, or an
    // uppercase-addressed request would bypass the family's serialization.
    expect(filamentLockKey("507F1F77BCF86CD799439011")).toBe("507f1f77bcf86cd799439011");
    expect(filamentLockKey("507f1f77bcf86cd799439011")).toBe("507f1f77bcf86cd799439011");
    // Non-ObjectId strings pass through untouched (they lock a private key).
    expect(filamentLockKey("not-an-objectid")).toBe("not-an-objectid");
    // Stringifies non-strings (an actual ObjectId instance toString()s to
    // lowercase hex already).
    expect(filamentLockKey(42)).toBe("42");
  });

  it("three queued sections run in submission order", async () => {
    const order: number[] = [];
    const gate = deferred();
    const p1 = runExclusive("fifo", async () => {
      order.push(1);
      await gate.promise;
    });
    const p2 = runExclusive("fifo", async () => {
      order.push(2);
    });
    const p3 = runExclusive("fifo", async () => {
      order.push(3);
    });
    gate.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});
