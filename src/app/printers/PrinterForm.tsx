"use client";

import { useEffect, useState, useRef } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";

interface Nozzle {
  _id: string;
  name: string;
  diameter: number;
  type: string;
}

interface AmsSlotEntry {
  _uid: string;
  _id?: string;
  slotName: string;
  filamentId: string | null;
  spoolId: string | null;
}

interface FilamentOption {
  _id: string;
  name: string;
  vendor: string;
  color: string;
  spools?: { _id: string; label: string }[];
}

interface PrinterFormData {
  name: string;
  manufacturer: string;
  printerModel: string;
  installedNozzles: string[];
  notes: string;
  buildVolume: { x: string; y: string; z: string };
  maxFlow: string;
  maxSpeed: string;
  enclosed: boolean;
  autoBedLevel: boolean;
  amsSlots: AmsSlotEntry[];
}

interface PrinterInitialData {
  name?: string;
  manufacturer?: string;
  printerModel?: string;
  installedNozzles?: (Nozzle | string)[];
  notes?: string;
  buildVolume?: { x: number | null; y: number | null; z: number | null };
  maxFlow?: number | null;
  maxSpeed?: number | null;
  enclosed?: boolean;
  autoBedLevel?: boolean;
  amsSlots?: {
    _id?: string;
    slotName: string;
    filamentId: string | { _id: string } | null;
    spoolId: string | null;
  }[];
}

