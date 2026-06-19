/**
 * Brother PT-P710BT label-printer transport for the Electron main
 * process — OS print-system backend (GH #588).
 *
 * The PT-P710BT's Bluetooth is iOS/Android only per Brother; on the
 * desktop it connects over USB as a USB **printer-class** device, NOT a
 * serial port. So this transport hands the raster byte stream to the
 * platform print stack, which owns the USB device and its driver:
 *
 *   - macOS / Linux → CUPS. We `lp -o raw` to a print queue. The printer
 *     usually isn't an installed *queue* (Brother's own app talks to the
 *     device directly), so when the user selects a raw `usb://…` device we
 *     auto-manage a hidden raw queue (`FilamentDB_Label`) bound to it.
 *   - Windows → the print spooler. We send the `RAW` datatype to the
 *     installed printer via the Win32 `WritePrinter` API (driven from a
 *     short PowerShell P/Invoke script).
 *
 * The byte stream itself is produced by `src/lib/labelEncoder.ts` — this
 * file is transport only.
 *
 * Replaces the previous `serialport` transport, which could only reach
 * the (unsupported, flaky) Bluetooth-SPP node and never the USB device.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

const execFileP = promisify(execFile);

/** Heuristic match for "this printer/device is a PT-series label printer". */
const PRINTER_PATTERN = /pt-?p710bt|p-?touch|brother/i;

/** Name of the hidden raw CUPS queue we manage for raw `usb://` devices
 *  that aren't already installed as a queue. CUPS queue names allow only
 *  letters, digits and underscores. */
const MANAGED_QUEUE = "FilamentDB_Label";

/** Per-subprocess timeout for listing + the CUPS `lp` print. Listing and a
 *  single 24mm label both complete well under this; the IPC handler wraps the
 *  whole print in its own 30s timeout on top. */
const EXEC_TIMEOUT_MS = 15_000;

/** GH #759 — the Windows winspool print gets a LONGER subprocess timeout than
 *  the 15s listing timeout. `EndDocPrinter` blocks until the spooler drains the
 *  RAW bytes to the (slow, USB) label printer, which can take several seconds;
 *  at 15s a busy/recovering spooler could be SIGKILLed mid-`EndDocPrinter`,
 *  leaving the job open + a leaked printer handle (the "2nd print sticks, 3rd
 *  errors" cascade). Kept under the IPC handler's 30s wrapper so the user still
 *  gets a bounded failure. Exported for the regression test. */
export const WINDOWS_PRINT_TIMEOUT_MS = 25_000;

/** On Linux a GUI app's PATH often omits /usr/sbin where lpadmin/lpinfo
 *  live, so we try the bare name first then the sbin path. (The CUPS tools
 *  stay bare names on purpose: Unix execvp never searches the cwd, and
 *  their install paths vary across distros — see windowsPowershellPath()
 *  for why Windows gets the opposite treatment.) */
const SBIN = "/usr/sbin";

/**
 * Absolute path to powershell.exe (GH #623). Windows' CreateProcess
 * resolves a bare executable name from the application's own directory
 * and the current directory BEFORE System32, so a `powershell.exe`
 * planted next to a portable/unpacked run would be picked up first and
 * turn these calls into an arbitrary-code-execution sink. Anchor to an
 * absolute path — the exact pattern the sc.exe probe in electron/main.ts
 * uses. Exported for the unit test; built with win32.join so the path is
 * identical regardless of the host the test runs on.
 */
