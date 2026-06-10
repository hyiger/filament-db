"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { NozzleConflictError, type NozzleConflict } from "@/lib/nozzleConflicts";

interface Nozzle {
  _id: string;
  name: string;
  diameter: number;
  type: string;
  /** GH #232 — server-side enrichment in /api/nozzles GET. Each entry is
   * a printer that currently has this nozzle in its installedNozzles. */
  printers?: { _id: string; name: string }[];
}

interface BedTypeOption {
  _id: string;
  name: string;
  material: string;
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
  installedBedTypes: string[];
  notes: string;
  buildVolume: { x: string; y: string; z: string };
  maxFlow: string;
  maxSpeed: string;
  enclosed: boolean;
  autoBedLevel: boolean;
  amsSlots: AmsSlotEntry[];
}

interface PrinterInitialData {
  /** GH #232 — present on edit (the route returns `_id` via .lean());
   * absent on create. Used to filter "in use by another printer" from
   * "in use by this printer" when rendering the inline conflict badge. */
  _id?: string;
  name?: string;
  manufacturer?: string;
  printerModel?: string;
  installedNozzles?: (Nozzle | string)[];
  installedBedTypes?: (BedTypeOption | string)[];
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
    installedBedTypes: initialData?.installedBedTypes?.map((b: BedTypeOption | string) =>
      typeof b === "string" ? b : b._id,
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
  const [bedTypes, setBedTypes] = useState<BedTypeOption[]>([]);
  const [bedTypesFetchError, setBedTypesFetchError] = useState(false);
  const [filamentOptions, setFilamentOptions] = useState<FilamentOption[]>([]);
  const [saving, setSaving] = useState(false);
  // GH #640 (mirrors the GH #286 FilamentForm fix): derive dirtiness by
  // comparing a snapshot of the editable form state against the last
  // clean baseline, instead of one-way latching a boolean on every edit.
  // The latch meant reverting a change still triggered the
  // unsaved-changes prompt on navigation; the snapshot comparison is
  // two-way. The baseline is seeded with the initial snapshot via the
  // lazy useState initializer and re-pointed after a successful save.
  const dirtySnapshot = useMemo(() => JSON.stringify(form), [form]);
  const [dirtyBaseline, setDirtyBaseline] = useState(dirtySnapshot);
  const dirty = dirtySnapshot !== dirtyBaseline;
  const savedRef = useRef(false);
  // GH #232 — when the parent's onSubmit throws NozzleConflictError, we
  // store the conflicts here to open the resolution modal. `null` means
  // no modal is showing. Resolution writes back into form state +
  // re-invokes onSubmit on confirm.
  const [pendingConflicts, setPendingConflicts] = useState<NozzleConflict[] | null>(null);
  // Per-conflict user choice. Default = "clone" because that's the safe
  // path (creates a new nozzle for this printer, leaves the other
  // printer untouched). "move" silently strips the nozzle from the
  // other printer, which is more destructive.
  const [conflictChoices, setConflictChoices] = useState<Record<string, "clone" | "move">>({});
  const [resolvingConflicts, setResolvingConflicts] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);

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

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/bed-types", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then(setBedTypes)
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setBedTypesFetchError(true);
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
  };

  const toggleNozzle = (id: string) => {
    setForm((f) => ({
      ...f,
      installedNozzles: f.installedNozzles.includes(id)
        ? f.installedNozzles.filter((n) => n !== id)
        : [...f.installedNozzles, id],
    }));
  };

  const toggleBedType = (id: string) => {
    setForm((f) => ({
      ...f,
      installedBedTypes: f.installedBedTypes.includes(id)
        ? f.installedBedTypes.filter((b) => b !== id)
        : [...f.installedBedTypes, id],
    }));
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

  // Hoisted out of handleSubmit so it can be re-invoked after the user
  // resolves nozzle conflicts in the modal.
  const buildSubmitPayload = (
    installedNozzles: string[] = form.installedNozzles,
  ): Record<string, unknown> => ({
    name: form.name,
    manufacturer: form.manufacturer,
    printerModel: form.printerModel,
    installedNozzles,
    installedBedTypes: form.installedBedTypes,
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSubmit(buildSubmitPayload());
      savedRef.current = true;
      // GH #640: re-baseline so the just-saved state counts as clean.
      setDirtyBaseline(JSON.stringify(form));
    } catch (err) {
      // GH #232 — a 409 nozzle conflict thrown by the parent's onSubmit
      // routes to the resolution modal instead of the generic
      // error-toast path. Anything else propagates as before.
      if (err instanceof NozzleConflictError) {
        // Default every conflict to "clone" — safer than silently
        // stripping the nozzle off another printer.
        const choices: Record<string, "clone" | "move"> = {};
        for (const c of err.conflicts) choices[c.nozzleId] = "clone";
        setConflictChoices(choices);
        setPendingConflicts(err.conflicts);
        setConflictError(null);
      } else {
        throw err;
      }
    } finally {
      setSaving(false);
    }
  };

  /**
   * Apply the user's resolution choices, then retry the save. Order:
   *   1. For every "move" choice, GET the other printer, PUT it with
   *      the nozzle stripped from its installedNozzles.
   *   2. For every "clone" choice, POST /api/nozzles/{id}/clone, get
   *      the new id, swap it into the local installedNozzles state.
   *   3. Retry onSubmit with the updated installedNozzles.
   *
   * If anything goes wrong mid-resolution we surface the error inside
   * the modal so the user can retry without losing their other
   * choices.
   */
  const resolveConflicts = async () => {
    if (!pendingConflicts) return;
    setResolvingConflicts(true);
    setConflictError(null);
    try {
      // Build the next installedNozzles array by walking the form state
      // and substituting clone ids where the user chose "clone".
      const cloneSubstitutions = new Map<string, string>();
      for (const c of pendingConflicts) {
        const choice = conflictChoices[c.nozzleId];
        if (choice === "clone") {
          const res = await fetch(`/api/nozzles/${c.nozzleId}/clone`, {
            method: "POST",
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(
              body?.error || `Failed to clone "${c.nozzleName || c.nozzleId}"`,
            );
          }
          const cloned = await res.json();
          cloneSubstitutions.set(c.nozzleId, String(cloned._id));
        } else if (choice === "move") {
          // Load the other printer to strip the nozzle off, then PUT
          // it back. Two round-trips — fine, this is one-shot UX work.
          const getRes = await fetch(`/api/printers/${c.otherPrinterId}`);
          if (!getRes.ok) {
            throw new Error(
              `Couldn't load "${c.otherPrinterName}" to move "${c.nozzleName || c.nozzleId}".`,
            );
          }
          const other = await getRes.json();
          const otherInstalled: string[] = (other.installedNozzles || []).map(
            (n: { _id: string } | string) =>
              typeof n === "string" ? n : n._id,
          );
          const stripped = otherInstalled.filter((nid) => nid !== c.nozzleId);
          const putRes = await fetch(`/api/printers/${c.otherPrinterId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...other,
              installedNozzles: stripped,
            }),
          });
          if (!putRes.ok) {
            const body = await putRes.json().catch(() => null);
            throw new Error(
              body?.error ||
                `Failed to move "${c.nozzleName || c.nozzleId}" off "${c.otherPrinterName}".`,
            );
          }
        }
      }

      // Substitute clone ids in form state. Move choices leave the
      // original id in place (the nozzle now lives on this printer
      // unchanged).
      const resolvedInstalled = form.installedNozzles.map(
        (nid) => cloneSubstitutions.get(nid) ?? nid,
      );
      // Update form state so the checkbox list reflects the new clones
      // immediately — and so any subsequent submit uses the resolved
      // ids without re-running resolution.
      setForm((f) => ({ ...f, installedNozzles: resolvedInstalled }));

      // Re-fetch the nozzle list so the new clones appear as checked
      // entries instead of orphaned ids.
      const nozzlesRes = await fetch("/api/nozzles");
      if (nozzlesRes.ok) {
        const next = await nozzlesRes.json();
        setNozzles(next);
      }

      // Close the modal and re-submit.
      setPendingConflicts(null);
      setSaving(true);
      try {
        await onSubmit(buildSubmitPayload(resolvedInstalled));
        savedRef.current = true;
        // GH #640: re-baseline against the form as just saved. The
        // setForm above hasn't re-rendered this closure, so merge the
        // resolved nozzle ids in rather than snapshotting stale `form`.
        setDirtyBaseline(
          JSON.stringify({ ...form, installedNozzles: resolvedInstalled }),
        );
      } catch (err) {
        // If the retry also returns a conflict (e.g. a third printer
        // claimed the nozzle between the first 409 and now), surface
        // it as a fresh modal instead of double-nesting.
        if (err instanceof NozzleConflictError) {
          const choices: Record<string, "clone" | "move"> = {};
          for (const c of err.conflicts) choices[c.nozzleId] = "clone";
          setConflictChoices(choices);
          setPendingConflicts(err.conflicts);
          setConflictError(null);
        } else {
          throw err;
        }
      } finally {
        setSaving(false);
      }
    } catch (err) {
      setConflictError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingConflicts(false);
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
            <label htmlFor="printer-build-x" className={labelClass}>{t("printers.form.buildX")}</label>
            <input
              id="printer-build-x"
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
            <label htmlFor="printer-build-y" className={labelClass}>{t("printers.form.buildY")}</label>
            <input
              id="printer-build-y"
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
            <label htmlFor="printer-build-z" className={labelClass}>{t("printers.form.buildZ")}</label>
            <input
              id="printer-build-z"
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
            <label htmlFor="printer-max-flow" className={labelClass}>{t("printers.form.maxFlow")}</label>
            <input
              id="printer-max-flow"
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
            <label htmlFor="printer-max-speed" className={labelClass}>{t("printers.form.maxSpeed")}</label>
            <input
              id="printer-max-speed"
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
                    aria-label={t("printers.form.amsSlotNameAriaLabel", {
                      name: slot.slotName || t("printers.form.amsSlotUnnamed"),
                    })}
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
                    aria-label={t("printers.form.amsFilamentAriaLabel", {
                      name: slot.slotName || t("printers.form.amsSlotUnnamed"),
                    })}
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
                    aria-label={t("printers.form.amsSpoolAriaLabel", {
                      name: slot.slotName || t("printers.form.amsSlotUnnamed"),
                    })}
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
            {nozzles.map((n) => {
              // GH #232 — surface which other printer currently has this
              // nozzle installed, so the user can see the conflict
              // *before* they save. Empty when no other printer claims
              // it (the common case on a clean DB).
              const otherPrinters = (n.printers ?? []).filter(
                (p) => p._id !== initialData?._id,
              );
              return (
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
                  {otherPrinters.length > 0 && (
                    <span
                      className="ml-auto px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 rounded text-[10px] whitespace-nowrap"
                      title={t("printers.form.nozzleInUseTip")}
                    >
                      {t("printers.form.nozzleInUseLabel", {
                        printer: otherPrinters.map((p) => p.name).join(", "),
                      })}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {bedTypesFetchError && (
        <div className="px-3 py-2 bg-yellow-900/30 border border-yellow-800 rounded text-sm text-yellow-300">
          {t("printers.form.bedTypesLoadError")}
        </div>
      )}

      {bedTypes.length > 0 && (
        <div>
          <label className={labelClass}>{t("printers.form.bedTypes")}</label>
          <p className="text-xs text-gray-500 mb-2">{t("printers.form.bedTypesHint")}</p>
          {/* Plain checkbox list — bed types are a shared catalog, so
              (unlike nozzles) there's no per-printer conflict to surface. */}
          <div className="grid grid-cols-2 gap-2">
            {bedTypes.map((b) => (
              <label
                key={b._id}
                className="flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer text-sm"
              >
                <input
                  type="checkbox"
                  checked={form.installedBedTypes.includes(b._id)}
                  onChange={() => toggleBedType(b._id)}
                  className="w-4 h-4 rounded"
                />
                <span>{b.name}</span>
                <span className="text-gray-500 text-xs">{b.material}</span>
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

      {/* GH #232 — nozzle-conflict resolution modal. Renders inside the
       *  form element so the user's submit context stays intact; the
       *  modal's primary action triggers the resolution flow + a retry. */}
      {pendingConflicts && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="nozzle-conflict-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-5 space-y-4">
            <h2
              id="nozzle-conflict-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              {t("printers.form.nozzleConflictTitle")}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {t("printers.form.nozzleConflictHint")}
            </p>

            <div className="space-y-3 max-h-72 overflow-y-auto">
              {pendingConflicts.map((c) => (
                <div
                  key={c.nozzleId}
                  className="border border-gray-200 dark:border-gray-700 rounded p-3 text-sm"
                >
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {c.nozzleName ?? c.nozzleId}
                  </div>
                  <div className="text-xs text-gray-500 mb-2">
                    {t("printers.form.nozzleConflictCurrentlyIn", {
                      printer: c.otherPrinterName,
                    })}
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name={`nozzle-conflict-${c.nozzleId}`}
                        value="clone"
                        checked={conflictChoices[c.nozzleId] === "clone"}
                        onChange={() =>
                          setConflictChoices((prev) => ({
                            ...prev,
                            [c.nozzleId]: "clone",
                          }))
                        }
                      />
                      <span className="text-gray-800 dark:text-gray-200">
                        {t("printers.form.nozzleConflictChoiceClone")}
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name={`nozzle-conflict-${c.nozzleId}`}
                        value="move"
                        checked={conflictChoices[c.nozzleId] === "move"}
                        onChange={() =>
                          setConflictChoices((prev) => ({
                            ...prev,
                            [c.nozzleId]: "move",
                          }))
                        }
                      />
                      <span className="text-gray-800 dark:text-gray-200">
                        {t("printers.form.nozzleConflictChoiceMove", {
                          printer: c.otherPrinterName,
                        })}
                      </span>
                    </label>
                  </div>
                </div>
              ))}
            </div>

            {conflictError && (
              <div className="text-sm text-red-600 dark:text-red-400">
                {conflictError}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                type="button"
                disabled={resolvingConflicts}
                onClick={() => {
                  // Cancel — close modal, leave form as the user had it.
                  // They can uncheck the conflicting nozzles and re-submit.
                  setPendingConflicts(null);
                  setConflictError(null);
                }}
                className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={resolvingConflicts}
                onClick={resolveConflicts}
                className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {resolvingConflicts
                  ? t("printers.form.nozzleConflictResolving")
                  : t("printers.form.nozzleConflictApply")}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
