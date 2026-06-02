import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * GH #526 — transport-layer tests for electron/label-printer.ts.
 *
 * The Brother PT-P710BT transport (printLabel) wraps `serialport` with a
 * stall watchdog and a single settleWithCleanup() path that must close the
 * port before rejecting on every failure mode. None of that had coverage —
 * the file is outside the enforced coverage scope (electron/ is excluded),
 * so CI gave no signal on a regression in the cleanup invariants the code's
 * own comments call out as Codex rounds 4–6 on PR #487.
 *
 * `serialport` is mocked with a controllable fake so each test drives a
 * specific open/write/drain/close/error sequence. The fake records close()
 * calls so we can assert the "always close before reject" invariant.
 */

// vi.mock is hoisted; share mutable state with the factory via vi.hoisted.
const h = vi.hoisted(() => {
  type FakeCfg = {
    constructorError?: Error;
    openError?: Error;
    openHangs?: boolean; // open() never calls its cb (simulates a hung RFCOMM open)
    writeError?: Error;
    writeHangs?: boolean; // write() never calls its cb (so an async error event can win)
    drainError?: Error;
    closeError?: Error;
  };
  const state: {
    cfg: FakeCfg;
    instances: FakeInstance[];
  } = { cfg: {}, instances: [] };

  interface FakeInstance {
    path: string;
    isOpen: boolean;
    written: Buffer | null;
    closeCalls: number;
    errorHandler: ((err: Error) => void) | null;
    pendingOpenCb: ((err: Error | null) => void) | null;
    open: (cb: (err: Error | null) => void) => void;
    write: (buf: Buffer, cb: (err?: Error | null) => void) => void;
    drain: (cb: (err?: Error | null) => void) => void;
    close: (cb?: (err?: Error | null) => void) => void;
    on: (event: string, handler: (err: Error) => void) => void;
    emitError: (err: Error) => void;
    /** Fire a previously-hung open() callback (for the post-timeout late-open test). */
    resolveOpen: () => void;
  }

  return { state, _typeMarker: undefined as unknown as FakeInstance };
});

vi.mock("serialport", () => {
  class SerialPort {
    path: string;
    isOpen = false;
    written: Buffer | null = null;
    closeCalls = 0;
    errorHandler: ((err: Error) => void) | null = null;
    pendingOpenCb: ((err: Error | null) => void) | null = null;

    constructor(
      opts: { path: string; baudRate: number; autoOpen: boolean },
      cb?: (err: Error | null) => void,
    ) {
      this.path = opts.path;
      h.state.instances.push(this as unknown as never);
      // With autoOpen:false the real SerialPort does NOT forward the
      // constructor callback (it's only wired to the implicit open when
      // autoOpen is on) — a bad path/options THROWS synchronously instead.
      // So a "constructor error" must surface as a synchronous throw, which
      // is exactly what the transport's try/catch around `new SerialPort`
      // is there to catch. Calling cb here would exercise a code path the
      // real dependency never takes (Codex P3 on PR #543).
      if (h.state.cfg.constructorError) {
        throw h.state.cfg.constructorError;
      }
      // autoOpen:false → the callback is never invoked on success either.
    }

    open(cb: (err: Error | null) => void) {
      if (h.state.cfg.openHangs) {
        this.pendingOpenCb = cb; // never call — caller's watchdog must fire
        return;
      }
      if (h.state.cfg.openError) {
        cb(h.state.cfg.openError);
        return;
      }
      this.isOpen = true;
      cb(null);
    }

    /** Fire a hung open() callback after the fact (success). */
    resolveOpen() {
      if (this.pendingOpenCb) {
        this.isOpen = true;
        const cb = this.pendingOpenCb;
        this.pendingOpenCb = null;
        cb(null);
      }
    }

    write(buf: Buffer, cb: (err?: Error | null) => void) {
      this.written = buf;
      if (h.state.cfg.writeHangs) return; // never call cb — let an error event race in
      cb(h.state.cfg.writeError ?? null);
    }

    drain(cb: (err?: Error | null) => void) {
      cb(h.state.cfg.drainError ?? null);
    }

    close(cb?: (err?: Error | null) => void) {
      this.isOpen = false;
      this.closeCalls++;
      cb?.(h.state.cfg.closeError ?? null);
    }

    on(event: string, handler: (err: Error) => void) {
      if (event === "error") this.errorHandler = handler;
    }

    emitError(err: Error) {
      this.errorHandler?.(err);
    }

    static list = async () => [];
  }
  return { SerialPort };
});

import { printLabel } from "../electron/label-printer";

const BYTES = new Uint8Array([0x1b, 0x40, 0x41, 0x42]);

