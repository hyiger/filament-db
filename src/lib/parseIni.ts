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
 * C-style quoted-string escaping is applied/removed. Three entry points:
 *
 *  - `serializeIniValue` — export emitter (prusaSlicerBundle's writeSection)
 *  - `wrapIniString` / `unwrapIniString` — FilamentForm's gcode/notes textareas
 *
 * Contract: the settings bag CANONICALLY stores WIRE form — the single-line
 * bytes after `=` in the INI. Every writer agrees on that representation:
 * the fork sync-back stores exactly what PrusaSlicer sends (a multi-line
 * gcode arrives as a quoted string with LITERAL `\n` escape sequences, not
 * raw newlines), the form escapes via `wrapIniString` on save, and the bulk
 * INI import below stores the trimmed wire bytes VERBATIM. That last point
 * is deliberate (Codex P2s on PR #1086): an earlier revision unescaped
 * cleanly-quoted values on import, which (a) flipped a literal quoted
 * `"nil"` into the bare `nil` inheritance marker on the next export,
 * (b) stripped literal boundary quotes/whitespace the quoting existed to
 * protect, and (c) broke `splitInheritedImportSet`'s strict-equality
 * comparison against a parent's form-stored WIRE value — pinning inherited
 * gcode/notes as variant overrides on an otherwise idempotent re-import.
 * Wire-canonical storage makes export → import → export byte-identical by
 * construction. Only content that cannot ride one `key = value` line (raw
 * \r/\n — legacy form-wrapped values, multi-line top-level notes) is
 * transformed, at the EMIT boundary (`serializeIniValue`).
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
 *
 * `\t` is deliberately NOT decoded as a tab (Codex P2 round 8 suggested
 * it): upstream's unescape_string_cstyle (prusa3d/PrusaSlicer,
 * src/libslic3r/Config.cpp) special-cases ONLY `r` and `n` — every other
 * escaped char is emitted verbatim, so PrusaSlicer itself reads `\t` as
 * the letter `t` — and escape_string_cstyle never PRODUCES `\t` (a real
 * tab rides raw, unescaped, exactly as ours does). Decoding `\t` here
 * would diverge from what the slicer reads from the same bytes. The same
 * fact is why `\t` is not in hasOnlyCanonicalEscapes: no canonical writer
 * emits it, so its presence proves a legacy raw wrap (see
 * unwrapIniString).
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
 * the unwrap. Foreign INI input is never decoded (the bag stores wire form
 * verbatim — see the codec docblock above), so leniency here can't corrupt
 * imported data: this only ever runs on the form's own gcode/notes keys.
 */
export function unwrapIniString(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    // Codex P2 round 5: pre-#1070 the form wrapped `"${raw}"` WITHOUT
    // escaping, so a legacy value may hold literal backslashes (a Windows
    // path in a note). A backslash starting a NON-canonical sequence
    // (`\t`, a trailing lone `\`) can only come from such a raw wrap —
    // every canonical writer (wrapIniString, the fork's escape_string_
    // cstyle) emits only `\\ \" \n \r` — so return the raw content
    // verbatim: unescaping would render `\n` as a newline and an edit
    // would re-encode the mangled display permanently, while the verbatim
    // seed + a later edit re-encodes CANONICALLY and heals the legacy
    // value. A value whose escapes are all canonical stays ambiguous
    // (`"C:\new"` raw vs wire are byte-identical) and decodes as wire —
    // matching what PrusaSlicer itself reads from those bytes.
    return hasOnlyCanonicalEscapes(inner) ? unescapeIniValueContent(inner) : inner;
  }
  return value;
}

/** Every backslash in `content` begins a canonical escape (`\\ \" \n \r`). */
function hasOnlyCanonicalEscapes(content: string): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\\") {
      const next = content[i + 1];
      if (next !== "\\" && next !== '"' && next !== "n" && next !== "r") {
        return false;
      }
      i += 1;
    }
  }
  return true;
}

