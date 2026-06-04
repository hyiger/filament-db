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
import { join } from "node:path";

const execFileP = promisify(execFile);

/** Heuristic match for "this printer/device is a PT-series label printer". */
const PRINTER_PATTERN = /pt-?p710bt|p-?touch|brother/i;

/** Name of the hidden raw CUPS queue we manage for raw `usb://` devices
 *  that aren't already installed as a queue. CUPS queue names allow only
 *  letters, digits and underscores. */
const MANAGED_QUEUE = "FilamentDB_Label";

/** Per-subprocess timeout. Listing and a single 24mm label both complete
 *  well under this; the IPC handler wraps the whole print in its own 30s
 *  timeout on top. */
const EXEC_TIMEOUT_MS = 15_000;

/** On Linux a GUI app's PATH often omits /usr/sbin where lpadmin/lpinfo
 *  live, so we try the bare name first then the sbin path. */
const SBIN = "/usr/sbin";

export interface LabelPrinterDevice {
  /** Opaque print target: a CUPS queue name, a `usb://…` device URI, or a
   *  Windows printer name. Passed back to {@link printLabel}. */
  path: string;
  /** Human-readable name for the picker dropdown. */
  friendlyName: string;
  /** True when the target matches a PT-series printer — the picker badges
   *  / pre-selects the obvious choice. */
  looksLikePrinter: boolean;
}

function isCups(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

/**
 * List the printers/devices the OS print system can reach. Never throws —
 * returns [] on any failure so the picker shows its empty state.
 */
export async function listLabelPrinters(): Promise<LabelPrinterDevice[]> {
  try {
    if (process.platform === "win32") return await listWindowsPrinters();
    if (isCups()) return await listCupsPrinters();
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

async function listCupsPrinters(): Promise<LabelPrinterDevice[]> {
  const devices: LabelPrinterDevice[] = [];
  const seenUris = new Set<string>();

  // 1. Installed queues (excluding our own managed one). `lpstat -v` lines
  //    look like: "device for NAME: usb://Brother/PT-P710BT?serial=…".
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
  try {
    const stdout = await runCupsTool("lpinfo", ["-v"]);
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
  // ConvertTo-Json yields a single object for one printer and an array for
  // many; @(...) forces an array so the shape is predictable.
  const script =
    "@(Get-Printer | Select-Object Name) | ConvertTo-Json -Compress";
  const { stdout } = await execFileP(
    "powershell",
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
    .map((r) => (r && typeof r === "object" ? (r as { Name?: string }).Name : undefined))
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map((name) => ({
      path: name,
      friendlyName: name,
      looksLikePrinter: PRINTER_PATTERN.test(name),
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
  // A target containing a scheme ("usb://…") is a raw device → route it
  // through our managed raw queue. Otherwise it's an installed queue name.
  let queue = target;
  if (/^[a-z]+:\/\//i.test(target)) {
    await ensureManagedQueue(target);
    queue = MANAGED_QUEUE;
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
      "powershell",
      [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-PrinterName", printerName,
        "-FilePath", dataPath,
      ],
      { timeout: EXEC_TIMEOUT_MS },
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** PowerShell that sends a file's bytes to a printer with the spooler RAW
 *  datatype via winspool.drv WritePrinter — the Windows equivalent of
 *  `lp -o raw`. Bypasses the driver's rendering so the Brother raster
 *  stream reaches the print head verbatim. */
const WINDOWS_RAW_PRINT_PS1 = `param([Parameter(Mandatory=$true)][string]$PrinterName,
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
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Filament DB Label"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        int written;
        if (!WritePrinter(h, data, data.Length, out written)) throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        if (written != data.Length) throw new Exception("WritePrinter wrote " + written + " of " + data.Length + " bytes");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
Add-Type -TypeDefinition $code -Language CSharp
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[FdbRawPrinter]::Print($PrinterName, $bytes)
`;
