"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

interface BedTypeFormData {
  name: string;
  material: string;
  notes: string;
}

interface BedTypeInitialData {
  name?: string;
  material?: string;
  notes?: string;
}

interface Props {
  initialData?: BedTypeInitialData;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

const BED_MATERIALS = [
  "PEI",
  "Textured PEI",
  "Spring Steel",
  "Glass",
  "G10/FR4",
  "BuildTak",
  "PEX",
  "Polypropylene",
  "Other",
];

export default function BedTypeForm({ initialData, onSubmit, onDirtyChange }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<BedTypeFormData>({
    name: initialData?.name || "",
    material: initialData?.material || "PEI",
    notes: initialData?.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef(false);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty && !savedRef.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const updateForm = (updates: Partial<BedTypeFormData>) => {
    setForm((f) => ({ ...f, ...updates }));
    setDirty(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      await onSubmit({
        name: form.name,
        material: form.material,
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
  const labelClass = "block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className={labelClass}>{t("bedTypes.form.name")} *</label>
        <input
          className={inputClass}
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          placeholder={t("bedTypes.form.namePlaceholder")}
          required
        />
      </div>

      <div>
        <label className={labelClass}>{t("bedTypes.form.material")} *</label>
        <select
          className={inputClass}
          value={form.material}
          onChange={(e) => updateForm({ material: e.target.value })}
        >
          {BED_MATERIALS.map((mat) => (
            <option key={mat} value={mat}>
              {mat}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelClass}>{t("bedTypes.form.notes")}</label>
        <textarea
          className={inputClass}
          rows={3}
          value={form.notes}
          onChange={(e) => updateForm({ notes: e.target.value })}
          placeholder={t("bedTypes.form.notesPlaceholder")}
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? t("bedTypes.form.saving") : initialData ? t("bedTypes.form.update") : t("bedTypes.form.create")}
      </button>
    </form>
  );
}
