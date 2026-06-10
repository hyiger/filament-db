"use client";

import { Fragment, useState, useEffect, useMemo, useRef } from "react";
import { useCurrency } from "@/hooks/useCurrency";
import { useTranslation } from "@/i18n/TranslationProvider";
import CollapsibleSection, { expandAndScrollToSection } from "@/components/CollapsibleSection";
import FormToc, { FormTocMobileButton, type TocEntry } from "@/components/FormToc";
import FilamentSwatch from "@/components/FilamentSwatch";
import { snapToStep } from "@/lib/snapToStep";
import {
  filterColorSuggestions,
  lookupCssNamedColor,
  type ColorSuggestion,
} from "@/lib/cssNamedColors";
import {
  deriveArrangement,
  arrangementToOptTag,
  stripArrangementTags,
  type ColorArrangement,
} from "@/lib/filamentColors";
import { isInvertedNozzleRange } from "@/lib/temperatureRange";

interface BedTypeTempEntry {
  /** Client-only stable row id for React keys. Stripped before API submission. */
  _uid: string;
  bedType: string;
  temperature: string;
  firstLayerTemperature: string;
}

interface FilamentFormData {
  name: string;
  vendor: string;
  type: string;
  /** GH #477: primary color (OpenPrintTag spec key 19). Nullable for
   *  coextruded / rainbow filaments where the spec says primary "can
   *  be null". The form normalises `null` to empty string in the input
   *  for editing purposes, but the submit handler converts back to
   *  null when the user has explicitly cleared it (multi-color
   *  arrangement was set). */
  color: string;
  /** GH #477: up to 5 additional color hexes (OpenPrintTag spec keys
   *  20–24). The arrangement radio derived from optTags 28/29 drives
   *  the swatch rendering — coextruded shows stripes, gradient shows a
   *  linear-gradient. */
  secondaryColors: string[];
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
  lowStockThreshold: string;
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
  /** Annotated by /api/filaments/parents — true when this candidate
   * currently has ≥1 variant. Drives the cross-hatch swatch in the picker. */
  hasVariants?: boolean;
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
  /** Client-only stable row id for React keys. Stripped before API submission. */
  _uid: string;
  label: string;
  extrusionMultiplier: string;
  nozzle: string;
  nozzleFirstLayer: string;
  bed: string;
  bedFirstLayer: string;
}

/**
 * Generate a stable unique id for a client-side list row. Using crypto.randomUUID
 * when available (secure contexts only) with a math-random fallback for legacy
 * environments. Rows need this because using the array index as a React key
 * causes input focus / cursor state to jump when a mid-list row is deleted.
 */