beforeEach(() => {
  h.state.cfg = {};
  h.state.instances = [];
  vi.useRealTimers();
});

function lastInstance() {
  return h.state.instances[h.state.instances.length - 1] as unknown as {
    isOpen: boolean;
    written: Buffer | null;
    closeCalls: number;
    emitError: (err: Error) => void;
    resolveOpen: () => void;
  };
}

describe("printLabel — happy path", () => {
  it("opens, writes the bytes, drains, closes, and resolves", async () => {
    await expect(printLabel("/dev/tty.fake", BYTES)).resolves.toBeUndefined();
    const inst = lastInstance();
    expect(inst.written).toEqual(Buffer.from(BYTES));
    expect(inst.closeCalls).toBe(1);
    expect(inst.isOpen).toBe(false);
  });
});

describe("printLabel — failure routing through settleWithCleanup", () => {
  it("rejects on a constructor error (no port to close)", async () => {
    h.state.cfg.constructorError = new Error("bad device path");
    await expect(printLabel("/dev/nope", BYTES)).rejects.toThrow("bad device path");
  });

  it("rejects on an open() error", async () => {
    h.state.cfg.openError = new Error("port busy");
    await expect(printLabel("/dev/tty.fake", BYTES)).rejects.toThrow("port busy");
    // open() failed → never opened → nothing to close.
    expect(lastInstance().closeCalls).toBe(0);
  });

  it("routes a write() failure through cleanup — closes the open port before rejecting", async () => {
    h.state.cfg.writeError = new Error("write EIO");
    await expect(printLabel("/dev/tty.fake", BYTES)).rejects.toThrow("write EIO");
    expect(lastInstance().closeCalls).toBe(1);
  });

  it("routes a drain() failure through cleanup — closes before rejecting", async () => {
    h.state.cfg.drainError = new Error("drain stalled");
    await expect(printLabel("/dev/tty.fake", BYTES)).rejects.toThrow("drain stalled");
    expect(lastInstance().closeCalls).toBe(1);
  });

  it("routes a post-open async error event through cleanup", async () => {
    // Make write() hang so the async 'error' event wins the race. We
    // Make write() hang so it never resolves the happy path; then fire
    // the port's async 'error' event (BT drop / USB unplug). The error
    // handler registered post-open must route through settleWithCleanup,
    // closing the open port and rejecting with the error.
    h.state.cfg.writeHangs = true;
    const promise = printLabel("/dev/tty.fake", BYTES);
    const assertion = expect(promise).rejects.toThrow("bluetooth dropped");
    await Promise.resolve(); // let open→write wiring settle
    lastInstance().emitError(new Error("bluetooth dropped"));
    await assertion;
    expect(lastInstance().closeCalls).toBe(1);
  });
});

describe("printLabel — watchdog + idempotent settle", () => {
  it("fires the stall watchdog when open() hangs and rejects without leaking a port", async () => {
    vi.useFakeTimers();
    h.state.cfg.openHangs = true;
    const promise = printLabel("/dev/tty.fake", BYTES);
    // Attach the rejection handler BEFORE advancing timers so the
    // timer-driven reject isn't momentarily unhandled.
    const assertion = expect(promise).rejects.toThrow(/stalled/i);
    // open() is hung; advance past the 25s PRINT_TIMEOUT_MS.
    await vi.advanceTimersByTimeAsync(25_001);
    await assertion;
    // open() never completed → isOpen false → nothing leaked / no close.
    expect(lastInstance().isOpen).toBe(false);
  });

  it("closes a port whose open() callback arrives AFTER the watchdog already rejected", async () => {
    vi.useFakeTimers();
    h.state.cfg.openHangs = true;
    const promise = printLabel("/dev/tty.fake", BYTES);
    const assertion = expect(promise).rejects.toThrow(/stalled/i);
    await vi.advanceTimersByTimeAsync(25_001);
    await assertion;
    // Now the hung open() finally resolves successfully — the late
    // callback must best-effort close the acquired handle so the next
    // print doesn't see "port busy".
    lastInstance().resolveOpen();
    expect(lastInstance().closeCalls).toBe(1);
    expect(lastInstance().isOpen).toBe(false);
  });

  it("settles only once — a second failure after settle is a no-op", async () => {
    // write fails (first settle → reject). Then emit a late error event;
    // it must not double-settle or double-close.
    h.state.cfg.writeError = new Error("first failure");
    const promise = printLabel("/dev/tty.fake", BYTES);
    await expect(promise).rejects.toThrow("first failure");
    const before = lastInstance().closeCalls;
    lastInstance().emitError(new Error("late noise"));
    // No additional close, no unhandled rejection.
    expect(lastInstance().closeCalls).toBe(before);
  });
});
