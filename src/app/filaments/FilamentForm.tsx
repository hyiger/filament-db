"use client";

import { useState, useEffect, useRef } from "react";
import { useCurrency } from "@/hooks/useCurrency";
import { useTranslation } from "@/i18n/TranslationProvider";

interface BedTypeTempEntry {
  bedType: string;
  temperature: string;
  firstLayerTemperature: string;
}

interface FilamentFormData {
  name: string;
  vendor: string;
  type: string;
  color: string;
  colorName: string;
  cost: string;
  density: string;
  diameter: string;
  temperatures: {
    nozzle: string;
    nozzleFirstLayer: string;
    nozzleRangeMin: string;
    nozzleRangeMax: string;
    bed: string;
    bedFirstLayer: string;
    standby: string;
    chamber: string;
  };
  bedTypeTemps: BedTypeTempEntry[];
  maxVolumetricSpeed: string;
  minPrintSpeed: string;
  maxPrintSpeed: string;
  extrusionMultiplier: string;
  shrinkageXY: string;
  shrinkageZ: string;
  shoreHardnessA: string;
  shoreHardnessD: string;
  glassTempTransition: string;
  heatDeflectionTemp: string;
  abrasive: boolean;
  soluble: boolean;
  optTags: number[];
  fanMinSpeed: string;
  fanMaxSpeed: string;
  fanBridgeSpeed: string;
  fanDisableFirstLayers: string;
  overhangFanSpeed: string;
  auxFanSpeed: string;
  fanBelowLayerTime: string;
  slowDownMinSpeed: string;
  activateAirFiltration: boolean;
  retractLength: string;
  retractSpeed: string;
  retractLift: string;
  retractMinTravel: string;
  pressureAdvance: string;
  zOffset: string;
  filamentLoadingSpeed: string;
  filamentUnloadingSpeed: string;
  filamentLoadTime: string;
  filamentUnloadTime: string;
  rammingParameters: string;
  wipe: boolean;
  spoolWeight: string;
  netFilamentWeight: string;
  totalWeight: string;
  spoolType: string;
  dryingTemperature: string;
  dryingTime: string;
  transmissionDistance: string;
  startGcode: string;
  endGcode: string;
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
  printers?: { _id: string; name: string }[];
}

interface BedTypeOption {
  _id: string;
  name: string;
  material: string;
}

interface CalibrationEntry {
  extrusionMultiplier: string;
  maxVolumetricSpeed: string;
  pressureAdvance: string;
  retractLength: string;
  retractSpeed: string;
  retractLift: string;
  nozzleTemp: string;
  nozzleTempFirstLayer: string;
  bedTemp: string;
  bedTempFirstLayer: string;
  chamberTemp: string;
  fanMinSpeed: string;
  fanMaxSpeed: string;
  fanBridgeSpeed: string;
}