interface Props {
  initialData?: PrinterInitialData;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

function makeUid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `uid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export default function PrinterForm({ initialData, onSubmit, onDirtyChange }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PrinterFormData>({
    name: initialData?.name || "",
    manufacturer: initialData?.manufacturer || "",
    printerModel: initialData?.printerModel || "",
    installedNozzles: initialData?.installedNozzles?.map((n: Nozzle | string) =>
      typeof n === "string" ? n : n._id,
    ) || [],
    notes: initialData?.notes || "",
    buildVolume: {
      x: initialData?.buildVolume?.x?.toString() ?? "",
      y: initialData?.buildVolume?.y?.toString() ?? "",
      z: initialData?.buildVolume?.z?.toString() ?? "",
    },
    maxFlow: initialData?.maxFlow?.toString() ?? "",
    maxSpeed: initialData?.maxSpeed?.toString() ?? "",
    enclosed: initialData?.enclosed ?? false,
    autoBedLevel: initialData?.autoBedLevel ?? false,
    amsSlots: (initialData?.amsSlots || []).map((s) => ({
      _uid: makeUid(),
      _id: s._id,
      slotName: s.slotName,
      filamentId:
        typeof s.filamentId === "string"
          ? s.filamentId
          : s.filamentId?._id ?? null,
      spoolId: s.spoolId ?? null,
    })),
  });
  const [nozzles, setNozzles] = useState<Nozzle[]>([]);
  const [nozzlesFetchError, setNozzlesFetchError] = useState(false);
  const [filamentOptions, setFilamentOptions] = useState<FilamentOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef(false);

  // Warn on unsaved changes when navigating away
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

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/nozzles", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then(setNozzles)
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setNozzlesFetchError(true);
      });
    return () => ac.abort();
  }, []);

  // Lazy-load filament options only when the user actually adds an AMS
  // slot — most printers don't have AMS, so avoid the extra request.
  useEffect(() => {
    if (form.amsSlots.length === 0) return;
    if (filamentOptions.length > 0) return;
    const ac = new AbortController();
    fetch("/api/filaments", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setFilamentOptions)
      .catch(() => {});
    return () => ac.abort();
  }, [form.amsSlots.length, filamentOptions.length]);

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

  const addSlot = () => {
    updateForm({
      amsSlots: [
        ...form.amsSlots,
        {
          _uid: makeUid(),
          slotName: `Slot ${form.amsSlots.length + 1}`,
          filamentId: null,
          spoolId: null,
        },
      ],
    });
  };

  const removeSlot = (uid: string) => {
    updateForm({ amsSlots: form.amsSlots.filter((s) => s._uid !== uid) });
  };

  const updateSlot = (uid: string, patch: Partial<AmsSlotEntry>) => {
    updateForm({
      amsSlots: form.amsSlots.map((s) => (s._uid === uid ? { ...s, ...patch } : s)),
    });
  };

  const parseNum = (s: string): number | null => {
    if (s.trim() === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
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
        buildVolume: {
          x: parseNum(form.buildVolume.x),
          y: parseNum(form.buildVolume.y),
          z: parseNum(form.buildVolume.z),
        },
        maxFlow: parseNum(form.maxFlow),
        maxSpeed: parseNum(form.maxSpeed),
        enclosed: form.enclosed,
        autoBedLevel: form.autoBedLevel,
        amsSlots: form.amsSlots.map((s) => ({
          slotName: s.slotName,
          filamentId: s.filamentId,
          spoolId: s.spoolId,
        })),
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
        <p className="text-xs text-gray-500 mt-1">{t("printers.form.nameHint")}</p>
      </div>

      {/* Expanded printer profile — v1.11 */}
      <fieldset className="border border-gray-300 dark:border-gray-700 rounded p-4">
        <legend className="text-sm font-medium px-2">
          {t("printers.form.profile")}
        </legend>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>{t("printers.form.buildX")}</label>
            <input
              type="number"
              min="0"
              step="1"
              className={inputClass}
              value={form.buildVolume.x}
              onChange={(e) =>
                updateForm({ buildVolume: { ...form.buildVolume, x: e.target.value } })
              }
            />
          </div>
          <div>
            <label className={labelClass}>{t("printers.form.buildY")}</label>
            <input
              type="number"
              min="0"
              step="1"
              className={inputClass}
              value={form.buildVolume.y}
              onChange={(e) =>
                updateForm({ buildVolume: { ...form.buildVolume, y: e.target.value } })
              }
            />
          </div>
          <div>
            <label className={labelClass}>{t("printers.form.buildZ")}</label>
            <input
              type="number"
              min="0"
              step="1"
              className={inputClass}
              value={form.buildVolume.z}
              onChange={(e) =>
                updateForm({ buildVolume: { ...form.buildVolume, z: e.target.value } })
              }
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label className={labelClass}>{t("printers.form.maxFlow")}</label>
            <input
              type="number"
              min="0"
              step="0.1"
              className={inputClass}
              value={form.maxFlow}
              onChange={(e) => updateForm({ maxFlow: e.target.value })}
              placeholder={t("printers.form.maxFlowPlaceholder")}
            />
          </div>
          <div>
            <label className={labelClass}>{t("printers.form.maxSpeed")}</label>
            <input
              type="number"
              min="0"
              step="1"
              className={inputClass}
              value={form.maxSpeed}
              onChange={(e) => updateForm({ maxSpeed: e.target.value })}
              placeholder={t("printers.form.maxSpeedPlaceholder")}
            />
          </div>
        </div>
        <div className="flex items-center gap-4 mt-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.enclosed}
              onChange={(e) => updateForm({ enclosed: e.target.checked })}
              className="w-4 h-4"
            />
            {t("printers.form.enclosed")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.autoBedLevel}
              onChange={(e) => updateForm({ autoBedLevel: e.target.checked })}
              className="w-4 h-4"
            />
            {t("printers.form.autoBedLevel")}
          </label>
        </div>
      </fieldset>

      {/* AMS / MMU slots */}
      <fieldset className="border border-gray-300 dark:border-gray-700 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("printers.form.amsSlots")}</legend>
        <p className="text-xs text-gray-500 mb-3">{t("printers.form.amsSlotsHint")}</p>
        {form.amsSlots.length > 0 && (
          <div className="space-y-2 mb-2">
            {form.amsSlots.map((slot) => {
              const filament = filamentOptions.find((f) => f._id === slot.filamentId);
              return (
                <div key={slot._uid} className="grid grid-cols-12 gap-2 items-center">
                  <input
                    className={`col-span-3 ${inputClass}`}
                    value={slot.slotName}
                    onChange={(e) => updateSlot(slot._uid, { slotName: e.target.value })}
                    placeholder={t("printers.form.amsSlotNamePlaceholder")}
                  />
                  <select
                    className={`col-span-5 ${inputClass}`}
                    value={slot.filamentId ?? ""}
                    onChange={(e) =>
                      updateSlot(slot._uid, {
                        filamentId: e.target.value || null,
                        spoolId: null, // reset spool when filament changes
                      })
                    }
                  >
                    <option value="">{t("printers.form.amsEmpty")}</option>
                    {filamentOptions.map((f) => (
                      <option key={f._id} value={f._id}>
                        {f.name} — {f.vendor}
                      </option>
                    ))}
                  </select>
                  <select
                    className={`col-span-3 ${inputClass}`}
                    value={slot.spoolId ?? ""}
                    onChange={(e) =>
                      updateSlot(slot._uid, { spoolId: e.target.value || null })
                    }
                    disabled={!slot.filamentId || !filament?.spools?.length}
                  >
                    <option value="">{t("printers.form.amsAnySpool")}</option>
                    {filament?.spools?.map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.label || s._id.slice(-4)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeSlot(slot._uid)}
                    className="col-span-1 text-red-500 hover:text-red-700 text-sm"
                    aria-label={t("printers.form.amsRemoveSlot")}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <button
          type="button"
          onClick={addSlot}
          className="text-xs text-blue-600 hover:underline"
        >
          + {t("printers.form.amsAddSlot")}
        </button>
      </fieldset>

      {nozzlesFetchError && (
        <div className="px-3 py-2 bg-yellow-900/30 border border-yellow-800 rounded text-sm text-yellow-300">
          {t("printers.form.nozzlesLoadError")}
        </div>
      )}

      {nozzles.length > 0 && (
        <div>
          <label className={labelClass}>{t("printers.form.nozzles")}</label>
          <p className="text-xs text-gray-500 mb-2">{t("printers.form.nozzlesHint")}</p>
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