export function windowsPowershellPath(): string {
  return win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export interface LabelPrinterDevice {
  /** Opaque print target: a CUPS queue name, a `usb://…` device URI, or a
   *  Windows printer name. Passed back to {@link printLabel}. */
  path: string;
  /** Human-readable name for the picker dropdown. */
  friendlyName: string;
  /** True when the target matches a PT-series printer — the picker badges
   *  / pre-selects the obvious choice. */
  looksLikePrinter: boolean;
  /** Windows only: the queue has bidirectional support (EnableBIDI) turned on.
   *  Some drivers (the PT-P710BT among them) crash the Print Spooler when the
   *  spooler's bidi status query runs at schedule time, so the picker warns the
   *  user to disable it. `undefined` on macOS/Linux and whenever the bidi state
   *  couldn't be read — only an explicit `true` should trigger the warning. */
  bidiEnabled?: boolean;
}

function isCups(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

/**
 * List the printers/devices the OS print system can reach. Never throws —
 * returns [] on any failure so the picker shows its empty state.
 */
/**
 * List label-printer targets.
 *
 * `probeUsb` (GH #771): when false (the default), only ALREADY-CONFIGURED
 * print queues are listed — on CUPS that's `lpstat -v`, which is a plain
 * read and never prompts. When true, additionally run `lpinfo` to discover
 * raw `usb://` devices that aren't set up as a queue yet.
 *
 * Why this matters: on macOS `lpinfo` issues the CUPS `CUPS-Get-Devices`
 * operation, which the default cupsd policy restricts to admins — so it pops
 * the macOS authorization dialog asking for an admin password. The Settings
 * panel used to call this on mount, so merely opening Settings prompted for
 * admin credentials (#771), which is especially jarring for the many users
 * who don't own a label printer. The renderer now does a passive (no-probe)
 * list on mount and only probes for USB devices on an explicit user action
 * (the Refresh button), where a credential prompt is expected and contextual.
 *
 * Windows (`Get-Printer`) lists installed printers without any elevation, so
 * `probeUsb` is a no-op there.
 */
export async function listLabelPrinters(
  opts: { probeUsb?: boolean } = {},
): Promise<LabelPrinterDevice[]> {
  try {
    if (process.platform === "win32") return await listWindowsPrinters();
    if (isCups()) return await listCupsPrinters(opts.probeUsb === true);
    return [];
  } catch (err) {
    console.error("[label-printer] list failed:", err);
    return [];
  }
}

/** Run a CUPS admin/info tool, falling back to /usr/sbin when it isn't on PATH. */
async function runCupsTool(tool: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(tool, args, { timeout: EXEC_TIMEOUT_MS });
    return stdout;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      const { stdout } = await execFileP(join(SBIN, tool), args, { timeout: EXEC_TIMEOUT_MS });
      return stdout;
    }
    throw err;
  }
}

async function listCupsPrinters(probeUsb: boolean): Promise<LabelPrinterDevice[]> {
  const devices: LabelPrinterDevice[] = [];
  const seenUris = new Set<string>();

  // 1. Installed queues (excluding our own managed one). `lpstat -v` lines
  //    look like: "device for NAME: usb://Brother/PT-P710BT?serial=…".
  //    This is a plain read of configured queues — it never prompts for
  //    credentials, so it's safe to run on the passive (mount-time) path.
  try {
    const stdout = await runCupsTool("lpstat", ["-v"]);
    for (const line of stdout.split("\n")) {
      const m = line.match(/^device for (.+?):\s*(.+)$/);
      if (!m) continue;
      const name = m[1].trim();
      const uri = m[2].trim();
      seenUris.add(uri);
      if (name === MANAGED_QUEUE) {
        // Our own managed queue is an implementation detail — surface it as
        // the underlying USB *device* (path = the uri), so selecting it and
        // printing both route through ensureManagedQueue idempotently. Without
        // this the device would vanish from the picker once the queue exists
        // (its uri is in seenUris, so the lpinfo pass below dedups it away).
        devices.push({
          path: uri,
          friendlyName: prettifyUsbUri(uri),
          looksLikePrinter: PRINTER_PATTERN.test(uri),
        });
        continue;
      }
      devices.push({
        path: name,
        friendlyName: name,
        looksLikePrinter: PRINTER_PATTERN.test(`${name} ${uri}`),
      });
    }
  } catch {
    /* no installed queues / lpstat unavailable — fall through to lpinfo */
  }

  // 2. Available USB printer devices not already installed as a queue.
  //    `lpinfo -v` lines look like: "direct usb://Brother/PT-P710BT?serial=…".
  //    `--include-schemes usb` restricts it to the USB backend: a bare
  //    `lpinfo -v` also runs the network backends (snmp/dnssd), which probe
  //    the LAN and can block ~10-15s — enough to blow the IPC timeout (the
  //    list-devices handler hung at 15s, GH follow-up). We only parse usb://
  //    lines anyway, so this is both faster (~0.1s) and strictly correct.
  //
  //    GH #771: gated behind `probeUsb`. On macOS `lpinfo` runs the admin-only
  //    CUPS-Get-Devices op and pops the OS authorization dialog, so this only
  //    runs on an explicit user action (Refresh), never on Settings mount.
  if (!probeUsb) return devices;
  try {
    const stdout = await runCupsTool("lpinfo", ["--include-schemes", "usb", "-v"]);
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^\w+\s+(usb:\/\/\S+)$/);
      if (!m) continue;
      const uri = m[1].trim();
      if (seenUris.has(uri)) continue;
      seenUris.add(uri);
      devices.push({
        path: uri,
        friendlyName: prettifyUsbUri(uri),
        looksLikePrinter: PRINTER_PATTERN.test(uri),
      });
    }
  } catch {
    /* lpinfo may need elevated privileges on some Linux distros — the
       installed-queue list above still works; skip silently. */
  }

  return devices;
}

