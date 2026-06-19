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

import {
  listLabelPrinters,
  printLabel,
  windowsPowershellPath,
  mapWindowsPrintError,
  SPOOLER_DOWN_MESSAGE,
  WINDOWS_RAW_PRINT_PS1,
  WINDOWS_PRINT_TIMEOUT_MS,
} from "../electron/label-printer";

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

/**
 * Run `fn` with `process.platform` forced to "win32" so the Windows branch is
 * reachable on the CUPS test host. execFile is mocked, so nothing is spawned;
 * the fs calls printWindows makes (mkdtemp/writeFile/rm) are real but
 * platform-agnostic. Restores the original descriptor even if `fn` throws.
 */
async function runAsWin32(fn: () => Promise<void> | void): Promise<void> {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...desc, value: "win32" });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
}

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
    const devices = await listLabelPrinters({ probeUsb: true });
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

  it("restricts lpinfo to the usb backend so slow network discovery can't time out the IPC", async () => {
    // Bare `lpinfo -v` also runs snmp/dnssd backends that probe the LAN and
    // can block ~15s, blowing the list-devices IPC timeout. We only parse
    // usb:// lines, so the call must scope to the usb scheme. (Regression
    // guard for the 15s list-devices hang.)
    h.state.execImpl = (cmd) => (cmd === "lpinfo" ? { stdout: `direct ${BROTHER_URI}\n` } : { stdout: "" });
    await listLabelPrinters({ probeUsb: true });
    const lpinfo = h.state.execCalls.find((c) => c.cmd === "lpinfo");
    expect(lpinfo).toBeTruthy();
    expect(lpinfo!.args).toEqual(expect.arrayContaining(["--include-schemes", "usb"]));
  });

  // GH #771: opening Settings used to run `lpinfo`, which on macOS pops the
  // admin-password dialog (CUPS-Get-Devices is admin-only). The passive
  // (mount-time) list must NOT invoke lpinfo — only an explicit probe does.
  it("does NOT run lpinfo on a passive list (no admin prompt on Settings open)", async () => {
    h.state.execImpl = (cmd, args) => {
      if (cmd === "lpstat" && args[0] === "-v") {
        return { stdout: "device for HP_DeskJet: ipp://hp.local/\n" };
      }
      return { stdout: "" };
    };
    const devices = await listLabelPrinters(); // default: probeUsb = false
    // Installed queue still surfaces (lpstat is a prompt-free read)…
    expect(devices.some((x) => x.path === "HP_DeskJet")).toBe(true);
    // …but lpinfo is never invoked.
    expect(h.state.execCalls.some((c) => c.cmd === "lpinfo")).toBe(false);
  });

  it("runs lpinfo only when probeUsb is requested", async () => {
    h.state.execImpl = (cmd) => (cmd === "lpinfo" ? { stdout: `direct ${BROTHER_URI}\n` } : { stdout: "" });
    await listLabelPrinters({ probeUsb: true });
    expect(h.state.execCalls.some((c) => c.cmd === "lpinfo")).toBe(true);
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
    const devices = await listLabelPrinters({ probeUsb: true });
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

d("printLabel — non-usb scheme targets (GH #623)", () => {
  // Only `usb://` device URIs are valid raw-device targets — it's the one
  // scheme listLabelPrinters surfaces. Any other scheme must be refused
  // instead of being forwarded to `lpadmin -v` (which would bind the
  // managed queue to an attacker-chosen device URI).
  it.each([
    "ipp://attacker.example/printers/q",
    "file:///etc/passwd",
    "socket://10.0.0.5",
  ])("rejects %s and never reaches lpadmin or lp", async (target) => {
    await expect(printLabel(target, BYTES)).rejects.toThrow(/only usb:\/\/ devices/i);
    expect(h.state.spawnCalls.some((c) => c.cmd === "lp")).toBe(false);
    expect(h.state.execCalls.some((c) => c.cmd === "lpadmin")).toBe(false);
  });
});

describe("windowsPowershellPath (GH #623)", () => {
  // Windows' CreateProcess resolves a bare executable name from the app /
  // current directory BEFORE System32, so the transport must invoke
  // powershell.exe by absolute path (same hardening as the sc.exe probe in
  // electron/main.ts). Built with win32.join, so the expected string is
  // identical on any test host.
  it("anchors to %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", () => {
    vi.stubEnv("SystemRoot", "D:\\WinNT");
    try {
      expect(windowsPowershellPath()).toBe(
        "D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("defaults to C:\\Windows when SystemRoot is unset", () => {
    const prev = process.env.SystemRoot;
    delete process.env.SystemRoot;
    try {
      expect(windowsPowershellPath()).toBe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
    } finally {
      if (prev !== undefined) process.env.SystemRoot = prev;
    }
  });

  it("listLabelPrinters invokes powershell by absolute path, not bare name", async () => {
    // Force the Windows branch — execFile is mocked, so nothing is spawned.
    const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...desc, value: "win32" });
    try {
      h.state.execImpl = () => ({ stdout: '[{"Name":"Brother PT-P710BT"}]' });
      const devices = await listLabelPrinters();
      expect(devices).toEqual([
        { path: "Brother PT-P710BT", friendlyName: "Brother PT-P710BT", looksLikePrinter: true },
      ]);
      expect(h.state.execCalls).toHaveLength(1);
      expect(h.state.execCalls[0].cmd).toBe(windowsPowershellPath());
      expect(h.state.execCalls[0].cmd).toMatch(/powershell\.exe$/);
    } finally {
      Object.defineProperty(process, "platform", desc);
    }
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

describe("Windows raw-print job lifecycle (GH #759)", () => {
  // The win32 print path can't be executed without a Windows host + printer
  // (see the file header), so these are string-level guards on the generated
  // PowerShell template + the dedicated timeout — pinning the #759 fix so a
  // future edit can't silently re-introduce the "job never commits" bug.
  it("surfaces EndPagePrinter/EndDocPrinter failures instead of completing silently", () => {
    // The throw-strings only exist if the bool returns of the two commit calls
    // are checked — discarding them again (the original bug) removes both.
    expect(WINDOWS_RAW_PRINT_PS1).toMatch(/EndPagePrinter failed/);
    expect(WINDOWS_RAW_PRINT_PS1).toMatch(/EndDocPrinter failed/);
    // Still RAW datatype (the Brother raster must bypass driver rendering).
    expect(WINDOWS_RAW_PRINT_PS1).toContain('di.pDataType = "RAW"');
    // The guard flags that keep a teardown-after-write-failure from masking
    // the original WritePrinter error.
    expect(WINDOWS_RAW_PRINT_PS1).toMatch(/bool pageOk = false/);
    expect(WINDOWS_RAW_PRINT_PS1).toMatch(/bool docOk = false/);
  });

  it("gives the Windows print a longer subprocess timeout than the 15s listing timeout, under the 30s IPC wrapper", () => {
    expect(WINDOWS_PRINT_TIMEOUT_MS).toBeGreaterThan(15_000);
    expect(WINDOWS_PRINT_TIMEOUT_MS).toBeLessThan(30_000);
  });
});

describe("Windows spooler-down error mapping (win32 1722)", () => {
  // win32 1722 = RPC_S_SERVER_UNAVAILABLE — the winspool calls are RPC to the
  // Print Spooler service, so a stopped/crashed spooler fails OpenPrinter with
  // 1722. The cryptic "OpenPrinter failed (1722)" becomes an actionable hint.

  it("SPOOLER_DOWN_MESSAGE names the service and how to restart it, ASCII-only", () => {
    expect(SPOOLER_DOWN_MESSAGE).toMatch(/Print Spooler/i);
    expect(SPOOLER_DOWN_MESSAGE).toMatch(/services\.msc/i);
    // ASCII-only: it's embedded in the PS1 here-string that's written to disk
    // and re-read under the host code page, where non-ASCII can be mangled.
    expect(/^[\x00-\x7F]*$/.test(SPOOLER_DOWN_MESSAGE)).toBe(true);
  });

  describe("the PowerShell template special-cases 1722 on OpenPrinter", () => {
    it("branches on win32 1722 and embeds the friendly message", () => {
      expect(WINDOWS_RAW_PRINT_PS1).toMatch(/err == 1722/);
      expect(WINDOWS_RAW_PRINT_PS1).toContain(SPOOLER_DOWN_MESSAGE);
    });
    it("keeps the generic 'OpenPrinter failed (N)' for every other code", () => {
      expect(WINDOWS_RAW_PRINT_PS1).toContain('"OpenPrinter failed (" + err + ")"');
    });
    it("the whole template stays ASCII (host-code-page safe)", () => {
      expect(/^[\x00-\x7F]*$/.test(WINDOWS_RAW_PRINT_PS1)).toBe(true);
    });
  });

  describe("mapWindowsPrintError", () => {
    it("maps the bare 'OpenPrinter failed (1722)' text to the friendly hint", () => {
      expect(mapWindowsPrintError("OpenPrinter failed (1722)")).toBe(SPOOLER_DOWN_MESSAGE);
    });
    it("maps a 1722 buried in .NET/PowerShell noise (later winspool call)", () => {
      const noise =
        "Exception calling \"Print\": \"WritePrinter failed (1722)\"\n    at <ScriptBlock>";
      expect(mapWindowsPrintError(noise)).toBe(SPOOLER_DOWN_MESSAGE);
    });
    it("passes through the friendly message the PS child already emitted", () => {
      expect(mapWindowsPrintError(`boom\n${SPOOLER_DOWN_MESSAGE}\n`)).toBe(SPOOLER_DOWN_MESSAGE);
    });
    it("returns null for unrelated win32 codes", () => {
      expect(mapWindowsPrintError("OpenPrinter failed (5)")).toBeNull(); // access denied
      expect(mapWindowsPrintError("WritePrinter failed (1784)")).toBeNull();
    });
    it("does not match 1722 as a substring of a larger number", () => {
      expect(mapWindowsPrintError("code 17220")).toBeNull();
      expect(mapWindowsPrintError("error 21722")).toBeNull();
    });
    it("returns null for empty input", () => {
      expect(mapWindowsPrintError("")).toBeNull();
    });
  });

  describe("printWindows surfaces the mapping to the renderer", () => {
    it("rewrites a 1722 print failure to the actionable spooler-down message", async () => {
      await runAsWin32(async () => {
        h.state.execImpl = () => ({
          error: new Error("Command failed: powershell.exe ..."),
          stderr: "OpenPrinter failed (1722)",
        });
        await expect(printLabel("Brother PT-P710BT", BYTES)).rejects.toThrow(/Print Spooler/i);
      });
    });

    it("passes unrelated print failures through unchanged", async () => {
      await runAsWin32(async () => {
        h.state.execImpl = () => ({
          error: new Error("WritePrinter failed (5)"),
          stderr: "",
        });
        await expect(printLabel("Brother PT-P710BT", BYTES)).rejects.toThrow(
          /WritePrinter failed \(5\)/,
        );
      });
    });
  });
});

describe("listWindowsPrinters — bidirectional-support detection", () => {
  // Some drivers (the PT-P710BT among them) crash the spooler when BiDi is on;
  // the picker reads EnableBIDI from Win32_Printer to warn the user. Get-Printer
  // stays the source of the device list — Win32_Printer only supplies the flag.

  it("keeps Get-Printer as the device source and reads EnableBIDI from Win32_Printer", async () => {
    await runAsWin32(async () => {
      h.state.execImpl = () => ({ stdout: '[{"Name":"Brother PT-P710BT","EnableBIDI":true}]' });
      await listLabelPrinters();
      const script = h.state.execCalls[0].args[3];
      expect(script).toContain("Get-Printer");
      expect(script).toContain("Win32_Printer");
      expect(script).toContain("EnableBIDI");
    });
  });

  it("flags printers with BiDi on and leaves it false when off", async () => {
    await runAsWin32(async () => {
      h.state.execImpl = () => ({
        stdout:
          '[{"Name":"Brother PT-P710BT","EnableBIDI":true},{"Name":"HP DeskJet","EnableBIDI":false}]',
      });
      const devices = await listLabelPrinters();
      expect(devices.find((x) => x.path === "Brother PT-P710BT")?.bidiEnabled).toBe(true);
      expect(devices.find((x) => x.path === "HP DeskJet")?.bidiEnabled).toBe(false);
    });
  });

  it("leaves bidiEnabled undefined when the flag is absent (CIM probe failed)", async () => {
    await runAsWin32(async () => {
      h.state.execImpl = () => ({ stdout: '[{"Name":"Brother PT-P710BT"}]' });
      const devices = await listLabelPrinters();
      expect(devices[0].bidiEnabled).toBeUndefined();
    });
  });
});
