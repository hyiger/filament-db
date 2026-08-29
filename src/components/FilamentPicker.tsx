"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import FilamentSwatch from "@/components/FilamentSwatch";
import { deriveArrangement } from "@/lib/filamentColors";
import { deriveFinish } from "@/lib/filamentFinish";

/**
 * Shared filament picker used by /compare and /share — a checkbox list
 * with search / type filter / selected-only affordances matching the main
 * filament list page's UX.
 */

interface PickerFilament {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  /** Nullable per OpenPrintTag key 19 — a coextruded filament's colors
   *  live in `secondaryColors`, and a template parent is deliberately
   *  colorless. Typing this `string` renders those rows with a
   *  transparent dot (GH #1120). */
  color: string | null;
  secondaryColors?: string[];
  optTags?: number[];
}

interface FilamentPickerProps {
  /** Full catalog. The picker filters in-memory; callers don't
   *  pre-filter. */
  filaments: PickerFilament[];
  selectedIds: Set<string>;
  /** Caller owns the selection state — the picker is purely a
   *  controlled view. */
  onToggle: (id: string) => void;
  /** When set, additional selections beyond this cap are disabled.
   *  /compare passes 8 (the comparison table caps at 8 columns). */
  maxSelections?: number;
  /** Falls back to a generic label via picker.listAriaLabel. */
  ariaLabel?: string;
}

/** Show the controls only when there are enough filaments that scrolling
 *  becomes painful — the chrome is meaningless on a tiny list. */
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

  // Distinct filament types for the chip row, most-common first.
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
  // The selected-only toggle hides when there are no selections, but if
  // `showSelectedOnly` was true when the last selection got removed
  // (manual unchecks, /share's publish handler clearing selectedIds) the
  // filter would keep applying with no way to turn it off. Deriving the
  // *effective* value at render time makes the empty-selection case fall
  // back to "show everything" regardless of the persisted toggle state.
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
          role="group"
          aria-label={t("picker.typeFilterAriaLabel")}
        >
          <button
            type="button"
            aria-pressed={typeFilter === null}
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
              aria-pressed={typeFilter === type}
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
                // The row is genuinely `disabled`, so the click never reaches
                // onToggle and the caller can't explain the no-op itself.
                title={isDisabled ? t("picker.capReached", { max: maxSelections }) : undefined}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(f._id)}
                  disabled={isDisabled}
                  className="w-4 h-4"
                />
                {/* aria-hidden wrapper: FilamentSwatch always emits
                    role="img" with a colour label, and this sits INSIDE the
                    checkbox's <label> — so without this the colour becomes
                    part of every row's accessible name ("#ff0000, Prusament
                    PLA") in both the compare and share pickers. The colour is
                    decorative here; the row is identified by its name, vendor
                    and type. (The compare TABLE avoids this differently, by
                    placing the swatch outside the link.) */}
                <span aria-hidden="true" className="flex-shrink-0">
                  <FilamentSwatch
                    color={f.color}
                    secondaryColors={f.secondaryColors}
                    arrangement={deriveArrangement(f.optTags)}
                    finish={deriveFinish(f.optTags)}
                    size={16}
                  />
                </span>
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
      {capReached && (
        <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
          {t("picker.capReached", { max: maxSelections })}
        </p>
      )}
    </div>
  );
}
