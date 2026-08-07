// Note: this type is specific to PrusaSlicer INI parsing and differs from
// the shared Filament types in src/types/filament.ts (which cover DB documents).
export interface FilamentData {
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost: number | null;
  density: number | null;
  diameter: number;
  temperatures: {
    nozzle: number | null;
    nozzleFirstLayer: number | null;
    bed: number | null;
    bedFirstLayer: number | null;
  };
  maxVolumetricSpeed: number | null;
  inherits: string | null;
  // GH #951 (Codex): spool weight + shrinkage are lifted to top-level (like
  // cost/density) so their settings-bag shadow can be stripped without data
  // loss. OPTIONAL and set ONLY when the source INI key is present — an omitted
  // key must not become `$set: null` and clobber an existing value on a root
  // (the "carry only when supplied" idiom the per-nozzle collapse also uses).
  spoolWeight?: number | null;
  shrinkageXY?: number | null;
  shrinkageZ?: number | null;
  settings: Record<string, string | null>;
}

/**
 * GH #951 (Codex): the INI keys that `flushFilament` below lifts into a
 * TOP-LEVEL `FilamentData` field (rather than leaving only in the `settings`
 * passthrough bag). The bulk INI importers strip these from the stored
 * `settings` bag so a variant that inherits one of them doesn't keep a stale
 * shadow copy that leaks back into exports (`filamentToSlicerKeys` seeds `keys`
 * from `settings`, so a shadow survives when the resolved top-level value is
 * null). Every key here round-trips via its top-level field, so stripping loses
 * nothing. Keep this in lockstep with the `currentSettings.*` reads in
 * `flushFilament` — `tests/parseIni.test.ts` pins that invariant.
 */
export const INI_TOP_LEVEL_SETTING_KEYS = [
  "filament_vendor",
  "filament_type",
  "filament_colour",
  "filament_cost",
  "filament_density",
  "filament_diameter",
  "filament_max_volumetric_speed",
  "temperature",
  "first_layer_temperature",
  "bed_temperature",
  "first_layer_bed_temperature",
  "inherits",
  "filament_spool_weight",
  "filament_shrinkage_compensation_xy",
  "filament_shrinkage_compensation_z",
] as const;

/**
 * GH #1070: the INI VALUE codec — the ONE boundary where PrusaSlicer's
 * C-style quoted-string escaping is applied/removed. Four entry points:
 *
 *  - `serializeIniValue` — export emitter (prusaSlicerBundle's writeSection)
 *  - `parseIniValue`     — bulk import (parseIniFilaments below)
 *  - `wrapIniString` / `unwrapIniString` — FilamentForm's gcode/notes textareas
 *
 * Contract: the settings bag stores single-line values in WIRE form (the
 * bytes after `=` in the INI). The fork sync-back stores exactly what
 * PrusaSlicer sends (a multi-line gcode arrives as a quoted string with
 * LITERAL `\n` escape sequences, not raw newlines), and both the form and
 * the export must keep those BYTE-IDENTICAL — an already-escaped
 * `"...\n..."` value must never be double-wrapped/double-escaped. Only
 * content that cannot ride one `key = value` line (raw \r/\n) is
 * transformed at the emit boundary (`serializeIniValue`); the import side
 * (`parseIniValue`) unescapes cleanly-quoted values so a bundle round-trip
 * is faithful and PrusaSlicer's own output parses to the real content.
 */

/** Escape content C-style, matching PrusaSlicer's escape_string_cstyle. */
function escapeIniValueContent(content: string): string {
  let out = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else out += ch;
  }
  return out;
}

/**
 * Inverse of `escapeIniValueContent`, matching PrusaSlicer's
 * unescape_string_cstyle: `\n`/`\r` become the real terminators; any other
 * escaped character is taken verbatim (`\"` → `"`, `\\` → `\`, `\x` → `x`).
 * A trailing lone backslash is preserved as-is.
 */
function unescapeIniValueContent(content: string): string {
  let out = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\\" && i + 1 < content.length) {
      const next = content[i + 1];
      i += 1;
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else out += next;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Wrap raw content (e.g. a textarea's text, real newlines and all) into the
 * quoted-escaped wire form PrusaSlicer expects for string values. Used by
 * FilamentForm when writing gcode/notes into the settings bag, so the bag
 * always holds a valid single-line value.
 */
export function wrapIniString(content: string): string {
  return `"${escapeIniValueContent(content)}"`;
}

/**
 * Lenient inverse of `wrapIniString` for OUR OWN stored bag values: if the
 * value is quote-wrapped, strip the outer quotes and unescape; otherwise
 * return it verbatim (raw legacy values / never-wrapped keys). Lenient on
 * purpose — pre-#1070 FilamentForm hand-wrapped `"..."` around raw content,
 * so an interior unescaped quote (a quote the user typed) must not defeat
 * the unwrap. Foreign INI input goes through the STRICT `parseIniValue`.
 */
export function unwrapIniString(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeIniValueContent(value.slice(1, -1));
  }
  return value;
}

/**
 * Is `value` exactly ONE cleanly-quoted string — an opening quote, escaped
 * content, and a closing quote at the very end? Multi-element vector values
 * (`"A";"B"`), expressions that merely start and end with a quote
 * (`"PLA"=="PLA"`), and unterminated strings (`"abc\"`) all return false so
 * the strict import path leaves them verbatim.
 */
function isCleanQuotedString(value: string): boolean {
  if (value.length < 2 || value[0] !== '"') return false;
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') return i === value.length - 1;
  }
  return false;
}

