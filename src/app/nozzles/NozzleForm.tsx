"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

interface NozzleFormData {
  name: string;
  diameter: string;
  type: string;
  highFlow: boolean;
  hardened: boolean;
  notes: string;
}

interface NozzleInitialData {
  name?: string;
  diameter?: number;
  type?: string;
  highFlow?: boolean;
  hardened?: boolean;
  notes?: string;
}

interface Props {
  initialData?: NozzleInitialData;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

const NOZZLE_TYPES = [
  "Brass",
  "Hardened Steel",
  "Stainless Steel",
  "Copper",
  "Ruby Tipped",
  "Tungsten Carbide",
  "ObXidian",
  "Diamondback",
  "Other",
];

const COMMON_DIAMETERS = ["0.1", "0.15", "0.2", "0.25", "0.3", "0.35", "0.4", "0.5", "0.6", "0.7", "0.8", "1.0", "1.2", "1.4", "1.6", "1.8", "2.0"];

export default function NozzleForm({ initialData, onSubmit, onDirtyChange }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<NozzleFormData>({
    name: initialData?.name || "",
    diameter: initialData?.diameter?.toString() || "0.4",
    type: initialData?.type || "Brass",
    highFlow: initialData?.highFlow || false,
    hardened: initialData?.hardened || false,
    notes: initialData?.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef(false);

  // Warn on unsaved changes when navigating away
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty && !savedRef.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Notify parent of dirty state changes
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const updateForm = (updates: Partial<NozzleFormData>) => {
    setForm((f) => ({ ...f, ...updates }));
    setDirty(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    const diameter = parseFloat(form.diameter);
    if (isNaN(diameter) || diameter <= 0) {
      setSaving(false);
      return;
    }

    try {
      await onSubmit({
        name: form.name,
        diameter,
        type: form.type,
        highFlow: form.highFlow,
        hardened: form.hardened,
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
        <label className={labelClass}>{t("nozzles.form.name")} *</label>
        <input
          className={inputClass}
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          placeholder={t("nozzles.form.namePlaceholder")}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{t("nozzles.form.diameter")} *</label>
          <input
            className={inputClass}
            type="number"
            step="any"
            min="0.01"
            max="10"
            list="common-diameters"
            value={form.diameter}
            onChange={(e) => updateForm({ diameter: e.target.value })}
            placeholder={t("nozzles.form.diameterPlaceholder")}
            required
          />
          <datalist id="common-diameters">
            {COMMON_DIAMETERS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </div>
        <div>
          <label className={labelClass}>{t("nozzles.form.type")} *</label>
          <select
            className={inputClass}
            value={form.type}
            onChange={(e) => updateForm({ type: e.target.value })}
          >
            {NOZZLE_TYPES.map((ntype) => (
              <option key={ntype} value={ntype}>
                {ntype}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="highFlow"
          checked={form.highFlow}
          onChange={(e) => updateForm({ highFlow: e.target.checked })}
          className="w-4 h-4"
        />
        <label htmlFor="highFlow" className="text-sm font-medium">
          {t("nozzles.form.highFlow")}
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="hardened"
          checked={form.hardened}
          onChange={(e) => updateForm({ hardened: e.target.checked })}
          className="w-4 h-4"
        />
        <label htmlFor="hardened" className="text-sm font-medium">
          {t("nozzles.form.hardened")}
        </label>
      </div>

      <div>
        <label className={labelClass}>{t("nozzles.form.notes")}</label>
        <textarea
          className={inputClass}
          rows={3}
          value={form.notes}
          onChange={(e) => updateForm({ notes: e.target.value })}
          placeholder={t("nozzles.form.notesPlaceholder")}
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? t("nozzles.form.saving") : initialData ? t("nozzles.form.update") : t("nozzles.form.create")}
      </button>
    </form>
  );
}
