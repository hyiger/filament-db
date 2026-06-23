import { describe, it, expect, vi } from "vitest";
import { isPortInUseError, startWithRetry } from "./mongoRetry";

/**
 * GH #808 — the shared Mongo startup must survive a random-port collision by
 * retrying with a fresh server, but must not mask genuine startup failures.
 */
describe("isPortInUseError", () => {
  it("matches the mongodb-memory-server port-in-use message", () => {
    expect(isPortInUseError(new Error('Port "57343" already in use'))).toBe(true);
    expect(isPortInUseError(new Error("listen EADDRINUSE: address already in use"))).toBe(true);
  });

  it("matches a raw EADDRINUSE code", () => {
    expect(isPortInUseError({ code: "EADDRINUSE" })).toBe(true);
  });

  it("does NOT match unrelated startup failures", () => {
    expect(isPortInUseError(new Error("Instance failed to start within 60000ms"))).toBe(false);
    expect(isPortInUseError(new Error("spawn mongod ENOENT"))).toBe(false);
    expect(isPortInUseError(null)).toBe(false);
  });
});

describe("startWithRetry", () => {
  const noSleep = () => Promise.resolve();

  it("retries past port collisions and returns the eventual success", async () => {
    let calls = 0;
    const create = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('Port "57343" already in use');
      return "server";
    });
    const onRetry = vi.fn();
    const result = await startWithRetry(create, { delayMs: 0, sleep: noSleep, onRetry });
    expect(result).toBe("server");
    expect(create).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("rethrows a non-port error immediately without retrying", async () => {
    const create = vi.fn(async () => {
      throw new Error("Instance failed to start within 60000ms");
    });
    await expect(startWithRetry(create, { delayMs: 0, sleep: noSleep })).rejects.toThrow(
      /failed to start/,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and throws the last port error", async () => {
    const create = vi.fn(async () => {
      throw new Error('Port "5000" already in use');
    });
    await expect(
      startWithRetry(create, { maxAttempts: 3, delayMs: 0, sleep: noSleep }),
    ).rejects.toThrow(/already in use/);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("succeeds on the first try without invoking the retry callback", async () => {
    const create = vi.fn(async () => "ok");
    const onRetry = vi.fn();
    expect(await startWithRetry(create, { onRetry })).toBe("ok");
    expect(create).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