/**
 * Is `value` exactly ONE cleanly-quoted string — an opening quote, escaped
 * content, and a closing quote at the very end? Multi-element vector values
 * (`"A";"B"`), expressions that merely start and end with a quote
 * (`"PLA"=="PLA"`), and unterminated strings (`"abc\"`) all return false.
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
 * GH #1070 / Codex P2 round 3 on PR #1086: decode ONE bag value for the
 * Orca/Bambu JSON exporters. The bag is wire-canonical (see the codec
 * docblock above), but JSON carries real newlines natively — emitting Prusa
 * INI wire syntax there hands Orca literal wrapper quotes and backslash
 * escapes, breaking the previously-lossless Bambu import → export
 * round-trip for multi-line values (and, pre-existing on main, garbling
 * fork-synced multi-line gcode the same way). Decoding is deliberately
 * NARROW: only a cleanly-quoted string (per isCleanQuotedString — vectors
 * and quote-bracketed expressions fail the scan) whose decoded content
 * actually contains a line terminator. Single-line quoted values stay
 * verbatim, so their Orca round-trip remains byte-identical to main.
 *
 * ACCEPTED RESIDUE (Codex P2 round 8, stated in both directions): a JSON
 * profile whose value is the LITERAL text `"a\nb"` — boundary quotes and
 * backslash as visible characters — is byte-identical to Prusa wire and
 * decodes as wire here, losing those characters on the JSON export. The
 * bag carries no provenance bit, so the two readings are structurally
 * indistinguishable; wire wins because wire-shaped JSON strings are
 * overwhelmingly ACTUAL wire — every pre-#1070 export wrote bag values
 * into Orca/Bambu JSON verbatim, so real users' exported files carry wire
 * multi-line gcode/notes that MUST decode (the bug this function fixes) —
 * while wire-lookalike literal content is contrived. Wrapping such
 * strings at JSON ingestion instead was considered and REJECTED: it would
 * misread every re-imported pre-#1070 export (real, common) to preserve
 * the lookalike (hypothetical), inverting the bias the wrong way.
 */
export function decodeMultilineWireValue(value: string): string {
  if (!isCleanQuotedString(value)) return value;
  const inner = value.slice(1, -1);
  // Codex P2 round 10: the same legacy-vs-canonical distinction the form's
  // unwrapIniString applies (round 5). A backslash starting a non-canonical
  // sequence proves a pre-#1070 raw wrap — its `\n` is literal content
  // (`C:\new\tool`), not an escape — so decoding would corrupt it exactly
  // the way the form display used to. Return the bytes verbatim; the
  // Prusa emit path preserves the content via serializeIniValue's
  // key-scoped handling.
  if (!hasOnlyCanonicalEscapes(inner)) return value;
  const decoded = unescapeIniValueContent(inner);
  return /[\r\n]/.test(decoded) ? decoded : value;
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
 *
 * The wrapper strip is KEY-SCOPED (Codex P2 round 9 on PR #1086): the
 * pre-#1070 form only ever hand-wrapped {@link LEGACY_FORM_WRAPPED_KEYS},
 * so a quote-bounded raw multi-line value on any OTHER key can't be a
 * form wrap — its quotes are genuine content from a pre-upgrade
 * generic-API / Bambu-import write and survive the escape. Accepted
 * residue on the three form keys themselves: a pre-upgrade generic write
 * of quote-bounded multi-line content there is byte-indistinguishable
 * from a form wrap, and form writes vastly dominate those keys.
 */
export function serializeIniValue(value: string, key?: string): string {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  const stripWrapper =
    key !== undefined &&
    LEGACY_FORM_WRAPPED_KEYS.has(key) &&
    value.length >= 2 &&
    value.startsWith('"') &&
    value.endsWith('"');
  const content = stripWrapper ? value.slice(1, -1) : value;
  return `"${escapeIniValueContent(content)}"`;
}

/**
 * The ONLY settings keys the pre-#1070 FilamentForm ever hand-wrapped as
 * `"${textarea}"` — see serializeIniValue's key-scoped wrapper strip.
 */
export const LEGACY_FORM_WRAPPED_KEYS = new Set([
  "start_filament_gcode",
  "end_filament_gcode",
  "filament_notes",
]);

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
        // GH #1070: the wire value is stored VERBATIM (bag = wire form —
        // see the codec docblock). A bare `nil` is PrusaSlicer's
        // inheritance marker → null; a QUOTED "nil" is the literal string
        // and stays verbatim like everything else.
        let value: string | null = trimmed.substring(eqIndex + 1).trim();
        if (value === "nil") value = null;
        currentSettings[key] = value;
      }
    }
  }

  flushFilament();
  return filaments;
}
