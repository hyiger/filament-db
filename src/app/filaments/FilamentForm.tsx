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
  shoreHardnessA: string;
  shoreHardnessD: string;
  abrasive: boolean;
  soluble: boolean;
  optTags: number[];
  fanMinSpeed: string;
  fanMaxSpeed: string;
  fanBridgeSpeed: string;
  fanDisableFirstLayers: string;
  retractLength: string;
  retractSpeed: string;
  retractLift: string;
  pressureAdvance: string;
  spoolWeight: string;
  netFilamentWeight: string;
  totalWeight: string;
  dryingTemperature: string;
  dryingTime: string;
  transmissionDistance: string;
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

interface PrinterOption {
  _id: string;
  name: string;
  manufacturer: string;
  printerModel: string;
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

interface PresetEntry {
  label: string;
  extrusionMultiplier: string;
  nozzle: string;
  nozzleFirstLayer: string;
  bed: string;
  bedFirstLayer: string;
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
  const [nozzlesLoading, setNozzlesLoading] = useState(true);
  const [printers, setPrinters] = useState<PrinterOption[]>([]);
  const [printersLoading, setPrintersLoading] = useState(true);
  const [selectedPrinter, setSelectedPrinter] = useState<string>("default");
  const [parentOptions, setParentOptions] = useState<ParentOption[]>([]);
  const [parentsLoading, setParentsLoading] = useState(true);
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
    shoreHardnessA: initialData?.shoreHardnessA?.toString() || "",
    shoreHardnessD: initialData?.shoreHardnessD?.toString() || "",
    abrasive: getSettingVal(initialData, "filament_abrasive") === "1",
    soluble: getSettingVal(initialData, "filament_soluble") === "1",
    optTags: initialData?.optTags || [],
    fanMinSpeed: getSettingVal(initialData, "min_fan_speed"),
    fanMaxSpeed: getSettingVal(initialData, "max_fan_speed"),
    fanBridgeSpeed: getSettingVal(initialData, "bridge_fan_speed"),
    fanDisableFirstLayers: getSettingVal(initialData, "disable_fan_first_layers"),
    retractLength: getSettingVal(initialData, "filament_retract_length"),
    retractSpeed: getSettingVal(initialData, "filament_retract_speed") === "nil" ? "" : getSettingVal(initialData, "filament_retract_speed"),
    retractLift: getSettingVal(initialData, "filament_retract_lift"),
    pressureAdvance: extractPressureAdvance(initialData),
    spoolWeight: initialData?.spoolWeight?.toString() || "",
    netFilamentWeight: initialData?.netFilamentWeight?.toString() || "",
    totalWeight: initialData?.totalWeight?.toString() || "",
    dryingTemperature: initialData?.dryingTemperature?.toString() || "",
    dryingTime: initialData?.dryingTime?.toString() || "",
    transmissionDistance: initialData?.transmissionDistance?.toString() || "",
    notes: getSettingVal(initialData, "filament_notes").replace(/^"|"$/g, ""),
    tdsUrl: initialData?.tdsUrl || "",
    compatibleNozzles: getInitialNozzleIds(),
    inherits: initialData?.inherits || "",
    parentId: initialData?.parentId?._id || initialData?.parentId || "",
  });
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(() => {
    // Auto-expand if any advanced fields have values
    return !!(
      form.shrinkageXY || form.shrinkageZ ||
      form.fanMinSpeed || form.fanMaxSpeed || form.fanBridgeSpeed || form.fanDisableFirstLayers ||
      form.retractLength || form.retractSpeed || form.retractLift ||
      form.abrasive || form.soluble || form.optTags.length > 0 ||
      form.shoreHardnessA || form.shoreHardnessD ||
      form.dryingTemperature || form.dryingTime || form.transmissionDistance
    );
  });
  const [tdsSuggestions, setTdsSuggestions] = useState<{ name: string; tdsUrl: string }[]>([]);
  const [filamentTypes, setFilamentTypes] = useState<string[]>(DEFAULT_FILAMENT_TYPES);
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const [typeHighlight, setTypeHighlight] = useState(-1);
  const [parentHighlight, setParentHighlight] = useState(-1);
  const typeRef = useRef<HTMLDivElement>(null);
  const [vendorOptions, setVendorOptions] = useState<string[]>([]);
  const [vendorDropdownOpen, setVendorDropdownOpen] = useState(false);
  const [vendorHighlight, setVendorHighlight] = useState(-1);
  const vendorRef = useRef<HTMLDivElement>(null);
  const [fetchErrors, setFetchErrors] = useState<string[]>([]);

  const addFetchError = (label: string) =>
    setFetchErrors((prev) => (prev.includes(label) ? prev : [...prev, label]));

  // Fetch distinct filament types from DB and merge with defaults
  useEffect(() => {
    fetch("/api/filaments/types")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((dbTypes: string[]) => {
        const merged = Array.from(new Set([...DEFAULT_FILAMENT_TYPES, ...dbTypes])).sort();
        setFilamentTypes(merged);
      })
      .catch(() => addFetchError("filament types"));
  }, []);

  // Fetch distinct vendors from DB
  useEffect(() => {
    fetch("/api/filaments/vendors")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((v: string[]) => setVendorOptions(v))
      .catch(() => addFetchError("vendors"));
  }, []);

  // Fetch potential parent filaments
  useEffect(() => {
    const exclude = initialData?._id || "";
    fetch(`/api/filaments/parents${exclude ? `?exclude=${exclude}` : ""}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setParentOptions)
      .catch(() => addFetchError("parent filaments"))
      .finally(() => setParentsLoading(false));
  }, [initialData?._id]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (typeRef.current && !typeRef.current.contains(e.target as Node)) {
        setTypeDropdownOpen(false);
      }
      if (vendorRef.current && !vendorRef.current.contains(e.target as Node)) {
        setVendorDropdownOpen(false);
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

  const calKey = (printerId: string | null, nozzleId: string) =>
    `${printerId || "default"}:${nozzleId}`;

  const getInitialCalibrations = (): Record<string, CalibrationEntry> => {
    const cals: Record<string, CalibrationEntry> = {};
    if (!initialData?.calibrations) return cals;
    for (const cal of initialData.calibrations) {
      const nozzleId = typeof cal.nozzle === "string" ? cal.nozzle : cal.nozzle?._id;
      if (!nozzleId) continue;
      const printerId = cal.printer
        ? (typeof cal.printer === "string" ? cal.printer : cal.printer._id)
        : null;
      cals[calKey(printerId, nozzleId)] = {
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

  const getInitialPresets = (): PresetEntry[] => {
    if (!initialData?.presets) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return initialData.presets.map((p: any) => ({
      label: p.label || "",
      extrusionMultiplier: p.extrusionMultiplier?.toString() || "",
      nozzle: p.temperatures?.nozzle?.toString() || "",
      nozzleFirstLayer: p.temperatures?.nozzleFirstLayer?.toString() || "",
      bed: p.temperatures?.bed?.toString() || "",
      bedFirstLayer: p.temperatures?.bedFirstLayer?.toString() || "",
    }));
  };

  const [presets, setPresets] = useState<PresetEntry[]>(getInitialPresets);

  const addPreset = () => {
    setPresets((prev) => [
      ...prev,
      { label: "", extrusionMultiplier: "", nozzle: "", nozzleFirstLayer: "", bed: "", bedFirstLayer: "" },
    ]);
  };

  const removePreset = (index: number) => {
    setPresets((prev) => prev.filter((_, i) => i !== index));
  };

  const updatePreset = (index: number, field: keyof PresetEntry, value: string) => {
    setPresets((prev) =>
      prev.map((p, i) => (i === index ? { ...p, [field]: value } : p))
    );
  };

  const updateCalibration = (key: string, field: keyof CalibrationEntry, value: string) => {
    setCalibrations((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] || {
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
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setNozzles)
      .catch(() => addFetchError("nozzles"))
      .finally(() => setNozzlesLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/printers")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setPrinters)
      .catch(() => addFetchError("printers"))
      .finally(() => setPrintersLoading(false));
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

    // Merge form fields back into settings — explicit empty string clears the value
    const settings = { ...(initialData?.settings || {}) };
    settings.extrusion_multiplier = form.extrusionMultiplier || undefined;
    settings.filament_shrinkage_compensation_xy = form.shrinkageXY || undefined;
    settings.filament_shrinkage_compensation_z = form.shrinkageZ || undefined;
    settings.filament_abrasive = form.abrasive ? "1" : "0";
    settings.filament_soluble = form.soluble ? "1" : "0";
    settings.chamber_temperature = form.temperatures.chamber || undefined;
    settings.min_fan_speed = form.fanMinSpeed || undefined;
    settings.max_fan_speed = form.fanMaxSpeed || undefined;
    settings.bridge_fan_speed = form.fanBridgeSpeed || undefined;
    settings.disable_fan_first_layers = form.fanDisableFirstLayers || undefined;
    settings.filament_retract_length = form.retractLength || undefined;
    settings.filament_retract_speed = form.retractSpeed || undefined;
    settings.filament_retract_lift = form.retractLift || undefined;
    settings.filament_notes = form.notes ? `"${form.notes}"` : undefined;

    // Update pressure advance in start_filament_gcode
    if (form.pressureAdvance) {
      if (settings.start_filament_gcode) {
        const gcode = settings.start_filament_gcode as string;
        if (gcode.match(/M572\s+S[\d.]+/) && !gcode.includes("{if")) {
          // Update existing M572 line
          settings.start_filament_gcode = gcode.replace(
            /M572\s+S[\d.]+/,
            `M572 S${form.pressureAdvance}`
          );
        } else if (!gcode.match(/M572/) && !gcode.includes("{if")) {
          // Append M572 to existing gcode
          const trimmed = gcode.replace(/^"|"$/g, "");
          settings.start_filament_gcode = `"${trimmed}\\nM572 S${form.pressureAdvance}"`;
        }
      } else {
        // No gcode yet — create it
        settings.start_filament_gcode = `"M572 S${form.pressureAdvance}"`;
      }
    } else if (settings.start_filament_gcode) {
      // PA cleared — remove M572 line if it's a simple one
      const gcode = settings.start_filament_gcode as string;
      if (gcode.match(/M572\s+S[\d.]+/) && !gcode.includes("{if")) {
        const cleaned = gcode.replace(/\\n?M572\s+S[\d.]+/, "").replace(/^"\\n/, '"');
        settings.start_filament_gcode = cleaned === '""' ? undefined : cleaned;
      }
    }

    try {
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
        calibrations: Object.entries(calibrations)
          .filter(([, cal]) => Object.values(cal).some((v) => v !== ""))
          .filter(([key]) => {
            const [, nozzleId] = key.split(":");
            return form.compatibleNozzles.includes(nozzleId);
          })
          .map(([key, cal]) => {
            const [printerId, nozzleId] = key.split(":");
            return {
              printer: printerId === "default" ? null : printerId,
              nozzle: nozzleId,
              extrusionMultiplier: parseNum(cal.extrusionMultiplier),
              maxVolumetricSpeed: parseNum(cal.maxVolumetricSpeed),
              pressureAdvance: parseNum(cal.pressureAdvance),
              retractLength: parseNum(cal.retractLength),
              retractSpeed: parseNum(cal.retractSpeed),
              retractLift: parseNum(cal.retractLift),
            };
          }),
        spoolWeight: parseNum(form.spoolWeight),
        netFilamentWeight: parseNum(form.netFilamentWeight),
        totalWeight: parseNum(form.totalWeight),
        presets: presets
          .filter((p) => p.label.trim() !== "")
          .map((p) => ({
            label: p.label.trim(),
            extrusionMultiplier: parseNum(p.extrusionMultiplier),
            temperatures: {
              nozzle: parseNum(p.nozzle),
              nozzleFirstLayer: parseNum(p.nozzleFirstLayer),
              bed: parseNum(p.bed),
              bedFirstLayer: parseNum(p.bedFirstLayer),
            },
          })),
        dryingTemperature: parseNum(form.dryingTemperature),
        dryingTime: parseNum(form.dryingTime),
        transmissionDistance: parseNum(form.transmissionDistance),
        shoreHardnessA: parseNum(form.shoreHardnessA),
        shoreHardnessD: parseNum(form.shoreHardnessD),
        optTags: form.optTags,
        tdsUrl: form.tdsUrl || null,
        inherits: form.inherits || null,
        parentId: form.parentId || null,
        settings,
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
      {fetchErrors.length > 0 && (
        <div className="px-3 py-2 bg-yellow-900/30 border border-yellow-800 rounded text-sm text-yellow-300">
          Could not load {fetchErrors.join(", ")}. Some dropdowns may be empty. Check that the server is running.
        </div>
      )}

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
              role="combobox"
              aria-expanded={parentDropdownOpen}
              aria-controls="parent-listbox"
              aria-autocomplete="list"
              aria-activedescendant={parentHighlight >= 0 ? `parent-opt-${parentHighlight}` : undefined}
              onChange={(e) => {
                setParentSearch(e.target.value);
                setParentDropdownOpen(true);
                setParentHighlight(-1);
              }}
              onFocus={() => { setParentDropdownOpen(true); setParentHighlight(-1); }}
              onKeyDown={(e) => {
                if (!parentDropdownOpen) return;
                const filtered = parentOptions
                  .filter((p) => !parentSearch || p.name.toLowerCase().includes(parentSearch.toLowerCase()) || p.vendor.toLowerCase().includes(parentSearch.toLowerCase()))
                  .slice(0, 20);
                if (e.key === "ArrowDown") { e.preventDefault(); setParentHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setParentHighlight((h) => Math.max(h - 1, 0)); }
                else if (e.key === "Enter" && parentHighlight >= 0 && filtered[parentHighlight]) {
                  e.preventDefault();
                  const p = filtered[parentHighlight];
                  setForm({ ...form, parentId: p._id, vendor: form.vendor || p.vendor, type: (!form.type || form.type === "PLA") ? p.type : form.type });
                  setParentSearch("");
                  setParentDropdownOpen(false);
                  setParentHighlight(-1);
                } else if (e.key === "Escape") {
                  setParentDropdownOpen(false);
                  setParentHighlight(-1);
                }
              }}
              placeholder="Search for a parent filament..."
            />
            {parentDropdownOpen && (
              <ul id="parent-listbox" role="listbox" className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto bg-gray-800 border border-gray-600 rounded shadow-lg">
                {parentOptions
                  .filter((p) =>
                    !parentSearch ||
                    p.name.toLowerCase().includes(parentSearch.toLowerCase()) ||
                    p.vendor.toLowerCase().includes(parentSearch.toLowerCase())
                  )
                  .slice(0, 20)
                  .map((p, i) => (
                    <li
                      key={p._id}
                      id={`parent-opt-${i}`}
                      role="option"
                      aria-selected={p._id === form.parentId}
                      className={`px-3 py-2 cursor-pointer text-gray-100 hover:bg-gray-700 flex items-center gap-2 ${i === parentHighlight ? "bg-gray-600" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setForm({
                          ...form,
                          parentId: p._id,
                          vendor: form.vendor || p.vendor,
                          type: (!form.type || form.type === "PLA") ? p.type : form.type,
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
                  <li className="px-3 py-2 text-gray-500 text-sm">
                    {parentsLoading ? "Loading..." : "No matching filaments"}
                  </li>
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div ref={vendorRef} className="relative">
          <label className={labelClass} id="vendor-label">Vendor *</label>
          <input
            className={inputClass}
            value={form.vendor}
            role="combobox"
            aria-expanded={vendorDropdownOpen}
            aria-controls="vendor-listbox"
            aria-labelledby="vendor-label"
            aria-autocomplete="list"
            aria-activedescendant={vendorHighlight >= 0 ? `vendor-opt-${vendorHighlight}` : undefined}
            onChange={(e) => {
              const val = e.target.value;
              setForm({ ...form, vendor: val });
              setVendorDropdownOpen(true);
              setVendorHighlight(-1);
            }}
            onFocus={() => {
              setVendorDropdownOpen(true);
              setVendorHighlight(-1);
            }}
            onKeyDown={(e) => {
              if (!vendorDropdownOpen) return;
              const filtered = vendorOptions.filter((v) => !form.vendor || v.toLowerCase().includes(form.vendor.toLowerCase()));
              if (e.key === "ArrowDown") { e.preventDefault(); setVendorHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setVendorHighlight((h) => Math.max(h - 1, 0)); }
              else if (e.key === "Enter" && vendorHighlight >= 0 && filtered[vendorHighlight]) {
                e.preventDefault();
                setForm({ ...form, vendor: filtered[vendorHighlight] });
                setVendorDropdownOpen(false);
                setVendorHighlight(-1);
              } else if (e.key === "Escape") {
                setVendorDropdownOpen(false);
                setVendorHighlight(-1);
              }
            }}
            placeholder="Select or type..."
            required
          />
          {vendorDropdownOpen && (
            <ul id="vendor-listbox" role="listbox" aria-labelledby="vendor-label" className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto bg-gray-800 border border-gray-600 rounded shadow-lg">
              {vendorOptions
                .filter((v) => !form.vendor || v.toLowerCase().includes(form.vendor.toLowerCase()))
                .map((v, i) => (
                  <li
                    key={v}
                    id={`vendor-opt-${i}`}
                    role="option"
                    aria-selected={v === form.vendor}
                    className={`px-3 py-1.5 cursor-pointer text-gray-100 hover:bg-gray-700 ${i === vendorHighlight ? "bg-gray-600" : ""} ${v === form.vendor ? "bg-gray-700 font-semibold" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setForm({ ...form, vendor: v });
                      setVendorDropdownOpen(false);
                    }}
                  >
                    {v}
                  </li>
                ))}
              {form.vendor && !vendorOptions.some((v) => v.toLowerCase() === form.vendor.toLowerCase()) && (
                <li
                  role="option"
                  aria-selected={false}
                  className="px-3 py-1.5 cursor-pointer text-green-400 hover:bg-gray-700 border-t border-gray-600"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setVendorOptions((prev) => Array.from(new Set([...prev, form.vendor])).sort());
                    setVendorDropdownOpen(false);
                  }}
                >
                  + Add &quot;{form.vendor}&quot;
                </li>
              )}
            </ul>
          )}
        </div>
        <div ref={typeRef} className="relative">
          <label className={labelClass} id="type-label">Type *</label>
          <input
            className={inputClass}
            value={form.type}
            role="combobox"
            aria-expanded={typeDropdownOpen}
            aria-controls="type-listbox"
            aria-labelledby="type-label"
            aria-autocomplete="list"
            aria-activedescendant={typeHighlight >= 0 ? `type-opt-${typeHighlight}` : undefined}
            onChange={(e) => {
              const val = e.target.value.toUpperCase();
              setForm({ ...form, type: val });
              setTypeDropdownOpen(true);
              setTypeHighlight(-1);
            }}
            onFocus={() => {
              setTypeDropdownOpen(true);
              setTypeHighlight(-1);
            }}
            onKeyDown={(e) => {
              if (!typeDropdownOpen) return;
              const filtered = filamentTypes.filter((t) => !form.type || t.includes(form.type));
              if (e.key === "ArrowDown") { e.preventDefault(); setTypeHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setTypeHighlight((h) => Math.max(h - 1, 0)); }
              else if (e.key === "Enter" && typeHighlight >= 0 && filtered[typeHighlight]) {
                e.preventDefault();
                setForm({ ...form, type: filtered[typeHighlight] });
                setTypeDropdownOpen(false);
                setTypeHighlight(-1);
              } else if (e.key === "Escape") {
                setTypeDropdownOpen(false);
                setTypeHighlight(-1);
              }
            }}
            placeholder="Select or type..."
            required
          />
          {typeDropdownOpen && (
            <ul id="type-listbox" role="listbox" aria-labelledby="type-label" className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto bg-gray-800 border border-gray-600 rounded shadow-lg">
              {filamentTypes
                .filter((t) => !form.type || t.includes(form.type))
                .map((t, i) => (
                  <li
                    key={t}
                    id={`type-opt-${i}`}
                    role="option"
                    aria-selected={t === form.type}
                    className={`px-3 py-1.5 cursor-pointer text-gray-100 hover:bg-gray-700 ${i === typeHighlight ? "bg-gray-600" : ""} ${t === form.type ? "bg-gray-700 font-semibold" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setForm({ ...form, type: t });
                      setTypeDropdownOpen(false);
                    }}
                  >
                    {t}
                  </li>
                ))}
              {form.type && !filamentTypes.includes(form.type) && (
                <li
                  role="option"
                  aria-selected={false}
                  className="px-3 py-1.5 cursor-pointer text-green-400 hover:bg-gray-700 border-t border-gray-600"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setFilamentTypes((prev) => Array.from(new Set([...prev, form.type])).sort());
                    setTypeDropdownOpen(false);
                  }}
                >
                  + Add &quot;{form.type}&quot;
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
            min="0"
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

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">Spool Weight</legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>Net Filament (g)</label>
            <input
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.netFilamentWeight}
              onChange={(e) => setForm({ ...form, netFilamentWeight: e.target.value })}
              placeholder="e.g. 1000"
            />
          </div>
          <div>
            <label className={labelClass}>Empty Spool (g)</label>
            <input
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.spoolWeight}
              onChange={(e) => setForm({ ...form, spoolWeight: e.target.value })}
              placeholder="e.g. 250"
            />
          </div>
          <div>
            <label className={labelClass}>Initial Weight (g)</label>
            <input
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.totalWeight}
              onChange={(e) => setForm({ ...form, totalWeight: e.target.value })}
              placeholder="Weigh spool on scale"
            />
            <p className="text-xs text-gray-400 mt-1">Creates your first spool. Add more from the detail page.</p>
          </div>
        </div>
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-sm text-blue-600 hover:underline flex items-center gap-1"
        >
          <span className="text-xs">{showAdvanced ? "▾" : "▸"}</span>
          {showAdvanced ? "Hide" : "Show"} advanced settings
          <span className="text-gray-400 font-normal">(shrinkage, fan, retraction, flags)</span>
        </button>
      </div>

      {showAdvanced && (<>
      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">Shrinkage Compensation</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>Drying Temp (°C)</label>
          <input
            className={inputClass}
            type="number"
            step="1"
            min="0"
            value={form.dryingTemperature}
            onChange={(e) => setForm({ ...form, dryingTemperature: e.target.value })}
            placeholder="e.g. 45"
          />
        </div>
        <div>
          <label className={labelClass}>Drying Time (min)</label>
          <input
            className={inputClass}
            type="number"
            step="1"
            min="0"
            value={form.dryingTime}
            onChange={(e) => setForm({ ...form, dryingTime: e.target.value })}
            placeholder="e.g. 480"
          />
        </div>
        <div>
          <label className={labelClass}>HueForge TD</label>
          <input
            className={inputClass}
            type="number"
            step="any"
            min="0"
            value={form.transmissionDistance}
            onChange={(e) => setForm({ ...form, transmissionDistance: e.target.value })}
            placeholder="e.g. 6.6"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Shore Hardness A</label>
          <input
            className={inputClass}
            type="number"
            step="1"
            min="0"
            max="100"
            value={form.shoreHardnessA}
            onChange={(e) => setForm({ ...form, shoreHardnessA: e.target.value })}
            placeholder="e.g. 95 (TPU/TPE)"
          />
        </div>
        <div>
          <label className={labelClass}>Shore Hardness D</label>
          <input
            className={inputClass}
            type="number"
            step="1"
            min="0"
            max="100"
            value={form.shoreHardnessD}
            onChange={(e) => setForm({ ...form, shoreHardnessD: e.target.value })}
            placeholder="e.g. 60 (rigid)"
          />
        </div>
      </div>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">Material Tags</legend>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {([
            [4, "Abrasive"],
            [13, "Water Soluble"],
            [9, "Flexible"],
            [31, "Carbon Fiber"],
            [0, "Glass Fiber"],
            [16, "Matte"],
            [17, "Silk"],
            [22, "Sparkle"],
            [24, "Glow in the Dark"],
            [25, "Color Changing"],
            [71, "High Speed"],
            [49, "Recycled"],
            [2, "Transparent"],
            [3, "Translucent"],
            [19, "Wood Fill"],
            [20, "Metal Fill"],
            [12, "Biodegradable"],
            [5, "Food Safe"],
          ] as [number, string][]).map(([val, label]) => (
            <label key={val} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.optTags.includes(val) || (val === 4 && form.abrasive) || (val === 13 && form.soluble)}
                onChange={(e) => {
                  const checked = e.target.checked;
                  // Keep abrasive/soluble booleans in sync
                  const updates: Partial<FilamentFormData> = {};
                  if (val === 4) updates.abrasive = checked;
                  if (val === 13) updates.soluble = checked;
                  setForm((prev) => ({
                    ...prev,
                    ...updates,
                    optTags: checked
                      ? [...new Set([...prev.optTags, val])]
                      : prev.optTags.filter((t) => t !== val),
                  }));
                }}
                className="w-4 h-4"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      </>)}

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">Compatible Nozzles</legend>
        {nozzlesLoading ? (
          <p className="text-sm text-gray-400">Loading nozzles...</p>
        ) : nozzles.length > 0 && (
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => setForm({ ...form, compatibleNozzles: nozzles.map((n) => n._id) })}
              className="text-xs text-blue-600 hover:underline"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...form, compatibleNozzles: [] })}
              className="text-xs text-blue-600 hover:underline"
            >
              Clear All
            </button>
          </div>
        )}
        {!nozzlesLoading && nozzles.length === 0 && (
          <p className="text-sm text-gray-500">
            No nozzles defined yet. <a href="/nozzles/new" className="text-blue-600 hover:underline">Add one first.</a>
          </p>
        )}
        {nozzles.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
          <legend className="text-sm font-medium px-2">Calibrations</legend>
          <p className="text-xs text-gray-500 mb-3">
            Per-nozzle overrides for calibration values. Leave blank to use base defaults.
            {printers.length > 0 && " Select a printer tab for printer-specific calibrations."}
          </p>

          {/* Printer selector tabs */}
          {!printersLoading && printers.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-4 border-b border-gray-200 dark:border-gray-700 pb-2">
              <button
                type="button"
                onClick={() => setSelectedPrinter("default")}
                className={`px-3 py-1.5 text-sm rounded-t ${
                  selectedPrinter === "default"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                Default (any printer)
              </button>
              {printers.map((p) => (
                <button
                  key={p._id}
                  type="button"
                  onClick={() => setSelectedPrinter(p._id)}
                  className={`px-3 py-1.5 text-sm rounded-t ${
                    selectedPrinter === p._id
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-4">
            {form.compatibleNozzles.map((nozzleId) => {
              const nozzle = nozzles.find((n) => n._id === nozzleId);
              if (!nozzle) return null;
              const key = calKey(selectedPrinter === "default" ? null : selectedPrinter, nozzleId);
              const cal = calibrations[key] || {
                extrusionMultiplier: "",
                maxVolumetricSpeed: "",
                pressureAdvance: "",
                retractLength: "",
                retractSpeed: "",
                retractLift: "",
              };
              // Show default values as placeholders when viewing printer-specific calibrations
              const defaultKey = calKey(null, nozzleId);
              const defaultCal = selectedPrinter !== "default" ? calibrations[defaultKey] : undefined;
              return (
                <div
                  key={key}
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
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title="Extrusion Multiplier — flow rate scaling factor (e.g. 0.95)">EM</label>
                      <input
                        type="number"
                        step="0.01"
                        className={inputClass}
                        value={cal.extrusionMultiplier}
                        onChange={(e) =>
                          updateCalibration(key, "extrusionMultiplier", e.target.value)
                        }
                        placeholder={defaultCal?.extrusionMultiplier || form.extrusionMultiplier || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title="Maximum Volumetric Speed in mm³/s">Max Vol (mm³/s)</label>
                      <input
                        type="number"
                        step="0.1"
                        className={inputClass}
                        value={cal.maxVolumetricSpeed}
                        onChange={(e) =>
                          updateCalibration(key, "maxVolumetricSpeed", e.target.value)
                        }
                        placeholder={defaultCal?.maxVolumetricSpeed || form.maxVolumetricSpeed || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title="Pressure Advance — compensates for filament compression (e.g. 0.053)">PA</label>
                      <input
                        type="number"
                        step="0.001"
                        className={inputClass}
                        value={cal.pressureAdvance}
                        onChange={(e) =>
                          updateCalibration(key, "pressureAdvance", e.target.value)
                        }
                        placeholder={defaultCal?.pressureAdvance || form.pressureAdvance || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title="Retraction Length in mm">Retract (mm)</label>
                      <input
                        type="number"
                        step="0.1"
                        className={inputClass}
                        value={cal.retractLength}
                        onChange={(e) =>
                          updateCalibration(key, "retractLength", e.target.value)
                        }
                        placeholder={defaultCal?.retractLength || form.retractLength || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title="Retraction Speed in mm/s">Retract Speed (mm/s)</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={cal.retractSpeed}
                        onChange={(e) =>
                          updateCalibration(key, "retractSpeed", e.target.value)
                        }
                        placeholder={defaultCal?.retractSpeed || form.retractSpeed || "base"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title="Z Lift — nozzle raises by this amount during retraction">Z Lift (mm)</label>
                      <input
                        type="number"
                        step="0.01"
                        className={inputClass}
                        value={cal.retractLift}
                        onChange={(e) =>
                          updateCalibration(key, "retractLift", e.target.value)
                        }
                        placeholder={defaultCal?.retractLift || form.retractLift || "base"}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">
          Presets
          <span className="text-gray-400 font-normal ml-1">(e.g., shore hardness variants)</span>
        </legend>
        <p className="text-xs text-gray-500 mb-3">
          Define named presets with different temperature and extrusion multiplier settings.
        </p>
        {presets.length > 0 && (
          <div className="space-y-3">
            {presets.map((preset, idx) => (
              <div
                key={idx}
                className="border border-gray-200 dark:border-gray-700 rounded p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    className={inputClass}
                    value={preset.label}
                    onChange={(e) => updatePreset(idx, "label", e.target.value)}
                    placeholder="e.g. Shore 85A"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => removePreset(idx)}
                    className="text-red-500 hover:text-red-700 text-sm flex-shrink-0 px-2"
                    title="Remove preset"
                  >
                    ✕
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1" title="Extrusion Multiplier">EM</label>
                    <input
                      type="number"
                      step="0.01"
                      className={inputClass}
                      value={preset.extrusionMultiplier}
                      onChange={(e) => updatePreset(idx, "extrusionMultiplier", e.target.value)}
                      placeholder={form.extrusionMultiplier || "base"}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Nozzle (°C)</label>
                    <input
                      type="number"
                      className={inputClass}
                      value={preset.nozzle}
                      onChange={(e) => updatePreset(idx, "nozzle", e.target.value)}
                      placeholder={form.temperatures.nozzle || "base"}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Nozzle 1st (°C)</label>
                    <input
                      type="number"
                      className={inputClass}
                      value={preset.nozzleFirstLayer}
                      onChange={(e) => updatePreset(idx, "nozzleFirstLayer", e.target.value)}
                      placeholder={form.temperatures.nozzleFirstLayer || "base"}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Bed (°C)</label>
                    <input
                      type="number"
                      className={inputClass}
                      value={preset.bed}
                      onChange={(e) => updatePreset(idx, "bed", e.target.value)}
                      placeholder={form.temperatures.bed || "base"}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Bed 1st (°C)</label>
                    <input
                      type="number"
                      className={inputClass}
                      value={preset.bedFirstLayer}
                      onChange={(e) => updatePreset(idx, "bedFirstLayer", e.target.value)}
                      placeholder={form.temperatures.bedFirstLayer || "base"}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={addPreset}
          className="mt-2 text-sm text-blue-600 hover:underline"
        >
          + Add Preset
        </button>
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
