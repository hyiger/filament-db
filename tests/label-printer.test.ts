import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * GH #588 — transport-layer tests for electron/label-printer.ts.
 *
 * The label printer now talks to the OS print system instead of serialport:
 * on macOS/Linux it shells out to CUPS (`lpstat`/`lpinfo` to list, `lp -o raw`
 * to print, auto-managing a hidden raw queue for `usb://` devices); on Windows
 * it drives the spooler via PowerShell. These tests mock `node:child_process`
 * and exercise the CUPS path (the test runner is darwin/linux). The Windows
 * branch is gated on `process.platform === "win32"` and isn't covered here —
 * it needs a real Windows host.
 */

const h = vi.hoisted(() => {
  const state = {
    execCalls: [] as { cmd: string; args: string[] }[],
    // Map a command invocation to its result.
    execImpl: (() => ({ stdout: "" })) as (cmd: string, args: string[]) => { stdout?: string; stderr?: string; error?: Error },
    spawnCalls: [] as { cmd: string; args: string[] }[],
    spawn: { exitCode: 0 as number | null, stderr: "", written: null as Buffer | null, errorOnSpawn: null as Error | null },
  };
  return { state };
});

vi.mock("node:child_process", () => {
  // Give the mock the same util.promisify.custom shape the real execFile has,
  // so `promisify(execFile)` resolves to { stdout, stderr } (not just stdout).
  const execFile = (() => {}) as unknown as {
    (...a: unknown[]): unknown;
    [k: symbol]: unknown;
  };
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (cmd: string, args: string[]) => {
    h.state.execCalls.push({ cmd, args });
    const res = h.state.execImpl(cmd, args);
    if (res.error) return Promise.reject(Object.assign(res.error, { stderr: res.stderr ?? "" }));
    return Promise.resolve({ stdout: res.stdout ?? "", stderr: res.stderr ?? "" });
  };

  const spawn = (cmd: string, args: string[]) => {
    h.state.spawnCalls.push({ cmd, args });
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const fire = (ev: string, ...a: unknown[]) => (listeners[ev] ?? []).forEach((fn) => fn(...a));
    const child = {
      stdin: {
        on: () => {},
        end: (buf: Buffer) => {
          h.state.spawn.written = buf;
          // Resolve on the next microtask, after close/error handlers are wired.
          queueMicrotask(() => {
            if (h.state.spawn.errorOnSpawn) fire("error", h.state.spawn.errorOnSpawn);
            else fire("close", h.state.spawn.exitCode);
          });
        },
      },
      stderr: {
        on: (ev: string, fn: (d: Buffer) => void) => {
          if (ev === "data" && h.state.spawn.stderr) fn(Buffer.from(h.state.spawn.stderr));
        },
      },
      on: (ev: string, fn: (...a: unknown[]) => void) => { (listeners[ev] ??= []).push(fn); },
      kill: () => {},
    };
    return child;
  };

  return { execFile, spawn };
});

import { listLabelPrinters, printLabel } from "../electron/label-printer";

const BYTES = new Uint8Array([0x1b, 0x40, 0x41, 0x42]);
const BROTHER_URI = "usb://Brother/PT-P710BT?serial=000M5G671606";

beforeEach(() => {
  h.state.execCalls = [];
  h.state.spawnCalls = [];
  h.state.execImpl = () => ({ stdout: "" });
  h.state.spawn = { exitCode: 0, stderr: "", written: null, errorOnSpawn: null };
});

// Skip on Windows — that branch uses a different (PowerShell) transport.
const cups = process.platform !== "win32";
const d = cups ? describe : describe.skip;

