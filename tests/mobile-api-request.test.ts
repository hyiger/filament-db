import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiError, createApi } from "../packages/mobile/src/lib/api";

/**
 * GH #1211 — the mobile client's 15 s timeout and its network-error
 * conversion covered only the initial `fetch()`. The body read ran after both:
 * a stalled body hung forever (Expo's native `text()` only settles once the
 * body completes), and a dropped one escaped as a plain Error the offline
 * queue treated as permanent.
 */
describe("mobile api request — body phase (GH #1211)", () => {
  const api = createApi({ baseUrl: "http://desktop.test:3456", apiKey: null });
  const spoolPatch = () => api.updateSpool("f1", "s1", { remainingWeight: 500 });

  /** A Response whose body read does whatever `text` does. */
  function response(status: number, text: () => Promise<string>) {
    return { ok: status >= 200 && status < 300, status, text } as unknown as Response;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function settle<T>(promise: Promise<T>, ms = 0): Promise<{ value?: T; error?: unknown }> {
    const outcome = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return outcome;
  }

  it("returns the parsed body and leaves no timer behind", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, async () => '{"spool":{"_id":"s1"}}')));
    const { value } = await settle(spoolPatch());
    expect(value).toEqual({ spool: { _id: "s1" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a write whose 2xx reply dropped mid-body as committed, not unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(200, () => Promise.reject(new Error("connection reset")))),
    );
    const { error } = await settle(spoolPatch());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).committed).toBe(true);
    expect((error as ApiError).status).toBe(200);
  });

  it("reports a read whose reply dropped as a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(200, () => Promise.reject(new Error("connection reset")))),
    );
    const { error } = await settle(api.getLocations());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).committed).toBe(false);
  });

  it.each([503, 401, 404])("keeps an error status (%i) when its body can't be read", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(status, () => Promise.reject(new Error("connection reset")))),
    );
    const { error } = await settle(spoolPatch());
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    expect((error as ApiError).committed).toBe(false);
  });

  it("bounds a body that never arrives, and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        // Like Expo's native text(): ignores the abort and never settles.
        return response(200, () => new Promise<string>(() => {}));
      }),
    );
    let settled = false;
    const outcome = spoolPatch().then(
      () => ({ error: undefined as unknown }),
      (error: unknown) => ({ error }),
    );
    void outcome.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const { error } = await outcome;
    expect((error as ApiError).committed).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a slow body that does arrive succeed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(200, () => new Promise<string>((resolve) => setTimeout(() => resolve("{}"), 30_000))),
      ),
    );
    const { value } = await settle(spoolPatch(), 30_000);
    expect(value).toEqual({});
  });

  it("still fails fast when the headers never arrive", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { error } = await settle(spoolPatch(), 15_000);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toMatch(/didn't respond/);
  });

  it("recognizes an abort that Expo rejects with a plain Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("canceled")));
          }),
      ),
    );
    const { error } = await settle(spoolPatch(), 15_000);
    expect((error as ApiError).message).toMatch(/didn't respond/);
  });
});
