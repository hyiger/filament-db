import { describe, it, expect, vi } from "vitest";
import {
  createScanMatchHandler,
  type FilamentMatch,
  type NfcTagReadResult,
} from "@/lib/scanMatchHandler";
import type { DecodedOpenPrintTag } from "@/lib/openprinttag-decode";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (r: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeAbortAwareFetch(handlers: Array<(signal?: AbortSignal) => Promise<Response>>) {
  // Returns a vi.fn that uses one handler per call, in order.
  const fn = vi.fn();
  for (const handler of handlers) {
    fn.mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as { name: string }).name = "AbortError";
          reject(err);
        });
        handler(init?.signal).then(resolve, reject);
      });
    });
  }
  return fn as unknown as typeof globalThis.fetch;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function decoded(name: string): DecodedOpenPrintTag {
  return {
    meta: {},
    main: {},
    materialName: name,
    brandName: "Test Vendor",
    materialType: "PLA",
  } as DecodedOpenPrintTag;
}

function matchFor(id: string, name: string): FilamentMatch {
  return { _id: id, name, vendor: "Test Vendor", type: "PLA", color: "#000000" };
}

describe("createScanMatchHandler", () => {
  it("publishes once per scan with the matched filament", async () => {
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: makeAbortAwareFetch([
        async () => jsonResponse({ match: matchFor("abc", "PLA"), candidates: [] }),
      ]),
    });

    await handle({ data: decoded("PLA") });

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]![0]).toMatchObject({
      data: { materialName: "PLA" },
      match: { _id: "abc" },
      candidates: [],
    });
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toEqual(matchFor("abc", "PLA"));
  });

  it("matches by the written spool id and propagates matchedSpool (#732)", async () => {
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const spool = { _id: "sp1", instanceId: "5p001dcafe", label: "Drybox" };
    const fetchMock = makeAbortAwareFetch([
      async () => jsonResponse({ match: matchFor("fil1", "PLA"), candidates: [], matchedSpool: spool }),
    ]);
    const handle = createScanMatchHandler({ onResult, onPublish, fetch: fetchMock });

    await handle({ data: { ...decoded("PLA"), spoolUid: "5p001dcafe" } as DecodedOpenPrintTag });

    // The match request carried the decoded spool id as `instanceId` so the
    // server resolves by spool first (rename-robust, matching mobile).
    const url = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string;
    expect(url).toContain("instanceId=5p001dcafe");
    // matchedSpool is propagated to both callbacks.
    expect(onResult.mock.calls[0]![0].matchedSpool).toEqual(spool);
    expect(onPublish.mock.calls[0]![3]).toEqual(spool);
  });

  it("drops the commit from a superseded scan (regression: codex P1 on PR #234)", async () => {
    const onResult = vi.fn();
    const onPublish = vi.fn();

    const deferA = defer<Response>();
    const deferB = defer<Response>();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: makeAbortAwareFetch([() => deferA.promise, () => deferB.promise]),
    });

    // Fire A then B; A's fetch will be aborted by B's start.
    const pA = handle({ data: decoded("Tag A") });
    const pB = handle({ data: decoded("Tag B") });

    // Resolve B first — this is what should land.
    deferB.resolve(jsonResponse({ match: matchFor("bbb", "Tag B"), candidates: [] }));
    await pB;

    // Also resolve A's underlying promise — if the abort + seq guard
    // both work, this must NOT produce a second commit.
    deferA.resolve(jsonResponse({ match: matchFor("aaa", "Tag A"), candidates: [] }));
    await pA;
    // One extra microtask drain to be sure no late commit slips through.
    await Promise.resolve();

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toEqual(matchFor("bbb", "Tag B"));
    expect(onResult).toHaveBeenCalledTimes(1);
    const result = onResult.mock.calls[0]![0] as NfcTagReadResult;
    expect(result.match?._id).toBe("bbb");
  });

  it("commits with null match on a non-2xx match response", async () => {
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: makeAbortAwareFetch([
        async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response),
      ]),
    });

    await handle({ data: decoded("Bad request tag") });

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toBeNull();
    expect(onResult.mock.calls[0]![0]).toMatchObject({ match: null, candidates: [] });
  });

  it("commits with null match when the fetch throws a non-abort error", async () => {
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: makeAbortAwareFetch([
        async () => {
          throw new Error("network down");
        },
      ]),
    });

    await handle({ data: decoded("Offline tag") });

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toBeNull();
  });

  it("ignores AbortError without committing", async () => {
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: makeAbortAwareFetch([() => defer<Response>().promise, () => defer<Response>().promise]),
    });

    // Two scans — the first will be aborted by the second, and the
    // second's fetch is intentionally left pending. No commit should
    // happen from either.
    const pA = handle({ data: decoded("A") });
    handle({ data: decoded("B") }); // intentionally not awaited

    // Wait for A's aborted fetch to reject and the catch to run.
    await pA;
    await Promise.resolve();

    expect(onPublish).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("delivers an error event without firing a publish", async () => {
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });

    await handle({ error: "Cannot connect to tag" });

    expect(onResult).toHaveBeenCalledWith({ error: "Cannot connect to tag" });
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("delivers an empty-tag event without firing a publish", async () => {
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });

    await handle({ empty: true });

    expect(onResult).toHaveBeenCalledWith({ empty: true });
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("is a no-op when neither data nor error nor empty is set", async () => {
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });

    await handle({});

    expect(onResult).not.toHaveBeenCalled();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("commits null match when the fetch rejects with a non-object (no .name) rejection", async () => {
    // isAbortError sees a primitive rejection reason on a non-aborted signal:
    // typeof err !== "object" so it can't be an AbortError → returns false →
    // the catch commits a null match instead of swallowing (covers line 77).
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: makeAbortAwareFetch([
        async () => {
           
          throw "string failure";
        },
      ]),
    });

    await handle({ data: decoded("Primitive-reject tag") });

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toBeNull();
    expect(onResult.mock.calls[0]![0]).toMatchObject({ match: null, candidates: [] });
  });

  it("commits null match when the fetch rejects with an object lacking a name property", async () => {
    // typeof err === "object" but "name" not in err → the inner branch is
    // false and isAbortError falls through to `return false` (line 77).
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: makeAbortAwareFetch([
        async () => {
           
          throw { message: "no name key here" };
        },
      ]),
    });

    await handle({ data: decoded("Nameless-object-reject tag") });

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toBeNull();
  });

  it("falls back to global fetch when deps.fetch is omitted (covers the ?? default)", async () => {
    // No fetch override → the handler binds globalThis.fetch. Stub it so the
    // default-branch code path (line 81 `?? globalThis.fetch.bind(...)`) runs.
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const stub = vi
      .fn()
      .mockResolvedValue(jsonResponse({ match: matchFor("glob", "PLA"), candidates: [] }));
    const original = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof globalThis.fetch;
    try {
      const handle = createScanMatchHandler({ onResult, onPublish });
      await handle({ data: decoded("PLA") });
    } finally {
      globalThis.fetch = original;
    }

    expect(stub).toHaveBeenCalledTimes(1);
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toEqual(matchFor("glob", "PLA"));
  });

  it("omits query params for tag fields that are absent (covers the false side of each guard)", async () => {
    // data present but every optional field missing: none of the four
    // params.set() lines run (branches 111-114 false side).
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const fetchMock = makeAbortAwareFetch([
      async () => jsonResponse({ match: null, candidates: [] }),
    ]);
    const handle = createScanMatchHandler({ onResult, onPublish, fetch: fetchMock });

    await handle({ data: { meta: {}, main: {} } as DecodedOpenPrintTag });

    const url = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![0] as string;
    // Empty query string — no instanceId/name/vendor/type appended.
    expect(url).toBe("/api/filaments/match?");
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toBeNull();
  });

  it("defaults match to null and candidates to [] when the body omits them (branches 136/137)", async () => {
    // The match response is a bare object: parsed.match is undefined → `?? null`
    // fallback; parsed.candidates is undefined → the Array.isArray(...) guard is
    // false → `[]` fallback. Also parsed.matchedSpool absent → null.
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: makeAbortAwareFetch([async () => jsonResponse({})]),
    });

    await handle({ data: decoded("Empty-body tag") });

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toBeNull(); // match
    expect(onPublish.mock.calls[0]![2]).toEqual([]); // candidates
    expect(onPublish.mock.calls[0]![3]).toBeNull(); // matchedSpool
    expect(onResult.mock.calls[0]![0]).toMatchObject({ match: null, candidates: [] });
  });

  it("swallows a superseded scan's own successful commit via the seq guard (branch 122)", async () => {
    // A ignore-abort fetch lets the OLDER scan's request resolve successfully
    // even after a newer scan supersedes it. Reaching `commit`, the seq guard
    // (`mySeq !== seq`) must fire its early `return` so no stale commit lands —
    // this is the true-branch of line 122 that the abort-path tests don't reach.
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const deferA = defer<Response>();
    const deferB = defer<Response>();
    // Custom fetch that does NOT wire up the abort → the resolved promise wins.
    const calls: Array<Promise<Response>> = [deferA.promise, deferB.promise];
    let i = 0;
    const fetchMock = vi.fn(() => calls[i++]!) as unknown as typeof globalThis.fetch;

    const handle = createScanMatchHandler({ onResult, onPublish, fetch: fetchMock });

    const pA = handle({ data: decoded("Tag A") }); // mySeq = 1
    const pB = handle({ data: decoded("Tag B") }); // mySeq = 2, seq now 2

    // Resolve the OLDER (superseded) request first. It reaches commit, but
    // mySeq(1) !== seq(2) → early return, nothing published.
    deferA.resolve(jsonResponse({ match: matchFor("aaa", "Tag A"), candidates: [] }));
    await pA;
    expect(onPublish).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();

    // The newest request commits normally.
    deferB.resolve(jsonResponse({ match: matchFor("bbb", "Tag B"), candidates: [] }));
    await pB;

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![1]).toEqual(matchFor("bbb", "Tag B"));
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("coerces a non-array candidates field to [] (Array.isArray false branch, 137)", async () => {
    // parsed.candidates is a truthy non-array → the ternary's false side runs.
    const onResult = vi.fn();
    const onPublish = vi.fn();
    const handle = createScanMatchHandler({
      onResult,
      onPublish,
      fetch: makeAbortAwareFetch([
        async () =>
          jsonResponse({ match: matchFor("x", "PLA"), candidates: "not-an-array" }),
      ]),
    });

    await handle({ data: decoded("PLA") });

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]![2]).toEqual([]); // candidates coerced to []
  });
});