function makeUid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `uid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
    color: initialData?.color ?? "#808080",
    secondaryColors: initialData?.secondaryColors ?? [],
    colorName: initialData?.colorName || "",
    cost: initialData?.cost?.toString() || "",
    // density + diameter are CBOR half-floats on an OpenPrintTag, so an
    // NFC/TDS prefill can hand us e.g. 1.2392578125 / 2.849609375. Snap to
    // the inputs' step="0.01" grid so the value the user sees is one the
    // field can actually hold — otherwise native step validation blocks
    // save on every NFC-read filament (#570). Snapping an already-clean
    // stored value (1.24, 2.85, 1.75) is a no-op.
    density:
      initialData?.density != null
        ? snapToStep(initialData.density, 0.01).toString()
        : "",
    // Variants leave diameter blank when inheriting from the parent — falling
    // back to "1.75" here would paint a value into the input that the user
    // never typed, and saving would persist 1.75 as an explicit override
    // (even if the parent's diameter is e.g. 2.85). The submit-side fallback
    // in handleSubmit keeps 1.75 as the default for standalone filaments.
    diameter:
      initialData?.diameter != null
        ? snapToStep(initialData.diameter, 0.01).toString()
        : initialData?.parentId
          ? ""
          : "1.75",
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
      _uid: makeUid(),
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
    lowStockThreshold: initialData?.lowStockThreshold?.toString() || "",
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
  const savedRef = useRef(false);
  // GH #286: dirty state is derived below, once `calibrations` and
  // `presets` are declared — see the `dirty` block after those.

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
  // colorName typeahead — suggestions come from the user's own
  // (colorName, color) pairs first ("Prusa Orange" remembers the hex
  // you saved last time), then the 148 CSS named colors as a fallback
  // for generic names. Selecting a suggestion sets BOTH the colorName
  // and the hex `color` field, so the user gets a working swatch
  // without leaving the keyboard.
  const [colorNameSuggestions, setColorNameSuggestions] = useState<ColorSuggestion[]>([]);
  const [colorNameDropdownOpen, setColorNameDropdownOpen] = useState(false);
  const [colorNameHighlight, setColorNameHighlight] = useState(-1);
  const colorNameRef = useRef<HTMLDivElement>(null);
  const nozzleRangeMaxRef = useRef<HTMLInputElement>(null);
  const [fetchErrors, setFetchErrors] = useState<string[]>([]);

  // #574: a nozzle range with min > max is physically nonsense but each end
  // only has its own 0–600 bound, so the browser accepted the inverted pair.
  // Drive a cross-field native validity message off the max input so submit
  // is blocked and the existing onInvalidCapture handler scrolls to the
  // Temperatures section. Reactive so it clears the moment the user fixes it.
  useEffect(() => {
    const el = nozzleRangeMaxRef.current;
    if (!el) return;
    const min = parseFloat(form.temperatures.nozzleRangeMin);
    const max = parseFloat(form.temperatures.nozzleRangeMax);
    el.setCustomValidity(
      isInvertedNozzleRange({ nozzleRangeMin: min, nozzleRangeMax: max })
        ? t("form.error.nozzleRangeInverted")
        : "",
    );
  }, [form.temperatures.nozzleRangeMin, form.temperatures.nozzleRangeMax, t]);

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

  // Fetch the user's previously-saved (colorName, color) pairs so the
  // colorName typeahead can suggest "Prusa Orange → #FA6E1C" etc.
  // Falls back to CSS named colors when the DB has no match for what
  // the user is typing.
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/filaments/colors", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((pairs: { name: string; hex: string }[]) => {
        setColorNameSuggestions(pairs.map((p) => ({ name: p.name, hex: p.hex, source: "db" })));
      })
      .catch(() => { if (!ac.signal.aborted) addFetchError("color suggestions"); });
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
      if (colorNameRef.current && !colorNameRef.current.contains(e.target as Node)) {
        setColorNameDropdownOpen(false);
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
      _uid: makeUid(),
      label: p.label || "",
      extrusionMultiplier: p.extrusionMultiplier?.toString() || "",
      nozzle: p.temperatures?.nozzle?.toString() || "",
      nozzleFirstLayer: p.temperatures?.nozzleFirstLayer?.toString() || "",
      bed: p.temperatures?.bed?.toString() || "",
      bedFirstLayer: p.temperatures?.bedFirstLayer?.toString() || "",
    }));
  };

  const [presets, setPresets] = useState<PresetEntry[]>(getInitialPresets);

  // GH #286: derive dirtiness from a snapshot of *all* editable state —
  // form fields, calibrations, and presets. The previous effect watched
  // only `form`, so a calibration- or preset-only edit navigated away
  // with no unsaved-changes warning — silent loss of exactly the tedious
  // data this app exists to capture — and it one-way latched `dirty` to
  // true, so reverting an edit still warned. Deriving the value during
  // render makes it both two-way and complete. `baselineRef` is
  // re-pointed after a successful save so the saved state becomes the
  // new clean baseline.
  const dirtySnapshot = useMemo(
    () => JSON.stringify({ form, calibrations, presets }),
    [form, calibrations, presets],
  );

  // Printer tabs in the Calibrations section should only offer printers
  // that physically own at least one of this filament's compatible
  // nozzles. A nozzle lives on exactly one printer at a time (GH #232,
  // enforced by `findNozzleConflicts`), so selecting the Bambu 0.4mm
  // nozzle as compatible should not invite a Core One calibration row
  // — Core One literally doesn't have that nozzle installed and any
  // calibration captured against (Core One, Bambu 0.4mm) is meaningless.
  // Built from the `NozzleOption.printers` reverse-mapping already
  // populated by `/api/nozzles?withPrinters` so this stays in sync with
  // printer-form edits without an extra fetch.
  const relevantPrinters = useMemo(() => {
    if (form.compatibleNozzles.length === 0) return [];
    const relevantIds = new Set<string>();
    for (const nozzleId of form.compatibleNozzles) {
      const nozzle = nozzles.find((n) => n._id === nozzleId);
      if (!nozzle?.printers) continue;
      for (const p of nozzle.printers) relevantIds.add(p._id);
    }
    return printers.filter((p) => relevantIds.has(p._id));
  }, [printers, nozzles, form.compatibleNozzles]);

  // Derive the effective selection rather than syncing it via an effect.
  // When the user removes a compatible nozzle that was the only reason
  // a printer tab existed, `selectedPrinter` may still hold that id —
  // the tab is gone but the state lingers. Falling back to "default"
  // here keeps rendering and the calibration-key lookup consistent
  // without paying the extra-render cost of a setState-in-effect.
  // Project rule `react-hooks/set-state-in-effect` (see CLAUDE.md)
  // forbids the alternative.
  const effectiveSelectedPrinter =
    selectedPrinter === "default" ||
    relevantPrinters.some((p) => p._id === selectedPrinter)
      ? selectedPrinter
      : "default";
  // The clean baseline. Seeded once with the initial snapshot via the
  // lazy useState initializer; re-pointed after a successful save.
  const [dirtyBaseline, setDirtyBaseline] = useState(dirtySnapshot);
  const dirty = dirtySnapshot !== dirtyBaseline;

  // Warn on unsaved changes when navigating away (browser-level).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty && !savedRef.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Notify the parent (useUnsavedChanges) of dirty-state changes.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const addPreset = () => {
    setPresets((prev) => [
      ...prev,
      { _uid: makeUid(), label: "", extrusionMultiplier: "", nozzle: "", nozzleFirstLayer: "", bed: "", bedFirstLayer: "" },
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

    // Handle start G-code: user-typed text wins; else inject PA-only line; else
    // drop the override entirely so a variant inherits from its parent (GH #113).
    // Without the trailing `else`, an inherited (or pre-existing) gcode that
    // contained no `M572` line could never be cleared from the form.
    if (form.startGcode) {
      settings.start_filament_gcode = `"${form.startGcode}"`;
    } else if (form.pressureAdvance) {
      settings.start_filament_gcode = `"M572 S${form.pressureAdvance}"`;
    } else {
      settings.start_filament_gcode = undefined;
    }

    try {
      // GH #477: when the user has opted into the "Coextruded"
      // arrangement (auto-toggled via tag 29 in optTags), the
      // OpenPrintTag spec says primary color SHOULD be null for
      // coextruded — "Does not have a primary color, number of colors
      // can be derived from the defined secondary colors." Submit null
      // so resolveFilament + every read site honour that semantic. For
      // gradient and solid arrangements the primary stays as set.
      //
      // Codex P2 round 1 on PR #533: BOTH the dual_color tag (28) AND
      // the triple_color tag (29) represent coextruded — pre-fix this
      // only checked 29, so a dual-color save (the common 2-secondary
      // shape) kept the primary on the doc and rendered with an extra
      // unwanted stripe. Use deriveArrangement to stay aligned with
      // every other render site.
      const submittedColor =
        deriveArrangement(form.optTags) === "coextruded"
          ? null
          : form.color;
      await onSubmit({
        name: form.name,
        vendor: form.vendor,
        type: form.type,
        color: submittedColor,
        secondaryColors: form.secondaryColors,
        colorName: form.colorName || null,
        cost: parseNum(form.cost),
        density: parseNum(form.density),
        // Variants should inherit diameter from the parent when left blank;
        // only apply the 1.75 fallback for standalone filaments (GH #106).
        diameter: parseNum(form.diameter) ?? (form.parentId ? null : 1.75),
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
            const [printerId, nozzleId] = key.split(":");
            // Drop calibrations whose nozzle is no longer compatible.
            if (!form.compatibleNozzles.includes(nozzleId)) return false;
            // Drop printer-specific calibrations whose printer no longer
            // owns this nozzle. The Calibrations UI hides those tabs (see
            // `relevantPrinters` above), so the user has no way to view
            // or clear them through the form — without this prune-on-save
            // the entries would persist in the DB indefinitely as
            // orphans. Codex round-1 P2 on PR #358. The "default" scope
            // (printerId === "default") is always kept — it's the
            // baseline that applies regardless of which printer has
            // the nozzle at the moment.
            //
            // FAIL-OPEN when ownership data isn't available (codex
            // round-2 P1 on PR #358). The catalog is fetched async via
            // `/api/nozzles`; if the user saves while it's still
            // loading — or if the fetch failed — `nozzles` is empty,
            // the lookup returns `undefined`, and a strict predicate
            // would silently delete every valid per-printer
            // calibration. Treat absence of ownership data as
            // "uncertain" and keep the entry; only drop when we have
            // positive evidence (catalog loaded, nozzle found,
            // printers populated, and the printer is not in the
            // installed list).
            if (printerId === "default") return true;
            const nozzle = nozzles.find((n) => n._id === nozzleId);
            if (!nozzle || !nozzle.printers) return true;
            return nozzle.printers.some((p) => p._id === printerId);
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
        lowStockThreshold: parseNum(form.lowStockThreshold),
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
      // GH #286: re-baseline so the just-saved state counts as clean.
      setDirtyBaseline(JSON.stringify({ form, calibrations, presets }));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent text-gray-900 dark:text-gray-100";
  const labelClass = "block text-sm font-medium mb-1 text-gray-900 dark:text-gray-100";

  // Single source of truth for the submit button label so the duplicate at
  // the top of the form can't drift from the bottom one.
  //
  // Edit mode is identified by the presence of `_id` on initialData — only
  // /filaments/{id}/edit fetches a real doc with that field; the populate-from
  // flows on /filaments/new (clone, NFC, Prusament, INI, TDS, parent) all
  // synthesise an initialData object without an _id. Branching on the bare
  // truthiness of initialData (the prior behaviour) made every populate-from
  // flow show "Update Filament" on what is in fact a create — confusing on a
  // destructive-feeling action like Clone (GH #164).
  const isEdit = Boolean(initialData?._id);
  const submitLabel = saving
    ? t("form.saving")
    : isEdit
      ? t("form.updateFilament")
      : t("form.createFilament");

  // Sidebar TOC entries — must mirror what's actually rendered, otherwise
  // clicking an entry scrolls to a missing element and leaves the highlight
  // stuck on an unreachable item (codex PR #214 P2). Two gating signals:
  //   - `showAdvanced` hides shrinkage / fan / retraction / multi-material /
  //     material-properties / material-tags
  //   - `form.compatibleNozzles.length === 0` hides calibrations
  // Identity fields (name / parent / vendor / type / color / cost) sit above
  // the first TOC entry as always-visible primary content.
  const hasCompatibleNozzles = form.compatibleNozzles.length > 0;

  // Placeholder helpers — when the form is opened from `?parentId=`, the
  // parent doc rides along on `initialData._parent`. We render the parent's
  // values as faded placeholders on every inheritable input so the user
  // can see what they're inheriting without leaving the page. Inputs stay
  // empty in form state and on submit, so the variant doc records no
  // explicit override and continues to track the parent at read time via
  // resolveFilament (GH #106 — placeholders must NEVER bleed into form
  // state). Returns `undefined` when there is no parent, no value, or an
  // empty-string value, so callers can fall back to a static placeholder.
  type ParentDocLike = Record<string, unknown>;
  const parentDoc =
    (initialData?._parent && typeof initialData._parent === "object"
      ? (initialData._parent as ParentDocLike)
      : undefined);
  const parentPh = (path: string): string | undefined => {
    if (!parentDoc) return undefined;
    let value: unknown = parentDoc;
    for (const seg of path.split(".")) {
      if (value && typeof value === "object" && seg in (value as object)) {
        value = (value as Record<string, unknown>)[seg];
      } else {
        return undefined;
      }
    }
    if (value === null || value === undefined || value === "") return undefined;
    return String(value);
  };
  const tocEntries: TocEntry[] = useMemo(() => {
    const all: { id: string; label: string; show: boolean }[] = [
      { id: "spool-weight", label: t("form.section.spoolWeight"), show: true },
      { id: "temperatures", label: t("form.section.temperatures"), show: true },
      { id: "shrinkage", label: t("form.section.shrinkage"), show: showAdvanced },
      { id: "fan", label: t("form.section.fan"), show: showAdvanced },
      { id: "retraction", label: t("form.section.retraction"), show: showAdvanced },
      { id: "multi-material", label: t("form.section.multiMaterial"), show: showAdvanced },
      { id: "material-properties", label: t("form.section.materialProperties"), show: showAdvanced },
      { id: "material-tags", label: t("form.section.materialTags"), show: showAdvanced },
      { id: "compatible-nozzles", label: t("form.section.compatibleNozzles"), show: true },
      { id: "calibrations", label: t("form.section.calibrations"), show: hasCompatibleNozzles },
      { id: "presets", label: t("form.section.presets"), show: true },
      { id: "gcode", label: t("form.section.gcode"), show: true },
    ];
    return all.filter((e) => e.show).map(({ id, label }) => ({ id, label }));
  }, [t, showAdvanced, hasCompatibleNozzles]);

  return (
    <div className="lg:flex lg:gap-6 lg:items-start">
    <form
      onSubmit={handleSubmit}
      // GH #228: when HTML5 validation rejects a required input inside a
      // collapsed CollapsibleSection, the browser focuses the invalid
      // element and tries to scroll to it — but the field is `hidden`,
      // so the user sees nothing and the form looks frozen.
      // `expandAndScrollToSection` walks up from the invalid input to
      // its enclosing `<section data-toc-section>` and opens it before
      // the browser's default scroll runs. Use the capture phase
      // because the `invalid` event doesn't bubble in the standard
      // sense — capture lets us see it on the form root regardless.
      onInvalidCapture={(e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const section = target.closest("section[id]") as HTMLElement | null;
        if (section && section.id) {
          expandAndScrollToSection(section.id);
        }
      }}
      className="space-y-4 flex-1 min-w-0"
    >
      {fetchErrors.length > 0 && (
        <div className="px-3 py-2 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded text-sm text-yellow-700 dark:text-yellow-300">
          {t("form.fetchError", { items: fetchErrors.join(", ") })}
        </div>
      )}
      {/* Top submit button — mirrors the bottom one so users editing a long
       * filament don't have to scroll back down to save (GH #127). */}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
      {form.parentId && initialData?._parent && (
        // Variant banner — without this users edit a clone, see the parent's
        // values pre-filled (as they used to before GH #106 was fixed), and
        // don't realise that clicking Save copies every field onto the
        // child. Now the edit form fetches ?raw=true and shows only the
        // variant's own overrides; inherited fields render blank. This
        // banner spells that out so the empty inputs don't look buggy.
        <div className="px-3 py-2 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded text-sm text-blue-800 dark:text-blue-200">
          {t("form.variantHint", {
            parent: (initialData._parent as { name?: string }).name ?? "parent",
          })}
        </div>
      )}

      <div>
        <label className={labelClass} htmlFor="filament-name">{t("form.name")} *</label>
        <input
          id="filament-name"
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
                  <FilamentSwatch
                    color={p.color}
                    isParent={p.hasVariants === true}
                    size={16}
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
                      <FilamentSwatch
                        color={p.color}
                        isParent={p.hasVariants === true}
                        size={16}
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

      {/* Two columns, not four: at the form's width four cells were too
          narrow to fit the colour swatch + hex input together, and the
          "Density (g/cm³)" label wrapped to two lines, pushing its input
          out of alignment with the rest of the row. Two columns matches
          the vendor/type row above and gives every field room. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              className={`${inputClass} font-mono uppercase min-w-0`}
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
        <div ref={colorNameRef} className="relative">
          <label className={labelClass} id="colorName-label">{t("form.colorName")}</label>
          <input
            id="filament-colorName"
            className={inputClass}
            value={form.colorName}
            role="combobox"
            aria-expanded={colorNameDropdownOpen}
            aria-controls="colorName-listbox"
            aria-labelledby="colorName-label"
            aria-autocomplete="list"
            aria-activedescendant={
              colorNameHighlight >= 0 ? `colorName-opt-${colorNameHighlight}` : undefined
            }
            placeholder={t("form.placeholder.colorName")}
            onChange={(e) => {
              // Typing the colorName never overwrites `color` on its own —
              // we wait for the user to commit (Enter, click, or exact-
              // match-then-blur) so we don't churn the hex picker on every
              // keystroke. The user's free-text "I'm naming this whatever
              // I want" path stays uninterrupted.
              setForm({ ...form, colorName: e.target.value });
              setColorNameDropdownOpen(true);
              setColorNameHighlight(-1);
            }}
            onFocus={() => {
              setColorNameDropdownOpen(true);
              setColorNameHighlight(-1);
            }}
            onBlur={() => {
              // Exact (case- and whitespace-insensitive) match on a CSS
              // named color — populate the hex even though the user
              // never opened the dropdown. Mirrors how a user expects
              // the picker to behave after typing "navy" and tabbing.
              // DB matches are NOT auto-applied on blur because there
              // can be multiple hexes under the same name (e.g. several
              // brands of "Galaxy Black"); the user must explicitly
              // pick which one they meant via the dropdown.
              const cssHex = lookupCssNamedColor(form.colorName);
              if (cssHex && form.color.toUpperCase() !== cssHex) {
                setForm({ ...form, color: cssHex });
              }
            }}
            onKeyDown={(e) => {
              if (!colorNameDropdownOpen) return;
              const filtered = filterColorSuggestions(
                colorNameSuggestions,
                form.colorName,
              );
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setColorNameHighlight((h) => Math.min(h + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setColorNameHighlight((h) => Math.max(h - 1, 0));
              } else if (
                e.key === "Enter" &&
                colorNameHighlight >= 0 &&
                filtered[colorNameHighlight]
              ) {
                e.preventDefault();
                const s = filtered[colorNameHighlight];
                setForm({ ...form, colorName: s.name, color: s.hex });
                setColorNameDropdownOpen(false);
                setColorNameHighlight(-1);
              } else if (e.key === "Escape") {
                setColorNameDropdownOpen(false);
                setColorNameHighlight(-1);
              }
            }}
          />
          {colorNameDropdownOpen && (() => {
            const filtered = filterColorSuggestions(colorNameSuggestions, form.colorName);
            if (filtered.length === 0) return null;
            // Section boundaries — render a small "From your filaments"
            // / "Standard colors" header before each source group.
            // Pre-computing the first-of-each-source flag avoids an
            // extra pass during render.
            let lastSource: "db" | "css" | null = null;
            return (
              <ul
                id="colorName-listbox"
                role="listbox"
                aria-labelledby="colorName-label"
                className="absolute z-50 w-full mt-1 max-h-64 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg"
              >
                {filtered.map((s, i) => {
                  const showHeader = s.source !== lastSource;
                  lastSource = s.source;
                  return (
                    // GH #637 (#3): was a <span> wrapping the <li>s — a
                    // <span> is an invalid <ul> child (and put the <li>s
                    // outside the list's content model), so AT could fail
                    // to enumerate the options. A keyed Fragment keeps the
                    // <li>s as direct <ul> children.
                    <Fragment key={`${s.source}-${s.name}-${s.hex}`}>
                      {showHeader && (
                        <li
                          role="presentation"
                          aria-hidden="true"
                          className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-400 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700"
                        >
                          {s.source === "db"
                            ? t("form.colorName.section.db")
                            : t("form.colorName.section.css")}
                        </li>
                      )}
                      <li
                        id={`colorName-opt-${i}`}
                        role="option"
                        aria-selected={i === colorNameHighlight}
                        className={`px-3 py-1.5 cursor-pointer text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 ${i === colorNameHighlight ? "bg-gray-100 dark:bg-gray-600" : ""}`}
                        onMouseDown={(e) => {
                          // mousedown beats blur — without preventDefault the
                          // input's onBlur fires first and the dropdown closes
                          // before the click registers.
                          e.preventDefault();
                          setForm({ ...form, colorName: s.name, color: s.hex });
                          setColorNameDropdownOpen(false);
                          setColorNameHighlight(-1);
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className="inline-block w-4 h-4 rounded-full border border-gray-300 dark:border-gray-500 flex-shrink-0"
                          style={{ backgroundColor: s.hex }}
                        />
                        <span className="flex-1 truncate">{s.name}</span>
                        <span className="text-xs font-mono text-gray-400">{s.hex.toUpperCase()}</span>
                      </li>
                    </Fragment>
                  );
                })}
              </ul>
            );
          })()}
        </div>
        {/* GH #477: Multi-color editor + arrangement radio. Spans the
            full 2-col grid via sm:col-span-2. */}
        <div className="sm:col-span-2">
          <MultiColorEditor
            form={form}
            setForm={setForm}
            t={t}
          />
        </div>
        <div>
          <label htmlFor="filament-cost" className={labelClass}>{t("form.cost", { symbol: currencySymbol })}</label>
          <input
            id="filament-cost"
            type="number"
            step="0.01"
            min="0"
            className={inputClass}
            value={form.cost}
            onChange={(e) => setForm({ ...form, cost: e.target.value })}
            placeholder={parentPh("cost")}
          />
        </div>
        <div>
          <label htmlFor="filament-density" className={labelClass}>{t("form.density")}</label>
          <input
            id="filament-density"
            type="number"
            step="0.01"
            min="0"
            className={inputClass}
            value={form.density}
            onChange={(e) => setForm({ ...form, density: e.target.value })}
            placeholder={parentPh("density")}
          />
        </div>
      </div>

      <CollapsibleSection
        id="spool-weight"
        title={t("form.section.spoolWeight")}
        defaultOpen
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="filament-net-filament" className={labelClass}>{t("form.netFilament")}</label>
            <input
              id="filament-net-filament"
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.netFilamentWeight}
              onChange={(e) => setForm({ ...form, netFilamentWeight: e.target.value })}
              placeholder={parentPh("netFilamentWeight") ?? t("form.placeholder.netFilament")}
            />
            <p className="text-xs text-gray-400 mt-1">{t("form.netFilamentHint")}</p>
          </div>
          <div>
            <label htmlFor="filament-spool-weight" className={labelClass}>{t("form.emptySpool")}</label>
            <input
              id="filament-spool-weight"
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.spoolWeight}
              onChange={(e) => setForm({ ...form, spoolWeight: e.target.value })}
              placeholder={parentPh("spoolWeight") ?? t("form.placeholder.emptySpool")}
            />
            <p className="text-xs text-gray-400 mt-1">{t("form.emptySpoolHint")}</p>
          </div>
          <div>
            <label htmlFor="filament-initial-weight" className={labelClass}>{t("form.initialWeight")}</label>
            <input
              id="filament-initial-weight"
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.totalWeight}
              onChange={(e) => setForm({ ...form, totalWeight: e.target.value })}
              placeholder={t("form.placeholder.initialWeight")}
            />
            <p className="text-xs text-gray-400 mt-1">
              {initialData?._id
                ? t("form.initialWeightHintEdit")
                : t("form.initialWeightHint")}
            </p>
          </div>
          <div>
            <label htmlFor="filament-low-stock-threshold" className={labelClass}>{t("form.lowStockThreshold")}</label>
            <input
              id="filament-low-stock-threshold"
              type="number"
              step="1"
              min="0"
              className={inputClass}
              value={form.lowStockThreshold}
              onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })}
              placeholder={t("form.placeholder.lowStockThreshold")}
            />
            <p className="text-xs text-gray-400 mt-1">{t("form.lowStockThresholdHint")}</p>
          </div>
        </div>
      </CollapsibleSection>

      {/* EM, PA, and Max Vol. Speed are nozzle-specific — they belong in the
          Calibrations section below, not here at the top level. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <label htmlFor="filament-min-print-speed" className={labelClass}>{t("form.minPrintSpeed")}</label>
          <input id="filament-min-print-speed" type="number" step="1" min="0" className={inputClass}
            value={form.minPrintSpeed}
            onChange={(e) => setForm({ ...form, minPrintSpeed: e.target.value })}
            placeholder={parentPh("minPrintSpeed")}
          />
        </div>
        <div>
          <label htmlFor="filament-max-print-speed" className={labelClass}>{t("form.maxPrintSpeed")}</label>
          <input id="filament-max-print-speed" type="number" step="1" min="0" className={inputClass}
            value={form.maxPrintSpeed}
            onChange={(e) => setForm({ ...form, maxPrintSpeed: e.target.value })}
            placeholder={parentPh("maxPrintSpeed")}
          />
        </div>
        <div>
          <label htmlFor="filament-z-offset" className={labelClass}>{t("form.zOffset")}</label>
          <input id="filament-z-offset" type="number" step="0.001" className={inputClass}
            value={form.zOffset}
            onChange={(e) => setForm({ ...form, zOffset: e.target.value })}
            placeholder={t("form.placeholder.zOffset")}
          />
        </div>
      </div>

      <CollapsibleSection
        id="temperatures"
        title={t("form.section.temperatures")}
        defaultOpen
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="filament-temp-nozzle" className={labelClass}>{t("form.nozzleTemp")}</label>
            <input
              id="filament-temp-nozzle"
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
              placeholder={parentPh("temperatures.nozzle")}
            />
          </div>
          <div>
            <label htmlFor="filament-temp-nozzle-first-layer" className={labelClass}>{t("form.nozzleFirstLayer")}</label>
            <input
              id="filament-temp-nozzle-first-layer"
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
              placeholder={parentPh("temperatures.nozzleFirstLayer")}
            />
          </div>
          <div>
            <label htmlFor="filament-temp-bed" className={labelClass}>{t("form.bedTemp")}</label>
            <input
              id="filament-temp-bed"
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
              placeholder={parentPh("temperatures.bed")}
            />
          </div>
          <div>
            <label htmlFor="filament-temp-bed-first-layer" className={labelClass}>{t("form.bedFirstLayer")}</label>
            <input
              id="filament-temp-bed-first-layer"
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
              placeholder={parentPh("temperatures.bedFirstLayer")}
            />
          </div>
          <div>
            <label htmlFor="filament-temp-chamber" className={labelClass}>{t("form.chamberTemp")}</label>
            <input
              id="filament-temp-chamber"
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
            <label htmlFor="filament-temp-standby" className={labelClass}>{t("form.standbyTemp")}</label>
            <input
              id="filament-temp-standby"
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
              placeholder={parentPh("temperatures.standby")}
            />
          </div>
          <div>
            <label htmlFor="filament-temp-nozzle-range-min" className={labelClass}>{t("form.nozzleRangeMin")}</label>
            <input
              id="filament-temp-nozzle-range-min"
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
              placeholder={parentPh("temperatures.nozzleRangeMin") ?? t("form.placeholder.safeMinimum")}
            />
          </div>
          <div>
            <label htmlFor="filament-temp-nozzle-range-max" className={labelClass}>{t("form.nozzleRangeMax")}</label>
            <input
              ref={nozzleRangeMaxRef}
              id="filament-temp-nozzle-range-max"
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
              placeholder={parentPh("temperatures.nozzleRangeMax") ?? t("form.placeholder.safeMaximum")}
            />
          </div>
        </div>

        {/* Per-bed-type temperatures */}
        {form.bedTypeTemps.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-gray-400 font-medium uppercase">{t("form.perBedTypeTemps")}</p>
            {form.bedTypeTemps.map((bt, idx) => (
              <div key={bt._uid} className="grid grid-cols-4 gap-2 items-end">
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
          setForm({ ...form, bedTypeTemps: [...form.bedTypeTemps, { _uid: makeUid(), bedType: "", temperature: "", firstLayerTemperature: "" }] });
        }}>{t("form.addBedType")}</button>
      </CollapsibleSection>

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
      <CollapsibleSection id="shrinkage" title={t("form.section.shrinkage")}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t("form.shrinkageXY")}</label>
            <input
              type="text"
              className={inputClass}
              value={form.shrinkageXY}
              onChange={(e) => setForm({ ...form, shrinkageXY: e.target.value })}
              placeholder={parentPh("shrinkageXY") ?? t("form.placeholder.shrinkage")}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.shrinkageZ")}</label>
            <input
              type="text"
              className={inputClass}
              value={form.shrinkageZ}
              onChange={(e) => setForm({ ...form, shrinkageZ: e.target.value })}
              placeholder={parentPh("shrinkageZ") ?? t("form.placeholder.shrinkage")}
            />
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="fan" title={t("form.section.fan")}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t("form.fanMinSpeed")}</label>
            <input
              type="number"
              min="0"
              max="100"
              className={inputClass}
              value={form.fanMinSpeed}
              onChange={(e) => setForm({ ...form, fanMinSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.fanMaxSpeed")}</label>
            <input
              type="number"
              min="0"
              max="100"
              className={inputClass}
              value={form.fanMaxSpeed}
              onChange={(e) => setForm({ ...form, fanMaxSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.fanBridgeSpeed")}</label>
            <input
              type="number"
              min="0"
              max="100"
              className={inputClass}
              value={form.fanBridgeSpeed}
              onChange={(e) => setForm({ ...form, fanBridgeSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.fanDisableFirstLayers")}</label>
            <input
              type="number"
              min="0"
              className={inputClass}
              value={form.fanDisableFirstLayers}
              onChange={(e) => setForm({ ...form, fanDisableFirstLayers: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.overhangFanSpeed")}</label>
            <input type="number" min="0" max="100" className={inputClass}
              value={form.overhangFanSpeed}
              onChange={(e) => setForm({ ...form, overhangFanSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.auxFanSpeed")}</label>
            <input type="number" min="0" max="100" className={inputClass}
              value={form.auxFanSpeed}
              onChange={(e) => setForm({ ...form, auxFanSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.fanBelowLayerTime")}</label>
            <input type="number" min="0" className={inputClass}
              value={form.fanBelowLayerTime}
              onChange={(e) => setForm({ ...form, fanBelowLayerTime: e.target.value })}
              placeholder={t("form.placeholder.fanBelowLayerTime")}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.slowDownMinSpeed")}</label>
            <input type="number" min="0" className={inputClass}
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
      </CollapsibleSection>

      <CollapsibleSection id="retraction" title={t("form.section.retraction")}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>{t("form.retractLength")}</label>
            <input
              type="number"
              min="0"
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
              min="0"
              className={inputClass}
              value={form.retractSpeed}
              onChange={(e) => setForm({ ...form, retractSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.retractZLift")}</label>
            <input
              type="number"
              min="0"
              step="0.01"
              className={inputClass}
              value={form.retractLift}
              onChange={(e) => setForm({ ...form, retractLift: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.retractMinTravel")}</label>
            <input type="number" min="0" step="0.1" className={inputClass}
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
      </CollapsibleSection>

      <CollapsibleSection id="multi-material" title={t("form.section.multiMaterial")}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <label className={labelClass}>{t("form.loadingSpeed")}</label>
            <input type="number" min="0" step="0.1" className={inputClass}
              value={form.filamentLoadingSpeed}
              onChange={(e) => setForm({ ...form, filamentLoadingSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.unloadingSpeed")}</label>
            <input type="number" min="0" step="0.1" className={inputClass}
              value={form.filamentUnloadingSpeed}
              onChange={(e) => setForm({ ...form, filamentUnloadingSpeed: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.loadTime")}</label>
            <input type="number" min="0" step="0.1" className={inputClass}
              value={form.filamentLoadTime}
              onChange={(e) => setForm({ ...form, filamentLoadTime: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>{t("form.unloadTime")}</label>
            <input type="number" min="0" step="0.1" className={inputClass}
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
      </CollapsibleSection>

      <CollapsibleSection
        id="material-properties"
        title={t("form.section.materialProperties")}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <label className={labelClass}>{t("form.glassTempTransition")}</label>
          <input type="number" step="1" min="0" className={inputClass}
            value={form.glassTempTransition}
            onChange={(e) => setForm({ ...form, glassTempTransition: e.target.value })}
            placeholder={parentPh("glassTempTransition") ?? t("form.placeholder.glassTempTransition")}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.heatDeflectionTemp")}</label>
          <input type="number" step="1" min="0" className={inputClass}
            value={form.heatDeflectionTemp}
            onChange={(e) => setForm({ ...form, heatDeflectionTemp: e.target.value })}
            placeholder={parentPh("heatDeflectionTemp") ?? t("form.placeholder.heatDeflectionTemp")}
          />
        </div>
        <div>
          <label className={labelClass}>{t("form.transmissionDistance")}</label>
          <input type="number" step="any" min="0" className={inputClass}
            value={form.transmissionDistance}
            onChange={(e) => setForm({ ...form, transmissionDistance: e.target.value })}
            placeholder={parentPh("transmissionDistance") ?? t("form.placeholder.transmissionDistance")}
          />
        </div>
        </div>
      </CollapsibleSection>

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
            placeholder={parentPh("dryingTemperature") ?? t("form.placeholder.dryingTemp")}
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
            placeholder={parentPh("dryingTime") ?? t("form.placeholder.dryingTime")}
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
            placeholder={parentPh("shoreHardnessA") ?? t("form.placeholder.shoreHardnessA")}
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
            placeholder={parentPh("shoreHardnessD") ?? t("form.placeholder.shoreHardnessD")}
          />
        </div>
      </div>

      <CollapsibleSection id="material-tags" title={t("form.section.materialTags")}>
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
      </CollapsibleSection>
      </>)}

      <CollapsibleSection
        id="compatible-nozzles"
        title={t("form.section.compatibleNozzles")}
        defaultOpen
      >
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
      </CollapsibleSection>

      {form.compatibleNozzles.length > 0 && (
        <CollapsibleSection
          id="calibrations"
          title={t("form.section.calibrations")}
          defaultOpen
        >
          <p className="text-xs text-gray-500 mb-3">
            {t("form.calibrationsHint")}
            {printers.length > 0 && ` ${t("form.calibrationsPrinterHint")}`}
          </p>

          {/* Printer selector tabs — restricted to printers that
              physically own at least one of this filament's compatible
              nozzles. See the `relevantPrinters` memo above for the
              rationale (a calibration against a printer that doesn't
              have the nozzle is meaningless). */}
          {!printersLoading && relevantPrinters.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-4 border-b border-gray-200 dark:border-gray-700 pb-2">
              <button
                type="button"
                onClick={() => setSelectedPrinter("default")}
                className={`px-3 py-1.5 text-sm rounded-t ${
                  effectiveSelectedPrinter === "default"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {t("form.defaultAnyPrinter")}
              </button>
              {relevantPrinters.map((p) => (
                <button
                  key={p._id}
                  type="button"
                  onClick={() => setSelectedPrinter(p._id)}
                  className={`px-3 py-1.5 text-sm rounded-t ${
                    effectiveSelectedPrinter === p._id
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
            {form.compatibleNozzles
              // Filter calibration rows to nozzles physically installed on
              // the selected printer. The Default / Any-printer tab keeps
              // every compatible nozzle so the user can capture the
              // baseline calibration for each, regardless of which printer
              // currently owns it.
              .filter((nozzleId) => {
                if (effectiveSelectedPrinter === "default") return true;
                const nozzle = nozzles.find((n) => n._id === nozzleId);
                return nozzle?.printers?.some((p) => p._id === effectiveSelectedPrinter) ?? false;
              })
              .map((nozzleId) => {
              const nozzle = nozzles.find((n) => n._id === nozzleId);
              if (!nozzle) return null;
              const printerId = effectiveSelectedPrinter === "default" ? null : effectiveSelectedPrinter;
              const bedTypeId = selectedBedType === "any" ? null : selectedBedType;
              const key = calKey(printerId, nozzleId, bedTypeId);
              const cal = calibrations[key] || emptyCalibrationEntry;
              // Show default values as placeholders when viewing printer/bed-specific calibrations
              const defaultKey = calKey(null, nozzleId, null);
              const isOverride = effectiveSelectedPrinter !== "default" || selectedBedType !== "any";
              const defaultCal = isOverride ? calibrations[defaultKey] : undefined;
              // The calibration scope — shown in the card header so it's clear
              // that switching the printer/bed tab stores values independently.
              const printerName =
                effectiveSelectedPrinter === "default"
                  ? t("form.cal.scope.anyPrinter")
                  : printers.find((p) => p._id === effectiveSelectedPrinter)?.name ?? "";
              const bedName =
                selectedBedType === "any"
                  ? t("form.cal.scope.anyBed")
                  : bedTypes.find((b) => b._id === selectedBedType)?.name ?? "";
              return (
                <div
                  key={key}
                  className="border border-gray-200 dark:border-gray-700 rounded p-3"
                >
                  <div className="mb-2">
                    <p className="text-sm font-medium">
                      {nozzle.name}
                      {nozzle.highFlow && (
                        <span className="ml-1.5 px-1.5 py-0.5 bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 rounded text-xs">
                          HF
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t("form.cal.scope.for", {
                        printer: printerName,
                        bed: bedName,
                      })}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1" title={t("form.tooltip.em")}>{t("form.cal.em")}</label>
                      <input
                        type="number"
                        min="0"
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
                        min="0"
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
                        min="0"
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
                        min="0"
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
                        min="0"
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
                        min="0"
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
        </CollapsibleSection>
      )}

      <CollapsibleSection
        id="presets"
        title={t("form.section.presets")}
        subtitle={t("form.presetsHint")}
      >
        <p className="text-xs text-gray-500 mb-3">
          {t("form.presetsDescription")}
        </p>
        {presets.length > 0 && (
          <div className="space-y-3">
            {presets.map((preset, idx) => (
              <div
                key={preset._uid}
                className="border border-gray-200 dark:border-gray-700 rounded p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    aria-label={t("form.placeholder.presetLabel")}
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
      </CollapsibleSection>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="filament-diameter" className={labelClass}>{t("form.diameter")}</label>
          <input
            id="filament-diameter"
            type="number"
            step="0.01"
            className={inputClass}
            value={form.diameter}
            onChange={(e) => setForm({ ...form, diameter: e.target.value })}
            placeholder={parentPh("diameter")}
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
          placeholder={parentPh("tdsUrl") ?? t("form.placeholder.tdsUrl")}
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

      <CollapsibleSection id="gcode" title={t("form.section.gcode")}>
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
      </CollapsibleSection>

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
        {submitLabel}
      </button>
    </form>
    {/* Desktop sidebar TOC: 200px wide, sticky, sits to the right of the form.
     *  Mobile: replaced by the floating jump button below. */}
    <aside className="lg:w-48 lg:flex-shrink-0 hidden lg:block">
      <FormToc entries={tocEntries} />
    </aside>
    <FormTocMobileButton entries={tocEntries} />
    </div>
  );
}

/**
 * GH #477 — Multi-color editor + arrangement radio.
 *
 * Renders below the primary color picker. The arrangement radio toggles
 * the OpenPrintTag arrangement tags (28 = gradual_color_change, 29 =
 * coextruded) in the user's `optTags` array — there's no separate
 * "arrangement" field on the schema, just bits in the existing tags
 * list. When the user opts into the multi-color treatment we surface
 * 0–5 secondary-color slots; the swatch preview to the right updates
 * live so the user sees what the list / detail page will render.
 *
 * Kept as a sub-component so the (already very long) FilamentForm body
 * doesn't grow another 100 lines. State stays in the parent — we read
 * `form` / call `setForm` — so the existing dirty-tracking +
 * unsaved-changes guard work unchanged.
 */
function MultiColorEditor({
  form,
  setForm,
  t,
}: {
  form: FilamentFormData;
  setForm: (next: FilamentFormData) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const arrangement: ColorArrangement = deriveArrangement(form.optTags);

  /** Toggle a single arrangement tag on/off in optTags, removing every
   *  other arrangement tag so they're always mutually exclusive from
   *  the UI's perspective.
   *
   *  GH #507: arrangement is driven by the canonical OPT_TAG enum —
   *  27 = gradient, 28 = dual_color, 29 = triple_color. Both 28 and 29
   *  surface as `"coextruded"` at render time; `arrangementToOptTag`
   *  picks dual vs triple based on the current secondary-color count
   *  so toggling the radio writes the right id. `stripArrangementTags`
   *  removes ALL three so a prior arrangement's tag doesn't survive
   *  the switch (pre-fix, swapping gradient → coextruded left tag 27
   *  on the doc and deriveArrangement would then disagree with the
   *  UI on the next render).
   *
   *  Coextruded + gradient simultaneously is theoretically possible per
   *  spec but the form only models one arrangement at a time. */
  const setArrangement = (next: ColorArrangement) => {
    const stripped = stripArrangementTags(form.optTags);
    const newTag = arrangementToOptTag(next, form.secondaryColors.length);
    setForm({
      ...form,
      optTags: newTag != null ? [...stripped, newTag] : stripped,
    });
  };

  /** GH #507: when the user adds/removes a coextruded secondary slot,
   *  refresh the arrangement tag so dual→triple (or back) flips on the
   *  saved doc without the user having to re-click the radio. Gradient
   *  + solid don't carry a count distinction so they're untouched. */
  const refreshArrangementTagForCount = (
    nextSecondaries: string[],
    optTagsAfter: number[],
  ): number[] => {
    if (arrangement !== "coextruded") return optTagsAfter;
    const stripped = stripArrangementTags(optTagsAfter);
    const newTag = arrangementToOptTag("coextruded", nextSecondaries.length);
    return newTag != null ? [...stripped, newTag] : stripped;
  };

  // GH #637: stable row keys. `form.secondaryColors` is a plain string[]
  // shared with the parent form's prefill/submit paths, so rows carry no
  // natural id — a parallel uid list gives each slot the stable key that
  // bedTypeTemps/presets/amsSlots rows carry as `_uid` (see the makeUid
  // docblock for why index keys jump focus on mid-list deletes). The
  // add/remove handlers keep `uids` in lockstep with the array; a render-
  // time length reconcile covers external resizes (NFC/clone prefill) via
  // React's "adjust state during render" pattern — keeps existing rows'
  // uids, only the appended/trimmed tail changes.
  const [uids, setUids] = useState<string[]>(() =>
    form.secondaryColors.map(() => makeUid()),
  );
  if (uids.length !== form.secondaryColors.length) {
    setUids((prev) => {
      const next = prev.slice(0, form.secondaryColors.length);
      while (next.length < form.secondaryColors.length) next.push(makeUid());
      return next;
    });
  }

  const addColor = () => {
    if (form.secondaryColors.length >= 5) return; // spec cap
    const nextSecondaries = [...form.secondaryColors, "#808080"];
    setUids((prev) => [...prev, makeUid()]);
    setForm({
      ...form,
      secondaryColors: nextSecondaries,
      optTags: refreshArrangementTagForCount(nextSecondaries, form.optTags),
    });
  };

  const removeColor = (idx: number) => {
    // Drop the removed row's uid (not the last one) so the rows after it
    // keep their keys — and the focus-sensitive hex inputs keep their DOM
    // nodes — across a mid-list delete.
    setUids((prev) => prev.filter((_, i) => i !== idx));
    const nextSecondaries = form.secondaryColors.filter((_, i) => i !== idx);
    setForm({
      ...form,
      secondaryColors: nextSecondaries,
      optTags: refreshArrangementTagForCount(nextSecondaries, form.optTags),
    });
  };

  const setColorAt = (idx: number, hex: string) => {
    const next = [...form.secondaryColors];
    next[idx] = hex;
    setForm({ ...form, secondaryColors: next });
  };

  const labelClass =
    "block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1";
  const radioBase =
    "px-3 py-1.5 text-sm rounded border cursor-pointer transition-colors";

  return (
    <fieldset className="border border-gray-300 dark:border-gray-700 rounded p-3 space-y-3">
      <legend className="px-2 text-sm font-medium">
        {t("form.multiColor.title")}
      </legend>

      {/* Arrangement radio — three exclusive options driving optTags
          28/29. "None" clears both, "Coextruded" sets 29, "Gradient"
          sets 28. */}
      <div>
        <span className={labelClass}>{t("form.multiColor.arrangement")}</span>
        <div className="flex flex-wrap gap-2" role="radiogroup"
          aria-label={t("form.multiColor.arrangement")}>
          {(["solid", "coextruded", "gradient"] as ColorArrangement[]).map(
            (opt) => {
              const active = arrangement === opt;
              return (
                <label
                  key={opt}
                  className={`${radioBase} ${
                    active
                      ? "border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-200 font-medium"
                      : "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
                  }`}
                >
                  <input
                    type="radio"
                    name="filament-arrangement"
                    value={opt}
                    checked={active}
                    onChange={() => setArrangement(opt)}
                    className="sr-only"
                  />
                  {t(`form.multiColor.arrangement.${opt}`)}
                </label>
              );
            },
          )}
        </div>
        {arrangement === "coextruded" && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t("form.multiColor.coextrudedHint")}
          </p>
        )}
        {arrangement === "gradient" && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t("form.multiColor.gradientHint")}
          </p>
        )}
      </div>

      {/* Secondary color slots — only render when the user has chosen a
          multi-color arrangement OR already has secondaries set. Lets
          a "solid" single-color filament keep a quiet form. */}
      {(arrangement !== "solid" || form.secondaryColors.length > 0) && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className={labelClass}>
              {t("form.multiColor.secondaryColors")}
              <span className="ml-1 text-xs text-gray-500 font-normal">
                ({form.secondaryColors.length}/5)
              </span>
            </span>
            <button
              type="button"
              onClick={addColor}
              disabled={form.secondaryColors.length >= 5}
              className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              + {t("form.multiColor.addColor")}
            </button>
          </div>
          {form.secondaryColors.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400 italic">
              {t("form.multiColor.noColorsYet")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {form.secondaryColors.map((c, i) => (
                <li key={uids[i] ?? i} className="flex gap-2 items-center">
                  <span className="text-xs text-gray-500 w-6 text-right select-none">
                    #{i + 2}
                  </span>
                  <input
                    type="color"
                    aria-label={t("form.multiColor.colorAriaLabel", {
                      n: i + 2,
                    })}
                    className="h-9 w-11 rounded border border-gray-300 dark:border-gray-600 cursor-pointer bg-transparent flex-shrink-0"
                    value={c}
                    onChange={(e) => setColorAt(i, e.target.value)}
                  />
                  <input
                    type="text"
                    inputMode="text"
                    className="flex-1 min-w-0 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent font-mono uppercase"
                    value={c}
                    placeholder="#RRGGBB"
                    maxLength={7}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      let v = raw.startsWith("#") ? raw : `#${raw}`;
                      v = "#" + v.slice(1).replace(/[^0-9a-fA-F]/g, "");
                      setColorAt(i, v.slice(0, 7));
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => removeColor(i)}
                    aria-label={t("form.multiColor.removeColor", { n: i + 2 })}
                    className="px-2 py-1 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950 rounded"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* Live preview using the same swatch the list / detail page
              renders — the user sees exactly what their multi-color
              filament will look like everywhere else. Codex P2 on PR
              #483: mirror the submit handler's "coextruded clears
              primary to null" so the preview doesn't show a phantom
              extra gray stripe (#808080) that would disappear after
              save. For coextruded, only secondaryColors paint the
              swatch — exactly what the list/detail view will render. */}
          <div className="mt-2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span>{t("form.multiColor.preview")}:</span>
            <FilamentSwatch
              color={arrangement === "coextruded" ? null : form.color}
              secondaryColors={form.secondaryColors}
              arrangement={arrangement}
              size={40}
            />
          </div>
        </div>
      )}
    </fieldset>
  );
}