/** "usb://Brother/PT-P710BT?serial=000M…" → "Brother PT-P710BT (USB)". */
function prettifyUsbUri(uri: string): string {
  try {
    const path = uri.replace(/^usb:\/\//i, "").split("?")[0];
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    return parts.length ? `${parts.join(" ")} (USB)` : uri;
  } catch {
    return uri;
  }
}

async function listWindowsPrinters(): Promise<LabelPrinterDevice[]> {
  // Keep `Get-Printer` as the source of the device list (same printer set +
  // names as before) and enrich each row with EnableBIDI from Win32_Printer —
  // `Get-Printer` doesn't surface the bidi flag, but the WMI/CIM class does.
  // The CIM query is best-effort (wrapped in try/catch in PS): if it fails the
  // bidi map stays empty and EnableBIDI reports false for every printer, but
  // the listing itself still works. ConvertTo-Json yields a single object for
  // one printer and an array for many; @(...) forces an array so the shape is
  // predictable.
  const script =
    "$bidi=@{}; " +
    "try { Get-CimInstance Win32_Printer -ErrorAction Stop | " +
    "ForEach-Object { $bidi[$_.Name] = [bool]$_.EnableBIDI } } catch {}; " +
    "@(Get-Printer | ForEach-Object { " +
    "[pscustomobject]@{ Name = $_.Name; EnableBIDI = [bool]$bidi[$_.Name] } }) | " +
    "ConvertTo-Json -Compress";
  const { stdout } = await execFileP(
    windowsPowershellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: EXEC_TIMEOUT_MS },
  );
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((r): r is { Name?: unknown; EnableBIDI?: unknown } => !!r && typeof r === "object")
    .map((r) => ({ name: r.Name, bidi: r.EnableBIDI }))
    .filter((r): r is { name: string; bidi: unknown } => typeof r.name === "string" && r.name.length > 0)
    .map(({ name, bidi }) => ({
      path: name,
      friendlyName: name,
      looksLikePrinter: PRINTER_PATTERN.test(name),
      // Only a definite `true` warns; a missing/non-boolean value stays
      // undefined so a failed CIM probe doesn't show a spurious warning.
      bidiEnabled: typeof bidi === "boolean" ? bidi : undefined,
    }));
}

/**
 * A print target left over from the pre-#588 serialport transport: a macOS
 * `/dev/tty.*` / `/dev/cu.*` path, a Linux `/dev/rfcomm*`, or a Windows `COMn`.
 * None are valid OS print targets now — and a `/dev/...` path would otherwise
 * be mistaken for a CUPS queue name (which can't even contain `/`) and fail
 * obscurely. Detect them so we can prompt the user to reselect. (Codex P2 #589)
 */
function isLegacySerialTarget(target: string): boolean {
  return /^\/dev\//.test(target) || /^COM\d+$/i.test(target);
}

/**
 * Send the raster byte stream to the selected print target. Rejects with a
 * descriptive Error on failure; the IPC handler surfaces it to the renderer.
 */
export async function printLabel(target: string, bytes: Uint8Array): Promise<void> {
  if (isLegacySerialTarget(target)) {
    throw new Error(
      `"${target}" is a serial-port setting from an older version that printed over Bluetooth. ` +
        `The PT-P710BT now prints over USB — open Settings → Label Printer and select your printer again.`,
    );
  }
  if (process.platform === "win32") return printWindows(target, bytes);
  if (isCups()) return printCups(target, bytes);
  throw new Error(`Label printing is not supported on platform "${process.platform}".`);
}