/**
 * GH #1070: parse one wire value from an INI line (the trimmed bytes after
 * `=`). A cleanly-quoted string is unwrapped + unescaped (what PrusaSlicer
 * itself writes for gcode/notes — the app's bulk import becomes a faithful
 * round-trip); a bare `nil` is PrusaSlicer's inheritance marker → null;
 * everything else is stored verbatim. Note the ORDER: a QUOTED "nil" is the
 * literal string, so the quote check runs first.
 */
export function parseIniValue(raw: string): string | null {
  const value = raw.trim();
  if (isCleanQuotedString(value)) {
    return unescapeIniValueContent(value.slice(1, -1));
  }
  if (value === "nil") return null;
  return value;
}

/**
 * GH #1070: make one settings-bag value safe to emit as a single
 * `key = value` INI line.
 *
 * Values with no raw line terminators pass through BYTE-IDENTICAL — they are
 * already wire form (fork-synced `"...\n..."` strings with literal
 * backslash-n escapes, plain numbers, conditions, ...) and re-escaping them
 * would corrupt every existing preset. Only a value carrying a RAW \r/\n —
 * a pre-#1070 form-wrapped textarea value, a multi-line top-level
 * `filament.notes`, or any other path that sneaked raw text into the bag —
 * is transformed into PrusaSlicer's quoted-escaped form. A raw multi-line
 * value that is ALREADY quote-wrapped (the legacy FilamentForm shape:
 * `"line one<NL>line two"`) intends its outer quotes as the WRAPPER, not
 * content, so they are stripped before escaping — otherwise literal quotes
 * would leak into the preset's text.
 */
export function serializeIniValue(value: string): string {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  const content =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
  return `"${escapeIniValueContent(content)}"`;
}

export function parseIniFilaments(content: string): FilamentData[] {
  const filaments: FilamentData[] = [];
  const lines = content.split("\n");

  let currentName: string | null = null;
  let currentSettings: Record<string, string | null> = {};

  function flushFilament() {
    if (currentName && Object.keys(currentSettings).length > 0) {
      const parseNum = (val: string | null | undefined): number | null => {
        if (!val || val === "nil" || val === "") return null;
        const cleaned = val.replace("%", "");
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
      };

      const nilOrVal = (val: string | null | undefined): string | null => {
        if (!val || val === "nil") return null;
        return val;
      };

      const fd: FilamentData = {
        name: currentName!,
        vendor: currentSettings.filament_vendor || "Unknown",
        type: currentSettings.filament_type || "Unknown",
        color: currentSettings.filament_colour || "#808080",
        cost: parseNum(currentSettings.filament_cost),
        density: parseNum(currentSettings.filament_density),
        diameter: parseNum(currentSettings.filament_diameter) ?? 1.75,
        temperatures: {
          nozzle: parseNum(currentSettings.temperature),
          nozzleFirstLayer: parseNum(currentSettings.first_layer_temperature),
          bed: parseNum(currentSettings.bed_temperature),
          bedFirstLayer: parseNum(currentSettings.first_layer_bed_temperature),
        },
        maxVolumetricSpeed: parseNum(currentSettings.filament_max_volumetric_speed),
        inherits: nilOrVal(currentSettings.inherits),
        settings: { ...currentSettings },
      };
      // GH #951 (Codex): lift spool weight + shrinkage to top-level ONLY when the
      // source key is present, so an INI that omits them leaves the field
      // `undefined` (→ omitted from the importer's `$set`) rather than nulling a
      // value already on the row. See the FilamentData comment above.
      if ("filament_spool_weight" in currentSettings) {
        fd.spoolWeight = parseNum(currentSettings.filament_spool_weight);
      }
      if ("filament_shrinkage_compensation_xy" in currentSettings) {
        fd.shrinkageXY = parseNum(currentSettings.filament_shrinkage_compensation_xy);
      }
      if ("filament_shrinkage_compensation_z" in currentSettings) {
        fd.shrinkageZ = parseNum(currentSettings.filament_shrinkage_compensation_z);
      }
      filaments.push(fd);
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      flushFilament();

      const sectionName = sectionMatch[1];
      if (sectionName.startsWith("filament:")) {
        const parsedName = sectionName.substring("filament:".length).trim();
        if (!parsedName) {
          currentName = null;
          currentSettings = {};
          continue;
        }
        currentName = parsedName;
        currentSettings = {};
      } else {
        currentName = null;
        currentSettings = {};
      }
      continue;
    }

    if (currentName) {
      // GH #955: skip comment lines (`#` and `;` are both INI/PrusaSlicer
      // comment markers) and blanks — an in-section comment that happens to
      // contain `=` would otherwise become a junk settings key. Real preset
      // keys are `[a-z0-9_]` identifiers that never start with `#`/`;`.
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        // GH #1070: quoted values are unwrapped + unescaped, `nil` → null,
        // everything else verbatim — see parseIniValue's docblock.
        currentSettings[key] = parseIniValue(trimmed.substring(eqIndex + 1));
      }
    }
  }

  flushFilament();
  return filaments;
}
