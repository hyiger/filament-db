/**
 * Brother PT-P710BT label-printer transport for the Electron main
 * process.
 *
 * The printer pairs with the OS as a Bluetooth Classic SPP/RFCOMM
 * device. After pairing, the OS surfaces it as a serial-port path:
 *   - macOS:   /dev/tty.PT-P710BT-XXXX-Serialport
 *   - Linux:   /dev/rfcomm0 (after `rfcomm bind`)
 *   - Windows: COM3+ (auto-assigned outgoing port)
 *
 * Using `serialport` lets us pretend the printer is a plain UART and
 * avoids per-OS Bluetooth APIs. The bind/pairing flow stays in System
 * Settings; this module only opens an already-paired device path,
 * writes the byte stream, drains, and closes.
 *
 * The byte stream itself is produced by `src/lib/labelEncoder.ts` —
 * this file is transport only.
 */

import { SerialPort } from "serialport";

/** Heuristic match for "this serial port looks like a PT-P710BT". OS
 *  Bluetooth stacks differ on the exact path/manufacturer fields they
 *  expose, so we sweep across friendly name, path, and manufacturer
 *  with a single regex. */
const PT_P710BT_PATTERN = /pt-?p710bt|p-?touch/i;

export interface LabelPrinterDevice {
  /** OS-assigned device path to pass to `printLabel`. */
  path: string;
  /** Human-readable name for the picker dropdown. Falls back to `path`
   *  when the OS doesn't surface a friendly name. */
  friendlyName: string;
  /** True when our heuristic thinks this is a PT-series printer. The
   *  picker UI uses this to pre-select the obvious choice; the user
   *  can still manually pick any port. */
  looksLikePrinter: boolean;
}

/**
 * List every serial port the OS has paired/exposed. Doesn't filter —
 * the picker UI presents all of them and badges the ones whose
 * friendly name/path matches a PT-series printer.
 *
 * Returns [] if `SerialPort.list()` throws (driver missing, permission
 * denied, etc.) — the picker shows an empty state with a tip about
 * pairing in System Settings.
 */
export async function listLabelPrinters(): Promise<LabelPrinterDevice[]> {
  try {
    const ports = await SerialPort.list();
    return ports.map((p) => {
      const friendly =
        // serialport surfaces different fields per OS — try the most
        // likely candidates in priority order.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p as any).friendlyName ||
        (p as { manufacturer?: string }).manufacturer ||
        p.path;
      const haystack = `${friendly} ${p.path} ${p.manufacturer ?? ""}`;
      return {
        path: p.path,
        friendlyName: friendly,
        looksLikePrinter: PT_P710BT_PATTERN.test(haystack),
      };
    });
  } catch (err) {
    console.error("[label-printer] SerialPort.list failed:", err);
    return [];
  }
}

/**
 * Open the given serial-port path, write the byte stream, drain, and
 * close. Rejects with a descriptive Error on any step; the IPC handler
 * surfaces the message to the renderer for a toast.
 *
 * SPP/RFCOMM ignores the baud rate but the serialport API requires
 * one; 9600 is the conventional placeholder.
 */
/** Hard ceiling on a single print operation. Bluetooth Classic SPP
 *  writes for a typical 24mm label complete in ≤5s; 25s leaves ample
 *  headroom for a long-label slow-flush case and stays inside the IPC
 *  timeout (30s in electron/main.ts) so the transport's own cleanup
 *  fires before the IPC race rejects. The Codex round 5 catch (PR #487)
 *  was that the IPC timeout alone doesn't close the port — the
 *  underlying operation keeps running on a stalled SerialPort handle
 *  and the next print sees "port busy". This timer is the in-transport
 *  cleanup that fixes that. */
const PRINT_TIMEOUT_MS = 25_000;

export function printLabel(
  devicePath: string,
  bytes: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port: SerialPort | null = null;

    // Always route any failure through cleanup: close the port (if
    // open) before rejecting so a Bluetooth drop / write failure /
    // drain failure / stall doesn't leave the OS handle open and
    // block the next print attempt as "port busy". (Codex P2 rounds
    // 4-6 on PR #487.)
    const settleWithCleanup = (err: Error | null) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      const p = port;
      if (p && p.isOpen) {
        p.close((closeErr) => {
          // Prefer the original error if there was one — closeErr on
          // an already-broken port is just noise.
          if (err) reject(err);
          else if (closeErr) reject(closeErr);
          else resolve();
        });
      } else {
        if (err) reject(err);
        else resolve();
      }
    };

    // Arm the stall watchdog BEFORE calling .open() so a stalled
    // RFCOMM driver in the open phase also gets caught. Round 5 only
    // armed it inside the open callback, which round 6 caught as a
    // gap — open() itself can hang forever on a flaky Bluetooth
    // stack. (Codex P2 round 6 on PR #487.)
    let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      settleWithCleanup(
        new Error(
          `Print stalled — no progress in ${PRINT_TIMEOUT_MS}ms. ` +
            `Power-cycle the printer and try again.`,
        ),
      );
    }, PRINT_TIMEOUT_MS);

    try {
      port = new SerialPort(
        {
          path: devicePath,
          baudRate: 9600,
          autoOpen: false,
        },
        (err) => {
          // SerialPort's constructor takes an optional open callback, but
          // with autoOpen:false it is NOT forwarded — the callback is only
          // wired to the implicit open when autoOpen is on. A bad path /
          // options THROWS synchronously and is caught by the try/catch
          // below instead. This handler is therefore defensive only (it
          // won't fire under autoOpen:false); the real constructor-error
          // path is the catch block. Kept as belt-and-braces in case a
          // future serialport version changes the contract.
          if (err) settleWithCleanup(err);
        },
      );
    } catch (err) {
      settleWithCleanup(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!port) return; // settleWithCleanup already called

    const p = port;
    p.open((openErr) => {
      // Belt and braces: if the timer already fired while open() was
      // hung, this callback can still arrive later. If we're already
      // settled, the only cleanup left is to close any handle that
      // open() did eventually acquire so it doesn't leak.
      if (settled) {
        if (!openErr && p.isOpen) {
          p.close(() => {
            /* best-effort; the caller already saw the timeout error */
          });
        }
        return;
      }
      if (openErr) {
        // open() failure — settle through the same path for consistency.
        settleWithCleanup(openErr);
        return;
      }
      // Surface any post-open error (USB disconnect, BT drop, etc.)
      // through the cleanup path so a stale handle can't linger.
      p.on("error", (err) => settleWithCleanup(err));
      p.write(Buffer.from(bytes), (writeErr) => {
        if (writeErr) {
          settleWithCleanup(writeErr);
          return;
        }
        p.drain((drainErr) => {
          if (drainErr) {
            settleWithCleanup(drainErr);
            return;
          }
          // Happy path — close + resolve.
          settleWithCleanup(null);
        });
      });
    });
  });
}
