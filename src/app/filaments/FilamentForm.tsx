"use client";

import { useState, useEffect, useRef } from "react";

interface FilamentFormData {
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost: string;
  density: string;
  diameter: string;
  temperatures: {
    nozzle: string;
    nozzleFirstLayer: string;
    bed: string;
    bedFirstLayer: string;
    chamber: string;
  };
  maxVolumetricSpeed: string;
  extrusionMultiplier: string;
  shrinkageXY: string;
  shrinkageZ: string;
  abrasive: boolean;
  soluble: boolean;
  fanMinSpeed: string;
  fanMaxSpeed: string;
  fanBridgeSpeed: string;
  fanDisableFirstLayers: string;
  retractLength: string;
  retractSpeed: string;
  retractLift: string;
  pressureAdvance: string;
  notes: string;
  tdsUrl: string;
  compatibleNozzles: string[];
  inherits: string;
  parentId: string;
}

interface ParentOption {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
}

interface NozzleOption {
  _id: string;
  name: string;
  diameter: number;
  type: string;
  highFlow: boolean;
}

interface CalibrationEntry {
  extrusionMultiplier: string;
  maxVolumetricSpeed: string;
  pressureAdvance: string;
  retractLength: string;
  retractSpeed: string;
  retractLift: string;
}

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialData?: any;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}

const DEFAULT_FILAMENT_TYPES = [
  "PLA", "PETG", "PCTG", "ABS", "ASA", "PA", "PC", "TPU", "FLEX",
  "POM", "PP", "HIPS", "PVA", "PET-GF", "PPA", "IGLIDUR",
];

function getSettingVal(data: Record<string, unknown> | undefined, key: string): string {
  if (!data?.settings) return "";
  const settings = data.settings as Record<string, string | null>;
  const val = settings[key];
  if (!val || val === "nil") return "";
  return val;
}

function extractPressureAdvance(data: Record<string, unknown> | undefined): string {
  if (!data?.settings) return "";
  const settings = data.settings as Record<string, string | null>;
  const gcode = settings.start_filament_gcode;
  if (!gcode) return "";
  // Match M572 S<value> — take the first occurrence
  const match = gcode.match(/M572\s+S([\d.]+)/);
  return match ? match[1] : "";
}

