import { describe, it, expect, beforeEach, vi } from "vitest";
import { ApiError, type Api } from "../packages/mobile/src/lib/api";
import {
  clearQueue,
  flushQueue,
  pendingCount,
  ServerChangedError,
  submitWrite,
} from "../packages/mobile/src/lib/writeQueue";
import AsyncStorage, { resetAsyncStorage } from "./stubs/asyncStorage";

/**
 * packages/mobile's offline write queue, with AsyncStorage swapped for an
 * in-memory stand-in (vitest.config.ts) and the API client faked per test.
 */

type UpdateSpool = (filamentId: string, spoolId: string, patch: Record<string, unknown>) => Promise<unknown>;

/** A fake client: each `updateSpool` call is recorded with the server it hit. */
function fakeApi(server: string, calls: string[], impl: UpdateSpool): Api {
  return {
    updateSpool: (filamentId: string, spoolId: string, patch: Record<string, unknown>) => {
      calls.push(`${server}:${spoolId}`);
      return impl(filamentId, spoolId, patch);
    },
  } as unknown as Api;
}

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield to the event loop until `cond` holds (the fake request is in flight). */
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
}

const offline = () => Promise.reject(new ApiError(0, "Can't reach the server."));
const entry = (spoolId: string) => ({
  filamentId: "f1",
  spoolId,
  label: `edit ${spoolId}`,
  write: { kind: "updateSpool" as const, patch: { remainingWeight: 100 } },
});

beforeEach(async () => {
  resetAsyncStorage();
  await clearQueue();
});

describe("mobile write queue — server change (GH #1210)", () => {
  it("doesn't queue a write whose request to the old server fails after the switch", async () => {
    const calls: string[] = [];
    const inFlight = deferred();
    const apiA = fakeApi("A", calls, () => inFlight.promise);
    const submission = submitWrite(apiA, entry("s1"));
    await until(() => calls.length === 1);

    await clearQueue(); // the server-change path
    inFlight.reject(new ApiError(0, "Can't reach the server."));

    await expect(submission).rejects.toBeInstanceOf(ServerChangedError);
    expect(await pendingCount()).toBe(0);
    const apiB = fakeApi("B", calls, async () => ({}));
    expect(await flushQueue(apiB)).toEqual({ flushed: 0, dropped: 0, remaining: 0 });
    expect(calls).toEqual(["A:s1"]);
  });

  it("still returns a live write that succeeded on the old server", async () => {
    const inFlight = deferred();
    const calls: string[] = [];
    const submission = submitWrite(fakeApi("A", calls, () => inFlight.promise), entry("s1"));
    await until(() => calls.length === 1);
    await clearQueue();
    inFlight.resolve({ spool: { _id: "s1" } });
    await expect(submission).resolves.toEqual({ queued: false, result: { spool: { _id: "s1" } } });
  });

  it("neither sends nor queues a write when the switch lands during its pre-flush", async () => {
    const calls: string[] = [];
    await submitWrite(fakeApi("A", calls, offline), entry("queued"));
    expect(await pendingCount()).toBe(1);

    const replay = deferred();
    const apiA = fakeApi("A", calls, () => replay.promise);
    const submission = submitWrite(apiA, entry("s2"));
    await until(() => calls.length === 2);
    await clearQueue();
    replay.reject(new ApiError(0, "Can't reach the server."));

    await expect(submission).rejects.toBeInstanceOf(ServerChangedError);
    expect(calls).toEqual(["A:queued", "A:queued"]); // the replay only — s2 never went out
    expect(await pendingCount()).toBe(0);
  });

  it("doesn't send a live write when the switch lands during its last queue read", async () => {
    const calls: string[] = [];
    // submitWrite reads the queue twice before sending; switch during the second.
    let reads = 0;
    const getItem = vi.spyOn(AsyncStorage, "getItem").mockImplementation(async () => {
      if (++reads === 2) void clearQueue();
      return null;
    });
    try {
      await expect(
        submitWrite(fakeApi("A", calls, async () => ({})), entry("s1")),
      ).rejects.toBeInstanceOf(ServerChangedError);
    } finally {
      getItem.mockRestore();
    }
    expect(reads).toBe(2);
    expect(calls).toEqual([]);
    expect(await pendingCount()).toBe(0);
  });

  it("stops a flush that is running when the server changes", async () => {
    const calls: string[] = [];
    await submitWrite(fakeApi("A", calls, offline), entry("a1"));
    await submitWrite(fakeApi("A", calls, offline), entry("a2"));
    calls.length = 0;

    const first = deferred();
    const flushing = flushQueue(fakeApi("A", calls, () => first.promise));
    await until(() => calls.length === 1);
    await clearQueue();
    // A write made for the new server meanwhile is queued for it…
    await submitWrite(fakeApi("B", calls, offline), entry("b1"));
    first.resolve({});
    await flushing;

    // …and the old flush never replays it through the old client.
    expect(calls).toEqual(["A:a1", "B:b1"]);
    const onB: string[] = [];
    expect(await flushQueue(fakeApi("B", onB, async () => ({})))).toEqual({
      flushed: 1,
      dropped: 0,
      remaining: 0,
    });
    expect(onB).toEqual(["B:b1"]);
  });
});

describe("mobile write queue — a write applied but its reply lost (GH #1211)", () => {
  const committed = () =>
    Promise.reject(new ApiError(200, "The server accepted the change, but…", true));

  it("counts it as flushed instead of keeping or dropping it", async () => {
    await submitWrite(fakeApi("A", [], offline), entry("s1"));
    const calls: string[] = [];
    expect(await flushQueue(fakeApi("A", calls, committed))).toEqual({
      flushed: 1,
      dropped: 0,
      remaining: 0,
    });
    expect(calls).toEqual(["A:s1"]);
  });

  it("doesn't queue a live write whose reply was lost — it already applied", async () => {
    await expect(submitWrite(fakeApi("A", [], committed), entry("s1"))).rejects.toMatchObject({
      committed: true,
    });
    expect(await pendingCount()).toBe(0);
  });

  it("keeps a queued write through a server error and drains it later", async () => {
    await submitWrite(fakeApi("A", [], offline), entry("s1"));
    const unavailable = () => Promise.reject(new ApiError(503, "Request failed (503)"));
    expect(await flushQueue(fakeApi("A", [], unavailable))).toEqual({ flushed: 0, dropped: 0, remaining: 1 });
    expect(await flushQueue(fakeApi("A", [], async () => ({})))).toEqual({ flushed: 1, dropped: 0, remaining: 0 });
  });
});
