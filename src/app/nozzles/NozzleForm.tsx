"use client";

import { useState } from "react";

interface NozzleFormData {
  name: string;
  diameter: string;
  type: string;
  highFlow: boolean;
  hardened: boolean;
  notes: string;
}

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialData?: any;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
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

export default function NozzleForm({ initialData, onSubmit }: Props) {
  const [form, setForm] = useState<NozzleFormData>({
    name: initialData?.name || "",
    diameter: initialData?.diameter?.toString() || "0.4",
    type: initialData?.type || "Brass",
    highFlow: initialData?.highFlow || false,
    hardened: initialData?.hardened || false,
    notes: initialData?.notes || "",
  });
  const [saving, setSaving] = useState(false);

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
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 rounded text-sm bg-transparent";
  const labelClass = "block text-sm font-medium mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className={labelClass}>Name *</label>
        <input
          className={inputClass}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. CoreOne 0.4 Brass"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Diameter (mm) *</label>
          <input
            className={inputClass}
            type="number"
            step="any"
            min="0.01"
            max="10"
            list="common-diameters"
            value={form.diameter}
            onChange={(e) => setForm({ ...form, diameter: e.target.value })}
            placeholder="e.g. 0.4"
            required
          />
          <datalist id="common-diameters">
            {COMMON_DIAMETERS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </div>
        <div>
          <label className={labelClass}>Type *</label>
          <select
            className={inputClass}
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            {NOZZLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
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
          onChange={(e) => setForm({ ...form, highFlow: e.target.checked })}
          className="w-4 h-4"
        />
        <label htmlFor="highFlow" className="text-sm font-medium">
          High Flow nozzle
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="hardened"
          checked={form.hardened}
          onChange={(e) => setForm({ ...form, hardened: e.target.checked })}
          className="w-4 h-4"
        />
        <label htmlFor="hardened" className="text-sm font-medium">
          Hardened nozzle
        </label>
      </div>

      <div>
        <label className={labelClass}>Notes</label>
        <textarea
          className={inputClass}
          rows={3}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Optional notes about this nozzle..."
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving..." : initialData ? "Update Nozzle" : "Create Nozzle"}
      </button>
    </form>
  );
}