export default function FilamentForm({ initialData, onSubmit }: Props) {
  const [nozzles, setNozzles] = useState<NozzleOption[]>([]);
  const [parentOptions, setParentOptions] = useState<ParentOption[]>([]);
  const [parentSearch, setParentSearch] = useState("");
  const [parentDropdownOpen, setParentDropdownOpen] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  const getInitialNozzleIds = (): string[] => {
    if (!initialData?.compatibleNozzles) return [];
    return initialData.compatibleNozzles.map((n: string | { _id: string }) =>
      typeof n === "string" ? n : n._id
    );
  };

  const [form, setForm] = useState<FilamentFormData>({
    name: initialData?.name || "",
    vendor: initialData?.vendor || "",
    type: initialData?.type || "PLA",
    color: initialData?.color || "#808080",
    cost: initialData?.cost?.toString() || "",
    density: initialData?.density?.toString() || "",
    diameter: initialData?.diameter?.toString() || "1.75",
    temperatures: {
      nozzle: initialData?.temperatures?.nozzle?.toString() || "",
      nozzleFirstLayer: initialData?.temperatures?.nozzleFirstLayer?.toString() || "",
      bed: initialData?.temperatures?.bed?.toString() || "",
      bedFirstLayer: initialData?.temperatures?.bedFirstLayer?.toString() || "",
      chamber: getSettingVal(initialData, "chamber_temperature"),
    },
    maxVolumetricSpeed: initialData?.maxVolumetricSpeed?.toString() || "",
    extrusionMultiplier: getSettingVal(initialData, "extrusion_multiplier"),
    shrinkageXY: getSettingVal(initialData, "filament_shrinkage_compensation_xy"),
    shrinkageZ: getSettingVal(initialData, "filament_shrinkage_compensation_z"),
    abrasive: getSettingVal(initialData, "filament_abrasive") === "1",
    soluble: getSettingVal(initialData, "filament_soluble") === "1",
    fanMinSpeed: getSettingVal(initialData, "min_fan_speed"),
    fanMaxSpeed: getSettingVal(initialData, "max_fan_speed"),
    fanBridgeSpeed: getSettingVal(initialData, "bridge_fan_speed"),
    fanDisableFirstLayers: getSettingVal(initialData, "disable_fan_first_layers"),
    retractLength: getSettingVal(initialData, "filament_retract_length"),
    retractSpeed: getSettingVal(initialData, "filament_retract_speed") === "nil" ? "" : getSettingVal(initialData, "filament_retract_speed"),
    retractLift: getSettingVal(initialData, "filament_retract_lift"),
    pressureAdvance: extractPressureAdvance(initialData),
    notes: getSettingVal(initialData, "filament_notes").replace(/^"|"$/g, ""),
    tdsUrl: initialData?.tdsUrl || "",
    compatibleNozzles: getInitialNozzleIds(),
    inherits: initialData?.inherits || "",
    parentId: initialData?.parentId?._id || initialData?.parentId || "",
  });
  const [saving, setSaving] = useState(false);
  const [tdsSuggestions, setTdsSuggestions] = useState<{ name: string; tdsUrl: string }[]>([]);
  const [filamentTypes, setFilamentTypes] = useState<string[]>(DEFAULT_FILAMENT_TYPES);
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const typeRef = useRef<HTMLDivElement>(null);

  // Fetch distinct filament types from DB and merge with defaults
  useEffect(() => {
    fetch("/api/filaments/types")
      .then((r) => r.json())
      .then((dbTypes: string[]) => {
        const merged = Array.from(new Set([...DEFAULT_FILAMENT_TYPES, ...dbTypes])).sort();
        setFilamentTypes(merged);
      })
      .catch(() => {});
  }, []);

  // Fetch potential parent filaments
  useEffect(() => {
    const exclude = initialData?._id || "";
    fetch(`/api/filaments/parents${exclude ? `?exclude=${exclude}` : ""}`)
      .then((r) => r.json())
      .then(setParentOptions)
      .catch(() => {});
  }, [initialData?._id]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (typeRef.current && !typeRef.current.contains(e.target as Node)) {
        setTypeDropdownOpen(false);
      }
      if (parentRef.current && !parentRef.current.contains(e.target as Node)) {
        setParentDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Fetch TDS suggestions from other filaments with same vendor
  useEffect(() => {
    if (!form.vendor) return;
    fetch(`/api/filaments?vendor=${encodeURIComponent(form.vendor)}`)
      .then((r) => r.json())
      .then((data: { name: string; tdsUrl?: string }[]) => {
        const suggestions = data
          .filter((f) => f.tdsUrl && f.name !== form.name)
          .map((f) => ({ name: f.name, tdsUrl: f.tdsUrl! }));
        setTdsSuggestions(suggestions);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.vendor]);

  const getInitialCalibrations = (): Record<string, CalibrationEntry> => {
    const cals: Record<string, CalibrationEntry> = {};
    if (!initialData?.calibrations) return cals;
    for (const cal of initialData.calibrations) {
      const nozzleId = typeof cal.nozzle === "string" ? cal.nozzle : cal.nozzle?._id;
      if (!nozzleId) continue;
      cals[nozzleId] = {
        extrusionMultiplier: cal.extrusionMultiplier?.toString() || "",
        maxVolumetricSpeed: cal.maxVolumetricSpeed?.toString() || "",
        pressureAdvance: cal.pressureAdvance?.toString() || "",
        retractLength: cal.retractLength?.toString() || "",
        retractSpeed: cal.retractSpeed?.toString() || "",
        retractLift: cal.retractLift?.toString() || "",
      };
    }
    return cals;
  };

  const [calibrations, setCalibrations] = useState<Record<string, CalibrationEntry>>(
    getInitialCalibrations
  );

  const updateCalibration = (nozzleId: string, field: keyof CalibrationEntry, value: string) => {
    setCalibrations((prev) => ({
      ...prev,
      [nozzleId]: {
        ...(prev[nozzleId] || {
          extrusionMultiplier: "",
          maxVolumetricSpeed: "",
          pressureAdvance: "",
          retractLength: "",
          retractSpeed: "",
          retractLift: "",
        }),
        [field]: value,
      },
    }));
  };

  useEffect(() => {
    fetch("/api/nozzles")
      .then((r) => r.json())
      .then(setNozzles);
  }, []);

  const toggleNozzle = (id: string) => {
    setForm((prev) => ({
      ...prev,
      compatibleNozzles: prev.compatibleNozzles.includes(id)
        ? prev.compatibleNozzles.filter((n) => n !== id)
        : [...prev.compatibleNozzles, id],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    const parseNum = (val: string): number | null => {
      if (!val) return null;
      const num = parseFloat(val);
      return isNaN(num) ? null : num;
    };

    // Merge form fields back into settings
    const settings = { ...(initialData?.settings || {}) };
    settings.extrusion_multiplier = form.extrusionMultiplier || settings.extrusion_multiplier;
    settings.filament_shrinkage_compensation_xy = form.shrinkageXY || settings.filament_shrinkage_compensation_xy;
    settings.filament_shrinkage_compensation_z = form.shrinkageZ || settings.filament_shrinkage_compensation_z;
    settings.filament_abrasive = form.abrasive ? "1" : "0";
    settings.filament_soluble = form.soluble ? "1" : "0";
    settings.chamber_temperature = form.temperatures.chamber || settings.chamber_temperature;
    settings.min_fan_speed = form.fanMinSpeed || settings.min_fan_speed;
    settings.max_fan_speed = form.fanMaxSpeed || settings.max_fan_speed;
    settings.bridge_fan_speed = form.fanBridgeSpeed || settings.bridge_fan_speed;
    settings.disable_fan_first_layers = form.fanDisableFirstLayers || settings.disable_fan_first_layers;
    settings.filament_retract_length = form.retractLength || settings.filament_retract_length;
    if (form.retractSpeed) settings.filament_retract_speed = form.retractSpeed;
    settings.filament_retract_lift = form.retractLift || settings.filament_retract_lift;
    settings.filament_notes = form.notes ? `"${form.notes}"` : settings.filament_notes;

    // Update pressure advance in start_filament_gcode if a simple M572 line
    if (form.pressureAdvance && settings.start_filament_gcode) {
      const gcode = settings.start_filament_gcode as string;
      if (gcode.match(/^"?M572\s+S[\d.]+/) && !gcode.includes("{if")) {
        settings.start_filament_gcode = gcode.replace(
          /M572\s+S[\d.]+/,
          `M572 S${form.pressureAdvance}`
        );
      }
    }

    await onSubmit({
      name: form.name,
      vendor: form.vendor,
      type: form.type,
      color: form.color,
      cost: parseNum(form.cost),
      density: parseNum(form.density),
      diameter: parseNum(form.diameter) ?? 1.75,
      temperatures: {
        nozzle: parseNum(form.temperatures.nozzle),
        nozzleFirstLayer: parseNum(form.temperatures.nozzleFirstLayer),
        bed: parseNum(form.temperatures.bed),
        bedFirstLayer: parseNum(form.temperatures.bedFirstLayer),
      },
      maxVolumetricSpeed: parseNum(form.maxVolumetricSpeed),
      compatibleNozzles: form.compatibleNozzles,
      calibrations: form.compatibleNozzles
        .filter((nozzleId) => {
          const cal = calibrations[nozzleId];
          return cal && Object.values(cal).some((v) => v !== "");
        })
        .map((nozzleId) => {
          const cal = calibrations[nozzleId];
          return {
            nozzle: nozzleId,
            extrusionMultiplier: parseNum(cal.extrusionMultiplier),
            maxVolumetricSpeed: parseNum(cal.maxVolumetricSpeed),
            pressureAdvance: parseNum(cal.pressureAdvance),
            retractLength: parseNum(cal.retractLength),
            retractSpeed: parseNum(cal.retractSpeed),
            retractLift: parseNum(cal.retractLift),
          };
        }),
      tdsUrl: form.tdsUrl || null,
      inherits: form.inherits || null,
      parentId: form.parentId || null,
      settings,
    });

    setSaving(false);
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
          required
        />
      </div>

      <div ref={parentRef} className="relative">
        <label className={labelClass}>
          Parent Filament
          <span className="text-gray-400 font-normal ml-1">(optional — for color variants)</span>
        </label>
        {form.parentId ? (
          <div className="flex items-center gap-2 px-3 py-2 border border-blue-400 bg-blue-50 dark:bg-blue-950 rounded text-sm">
            {(() => {
              const p = parentOptions.find((o) => o._id === form.parentId);
              return p ? (
                <>
                  <div
                    className="w-4 h-4 rounded-full border border-gray-300 flex-shrink-0"
                    style={{ backgroundColor: p.color }}
                  />
                  <span className="flex-1">{p.name}</span>
                  <span className="text-gray-500 text-xs">{p.vendor} &middot; {p.type}</span>
                </>
              ) : (
                <span className="text-gray-500">Loading...</span>
              );
            })()}
            <button
              type="button"
              onClick={() => setForm({ ...form, parentId: "" })}
              className="text-red-500 hover:text-red-700 text-xs ml-2"
            >
              Remove
            </button>
          </div>
        ) : (
          <>
            <input
              className={inputClass}
              value={parentSearch}
              onChange={(e) => {
                setParentSearch(e.target.value);
                setParentDropdownOpen(true);
              }}
              onFocus={() => setParentDropdownOpen(true)}
              placeholder="Search for a parent filament..."
            />
            {parentDropdownOpen && (
              <ul className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto bg-gray-800 border border-gray-600 rounded shadow-lg">
                {parentOptions
                  .filter((p) =>
                    !parentSearch ||
                    p.name.toLowerCase().includes(parentSearch.toLowerCase()) ||
                    p.vendor.toLowerCase().includes(parentSearch.toLowerCase())
                  )
                  .slice(0, 20)
                  .map((p) => (
                    <li
                      key={p._id}
                      className="px-3 py-2 cursor-pointer text-gray-100 hover:bg-gray-700 flex items-center gap-2"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setForm({
                          ...form,
                          parentId: p._id,
                          vendor: form.vendor || p.vendor,
                          type: form.type || p.type,
                        });
                        setParentSearch("");
                        setParentDropdownOpen(false);
                      }}
                    >
                      <div
                        className="w-4 h-4 rounded-full border border-gray-500 flex-shrink-0"
                        style={{ backgroundColor: p.color }}
                      />
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="text-gray-400 text-xs flex-shrink-0">{p.vendor} &middot; {p.type}</span>
                    </li>
                  ))}
                {parentOptions.filter((p) =>
                  !parentSearch ||
                  p.name.toLowerCase().includes(parentSearch.toLowerCase()) ||
                  p.vendor.toLowerCase().includes(parentSearch.toLowerCase())
                ).length === 0 && (
                  <li className="px-3 py-2 text-gray-500 text-sm">No matching filaments</li>
                )}
              </ul>
            )}
          </>
        )}
        {form.parentId && (
          <p className="text-xs text-gray-500 mt-1">
            This filament will inherit shared settings (temps, density, retraction, etc.) from its parent.
            Only color, name, and cost need to be set here.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Vendor *</label>
          <input
            className={inputClass}
            value={form.vendor}
            onChange={(e) => setForm({ ...form, vendor: e.target.value })}
            required
          />
        </div>
        <div ref={typeRef} className="relative">
          <label className={labelClass}>Type *</label>
          <input
            className={inputClass}
            value={typeDropdownOpen ? typeFilter : form.type}
            onChange={(e) => {
              const val = e.target.value.toUpperCase();
              setTypeFilter(val);
              setForm({ ...form, type: val });
              setTypeDropdownOpen(true);
            }}
            onFocus={() => {
              setTypeFilter("");
              setTypeDropdownOpen(true);
            }}
            placeholder="Select or type..."
            required
          />
          {typeDropdownOpen && (
            <ul className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto bg-gray-800 border border-gray-600 rounded shadow-lg">
              {filamentTypes
                .filter((t) => !typeFilter || t.includes(typeFilter))
                .map((t) => (
                  <li
                    key={t}
                    className={`px-3 py-1.5 cursor-pointer text-gray-100 hover:bg-gray-700 ${t === form.type ? "bg-gray-700 font-semibold" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setForm({ ...form, type: t });
                      setTypeFilter("");
                      setTypeDropdownOpen(false);
                    }}
                  >
                    {t}
                  </li>
                ))}
              {typeFilter && !filamentTypes.includes(typeFilter) && (
                <li
                  className="px-3 py-1.5 cursor-pointer text-green-400 hover:bg-gray-700 border-t border-gray-600"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setFilamentTypes((prev) => Array.from(new Set([...prev, typeFilter])).sort());
                    setForm({ ...form, type: typeFilter });
                    setTypeFilter("");
                    setTypeDropdownOpen(false);
                  }}
                >
                  + Add &quot;{typeFilter}&quot;
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>Color</label>
          <input
            type="color"
            className="w-full h-10 rounded border border-gray-300 cursor-pointer"
            value={form.color}
            onChange={(e) => setForm({ ...form, color: e.target.value })}
          />
        </div>
        <div>
          <label className={labelClass}>Cost ($/kg)</label>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            value={form.cost}
            onChange={(e) => setForm({ ...form, cost: e.target.value })}
          />
        </div>
        <div>
          <label className={labelClass}>Density (g/cm³)</label>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            value={form.density}
            onChange={(e) => setForm({ ...form, density: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>Extrusion Multiplier</label>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            value={form.extrusionMultiplier}
            onChange={(e) => setForm({ ...form, extrusionMultiplier: e.target.value })}
            placeholder="e.g. 0.95"
          />
        </div>
        <div>
          <label className={labelClass}>Pressure Advance</label>
          <input
            type="number"
            step="0.001"
            className={inputClass}
            value={form.pressureAdvance}
            onChange={(e) => setForm({ ...form, pressureAdvance: e.target.value })}
            placeholder="e.g. 0.053"
          />
        </div>
        <div>
          <label className={labelClass}>Max Vol. Speed (mm³/s)</label>
          <input
            type="number"
            step="0.1"
            className={inputClass}
            value={form.maxVolumetricSpeed}
            onChange={(e) => setForm({ ...form, maxVolumetricSpeed: e.target.value })}
          />
        </div>
      </div>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">Temperatures (°C)</legend>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Nozzle</label>
            <input
              type="number"
              className={inputClass}
              value={form.temperatures.nozzle}
              onChange={(e) =>
                setForm({
                  ...form,
                  temperatures: { ...form.temperatures, nozzle: e.target.value },
                })
              }
            />
          </div>
          <div>
            <label className={labelClass}>Nozzle (1st Layer)</label>
            <input
              type="number"
              className={inputClass}
              value={form.temperatures.nozzleFirstLayer}
              onChange={(e) =>
                setForm({
                  ...form,
                  temperatures: { ...form.temperatures, nozzleFirstLayer: e.target.value },
                })
              }
            />
          </div>
          <div>
            <label className={labelClass}>Bed</label>
            <input
              type="number"
              className={inputClass}
              value={form.temperatures.bed}
              onChange={(e) =>
                setForm({
                  ...form,
                  temperatures: { ...form.temperatures, bed: e.target.value },
                })
              }
            />
          </div>
          <div>
            <label className={labelClass}>Bed (1st Layer)</label>
            <input
              type="number"
              className={inputClass}
              value={form.temperatures.bedFirstLayer}
              onChange={(e) =>
                setForm({
                  ...form,
                  temperatures: { ...form.temperatures, bedFirstLayer: e.target.value },
                })
              }
            />
          </div>
          <div>
            <label className={labelClass}>Chamber</label>
            <input
              type="number"
              className={inputClass}
              value={form.temperatures.chamber}
              onChange={(e) =>
                setForm({
                  ...form,
                  temperatures: { ...form.temperatures, chamber: e.target.value },
                })
              }
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">Shrinkage Compensation</legend>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>XY (%)</label>
            <input
              type="text"
              className={inputClass}
              value={form.shrinkageXY}
              onChange={(e) => setForm({ ...form, shrinkageXY: e.target.value })}
              placeholder="e.g. 0.2%"
            />
          </div>
          <div>
            <label className={labelClass}>Z (%)</label>
            <input
              type="text"
              className={inputClass}
              value={form.shrinkageZ}
              onChange={(e) => setForm({ ...form, shrinkageZ: e.target.value })}
              placeholder="e.g. 0.2%"
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">Fan Settings</legend>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Min Speed (%)</label>
            <input
              type="number"
              className={inputClass}
              value={form.fanMinSpeed}
              onChange={(e) => setForm({ ...form, fanMinSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>Max Speed (%)</label>
            <input
              type="number"
              className={inputClass}
              value={form.fanMaxSpeed}
              onChange={(e) => setForm({ ...form, fanMaxSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>Bridge Speed (%)</label>
            <input
              type="number"
              className={inputClass}
              value={form.fanBridgeSpeed}
              onChange={(e) => setForm({ ...form, fanBridgeSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>Disable First Layers</label>
            <input
              type="number"
              className={inputClass}
              value={form.fanDisableFirstLayers}
              onChange={(e) => setForm({ ...form, fanDisableFirstLayers: e.target.value })}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">Retraction</legend>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>Length (mm)</label>
            <input
              type="number"
              step="0.1"
              className={inputClass}
              value={form.retractLength}
              onChange={(e) => setForm({ ...form, retractLength: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>Speed (mm/s)</label>
            <input
              type="number"
              className={inputClass}
              value={form.retractSpeed}
              onChange={(e) => setForm({ ...form, retractSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>Z Lift (mm)</label>
            <input
              type="number"
              step="0.01"
              className={inputClass}
              value={form.retractLift}
              onChange={(e) => setForm({ ...form, retractLift: e.target.value })}
            />
          </div>
        </div>
      </fieldset>

      <div className="flex gap-6">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="abrasive"
            checked={form.abrasive}
            onChange={(e) => setForm({ ...form, abrasive: e.target.checked })}
            className="w-4 h-4"
          />
          <label htmlFor="abrasive" className="text-sm font-medium">
            Abrasive filament
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="soluble"
            checked={form.soluble}
            onChange={(e) => setForm({ ...form, soluble: e.target.checked })}
            className="w-4 h-4"
          />
          <label htmlFor="soluble" className="text-sm font-medium">
            Soluble filament
          </label>
        </div>
      </div>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">Compatible Nozzles</legend>
        {nozzles.length === 0 ? (
          <p className="text-sm text-gray-500">
            No nozzles defined yet. <a href="/nozzles/new" className="text-blue-600 hover:underline">Add one first.</a>
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {nozzles.map((n) => (
              <label
                key={n._id}
                className={`flex items-center gap-2 p-2 rounded border cursor-pointer text-sm ${
                  form.compatibleNozzles.includes(n._id)
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                    : "border-gray-200 dark:border-gray-700"
                }`}
              >
                <input
                  type="checkbox"
                  checked={form.compatibleNozzles.includes(n._id)}
                  onChange={() => toggleNozzle(n._id)}
                  className="w-4 h-4"
                />
                <span>
                  {n.name}
                  {n.highFlow && (
                    <span className="ml-1 px-1.5 py-0.5 bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 rounded text-xs">
                      HF
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {form.compatibleNozzles.length > 0 && (
        <fieldset className="border border-gray-300 rounded p-4">
          <legend className="text-sm font-medium px-2">Nozzle Calibrations</legend>
          <p className="text-xs text-gray-500 mb-3">
            Per-nozzle overrides for calibration values. Leave blank to use base defaults.
          </p>
          <div className="space-y-4">
            {form.compatibleNozzles.map((nozzleId) => {
              const nozzle = nozzles.find((n) => n._id === nozzleId);
              if (!nozzle) return null;
              const cal = calibrations[nozzleId] || {
                extrusionMultiplier: "",
                maxVolumetricSpeed: "",
                pressureAdvance: "",
                retractLength: "",
                retractSpeed: "",
                retractLift: "",
              };
              return (
                <div
                  key={nozzleId}
                  className="border border-gray-200 dark:border-gray-700 rounded p-3"
                >
                  <p className="text-sm font-medium mb-2">
                    {nozzle.name}
                    {nozzle.highFlow && (
                      <span className="ml-1.5 px-1.5 py-0.5 bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 rounded text-xs">
                        HF
                      </span>
                    )}
                  </p>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">EM</label>
                      <input
                        type="number"
                        step="0.01"
                        className={inputClass}
                        value={cal.extrusionMultiplier}
                        onChange={(e) =>
                          updateCalibration(nozzleId, "extrusionMultiplier", e.target.value)
                        }
                        placeholder={form.extrusionMultiplier || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Max Vol (mm³/s)</label>
                      <input
                        type="number"
                        step="0.1"
                        className={inputClass}
                        value={cal.maxVolumetricSpeed}
                        onChange={(e) =>
                          updateCalibration(nozzleId, "maxVolumetricSpeed", e.target.value)
                        }
                        placeholder={form.maxVolumetricSpeed || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">PA</label>
                      <input
                        type="number"
                        step="0.001"
                        className={inputClass}
                        value={cal.pressureAdvance}
                        onChange={(e) =>
                          updateCalibration(nozzleId, "pressureAdvance", e.target.value)
                        }
                        placeholder={form.pressureAdvance || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Retract (mm)</label>
                      <input
                        type="number"
                        step="0.1"
                        className={inputClass}
                        value={cal.retractLength}
                        onChange={(e) =>
                          updateCalibration(nozzleId, "retractLength", e.target.value)
                        }
                        placeholder={form.retractLength || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Retract Speed (mm/s)</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={cal.retractSpeed}
                        onChange={(e) =>
                          updateCalibration(nozzleId, "retractSpeed", e.target.value)
                        }
                        placeholder={form.retractSpeed || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Z Lift (mm)</label>
                      <input
                        type="number"
                        step="0.01"
                        className={inputClass}
                        value={cal.retractLift}
                        onChange={(e) =>
                          updateCalibration(nozzleId, "retractLift", e.target.value)
                        }
                        placeholder={form.retractLift || "base"}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Diameter (mm)</label>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            value={form.diameter}
            onChange={(e) => setForm({ ...form, diameter: e.target.value })}
          />
        </div>
        <div>
          <label className={labelClass}>Inherits (base profile name)</label>
          <input
            className={inputClass}
            value={form.inherits}
            onChange={(e) => setForm({ ...form, inherits: e.target.value })}
            placeholder="e.g. Spectrum PCTG @COREONE"
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>TDS Link (Technical Data Sheet)</label>
        <input
          type="url"
          className={inputClass}
          value={form.tdsUrl}
          onChange={(e) => setForm({ ...form, tdsUrl: e.target.value })}
          placeholder="https://vendor.com/filament-tds.pdf"
        />
        {!form.tdsUrl && tdsSuggestions.length > 0 && (
          <div className="mt-1">
            <p className="text-xs text-gray-500 mb-1">From other {form.vendor} filaments:</p>
            <div className="flex flex-wrap gap-1">
              {tdsSuggestions.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => setForm({ ...form, tdsUrl: s.tdsUrl })}
                  className="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800"
                >
                  Use from {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div>
        <label className={labelClass}>Notes</label>
        <textarea
          className={inputClass}
          rows={4}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Any notes about this filament..."
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving..." : initialData ? "Update Filament" : "Create Filament"}
      </button>
    </form>
  );
}
