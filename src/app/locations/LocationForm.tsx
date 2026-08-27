"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

interface LocationFormData {
  name: string;
  kind: string;
  humidity: string;
  /** `<input type="date">` value — "YYYY-MM-DD" or "" for unset. */
  desiccantChangedAt: string;
  notes: string;
}

interface LocationInitialData {
  name?: string;
  kind?: string;
  humidity?: number | null;
  desiccantChangedAt?: string | null;
  notes?: string;
}

interface Props {
  initialData?: LocationInitialData;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

// Common kinds shown in the dropdown. The underlying field is free-form
// so users with unusual layouts can type anything they want.
const LOCATION_KINDS = [
  { value: "shelf", labelKey: "locations.kind.shelf" },
  { value: "drybox", labelKey: "locations.kind.drybox" },
  { value: "cabinet", labelKey: "locations.kind.cabinet" },
  { value: "printer", labelKey: "locations.kind.printer" },
  { value: "other", labelKey: "locations.kind.other" },
];

export default function LocationForm({ initialData, onSubmit, onDirtyChange }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<LocationFormData>({
    name: initialData?.name || "",
    kind: initialData?.kind || "shelf",
    humidity: initialData?.humidity != null ? String(initialData.humidity) : "",
    // `<input type="date">` wants bare YYYY-MM-DD; the API returns a full
    // ISO timestamp. Slice rather than going through Date, which would
    // shift the calendar day for anyone west of UTC.
    desiccantChangedAt: initialData?.desiccantChangedAt
      ? initialData.desiccantChangedAt.slice(0, 10)
      : "",
    notes: initialData?.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef(false);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty && !savedRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const updateForm = (updates: Partial<LocationFormData>) => {
    setForm((f) => ({ ...f, ...updates }));
    setDirty(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const humidityNum = form.humidity.trim() === "" ? null : Number(form.humidity);
    try {
      await onSubmit({
        name: form.name,
        kind: form.kind,
        humidity:
          humidityNum != null && Number.isFinite(humidityNum) ? humidityNum : null,
        desiccantChangedAt: form.desiccantChangedAt.trim() === ""
          ? null
          : form.desiccantChangedAt,
        notes: form.notes,
      });
      savedRef.current = true;
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm dark:text-gray-100 bg-transparent";
  // GH #711: a <select> needs an explicit dark background so its native option
  // popup follows dark mode — a transparent bg makes the popup render
  // light-on-white. Text inputs keep bg-transparent (they have no popup).
  const selectClass = inputClass.replace("bg-transparent", "bg-white dark:bg-gray-900");
  const labelClass =
    "block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className={labelClass} htmlFor="location-name">
          {t("locations.form.name")} *
        </label>
        <input
          id="location-name"
          className={inputClass}
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          placeholder={t("locations.form.namePlaceholder")}
          required
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="location-kind">
          {t("locations.form.kind")}
        </label>
        <select
          id="location-kind"
          className={selectClass}
          value={form.kind}
          onChange={(e) => updateForm({ kind: e.target.value })}
        >
          {LOCATION_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {t(k.labelKey)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="location-humidity" className={labelClass}>{t("locations.form.humidity")}</label>
        <input
          id="location-humidity"
          type="number"
          min="0"
          max="100"
          step="any"
          className={inputClass}
          value={form.humidity}
          onChange={(e) => updateForm({ humidity: e.target.value })}
          placeholder={t("locations.form.humidityPlaceholder")}
        />
        <p className="text-xs text-gray-400 mt-1">{t("locations.form.humidityHint")}</p>
      </div>

      <div>
        <label htmlFor="location-desiccant" className={labelClass}>
          {t("locations.form.desiccantChangedAt")}
        </label>
        <input
          id="location-desiccant"
          type="date"
          className={inputClass}
          value={form.desiccantChangedAt}
          onChange={(e) => updateForm({ desiccantChangedAt: e.target.value })}
        />
        <p className="text-xs text-gray-400 mt-1">
          {t("locations.form.desiccantChangedAtHint")}
        </p>
      </div>

      <div>
        <label className={labelClass} htmlFor="location-notes">
          {t("locations.form.notes")}
        </label>
        <textarea
          id="location-notes"
          className={inputClass}
          rows={3}
          value={form.notes}
          onChange={(e) => updateForm({ notes: e.target.value })}
          placeholder={t("locations.form.notesPlaceholder")}
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {saving
          ? t("locations.form.saving")
          : initialData
            ? t("locations.form.update")
            : t("locations.form.create")}
      </button>
    </form>
  );
}
