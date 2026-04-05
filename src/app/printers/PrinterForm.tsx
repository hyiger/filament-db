"use client";

import { useEffect, useState, useRef } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

interface Nozzle {
  _id: string;
  name: string;
  diameter: number;
  type: string;
}

interface PrinterFormData {
  name: string;
  manufacturer: string;
  printerModel: string;
  installedNozzles: string[];
  notes: string;
}

interface PrinterInitialData {
  name?: string;
  manufacturer?: string;
  printerModel?: string;
  installedNozzles?: (Nozzle | string)[];
  notes?: string;
}

interface Props {
  initialData?: PrinterInitialData;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}

export default function PrinterForm({ initialData, onSubmit }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PrinterFormData>({
    name: initialData?.name || "",
    manufacturer: initialData?.manufacturer || "",
    printerModel: initialData?.printerModel || "",
    installedNozzles: initialData?.installedNozzles?.map((n: Nozzle | string) =>
      typeof n === "string" ? n : n._id
    ) || [],
    notes: initialData?.notes || "",
  });
  const [nozzles, setNozzles] = useState<Nozzle[]>([]);
  const [nozzlesFetchError, setNozzlesFetchError] = useState(false);
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

  useEffect(() => {
    fetch("/api/nozzles")
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then(setNozzles)
      .catch(() => setNozzlesFetchError(true));
  }, []);

  // Auto-generate name from manufacturer + model (for new printers only)
  const autoGenerateName = (manufacturer: string, printerModel: string) => {
    if (!initialData) {
      const auto = [manufacturer, printerModel].filter(Boolean).join(" ");
      if (auto) return auto;
    }
    return null;
  };

  const updateForm = (updates: Partial<PrinterFormData>) => {
    setForm((f) => ({ ...f, ...updates }));
    setDirty(true);
  };

  const toggleNozzle = (id: string) => {
    setForm((f) => ({
      ...f,
      installedNozzles: f.installedNozzles.includes(id)
        ? f.installedNozzles.filter((n) => n !== id)
        : [...f.installedNozzles, id],
    }));
    setDirty(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      await onSubmit({
        name: form.name,
        manufacturer: form.manufacturer,
        printerModel: form.printerModel,
        installedNozzles: form.installedNozzles,
        notes: form.notes,
      });
      savedRef.current = true;
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent text-gray-900 dark:text-gray-100";
  const labelClass = "block text-sm font-medium mb-1 text-gray-900 dark:text-gray-100";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{t("printers.form.manufacturer")} *</label>
          <input
            className={inputClass}
            value={form.manufacturer}
            onChange={(e) => {
              const manufacturer = e.target.value;
              const autoName = autoGenerateName(manufacturer, form.printerModel);
              updateForm({ manufacturer, ...(autoName != null ? { name: autoName } : {}) });
            }}
            placeholder={t("printers.form.manufacturerPlaceholder")}
            required
          />
        </div>
        <div>
          <label className={labelClass}>{t("printers.form.model")} *</label>
          <input
            className={inputClass}
            value={form.printerModel}
            onChange={(e) => {
              const printerModel = e.target.value;
              const autoName = autoGenerateName(form.manufacturer, printerModel);
              updateForm({ printerModel, ...(autoName != null ? { name: autoName } : {}) });
            }}
            placeholder={t("printers.form.modelPlaceholder")}
            required
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>{t("printers.form.name")} *</label>
        <input
          className={inputClass}
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          placeholder={t("printers.form.namePlaceholder")}
          required
        />
        <p className="text-xs text-gray-500 mt-1">
          {t("printers.form.nameHint")}
        </p>
      </div>

      {nozzlesFetchError && (
        <div className="px-3 py-2 bg-yellow-900/30 border border-yellow-800 rounded text-sm text-yellow-300">
          {t("printers.form.nozzlesLoadError")}
        </div>
      )}

      {nozzles.length > 0 && (
        <div>
          <label className={labelClass}>{t("printers.form.nozzles")}</label>
          <p className="text-xs text-gray-500 mb-2">
            {t("printers.form.nozzlesHint")}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {nozzles.map((n) => (
              <label
                key={n._id}
                className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer text-sm"
              >
                <input
                  type="checkbox"
                  checked={form.installedNozzles.includes(n._id)}
                  onChange={() => toggleNozzle(n._id)}
                  className="w-4 h-4 rounded"
                />
                <span>{n.name}</span>
                <span className="text-gray-500 text-xs">
                  {n.diameter}mm {n.type}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className={labelClass}>{t("printers.form.notes")}</label>
        <textarea
          className={inputClass}
          rows={3}
          value={form.notes}
          onChange={(e) => updateForm({ notes: e.target.value })}
          placeholder={t("printers.form.notesPlaceholder")}
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? t("printers.form.saving") : initialData ? t("printers.form.update") : t("printers.form.create")}
      </button>
    </form>
  );
}
