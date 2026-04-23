"use client";

import { useTranslation } from "@/i18n/TranslationProvider";

export type QuickFilter = "all" | "lowStock" | "hasSpools" | "noCalibration";

interface Props {
  active: QuickFilter;
  onChange: (f: QuickFilter) => void;
  counts?: Partial<Record<QuickFilter, number>>;
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
export default function QuickFilterChips({ active, onChange, counts }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5 mb-2" role="tablist" aria-label="Quick filters">
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
  );
}
