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
});