d("listLabelPrinters (CUPS)", () => {
  it("surfaces installed queues and available usb devices, badging PT printers", async () => {
    h.state.execImpl = (cmd, args) => {
      if (cmd === "lpstat" && args[0] === "-v") {
        return { stdout: "device for HP_DeskJet: ipp://hp.local/\n" };
      }
      if (cmd === "lpinfo") {
        return { stdout: `direct ${BROTHER_URI}\nnetwork socket://10.0.0.5\n` };
      }
      return { stdout: "" };
    };
    const devices = await listLabelPrinters();
    const brother = devices.find((x) => x.path === BROTHER_URI);
    const hp = devices.find((x) => x.path === "HP_DeskJet");
    expect(brother).toBeTruthy();
    expect(brother!.looksLikePrinter).toBe(true);
    expect(brother!.friendlyName).toMatch(/Brother PT-P710BT.*USB/);
    expect(hp).toBeTruthy();
    expect(hp!.looksLikePrinter).toBe(false);
    // socket:// is not a usb device → not listed.
    expect(devices.some((x) => x.path.startsWith("socket://"))).toBe(false);
  });

  it("surfaces the managed queue as its underlying usb device (and dedups lpinfo)", async () => {
    h.state.execImpl = (cmd, args) => {
      if (cmd === "lpstat" && args[0] === "-v") {
        return { stdout: `device for FilamentDB_Label: ${BROTHER_URI}\n` };
      }
      if (cmd === "lpinfo") {
        return { stdout: `direct ${BROTHER_URI}\n` };
      }
      return { stdout: "" };
    };
    const devices = await listLabelPrinters();
    // Exactly one entry for the Brother — the managed queue resolves to the
    // device uri, and the identical lpinfo line is deduped away.
    const brotherEntries = devices.filter((x) => x.path === BROTHER_URI);
    expect(brotherEntries).toHaveLength(1);
    // The managed queue name itself is never exposed as a target.
    expect(devices.some((x) => x.path === "FilamentDB_Label")).toBe(false);
  });
});

d("printLabel (CUPS)", () => {
  it("prints to an installed queue directly with `lp -o raw` (no lpadmin)", async () => {
    await expect(printLabel("HP_DeskJet", BYTES)).resolves.toBeUndefined();
    const lp = h.state.spawnCalls.find((c) => c.cmd === "lp");
    expect(lp!.args).toEqual(["-d", "HP_DeskJet", "-o", "raw"]);
    expect(h.state.spawn.written).toEqual(Buffer.from(BYTES));
    expect(h.state.execCalls.some((c) => c.cmd === "lpadmin")).toBe(false);
  });

  it("creates the managed raw queue for a usb:// device, then prints to it", async () => {
    h.state.execImpl = (cmd, args) => {
      // queue doesn't exist yet → lpstat -v <queue> errors
      if (cmd === "lpstat" && args.includes("FilamentDB_Label")) {
        return { error: new Error("lpstat: unknown printer") };
      }
      return { stdout: "" };
    };
    await expect(printLabel(BROTHER_URI, BYTES)).resolves.toBeUndefined();
    const lpadmin = h.state.execCalls.find((c) => c.cmd === "lpadmin");
    expect(lpadmin).toBeTruthy();
    expect(lpadmin!.args).toEqual(
      expect.arrayContaining(["-p", "FilamentDB_Label", "-v", BROTHER_URI, "-E"]),
    );
    const lp = h.state.spawnCalls.find((c) => c.cmd === "lp");
    expect(lp!.args).toEqual(["-d", "FilamentDB_Label", "-o", "raw"]);
  });

  it("does NOT recreate the managed queue when it's already bound to the device", async () => {
    h.state.execImpl = (cmd, args) => {
      if (cmd === "lpstat" && args.includes("FilamentDB_Label")) {
        return { stdout: `device for FilamentDB_Label: ${BROTHER_URI}\n` };
      }
      return { stdout: "" };
    };
    await expect(printLabel(BROTHER_URI, BYTES)).resolves.toBeUndefined();
    expect(h.state.execCalls.some((c) => c.cmd === "lpadmin")).toBe(false);
  });

  it("rejects with lp's stderr when the print job fails", async () => {
    h.state.spawn.exitCode = 1;
    h.state.spawn.stderr = "lp: Error - The printer is not responding.";
    await expect(printLabel("HP_DeskJet", BYTES)).rejects.toThrow(/not responding/);
  });

  it("rejects when lp can't be spawned", async () => {
    h.state.spawn.errorOnSpawn = new Error("spawn lp ENOENT");
    await expect(printLabel("HP_DeskJet", BYTES)).rejects.toThrow(/ENOENT/);
  });
});

describe("printLabel — legacy serial targets (GH #589)", () => {
  // A stored target from the pre-#588 serialport transport must NOT be treated
  // as a CUPS queue name (it would fail obscurely); prompt a reselect instead.
  it.each([
    "/dev/tty.PT-P710BT-1606-Serialport",
    "/dev/cu.PT-P710BT1606",
    "/dev/rfcomm0",
    "COM3",
  ])("rejects %s with a reselect message and never spawns lp", async (target) => {
    await expect(printLabel(target, BYTES)).rejects.toThrow(/select your printer again/i);
    expect(h.state.spawnCalls.some((c) => c.cmd === "lp")).toBe(false);
    expect(h.state.execCalls.some((c) => c.cmd === "lpadmin")).toBe(false);
  });
});
