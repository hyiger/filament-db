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
export function printLabel(
  devicePath: string,
  bytes: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    let port: SerialPort | null = null;
    try {
      port = new SerialPort(
        {
          path: devicePath,
          baudRate: 9600,
          autoOpen: false,
        },
        (err) => {
          // SerialPort's constructor takes an optional open callback,
          // but we want to control timing — use autoOpen: false and call
          // .open() below. This handler fires only on constructor errors.
          if (err) settle(err);
        },
      );
    } catch (err) {
      settle(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!port) return; // settle() already called

    const p = port;
    p.open((openErr) => {
      if (openErr) {
        settle(openErr);
        return;
      }
      // Surface any post-open error (USB disconnect, BT drop, etc.)
      // so the caller doesn't hang on a silent failure.
      p.on("error", settle);
      p.write(Buffer.from(bytes), (writeErr) => {
        if (writeErr) {
          settle(writeErr);
          return;
        }
        p.drain((drainErr) => {
          if (drainErr) {
            settle(drainErr);
            return;
          }
          p.close((closeErr) => {
            settle(closeErr ?? null);
          });
        });
      });
    });
  });
}
