"use client";

import type { ReactNode } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

export type QuickFilter = "all" | "lowStock" | "hasSpools" | "noCalibration";

interface Props {
  active: QuickFilter;
  onChange: (f: QuickFilter) => void;
  counts?: Partial<Record<QuickFilter, number>>;
  /**
   * Extra control(s) rendered inline at the END of the chip row (e.g. the
   * "show out of stock" toggle). Kept inside this flex row — rather than as a
   * sibling next to the component — so the control shares the chips' size,
   * gap, and vertical baseline instead of misaligning against the row's margin.
   */
  trailing?: ReactNode;
}

const FILTERS: { key: QuickFilter; labelKey: string }[] = [
  { key: "all", labelKey: "filaments.quickFilter.all" },
  { key: "lowStock", labelKey: "filaments.quickFilter.lowStock" },
  { key: "hasSpools", labelKey: "filaments.quickFilter.hasSpools" },
  { key: "noCalibration", labelKey: "filaments.quickFilter.noCalibration" },
];

/**
 * Chip row above the filament list for one-click filtering. Kept in a
 * dedicated component so the main list file stays readable and the chips
 * can be reused on the dashboard later.
 */
export default function QuickFilterChips({ active, onChange, counts, trailing }: Props) {
  const { t } = useTranslation();
  return (
    // Outer row carries the trailing toggle as a SIBLING of the tablist — the
    // toggle is an aria-pressed control, not a tab, so it must not live inside
    // the role="tablist" (which may only own role="tab" children). They share
    // this flex row, so the toggle still matches the chips' size + baseline.
    <div className="flex flex-wrap items-center gap-1.5 mb-2">
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t("filter.aria.quick")}>
        {FILTERS.map((f) => {
          const isActive = active === f.key;
          const count = counts?.[f.key];
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(f.key)}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                isActive
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-transparent text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
              }`}
            >
              {t(f.labelKey)}
              {count !== undefined && count > 0 && (
                <span
                  className={`ml-1.5 text-[10px] px-1 rounded ${
                    isActive ? "bg-white/20" : "bg-gray-200 dark:bg-gray-700"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}
