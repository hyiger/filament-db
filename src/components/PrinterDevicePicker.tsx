"use client";

import type { ReactNode } from "react";
import type { LabelPrinterDevice } from "@/types/electron";

/**
 * Presentational device-radio list shared by the two printer pickers
 * (Brother PT-P710BT in LabelPrinterSettings, KNAON Y813BT in
 * TsplPrinterSettings). Extracted rather than duplicated so a future row
 * change — a new badge, a warning, an a11y fix — lands in both pickers or
 * neither; the row markup diverging between the two is exactly the kind of
 * hand-mirroring drift this feature has already been bitten by (GH #1006 F4).
 *
 * Deliberately dumb: the list, the radios, and an optional badge. Loading,
 * persistence, badge SEMANTICS (which devices get badged and what the badge
 * says) and per-row extras (the Windows BiDi warning is Brother-specific)
 * all stay with the owning picker.
 */
interface PrinterDevicePickerProps {
  devices: LabelPrinterDevice[];
  selectedPath: string | null;
  /** Distinct per picker — two radio groups on one page must not merge. */
  radioName: string;
  onPick: (path: string) => void;
  /** Which devices get the badge. The Brother picker uses the transport's
   *  looksLikePrinter; the TSPL picker matches KNAON/Y813 itself. */
  isBadged: (device: LabelPrinterDevice) => boolean;
  badgeLabel: string;
  /** Brother-only today: the Windows BiDi warning + fix button. */
  renderRowExtra?: (device: LabelPrinterDevice) => ReactNode;
}

export default function PrinterDevicePicker({
  devices,
  selectedPath,
  radioName,
  onPick,
  isBadged,
  badgeLabel,
  renderRowExtra,
}: PrinterDevicePickerProps) {
  return (
    <div className="space-y-2">
      {devices.map((d) => {
        const selected = selectedPath === d.path;
        return (
          <label
            key={d.path}
            className={`flex items-start gap-2 p-3 border rounded cursor-pointer ${
              selected
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                : "border-gray-200 dark:border-gray-700"
            }`}
          >
            <input
              type="radio"
              name={radioName}
              checked={selected}
              onChange={() => onPick(d.path)}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {d.friendlyName}
                {isBadged(d) && (
                  <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded">
                    {badgeLabel}
                  </span>
                )}
              </p>
              <code className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                {d.path}
              </code>
              {renderRowExtra?.(d)}
            </div>
          </label>
        );
      })}
    </div>
  );
}
