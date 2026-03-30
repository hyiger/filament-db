"use client";

import { useEffect, useState } from "react";

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

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialData?: any;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}

export default function PrinterForm({ initialData, onSubmit }: Props) {
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

  const toggleNozzle = (id: string) => {
    setForm((f) => ({
      ...f,
      installedNozzles: f.installedNozzles.includes(id)
        ? f.installedNozzles.filter((n) => n !== id)
        : [...f.installedNozzles, id],
    }));
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
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 rounded text-sm bg-transparent";
  const labelClass = "block text-sm font-medium mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Manufacturer *</label>
          <input
            className={inputClass}
            value={form.manufacturer}
            onChange={(e) => {
              const manufacturer = e.target.value;
              const autoName = autoGenerateName(manufacturer, form.printerModel);
              setForm({ ...form, manufacturer, ...(autoName != null ? { name: autoName } : {}) });
            }}
            placeholder="e.g. Prusa, Bambu Lab"
            required
          />
        </div>
        <div>
          <label className={labelClass}>Model *</label>
          <input
            className={inputClass}
            value={form.printerModel}
            onChange={(e) => {
              const printerModel = e.target.value;
              const autoName = autoGenerateName(form.manufacturer, printerModel);
              setForm({ ...form, printerModel, ...(autoName != null ? { name: autoName } : {}) });
            }}
            placeholder="e.g. Core One, X1C"
            required
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>Name *</label>
        <input
          className={inputClass}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Auto-generated from manufacturer + model"
          required
        />
        <p className="text-xs text-gray-500 mt-1">
          Auto-generated from manufacturer and model. Edit to customize.
        </p>
      </div>

      {nozzlesFetchError && (
        <div className="px-3 py-2 bg-yellow-900/30 border border-yellow-800 rounded text-sm text-yellow-300">
          Could not load nozzles. Check that the server is running and try again.
        </div>
      )}

      {nozzles.length > 0 && (
        <div>
          <label className={labelClass}>Installed Nozzles</label>
          <p className="text-xs text-gray-500 mb-2">
            Select the nozzles installed or available for this printer.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {nozzles.map((n) => (
              <label
                key={n._id}
                className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-800 cursor-pointer text-sm"
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
        <label className={labelClass}>Notes</label>
        <textarea
          className={inputClass}
          rows={3}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Optional notes about this printer..."
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving..." : initialData ? "Update Printer" : "Create Printer"}
      </button>
    </form>
  );
}
