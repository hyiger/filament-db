"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

interface LocationFormData {
  name: string;
  kind: string;
  humidity: string;
  notes: string;
}

interface LocationInitialData {
  name?: string;
  kind?: string;
  humidity?: number | null;
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
  const labelClass =
    "block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className={labelClass}>{t("locations.form.name")} *</label>
        <input
          className={inputClass}
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          placeholder={t("locations.form.namePlaceholder")}
          required
        />
      </div>

      <div>
        <label className={labelClass}>{t("locations.form.kind")}</label>
        <select
          className={inputClass}
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
        <label className={labelClass}>{t("locations.form.humidity")}</label>
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          className={inputClass}
          value={form.humidity}
          onChange={(e) => updateForm({ humidity: e.target.value })}
          placeholder={t("locations.form.humidityPlaceholder")}
        />
        <p className="text-xs text-gray-400 mt-1">{t("locations.form.humidityHint")}</p>
      </div>

      <div>
        <label className={labelClass}>{t("locations.form.notes")}</label>
        <textarea
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
