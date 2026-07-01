"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

/**
 * Shared filament picker (#492) used by /compare and /share. Wraps the
 * shared scroll-only checkbox list with search / type filter / selected-
 * only / selected-count affordances that match the main filament list
 * page's UX. Below 12 filaments the controls render but stay invisible
 * because they don't earn their pixels yet; above that the user gets
 * the same find-as-you-type experience as elsewhere in the app.
 */

interface PickerFilament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
}

interface FilamentPickerProps {
  /** Full catalog. The picker filters this in-memory; callers don't
   *  need to pre-filter. */
  filaments: PickerFilament[];
  /** Set of currently-selected filament _ids. Set is fine because the
   *  callers track selections that way already and it gives O(1) check. */
  selectedIds: Set<string>;
  /** Called when the user toggles any row. Caller owns the selection
   *  state — the picker is purely a controlled view. */
  onToggle: (id: string) => void;
  /** When set, additional selections beyond this cap are disabled.
   *  /compare passes 8 (the comparison table caps at 8 columns). */
  maxSelections?: number;
  /** Optional ARIA label for the picker. Falls back to a generic
   *  "Filaments" label via picker.listAriaLabel if you don't want
   *  callers to plumb a custom one. */
  ariaLabel?: string;
}

/** Show the controls (search / type filter / selected-only toggle)
 *  only when there are enough filaments that scrolling becomes
 *  painful. 12 is roughly two scrolls in the 240-pixel list height
 *  both callers use today. */
const CONTROL_THRESHOLD = 12;

export default function FilamentPicker({
  filaments,
  selectedIds,
  onToggle,
  maxSelections,
  ariaLabel,
}: FilamentPickerProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);

  // Distinct filament types for the chip row, sorted by frequency
  // descending so the most-common types surface first. Empty / null
  // types are filtered out (they wouldn't be useful as a chip).
  const typeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of filaments) {
      if (!f.type) continue;
      counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type]) => type);
  }, [filaments]);

  const selectedCount = selectedIds.size;
  // Codex P2 round 1 on PR #497: the selected-only toggle hides when
  // there are no selections (the chrome is meaningless without any),
  // but if `showSelectedOnly` was true when the last selection got
  // removed (manual unchecks, /share's publish handler clearing
  // selectedIds, etc.) the filter kept applying with no way to turn
  // it off. Derive the *effective* value at render time so the empty-
  // selection case automatically falls back to "show everything"
  // regardless of the persisted toggle state. Same pattern PR #487's
  // PrintLabelDialog uses for its QR-mode fallback.
  const effectiveSelectedOnly = showSelectedOnly && selectedCount > 0;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return filaments.filter((f) => {
      if (typeFilter && f.type !== typeFilter) return false;
      if (effectiveSelectedOnly && !selectedIds.has(f._id)) return false;
      if (needle) {
        const hay = `${f.name} ${f.vendor} ${f.type} ${f.color}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [filaments, search, typeFilter, effectiveSelectedOnly, selectedIds]);

  const showControls = filaments.length >= CONTROL_THRESHOLD;
  const capReached =
    maxSelections != null && selectedCount >= maxSelections;

  return (
    <div className="space-y-2">
      {showControls && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("picker.searchPlaceholder")}
            aria-label={t("picker.searchAriaLabel")}
            className="flex-1 min-w-[12rem] px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-transparent"
          />
          {selectedCount > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showSelectedOnly}
                onChange={(e) => setShowSelectedOnly(e.target.checked)}
                className="w-3.5 h-3.5"
              />
              {t("picker.showSelectedOnly", { count: selectedCount })}
            </label>
          )}
        </div>
      )}
      {showControls && typeOptions.length > 1 && (
        <div
          className="flex flex-wrap gap-1"
          role="tablist"
          aria-label={t("picker.typeFilterAriaLabel")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={typeFilter === null}
            onClick={() => setTypeFilter(null)}
            className={`px-2 py-0.5 text-xs rounded-full border ${
              typeFilter === null
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
                : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            {t("picker.allTypes")}
          </button>
          {typeOptions.map((type) => (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={typeFilter === type}
              onClick={() =>
                setTypeFilter((current) => (current === type ? null : type))
              }
              className={`px-2 py-0.5 text-xs rounded-full border ${
                typeFilter === type
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
                  : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      )}
      <div
        className="max-h-60 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded"
        role="group"
        aria-label={ariaLabel ?? t("picker.listAriaLabel")}
      >
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-xs text-gray-500 dark:text-gray-400 text-center">
            {effectiveSelectedOnly
              ? t("picker.noSelectedMatches")
              : search || typeFilter
                ? t("picker.noMatches")
                : t("picker.empty")}
          </p>
        ) : (
          filtered.map((f) => {
            const isSelected = selectedIds.has(f._id);
            const isDisabled = !isSelected && capReached;
            return (
              <label
                key={f._id}
                className={`flex items-center gap-3 px-3 py-1.5 border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-900 text-sm ${
                  isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(f._id)}
                  disabled={isDisabled}
                  className="w-4 h-4"
                />
                <span
                  className="inline-block w-4 h-4 rounded-full border border-gray-300 flex-shrink-0"
                  style={{ backgroundColor: f.color }}
                  aria-hidden="true"
                />
                <span className="flex-1 min-w-0 truncate">{f.name}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                  {f.vendor}
                  {f.type ? ` · ${f.type}` : ""}
                </span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