interface PresetEntry {
  label: string;
  extrusionMultiplier: string;
  nozzle: string;
  nozzleFirstLayer: string;
  bed: string;
  bedFirstLayer: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type FilamentInitialData = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface Props {
  initialData?: FilamentInitialData;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
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

export default function FilamentForm({ initialData, onSubmit, onDirtyChange }: Props) {
  const { symbol: currencySymbol } = useCurrency();
  const { t } = useTranslation();
  const [nozzles, setNozzles] = useState<NozzleOption[]>([]);
  const [nozzlesLoading, setNozzlesLoading] = useState(true);
  const [printers, setPrinters] = useState<PrinterOption[]>([]);
  const [printersLoading, setPrintersLoading] = useState(true);
  const [bedTypes, setBedTypes] = useState<BedTypeOption[]>([]);
  const [bedTypesLoading, setBedTypesLoading] = useState(true);
  const [selectedPrinter, setSelectedPrinter] = useState<string>("default");
  const [selectedBedType, setSelectedBedType] = useState<string>("any");
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
    colorName: initialData?.colorName || "",
    cost: initialData?.cost?.toString() || "",
    density: initialData?.density?.toString() || "",
    diameter: initialData?.diameter?.toString() || "1.75",
    temperatures: {
      nozzle: initialData?.temperatures?.nozzle?.toString() || "",
      nozzleFirstLayer: initialData?.temperatures?.nozzleFirstLayer?.toString() || "",
      nozzleRangeMin: initialData?.temperatures?.nozzleRangeMin?.toString() || "",
      nozzleRangeMax: initialData?.temperatures?.nozzleRangeMax?.toString() || "",
      bed: initialData?.temperatures?.bed?.toString() || "",
      bedFirstLayer: initialData?.temperatures?.bedFirstLayer?.toString() || "",
      standby: initialData?.temperatures?.standby?.toString() || "",
      chamber: getSettingVal(initialData, "chamber_temperature"),
    },
    bedTypeTemps: (initialData?.bedTypeTemps || []).map((bt: Record<string, unknown>) => ({
      bedType: (bt.bedType as string) || "",
      temperature: bt.temperature?.toString() || "",
      firstLayerTemperature: bt.firstLayerTemperature?.toString() || "",
    })),
    maxVolumetricSpeed: initialData?.maxVolumetricSpeed?.toString() || "",
    minPrintSpeed: initialData?.minPrintSpeed?.toString() || "",
    maxPrintSpeed: initialData?.maxPrintSpeed?.toString() || "",
    extrusionMultiplier: getSettingVal(initialData, "extrusion_multiplier"),
    shrinkageXY: initialData?.shrinkageXY?.toString() || getSettingVal(initialData, "filament_shrinkage_compensation_xy"),
    shrinkageZ: initialData?.shrinkageZ?.toString() || getSettingVal(initialData, "filament_shrinkage_compensation_z"),
    shoreHardnessA: initialData?.shoreHardnessA?.toString() || "",
    shoreHardnessD: initialData?.shoreHardnessD?.toString() || "",
    glassTempTransition: initialData?.glassTempTransition?.toString() || "",
    heatDeflectionTemp: initialData?.heatDeflectionTemp?.toString() || "",
    abrasive: getSettingVal(initialData, "filament_abrasive") === "1",
    soluble: getSettingVal(initialData, "filament_soluble") === "1",
    optTags: initialData?.optTags || [],
    fanMinSpeed: getSettingVal(initialData, "min_fan_speed"),
    fanMaxSpeed: getSettingVal(initialData, "max_fan_speed"),
    fanBridgeSpeed: getSettingVal(initialData, "bridge_fan_speed"),
    fanDisableFirstLayers: getSettingVal(initialData, "disable_fan_first_layers"),
    overhangFanSpeed: getSettingVal(initialData, "overhang_fan_speed"),
    auxFanSpeed: getSettingVal(initialData, "additional_cooling_fan_speed"),
    fanBelowLayerTime: getSettingVal(initialData, "fan_below_layer_time"),
    slowDownMinSpeed: getSettingVal(initialData, "slow_down_min_speed"),
    activateAirFiltration: getSettingVal(initialData, "activate_air_filtration") === "1",
    retractLength: getSettingVal(initialData, "filament_retract_length"),
    retractSpeed: getSettingVal(initialData, "filament_retract_speed") === "nil" ? "" : getSettingVal(initialData, "filament_retract_speed"),
    retractLift: getSettingVal(initialData, "filament_retract_lift"),
    retractMinTravel: getSettingVal(initialData, "filament_retraction_minimum_travel"),
    pressureAdvance: extractPressureAdvance(initialData),
    zOffset: getSettingVal(initialData, "z_offset"),
    filamentLoadingSpeed: getSettingVal(initialData, "filament_loading_speed"),
    filamentUnloadingSpeed: getSettingVal(initialData, "filament_unloading_speed"),
    filamentLoadTime: getSettingVal(initialData, "filament_load_time"),
    filamentUnloadTime: getSettingVal(initialData, "filament_unload_time"),
    rammingParameters: getSettingVal(initialData, "filament_ramming_parameters"),
    wipe: getSettingVal(initialData, "filament_wipe") === "1",
    spoolWeight: initialData?.spoolWeight?.toString() || "",
    netFilamentWeight: initialData?.netFilamentWeight?.toString() || "",
    totalWeight: initialData?.totalWeight?.toString() || "",
    spoolType: initialData?.spoolType || "",
    dryingTemperature: initialData?.dryingTemperature?.toString() || "",
    dryingTime: initialData?.dryingTime?.toString() || "",
    transmissionDistance: initialData?.transmissionDistance?.toString() || "",
    startGcode: getSettingVal(initialData, "start_filament_gcode").replace(/^"|"$/g, ""),
    endGcode: getSettingVal(initialData, "end_filament_gcode").replace(/^"|"$/g, ""),
    notes: getSettingVal(initialData, "filament_notes").replace(/^"|"$/g, ""),
    tdsUrl: initialData?.tdsUrl || "",
    compatibleNozzles: getInitialNozzleIds(),
    inherits: initialData?.inherits || "",
    parentId: initialData?.parentId?._id || initialData?.parentId || "",
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

  // Track dirty state on any form field change via useEffect
  const initialFormRef = useRef(JSON.stringify(form));
  useEffect(() => {
    if (JSON.stringify(form) !== initialFormRef.current) {
      setDirty(true);
    }
  }, [form]);

  // Notify parent of dirty state changes
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const [showAdvanced, setShowAdvanced] = useState(() => {
    // Auto-expand if any advanced fields have values
    return !!(
      form.shrinkageXY || form.shrinkageZ ||
      form.fanMinSpeed || form.fanMaxSpeed || form.fanBridgeSpeed || form.fanDisableFirstLayers ||
      form.overhangFanSpeed || form.auxFanSpeed || form.fanBelowLayerTime || form.slowDownMinSpeed ||
      form.retractLength || form.retractSpeed || form.retractLift || form.retractMinTravel ||
      form.abrasive || form.soluble || form.optTags.length > 0 ||
      form.shoreHardnessA || form.shoreHardnessD ||
      form.glassTempTransition || form.heatDeflectionTemp ||
      form.dryingTemperature || form.dryingTime || form.transmissionDistance ||
      form.filamentLoadingSpeed || form.filamentUnloadingSpeed ||
      form.startGcode || form.endGcode || form.zOffset
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
    const ac = new AbortController();
    fetch("/api/filaments/types", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((dbTypes: string[]) => {
        const merged = Array.from(new Set([...DEFAULT_FILAMENT_TYPES, ...dbTypes])).sort();
        setFilamentTypes(merged);
      })
      .catch(() => { if (!ac.signal.aborted) addFetchError("filament types"); });
    return () => ac.abort();
  }, []);

  // Fetch distinct vendors from DB
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/filaments/vendors", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((v: string[]) => setVendorOptions(v))
      .catch(() => { if (!ac.signal.aborted) addFetchError("vendors"); });
    return () => ac.abort();
  }, []);

  // Fetch potential parent filaments
  useEffect(() => {
    const ac = new AbortController();
    const exclude = initialData?._id || "";
    fetch(`/api/filaments/parents${exclude ? `?exclude=${exclude}` : ""}`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setParentOptions)
      .catch(() => { if (!ac.signal.aborted) addFetchError("parent filaments"); })
      .finally(() => { if (!ac.signal.aborted) setParentsLoading(false); });
    return () => ac.abort();
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
    const ac = new AbortController();
    fetch(`/api/filaments?vendor=${encodeURIComponent(form.vendor)}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((data: { name: string; tdsUrl?: string }[]) => {
        const suggestions = data
          .filter((f) => f.tdsUrl && f.name !== form.name)
          .map((f) => ({ name: f.name, tdsUrl: f.tdsUrl! }));
        setTdsSuggestions(suggestions);
      })
      .catch((err) => { if (!ac.signal.aborted) console.error(err); });
    return () => ac.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.vendor]);

  const calKey = (printerId: string | null, nozzleId: string, bedTypeId: string | null = null) =>
    `${printerId || "default"}:${nozzleId}:${bedTypeId || "any"}`;

  const emptyCalibrationEntry: CalibrationEntry = {
    extrusionMultiplier: "",
    maxVolumetricSpeed: "",
    pressureAdvance: "",
    retractLength: "",
    retractSpeed: "",
    retractLift: "",
    nozzleTemp: "",
    nozzleTempFirstLayer: "",
    bedTemp: "",
    bedTempFirstLayer: "",
    chamberTemp: "",
    fanMinSpeed: "",
    fanMaxSpeed: "",
    fanBridgeSpeed: "",
  };

  const getInitialCalibrations = (): Record<string, CalibrationEntry> => {
    const cals: Record<string, CalibrationEntry> = {};
    if (!initialData?.calibrations) return cals;
    for (const cal of initialData.calibrations) {
      const nozzleId = typeof cal.nozzle === "string" ? cal.nozzle : cal.nozzle?._id;
      if (!nozzleId) continue;
      const printerId = cal.printer
        ? (typeof cal.printer === "string" ? cal.printer : cal.printer._id)
        : null;
      const bedTypeId = cal.bedType
        ? (typeof cal.bedType === "string" ? cal.bedType : cal.bedType._id)
        : null;
      cals[calKey(printerId, nozzleId, bedTypeId)] = {
        extrusionMultiplier: cal.extrusionMultiplier?.toString() || "",
        maxVolumetricSpeed: cal.maxVolumetricSpeed?.toString() || "",
        pressureAdvance: cal.pressureAdvance?.toString() || "",
        retractLength: cal.retractLength?.toString() || "",
        retractSpeed: cal.retractSpeed?.toString() || "",
        retractLift: cal.retractLift?.toString() || "",
        nozzleTemp: cal.nozzleTemp?.toString() || "",
        nozzleTempFirstLayer: cal.nozzleTempFirstLayer?.toString() || "",
        bedTemp: cal.bedTemp?.toString() || "",
        bedTempFirstLayer: cal.bedTempFirstLayer?.toString() || "",
        chamberTemp: cal.chamberTemp?.toString() || "",
        fanMinSpeed: cal.fanMinSpeed?.toString() || "",
        fanMaxSpeed: cal.fanMaxSpeed?.toString() || "",
        fanBridgeSpeed: cal.fanBridgeSpeed?.toString() || "",
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
        ...(prev[key] || emptyCalibrationEntry),
        [field]: value,
      },
    }));
  };

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/nozzles", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setNozzles)
      .catch(() => { if (!ac.signal.aborted) addFetchError("nozzles"); })
      .finally(() => { if (!ac.signal.aborted) setNozzlesLoading(false); });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/printers", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setPrinters)
      .catch(() => { if (!ac.signal.aborted) addFetchError("printers"); })
      .finally(() => { if (!ac.signal.aborted) setPrintersLoading(false); });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/bed-types", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setBedTypes)
      .catch(() => { if (!ac.signal.aborted) addFetchError("bed types"); })
      .finally(() => { if (!ac.signal.aborted) setBedTypesLoading(false); });
    return () => ac.abort();
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
    settings.filament_retraction_minimum_travel = form.retractMinTravel || undefined;
    settings.overhang_fan_speed = form.overhangFanSpeed || undefined;
    settings.additional_cooling_fan_speed = form.auxFanSpeed || undefined;
    settings.fan_below_layer_time = form.fanBelowLayerTime || undefined;
    settings.slow_down_min_speed = form.slowDownMinSpeed || undefined;
    settings.activate_air_filtration = form.activateAirFiltration ? "1" : "0";
    settings.z_offset = form.zOffset || undefined;
    settings.filament_loading_speed = form.filamentLoadingSpeed || undefined;
    settings.filament_unloading_speed = form.filamentUnloadingSpeed || undefined;
    settings.filament_load_time = form.filamentLoadTime || undefined;
    settings.filament_unload_time = form.filamentUnloadTime || undefined;
    settings.filament_ramming_parameters = form.rammingParameters || undefined;
    settings.filament_wipe = form.wipe ? "1" : "0";
    settings.end_filament_gcode = form.endGcode ? `"${form.endGcode}"` : undefined;
    settings.filament_notes = form.notes ? `"${form.notes}"` : undefined;

    // Handle start G-code: if the user edited it directly, use that; otherwise manage PA injection
    if (form.startGcode) {
      settings.start_filament_gcode = `"${form.startGcode}"`;
    } else if (form.pressureAdvance) {
      settings.start_filament_gcode = `"M572 S${form.pressureAdvance}"`;
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
        colorName: form.colorName || null,
        cost: parseNum(form.cost),
        density: parseNum(form.density),
        diameter: parseNum(form.diameter) ?? 1.75,
        temperatures: {
          nozzle: parseNum(form.temperatures.nozzle),
          nozzleFirstLayer: parseNum(form.temperatures.nozzleFirstLayer),
          nozzleRangeMin: parseNum(form.temperatures.nozzleRangeMin),
          nozzleRangeMax: parseNum(form.temperatures.nozzleRangeMax),
          bed: parseNum(form.temperatures.bed),
          bedFirstLayer: parseNum(form.temperatures.bedFirstLayer),
          standby: parseNum(form.temperatures.standby),
        },
        bedTypeTemps: form.bedTypeTemps
          .filter((bt) => bt.bedType.trim() !== "")
          .map((bt) => ({
            bedType: bt.bedType.trim(),
            temperature: parseNum(bt.temperature),
            firstLayerTemperature: parseNum(bt.firstLayerTemperature),
          })),
        maxVolumetricSpeed: parseNum(form.maxVolumetricSpeed),
        minPrintSpeed: parseNum(form.minPrintSpeed),
        maxPrintSpeed: parseNum(form.maxPrintSpeed),
        compatibleNozzles: form.compatibleNozzles,
        calibrations: Object.entries(calibrations)
          .filter(([, cal]) => Object.values(cal).some((v) => v !== ""))
          .filter(([key]) => {
            const [, nozzleId] = key.split(":");
            return form.compatibleNozzles.includes(nozzleId);
          })
          .map(([key, cal]) => {
            const [printerId, nozzleId, bedTypeId] = key.split(":");
            return {
              printer: printerId === "default" ? null : printerId,
              nozzle: nozzleId,
              bedType: bedTypeId === "any" ? null : bedTypeId,
              extrusionMultiplier: parseNum(cal.extrusionMultiplier),
              maxVolumetricSpeed: parseNum(cal.maxVolumetricSpeed),
              pressureAdvance: parseNum(cal.pressureAdvance),
              retractLength: parseNum(cal.retractLength),
              retractSpeed: parseNum(cal.retractSpeed),
              retractLift: parseNum(cal.retractLift),
              nozzleTemp: parseNum(cal.nozzleTemp),
              nozzleTempFirstLayer: parseNum(cal.nozzleTempFirstLayer),
              bedTemp: parseNum(cal.bedTemp),
              bedTempFirstLayer: parseNum(cal.bedTempFirstLayer),
              chamberTemp: parseNum(cal.chamberTemp),
              fanMinSpeed: parseNum(cal.fanMinSpeed),
              fanMaxSpeed: parseNum(cal.fanMaxSpeed),
              fanBridgeSpeed: parseNum(cal.fanBridgeSpeed),
            };
          }),
        spoolWeight: parseNum(form.spoolWeight),
        netFilamentWeight: parseNum(form.netFilamentWeight),
        totalWeight: parseNum(form.totalWeight),
        spoolType: form.spoolType || null,
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
        glassTempTransition: parseNum(form.glassTempTransition),
        heatDeflectionTemp: parseNum(form.heatDeflectionTemp),
        shrinkageXY: parseNum(form.shrinkageXY),
        shrinkageZ: parseNum(form.shrinkageZ),
        shoreHardnessA: parseNum(form.shoreHardnessA),
        shoreHardnessD: parseNum(form.shoreHardnessD),
        optTags: form.optTags,
        tdsUrl: form.tdsUrl || null,
        inherits: form.inherits || null,
        parentId: form.parentId || null,
        settings,
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
      {fetchErrors.length > 0 && (
        <div className="px-3 py-2 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded text-sm text-yellow-700 dark:text-yellow-300">
          {t("form.fetchError", { items: fetchErrors.join(", ") })}
        </div>
      )}

      <div>
        <label className={labelClass}>{t("form.name")} *</label>
        <input
          className={inputClass}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
      </div>

      <div ref={parentRef} className="relative">
        <label className={labelClass}>
          {t("form.parentFilament")}
          <span className="text-gray-400 font-normal ml-1">({t("form.parentFilamentHint")})</span>
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
                <span className="text-gray-500">{t("form.loading")}</span>
              );
            })()}
            <button
              type="button"
              onClick={() => setForm({ ...form, parentId: "" })}
              className="text-red-500 hover:text-red-700 text-xs ml-2"
            >
              {t("form.remove")}
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
              placeholder={t("form.placeholder.parentSearch")}
            />
            {parentDropdownOpen && (
              <ul id="parent-listbox" role="listbox" className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg">
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
                      className={`px-3 py-2 cursor-pointer text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 ${i === parentHighlight ? "bg-gray-100 dark:bg-gray-600" : ""}`}
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
                    {parentsLoading ? t("form.loading") : t("form.noMatchingFilaments")}
                  </li>
                )}
              </ul>
            )}
          </>
        )}
        {form.parentId && (
          <p className="text-xs text-gray-500 mt-1">
            {t("form.parentInheritHint")}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div ref={vendorRef} className="relative">
          <label className={labelClass} id="vendor-label">{t("form.vendor")} *</label>
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
            placeholder={t("form.placeholder.selectOrType")}
            required
          />
          {vendorDropdownOpen && (
            <ul id="vendor-listbox" role="listbox" aria-labelledby="vendor-label" className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg">
              {vendorOptions
                .filter((v) => !form.vendor || v.toLowerCase().includes(form.vendor.toLowerCase()))
                .map((v, i) => (
                  <li
                    key={v}
                    id={`vendor-opt-${i}`}
                    role="option"
                    aria-selected={v === form.vendor}
                    className={`px-3 py-1.5 cursor-pointer text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 ${i === vendorHighlight ? "bg-gray-100 dark:bg-gray-600" : ""} ${v === form.vendor ? "bg-gray-200 dark:bg-gray-700 font-semibold" : ""}`}
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
                  className="px-3 py-1.5 cursor-pointer text-green-600 dark:text-green-400 hover:bg-gray-100 dark:hover:bg-gray-700 border-t border-gray-200 dark:border-gray-600"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setVendorOptions((prev) => Array.from(new Set([...prev, form.vendor])).sort());
                    setVendorDropdownOpen(false);
                  }}
                >
                  {t("form.addItem", { item: form.vendor })}
                </li>
              )}
            </ul>
          )}
        </div>
        <div ref={typeRef} className="relative">
          <label className={labelClass} id="type-label">{t("form.type")} *</label>
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
              const filtered = filamentTypes.filter((ft) => !form.type || ft.includes(form.type));
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
            placeholder={t("form.placeholder.selectOrType")}
            required
          />
          {typeDropdownOpen && (
            <ul id="type-listbox" role="listbox" aria-labelledby="type-label" className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg">
              {filamentTypes
                .filter((ft) => !form.type || ft.includes(form.type))
                .map((ft, i) => (
                  <li
                    key={ft}
                    id={`type-opt-${i}`}
                    role="option"
                    aria-selected={ft === form.type}
                    className={`px-3 py-1.5 cursor-pointer text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 ${i === typeHighlight ? "bg-gray-100 dark:bg-gray-600" : ""} ${ft === form.type ? "bg-gray-200 dark:bg-gray-700 font-semibold" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setForm({ ...form, type: ft });
                      setTypeDropdownOpen(false);
                    }}
                  >
                    {ft}
                  </li>
                ))}
              {form.type && !filamentTypes.includes(form.type) && (
                <li
                  role="option"
                  aria-selected={false}
                  className="px-3 py-1.5 cursor-pointer text-green-600 dark:text-green-400 hover:bg-gray-100 dark:hover:bg-gray-700 border-t border-gray-200 dark:border-gray-600"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setFilamentTypes((prev) => Array.from(new Set([...prev, form.type])).sort());
                    setTypeDropdownOpen(false);
                  }}
                >
                  {t("form.addItem", { item: form.type })}
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <label className={labelClass}>{t("form.color")}</label>
          <div className="flex gap-2">
            <input
              type="color"
              aria-label={t("form.color")}
              className="h-10 w-12 rounded border border-gray-300 dark:border-gray-600 cursor-pointer bg-transparent flex-shrink-0"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
            />
            <input
              type="text"
              inputMode="text"
              className={`${inputClass} font-mono uppercase`}
              value={form.color}
              placeholder="#RRGGBB"
              maxLength={7}
              onChange={(e) => {
                const raw = e.target.value.trim();
                // Allow incremental typing: prepend # if missing, keep only hex chars
                let v = raw.startsWith("#") ? raw : `#${raw}`;
                v = "#" + v.slice(1).replace(/[^0-9a-fA-F]/g, "");
                setForm({ ...form, color: v.slice(0, 7) });
              }}
              onBlur={(e) => {
                const v = e.target.value.trim();
                // Expand 3-digit shorthand on blur (e.g. #abc → #aabbcc)
                const m = v.match(/^#([0-9a-fA-F]{3})$/);
                if (m) {
                  const [r, g, b] = m[1].split("");
                  setForm({ ...form, color: `#${r}${r}${g}${g}${b}${b}` });
                }
              }}
            />
          </div>
        </div>
        <div>
          <label className={labelClass}>{t("form.colorName")}</label>
          <input
            className={inputClass}
            value={form.colorName}
            onChange={(e) => setForm({ ...form, colorName: e.target.value })}
            placeholder={t("form.placeholder.colorName")}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.cost", { symbol: currencySymbol })}</label>
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
          <label className={labelClass}>{t("form.density")}</label>
          <input
            type="number"
            step="0.01"
            min="0"
            className={inputClass}
            value={form.density}
            onChange={(e) => setForm({ ...form, density: e.target.value })}
          />
        </div>
      </div>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("form.section.spoolWeight")}</legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>{t("form.netFilament")}</label>
            <input
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.netFilamentWeight}
              onChange={(e) => setForm({ ...form, netFilamentWeight: e.target.value })}
              placeholder={t("form.placeholder.netFilament")}
            />
            <p className="text-xs text-gray-400 mt-1">{t("form.netFilamentHint")}</p>
          </div>
          <div>
            <label className={labelClass}>{t("form.emptySpool")}</label>
            <input
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.spoolWeight}
              onChange={(e) => setForm({ ...form, spoolWeight: e.target.value })}
              placeholder={t("form.placeholder.emptySpool")}
            />
            <p className="text-xs text-gray-400 mt-1">{t("form.emptySpoolHint")}</p>
          </div>
          <div>
            <label className={labelClass}>{t("form.initialWeight")}</label>
            <input
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.totalWeight}
              onChange={(e) => setForm({ ...form, totalWeight: e.target.value })}
              placeholder={t("form.placeholder.initialWeight")}
            />
            <p className="text-xs text-gray-400 mt-1">{t("form.initialWeightHint")}</p>
          </div>
        </div>
      </fieldset>

      {/* EM, PA, and Max Vol. Speed are nozzle-specific — they belong in the
          Calibrations section below, not here at the top level. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>{t("form.minPrintSpeed")}</label>
          <input type="number" step="1" min="0" className={inputClass}
            value={form.minPrintSpeed}
            onChange={(e) => setForm({ ...form, minPrintSpeed: e.target.value })}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.maxPrintSpeed")}</label>
          <input type="number" step="1" min="0" className={inputClass}
            value={form.maxPrintSpeed}
            onChange={(e) => setForm({ ...form, maxPrintSpeed: e.target.value })}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.zOffset")}</label>
          <input type="number" step="0.001" className={inputClass}
            value={form.zOffset}
            onChange={(e) => setForm({ ...form, zOffset: e.target.value })}
            placeholder={t("form.placeholder.zOffset")}
          />
        </div>
      </div>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("form.section.temperatures")}</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t("form.nozzleTemp")}</label>
            <input
              type="number"
              min="0"
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
            <label className={labelClass}>{t("form.nozzleFirstLayer")}</label>
            <input
              type="number"
              min="0"
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
            <label className={labelClass}>{t("form.bedTemp")}</label>
            <input
              type="number"
              min="0"
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
            <label className={labelClass}>{t("form.bedFirstLayer")}</label>
            <input
              type="number"
              min="0"
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
            <label className={labelClass}>{t("form.chamberTemp")}</label>
            <input
              type="number"
              min="0"
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
          <div>
            <label className={labelClass}>{t("form.standbyTemp")}</label>
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.temperatures.standby}
              onChange={(e) =>
                setForm({
                  ...form,
                  temperatures: { ...form.temperatures, standby: e.target.value },
                })
              }
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.nozzleRangeMin")}</label>
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.temperatures.nozzleRangeMin}
              onChange={(e) =>
                setForm({
                  ...form,
                  temperatures: { ...form.temperatures, nozzleRangeMin: e.target.value },
                })
              }
              placeholder={t("form.placeholder.safeMinimum")}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.nozzleRangeMax")}</label>
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.temperatures.nozzleRangeMax}
              onChange={(e) =>
                setForm({
                  ...form,
                  temperatures: { ...form.temperatures, nozzleRangeMax: e.target.value },
                })
              }
              placeholder={t("form.placeholder.safeMaximum")}
            />
          </div>
        </div>

        {/* Per-bed-type temperatures */}
        {form.bedTypeTemps.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-gray-400 font-medium uppercase">{t("form.perBedTypeTemps")}</p>
            {form.bedTypeTemps.map((bt, idx) => (
              <div key={idx} className="grid grid-cols-4 gap-2 items-end">
                <div>
                  <input className={inputClass} value={bt.bedType} onChange={(e) => {
                    const updated = [...form.bedTypeTemps];
                    updated[idx] = { ...bt, bedType: e.target.value };
                    setForm({ ...form, bedTypeTemps: updated });
                  }} placeholder={t("form.placeholder.bedType")} />
                </div>
                <div>
                  <input type="number" min="0" className={inputClass} value={bt.temperature} onChange={(e) => {
                    const updated = [...form.bedTypeTemps];
                    updated[idx] = { ...bt, temperature: e.target.value };
                    setForm({ ...form, bedTypeTemps: updated });
                  }} placeholder={t("form.placeholder.temp")} />
                </div>
                <div>
                  <input type="number" min="0" className={inputClass} value={bt.firstLayerTemperature} onChange={(e) => {
                    const updated = [...form.bedTypeTemps];
                    updated[idx] = { ...bt, firstLayerTemperature: e.target.value };
                    setForm({ ...form, bedTypeTemps: updated });
                  }} placeholder={t("form.placeholder.firstLayer")} />
                </div>
                <button type="button" className="text-red-500 text-sm hover:underline" onClick={() => {
                  setForm({ ...form, bedTypeTemps: form.bedTypeTemps.filter((_, i) => i !== idx) });
                }}>{t("form.remove")}</button>
              </div>
            ))}
          </div>
        )}
        <button type="button" className="mt-2 text-xs text-blue-600 hover:underline" onClick={() => {
          setForm({ ...form, bedTypeTemps: [...form.bedTypeTemps, { bedType: "", temperature: "", firstLayerTemperature: "" }] });
        }}>{t("form.addBedType")}</button>
      </fieldset>

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-sm text-blue-600 hover:underline flex items-center gap-1"
        >
          <span className="text-xs">{showAdvanced ? "▾" : "▸"}</span>
          {showAdvanced ? t("form.hideAdvanced") : t("form.showAdvanced")}
          <span className="text-gray-400 font-normal">({t("form.advancedHint")})</span>
        </button>
      </div>

      {showAdvanced && (<>
      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("form.section.shrinkage")}</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t("form.shrinkageXY")}</label>
            <input
              type="text"
              className={inputClass}
              value={form.shrinkageXY}
              onChange={(e) => setForm({ ...form, shrinkageXY: e.target.value })}
              placeholder={t("form.placeholder.shrinkage")}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.shrinkageZ")}</label>
            <input
              type="text"
              className={inputClass}
              value={form.shrinkageZ}
              onChange={(e) => setForm({ ...form, shrinkageZ: e.target.value })}
              placeholder={t("form.placeholder.shrinkage")}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("form.section.fan")}</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t("form.fanMinSpeed")}</label>
            <input
              type="number"
              className={inputClass}
              value={form.fanMinSpeed}
              onChange={(e) => setForm({ ...form, fanMinSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.fanMaxSpeed")}</label>
            <input
              type="number"
              className={inputClass}
              value={form.fanMaxSpeed}
              onChange={(e) => setForm({ ...form, fanMaxSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.fanBridgeSpeed")}</label>
            <input
              type="number"
              className={inputClass}
              value={form.fanBridgeSpeed}
              onChange={(e) => setForm({ ...form, fanBridgeSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.fanDisableFirstLayers")}</label>
            <input
              type="number"
              className={inputClass}
              value={form.fanDisableFirstLayers}
              onChange={(e) => setForm({ ...form, fanDisableFirstLayers: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.overhangFanSpeed")}</label>
            <input type="number" className={inputClass}
              value={form.overhangFanSpeed}
              onChange={(e) => setForm({ ...form, overhangFanSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.auxFanSpeed")}</label>
            <input type="number" className={inputClass}
              value={form.auxFanSpeed}
              onChange={(e) => setForm({ ...form, auxFanSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.fanBelowLayerTime")}</label>
            <input type="number" className={inputClass}
              value={form.fanBelowLayerTime}
              onChange={(e) => setForm({ ...form, fanBelowLayerTime: e.target.value })}
              placeholder={t("form.placeholder.fanBelowLayerTime")}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.slowDownMinSpeed")}</label>
            <input type="number" className={inputClass}
              value={form.slowDownMinSpeed}
              onChange={(e) => setForm({ ...form, slowDownMinSpeed: e.target.value })}
              placeholder={t("form.placeholder.slowDownMinSpeed")}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <input type="checkbox" id="airFiltration" checked={form.activateAirFiltration}
            onChange={(e) => setForm({ ...form, activateAirFiltration: e.target.checked })} className="w-4 h-4" />
          <label htmlFor="airFiltration" className="text-sm font-medium">{t("form.activateAirFiltration")}</label>
        </div>
      </fieldset>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("form.section.retraction")}</legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>{t("form.retractLength")}</label>
            <input
              type="number"
              step="0.1"
              className={inputClass}
              value={form.retractLength}
              onChange={(e) => setForm({ ...form, retractLength: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.retractSpeed")}</label>
            <input
              type="number"
              className={inputClass}
              value={form.retractSpeed}
              onChange={(e) => setForm({ ...form, retractSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.retractZLift")}</label>
            <input
              type="number"
              step="0.01"
              className={inputClass}
              value={form.retractLift}
              onChange={(e) => setForm({ ...form, retractLift: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.retractMinTravel")}</label>
            <input type="number" step="0.1" className={inputClass}
              value={form.retractMinTravel}
              onChange={(e) => setForm({ ...form, retractMinTravel: e.target.value })}
              placeholder={t("form.placeholder.retractMinTravel")}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <input type="checkbox" id="wipe" checked={form.wipe}
            onChange={(e) => setForm({ ...form, wipe: e.target.checked })} className="w-4 h-4" />
          <label htmlFor="wipe" className="text-sm font-medium">{t("form.enableWipe")}</label>
        </div>
      </fieldset>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("form.section.multiMaterial")}</legend>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <label className={labelClass}>{t("form.loadingSpeed")}</label>
            <input type="number" step="0.1" className={inputClass}
              value={form.filamentLoadingSpeed}
              onChange={(e) => setForm({ ...form, filamentLoadingSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.unloadingSpeed")}</label>
            <input type="number" step="0.1" className={inputClass}
              value={form.filamentUnloadingSpeed}
              onChange={(e) => setForm({ ...form, filamentUnloadingSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.loadTime")}</label>
            <input type="number" step="0.1" className={inputClass}
              value={form.filamentLoadTime}
              onChange={(e) => setForm({ ...form, filamentLoadTime: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.unloadTime")}</label>
            <input type="number" step="0.1" className={inputClass}
              value={form.filamentUnloadTime}
              onChange={(e) => setForm({ ...form, filamentUnloadTime: e.target.value })}
            />
          </div>
        </div>
        <div className="mt-3">
          <label className={labelClass}>{t("form.rammingParameters")}</label>
          <input className={inputClass}
            value={form.rammingParameters}
            onChange={(e) => setForm({ ...form, rammingParameters: e.target.value })}
            placeholder={t("form.placeholder.rammingParameters")}
          />
        </div>
      </fieldset>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("form.section.materialProperties")}</legend>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>{t("form.glassTempTransition")}</label>
          <input type="number" step="1" min="0" className={inputClass}
            value={form.glassTempTransition}
            onChange={(e) => setForm({ ...form, glassTempTransition: e.target.value })}
            placeholder={t("form.placeholder.glassTempTransition")}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.heatDeflectionTemp")}</label>
          <input type="number" step="1" min="0" className={inputClass}
            value={form.heatDeflectionTemp}
            onChange={(e) => setForm({ ...form, heatDeflectionTemp: e.target.value })}
            placeholder={t("form.placeholder.heatDeflectionTemp")}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.transmissionDistance")}</label>
          <input type="number" step="any" min="0" className={inputClass}
            value={form.transmissionDistance}
            onChange={(e) => setForm({ ...form, transmissionDistance: e.target.value })}
            placeholder={t("form.placeholder.transmissionDistance")}
          />
        </div>
        </div>
      </fieldset>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>{t("form.dryingTemp")}</label>
          <input
            className={inputClass}
            type="number"
            step="1"
            min="0"
            value={form.dryingTemperature}
            onChange={(e) => setForm({ ...form, dryingTemperature: e.target.value })}
            placeholder={t("form.placeholder.dryingTemp")}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.dryingTime")}</label>
          <input
            className={inputClass}
            type="number"
            step="1"
            min="0"
            value={form.dryingTime}
            onChange={(e) => setForm({ ...form, dryingTime: e.target.value })}
            placeholder={t("form.placeholder.dryingTime")}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.spoolType")}</label>
          <select className={inputClass} value={form.spoolType}
            onChange={(e) => setForm({ ...form, spoolType: e.target.value })}>
            <option value="">—</option>
            <option value="plastic">{t("form.spoolType.plastic")}</option>
            <option value="cardboard">{t("form.spoolType.cardboard")}</option>
            <option value="metal">{t("form.spoolType.metal")}</option>
            <option value="refill">{t("form.spoolType.refill")}</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{t("form.shoreHardnessA")}</label>
          <input
            className={inputClass}
            type="number"
            step="1"
            min="0"
            max="100"
            value={form.shoreHardnessA}
            onChange={(e) => setForm({ ...form, shoreHardnessA: e.target.value })}
            placeholder={t("form.placeholder.shoreHardnessA")}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.shoreHardnessD")}</label>
          <input
            className={inputClass}
            type="number"
            step="1"
            min="0"
            max="100"
            value={form.shoreHardnessD}
            onChange={(e) => setForm({ ...form, shoreHardnessD: e.target.value })}
            placeholder={t("form.placeholder.shoreHardnessD")}
          />
        </div>
      </div>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("form.section.materialTags")}</legend>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {([
            [4, t("form.tag.abrasive")],
            [13, t("form.tag.waterSoluble")],
            [9, t("form.tag.flexible")],
            [31, t("form.tag.carbonFiber")],
            [0, t("form.tag.glassFiber")],
            [16, t("form.tag.matte")],
            [17, t("form.tag.silk")],
            [22, t("form.tag.sparkle")],
            [24, t("form.tag.glowInTheDark")],
            [25, t("form.tag.colorChanging")],
            [71, t("form.tag.highSpeed")],
            [49, t("form.tag.recycled")],
            [2, t("form.tag.transparent")],
            [3, t("form.tag.translucent")],
            [19, t("form.tag.woodFill")],
            [20, t("form.tag.metalFill")],
            [12, t("form.tag.biodegradable")],
            [5, t("form.tag.foodSafe")],
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
                      : prev.optTags.filter((ft) => ft !== val),
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
        <legend className="text-sm font-medium px-2">{t("form.section.compatibleNozzles")}</legend>
        {nozzlesLoading ? (
          <p className="text-sm text-gray-400">{t("form.loadingNozzles")}</p>
        ) : nozzles.length > 0 && (
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => setForm({ ...form, compatibleNozzles: nozzles.map((n) => n._id) })}
              className="text-xs text-blue-600 hover:underline"
            >
              {t("form.selectAll")}
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...form, compatibleNozzles: [] })}
              className="text-xs text-blue-600 hover:underline"
            >
              {t("form.clearAll")}
            </button>
          </div>
        )}
        {!nozzlesLoading && nozzles.length === 0 && (
          <p className="text-sm text-gray-500">
            {t("form.noNozzlesDefined")} <a href="/nozzles/new" className="text-blue-600 hover:underline">{t("form.addOneFirst")}</a>
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
                  {n.printers && n.printers.length > 0 && (
                    <span className="ml-1.5 text-xs text-indigo-700 dark:text-indigo-300">
                      · {n.printers.map((p) => p.name).join(", ")}
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
          <legend className="text-sm font-medium px-2">{t("form.section.calibrations")}</legend>
          <p className="text-xs text-gray-500 mb-3">
            {t("form.calibrationsHint")}
            {printers.length > 0 && ` ${t("form.calibrationsPrinterHint")}`}
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
                {t("form.defaultAnyPrinter")}
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

          {/* Bed type selector tabs */}
          {!bedTypesLoading && bedTypes.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-4 border-b border-gray-200 dark:border-gray-700 pb-2">
              <button
                type="button"
                onClick={() => setSelectedBedType("any")}
                className={`px-3 py-1.5 text-sm rounded-t ${
                  selectedBedType === "any"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {t("form.cal.anyBed")}
              </button>
              {bedTypes.map((b) => (
                <button
                  key={b._id}
                  type="button"
                  onClick={() => setSelectedBedType(b._id)}
                  className={`px-3 py-1.5 text-sm rounded-t ${
                    selectedBedType === b._id
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                  }`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-4">
            {form.compatibleNozzles.map((nozzleId) => {
              const nozzle = nozzles.find((n) => n._id === nozzleId);
              if (!nozzle) return null;
              const printerId = selectedPrinter === "default" ? null : selectedPrinter;
              const bedTypeId = selectedBedType === "any" ? null : selectedBedType;
              const key = calKey(printerId, nozzleId, bedTypeId);
              const cal = calibrations[key] || emptyCalibrationEntry;
              // Show default values as placeholders when viewing printer/bed-specific calibrations
              const defaultKey = calKey(null, nozzleId, null);
              const isOverride = selectedPrinter !== "default" || selectedBedType !== "any";
              const defaultCal = isOverride ? calibrations[defaultKey] : undefined;
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
                    {nozzle.printers && nozzle.printers.length > 0 && (
                      <span className="ml-1.5 text-xs font-normal text-indigo-700 dark:text-indigo-300">
                        · {nozzle.printers.map((p) => p.name).join(", ")}
                      </span>
                    )}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title={t("form.tooltip.em")}>{t("form.cal.em")}</label>
                      <input
                        type="number"
                        step="0.01"
                        className={inputClass}
                        value={cal.extrusionMultiplier}
                        onChange={(e) =>
                          updateCalibration(key, "extrusionMultiplier", e.target.value)
                        }
                        placeholder={defaultCal?.extrusionMultiplier || form.extrusionMultiplier || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title={t("form.tooltip.maxVol")}>{t("form.cal.maxVol")}</label>
                      <input
                        type="number"
                        step="0.1"
                        className={inputClass}
                        value={cal.maxVolumetricSpeed}
                        onChange={(e) =>
                          updateCalibration(key, "maxVolumetricSpeed", e.target.value)
                        }
                        placeholder={defaultCal?.maxVolumetricSpeed || form.maxVolumetricSpeed || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title={t("form.tooltip.pa")}>{t("form.cal.pa")}</label>
                      <input
                        type="number"
                        step="0.001"
                        className={inputClass}
                        value={cal.pressureAdvance}
                        onChange={(e) =>
                          updateCalibration(key, "pressureAdvance", e.target.value)
                        }
                        placeholder={defaultCal?.pressureAdvance || form.pressureAdvance || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title={t("form.tooltip.retractLength")}>{t("form.cal.retract")}</label>
                      <input
                        type="number"
                        step="0.1"
                        className={inputClass}
                        value={cal.retractLength}
                        onChange={(e) =>
                          updateCalibration(key, "retractLength", e.target.value)
                        }
                        placeholder={defaultCal?.retractLength || form.retractLength || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title={t("form.tooltip.retractSpeed")}>{t("form.cal.retractSpeed")}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={cal.retractSpeed}
                        onChange={(e) =>
                          updateCalibration(key, "retractSpeed", e.target.value)
                        }
                        placeholder={defaultCal?.retractSpeed || form.retractSpeed || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title={t("form.tooltip.zLift")}>{t("form.cal.zLift")}</label>
                      <input
                        type="number"
                        step="0.01"
                        className={inputClass}
                        value={cal.retractLift}
                        onChange={(e) =>
                          updateCalibration(key, "retractLift", e.target.value)
                        }
                        placeholder={defaultCal?.retractLift || form.retractLift || t("form.base")}
                      />
                    </div>
                  </div>

                  {/* Temperature overrides */}
                  <p className="text-xs font-medium text-gray-500 mt-3 mb-2">{t("form.cal.tempOverrides")}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t("form.cal.nozzleTemp")}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={cal.nozzleTemp}
                        onChange={(e) => updateCalibration(key, "nozzleTemp", e.target.value)}
                        placeholder={defaultCal?.nozzleTemp || form.temperatures.nozzle || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t("form.cal.nozzleTempFirstLayer")}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={cal.nozzleTempFirstLayer}
                        onChange={(e) => updateCalibration(key, "nozzleTempFirstLayer", e.target.value)}
                        placeholder={defaultCal?.nozzleTempFirstLayer || form.temperatures.nozzleFirstLayer || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t("form.cal.bedTemp")}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={cal.bedTemp}
                        onChange={(e) => updateCalibration(key, "bedTemp", e.target.value)}
                        placeholder={defaultCal?.bedTemp || form.temperatures.bed || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t("form.cal.bedTempFirstLayer")}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={cal.bedTempFirstLayer}
                        onChange={(e) => updateCalibration(key, "bedTempFirstLayer", e.target.value)}
                        placeholder={defaultCal?.bedTempFirstLayer || form.temperatures.bedFirstLayer || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t("form.cal.chamberTemp")}</label>
                      <input
                        type="number"
                        className={inputClass}
                        value={cal.chamberTemp}
                        onChange={(e) => updateCalibration(key, "chamberTemp", e.target.value)}
                        placeholder={defaultCal?.chamberTemp || t("form.base")}
                      />
                    </div>
                  </div>

                  {/* Fan settings */}
                  <p className="text-xs font-medium text-gray-500 mt-3 mb-2">{t("form.cal.fanSettings")}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t("form.cal.fanMin")}</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        className={inputClass}
                        value={cal.fanMinSpeed}
                        onChange={(e) => updateCalibration(key, "fanMinSpeed", e.target.value)}
                        placeholder={defaultCal?.fanMinSpeed || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t("form.cal.fanMax")}</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        className={inputClass}
                        value={cal.fanMaxSpeed}
                        onChange={(e) => updateCalibration(key, "fanMaxSpeed", e.target.value)}
                        placeholder={defaultCal?.fanMaxSpeed || t("form.base")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t("form.cal.fanBridge")}</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        className={inputClass}
                        value={cal.fanBridgeSpeed}
                        onChange={(e) => updateCalibration(key, "fanBridgeSpeed", e.target.value)}
                        placeholder={defaultCal?.fanBridgeSpeed || t("form.base")}
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
          {t("form.section.presets")}
          <span className="text-gray-400 font-normal ml-1">({t("form.presetsHint")})</span>
        </legend>
        <p className="text-xs text-gray-500 mb-3">
          {t("form.presetsDescription")}
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
                    placeholder={t("form.placeholder.presetLabel")}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => removePreset(idx)}
                    className="text-red-500 hover:text-red-700 text-sm flex-shrink-0 px-2"
                    title={t("form.removePreset")}
                  >
                    ✕
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1" title={t("form.tooltip.em")}>{t("form.cal.em")}</label>
                    <input
                      type="number"
                      step="0.01"
                      className={inputClass}
                      value={preset.extrusionMultiplier}
                      onChange={(e) => updatePreset(idx, "extrusionMultiplier", e.target.value)}
                      placeholder={form.extrusionMultiplier || t("form.base")}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t("form.preset.nozzle")}</label>
                    <input
                      type="number"
                      className={inputClass}
                      value={preset.nozzle}
                      onChange={(e) => updatePreset(idx, "nozzle", e.target.value)}
                      placeholder={form.temperatures.nozzle || t("form.base")}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t("form.preset.nozzleFirst")}</label>
                    <input
                      type="number"
                      className={inputClass}
                      value={preset.nozzleFirstLayer}
                      onChange={(e) => updatePreset(idx, "nozzleFirstLayer", e.target.value)}
                      placeholder={form.temperatures.nozzleFirstLayer || t("form.base")}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t("form.preset.bed")}</label>
                    <input
                      type="number"
                      className={inputClass}
                      value={preset.bed}
                      onChange={(e) => updatePreset(idx, "bed", e.target.value)}
                      placeholder={form.temperatures.bed || t("form.base")}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t("form.preset.bedFirst")}</label>
                    <input
                      type="number"
                      className={inputClass}
                      value={preset.bedFirstLayer}
                      onChange={(e) => updatePreset(idx, "bedFirstLayer", e.target.value)}
                      placeholder={form.temperatures.bedFirstLayer || t("form.base")}
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
          {t("form.addPreset")}
        </button>
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{t("form.diameter")}</label>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            value={form.diameter}
            onChange={(e) => setForm({ ...form, diameter: e.target.value })}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.inherits")}</label>
          <input
            className={inputClass}
            value={form.inherits}
            onChange={(e) => setForm({ ...form, inherits: e.target.value })}
            placeholder={t("form.placeholder.inherits")}
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>{t("form.tdsUrl")}</label>
        <input
          type="url"
          className={inputClass}
          value={form.tdsUrl}
          onChange={(e) => setForm({ ...form, tdsUrl: e.target.value })}
          placeholder={t("form.placeholder.tdsUrl")}
        />
        {!form.tdsUrl && tdsSuggestions.length > 0 && (
          <div className="mt-1">
            <p className="text-xs text-gray-500 mb-1">{t("form.tdsFromVendor", { vendor: form.vendor })}</p>
            <div className="flex flex-wrap gap-1">
              {tdsSuggestions.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => setForm({ ...form, tdsUrl: s.tdsUrl })}
                  className="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800"
                >
                  {t("form.useFrom", { name: s.name })}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <fieldset className="border border-gray-300 rounded p-4">
        <legend className="text-sm font-medium px-2">{t("form.section.gcode")}</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t("form.startGcode")}</label>
            <textarea className={inputClass} rows={3}
              value={form.startGcode}
              onChange={(e) => setForm({ ...form, startGcode: e.target.value })}
              placeholder={t("form.placeholder.startGcode")}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.endGcode")}</label>
            <textarea className={inputClass} rows={3}
              value={form.endGcode}
              onChange={(e) => setForm({ ...form, endGcode: e.target.value })}
              placeholder={t("form.placeholder.endGcode")}
            />
          </div>
        </div>
      </fieldset>

      <div>
        <label className={labelClass}>{t("form.notes")}</label>
        <textarea
          className={inputClass}
          rows={4}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder={t("form.placeholder.notes")}
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? t("form.saving") : initialData ? t("form.updateFilament") : t("form.createFilament")}
      </button>
    </form>
  );
}