async function printCups(target: string, bytes: Uint8Array): Promise<void> {
  // A `usb://…` target is a raw device → route it through our managed raw
  // queue. Otherwise it's an installed queue name. Only the usb scheme is
  // accepted — it's the only scheme listLabelPrinters ever surfaces — so a
  // stored target with any other scheme (ipp://, file://, …) is refused
  // instead of being forwarded verbatim to `lpadmin -v` (GH #623).
  let queue = target;
  if (/^usb:\/\//i.test(target)) {
    await ensureManagedQueue(target);
    queue = MANAGED_QUEUE;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    throw new Error(
      `Unsupported print target "${target}" — only usb:// devices and installed ` +
        `print queues are supported. Open Settings → Label Printer and select your printer again.`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    // `-o raw` tells CUPS to send the file to the printer unfiltered, so the
    // Brother raster stream reaches the print head verbatim regardless of
    // any driver attached to the queue.
    const child = spawn("lp", ["-d", queue, "-o", "raw"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(new Error(`lp timed out after ${EXEC_TIMEOUT_MS}ms — power-cycle the printer and try again.`));
    }, EXEC_TIMEOUT_MS);

    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => done(e instanceof Error ? e : new Error(String(e))));
    child.on("close", (code) => {
      if (code === 0) done();
      else done(new Error(`lp exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
    // If lp dies before consuming stdin, the write EPIPEs — swallow it so the
    // real exit-code error wins.
    child.stdin?.on("error", () => {});
    child.stdin?.end(Buffer.from(bytes));
  });
}

/**
 * Ensure the hidden raw queue exists and points at `uri`. Idempotent —
 * a no-op when it's already bound correctly.
 */
async function ensureManagedQueue(uri: string): Promise<void> {
  let current: string | null = null;
  try {
    const stdout = await runCupsTool("lpstat", ["-v", MANAGED_QUEUE]);
    const m = stdout.match(/^device for .+?:\s*(.+)$/m);
    current = m ? m[1].trim() : null;
  } catch {
    current = null; // queue doesn't exist yet
  }
  if (current === uri) return;

  // No `-m <model>` → CUPS creates a *raw* queue (no PPD), which is exactly
  // what we want: the raster bytes pass straight through.
  const args = [
    "-p", MANAGED_QUEUE,
    "-v", uri,
    "-E",
    "-D", "Filament DB Label Printer",
    "-o", "printer-is-shared=false",
  ];
  try {
    await runCupsTool("lpadmin", args);
  } catch (err) {
    throw new Error(
      `Could not set up the print queue for ${prettifyUsbUri(uri)}. ` +
        `On Linux you may need to add the printer in your system print settings first. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** win32 `RPC_S_SERVER_UNAVAILABLE`. The winspool APIs are RPC calls to the
 *  Print Spooler service, so when it's stopped or has crashed `OpenPrinter`
 *  (and every later winspool call) fails with this code. */
const WIN32_RPC_S_SERVER_UNAVAILABLE = 1722;

/** Actionable, renderer-ready message for the spooler-down case. Shared by the
 *  PowerShell `OpenPrinter` throw (interpolated into {@link WINDOWS_RAW_PRINT_PS1})
 *  and the {@link printWindows} catch, so the toast text is identical whichever
 *  layer first surfaces it. Kept ASCII-only on purpose: it's embedded in a C#
 *  string literal inside a PowerShell here-string that's written to disk and
 *  re-read, where non-ASCII (em dashes, arrows) can be mangled by the host code
 *  page. Exported for the unit test. */
export const SPOOLER_DOWN_MESSAGE =
  "The Windows Print Spooler service isn't running - restart it (open services.msc, select Print Spooler, and click Start), then try printing again.";

/** Flatten an execFile rejection (its message + any captured stderr) into one
 *  string for pattern matching. PowerShell writes the C# exception to stderr;
 *  execFile also attaches it to the rejection. */
function windowsPrintErrorText(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; stderr?: unknown };
    const msg = typeof e.message === "string" ? e.message : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    return `${msg}\n${stderr}`;
  }
  return String(err);
}

/**
 * Map a raw Windows print-subprocess failure to an actionable message, or
 * `null` when nothing specific applies (caller keeps the original error).
 *
 * Detects the spooler-down case both as the friendly message the PowerShell
 * child already emits for an `OpenPrinter` 1722 AND as the bare win32 code
 * `1722`, which can still surface from a later winspool call or be buried in
 * .NET/PowerShell error noise. Exported for the unit test.
 */
export function mapWindowsPrintError(raw: string): string | null {
  if (!raw) return null;
  if (raw.includes(SPOOLER_DOWN_MESSAGE)) return SPOOLER_DOWN_MESSAGE;
  // Word-boundaried so it matches "(1722)" / "error 1722" but not 17220 etc.
  if (/\b1722\b/.test(raw)) return SPOOLER_DOWN_MESSAGE;
  return null;
}

async function printWindows(printerName: string, bytes: Uint8Array): Promise<void> {
  // The spooler RAW datatype needs the bytes as a file; pass it + the printer
  // name to a P/Invoke script that calls winspool WritePrinter. Use a unique
  // per-call temp dir (mkdtemp) so concurrent prints — e.g. a print + a test
  // print, or two windows — can't collide on the same path, overwrite each
  // other's .bin mid-job, or delete a file the other is still reading.
  // (Codex P2 on PR #589.)
  const dir = await mkdtemp(join(tmpdir(), "fdb-label-"));
  const dataPath = join(dir, "label.bin");
  const scriptPath = join(dir, "print.ps1");
  await writeFile(dataPath, Buffer.from(bytes));
  await writeFile(scriptPath, WINDOWS_RAW_PRINT_PS1, "utf8");
  try {
    await execFileP(
      windowsPowershellPath(),
      [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-PrinterName", printerName,
        "-FilePath", dataPath,
      ],
      { timeout: WINDOWS_PRINT_TIMEOUT_MS },
    );
  } catch (err) {
    // Replace cryptic winspool failures (notably the Print Spooler being down,
    // win32 1722) with an actionable message so the renderer toast is clear;
    // anything we don't recognise rethrows verbatim.
    const friendly = mapWindowsPrintError(windowsPrintErrorText(err));
    throw friendly ? new Error(friendly) : err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** PowerShell that sends a file's bytes to a printer with the spooler RAW
 *  datatype via winspool.drv WritePrinter — the Windows equivalent of
 *  `lp -o raw`. Bypasses the driver's rendering so the Brother raster
 *  stream reaches the print head verbatim.
 *
 *  GH #759 — `EndPagePrinter`/`EndDocPrinter` are the calls that COMMIT the
 *  spool job as "printed". The pre-fix code discarded their bool returns, so a
 *  job that physically printed (WritePrinter succeeded) but failed to commit
 *  still exited 0 → the renderer saw success while the spooler held an
 *  uncommitted job that re-spooled on reboot and blocked the next print. We now
 *  check both returns and throw — but ONLY when the protected body succeeded
 *  (`pageOk`/`docOk` guard the throw), so a teardown after a real WritePrinter
 *  failure doesn't mask the original error. EndPage/EndDoc/Close are still
 *  ALWAYS called in their finallys, so a failed write tears the job down
 *  instead of leaking it open. Exported for the regression test. */
export const WINDOWS_RAW_PRINT_PS1 = `param([Parameter(Mandatory=$true)][string]$PrinterName,
      [Parameter(Mandatory=$true)][string]$FilePath)
$ErrorActionPreference = "Stop"
$code = @"
using System;
using System.Runtime.InteropServices;
public static class FdbRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static void Print(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) {
      int err = Marshal.GetLastWin32Error();
      // win32 1722 (RPC_S_SERVER_UNAVAILABLE) = the Print Spooler service is
      // down - surface the actionable hint instead of the bare code.
      throw new Exception(err == ${WIN32_RPC_S_SERVER_UNAVAILABLE} ? "${SPOOLER_DOWN_MESSAGE}" : "OpenPrinter failed (" + err + ")");
    }
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Filament DB Label"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      bool docOk = false;
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        bool pageOk = false;
        try {
          int written;
          if (!WritePrinter(h, data, data.Length, out written)) throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
          if (written != data.Length) throw new Exception("WritePrinter wrote " + written + " of " + data.Length + " bytes");
          pageOk = true;
        } finally {
          bool endPage = EndPagePrinter(h);
          if (pageOk && !endPage) throw new Exception("EndPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        }
        docOk = true;
      } finally {
        bool endDoc = EndDocPrinter(h);
        if (docOk && !endDoc) throw new Exception("EndDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      }
    } finally { ClosePrinter(h); }
  }
}
"@
Add-Type -TypeDefinition $code -Language CSharp
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[FdbRawPrinter]::Print($PrinterName, $bytes)
`;
