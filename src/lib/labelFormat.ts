/**
 * Customizable label formatting model (GH #592).
 *
 * Pure, browser- and Node-safe: the `LabelFormat` config, its defaults /
 * presets / font stacks, a built-in sample filament for the Settings
 * preview, and the `composeLabelLines` text-composition core. No DOM, no
 * Node deps — so the composition logic is unit-testable independently of the
 * canvas renderer (`src/lib/labelBitmap.ts`) that consumes it.
 */

export type LabelFieldId = "name" | "vendor" | "type" | "vendorType" | "colorName";
export type LabelFontFamily = "sans" | "serif" | "mono" | "condensed";
export type LabelFontSize = "s" | "m" | "l";
export type QrPlacement = "left" | "right";
export type LabelOrientation = "horizontal" | "vertical";

export interface LabelFormat {
  /** QR code: whether to show it and which side it sits on. The QR *payload*
   *  (instanceId vs URL) is a per-print choice in the dialog, not part of the
   *  saved format. */
  qr: { enabled: boolean; placement: QrPlacement };
  /** Ordered text lines, stacked top→bottom. ["vendor","type"] = vendor over
   *  type; ["vendorType"] = "Vendor Type" on one line. */
  lines: LabelFieldId[];
  font: { family: LabelFontFamily; size: LabelFontSize };
  /** Text reading direction along the label. */
  orientation: LabelOrientation;
  /** White text on a black background. */
  invert: boolean;
  /** #745: max lines a single field's text may word-wrap across. 1 = no wrap
   *  (one line per field, the pre-#745 behaviour). Up to MAX_LINES_PER_FIELD —
   *  lets a long OpenPrintTag name spread over several lines instead of one
   *  crazy-long line. The renderer shrinks the font so the wrapped lines fit. */
  maxLinesPerField: number;
}

/** Upper bound for the per-field word-wrap (the reporter's "not exceed 3 lines"). */
export const MAX_LINES_PER_FIELD = 3;

/** The subset of a filament the label can display. */
export interface LabelFilament {
  name?: string | null;
  vendor?: string | null;
  type?: string | null;
  colorName?: string | null;
}

/** Default == today's hardcoded output: QR left, the filament name, sans/medium, horizontal, not inverted. */
export const DEFAULT_LABEL_FORMAT: LabelFormat = {
  qr: { enabled: true, placement: "left" },
  lines: ["name"],
  font: { family: "sans", size: "m" },
  orientation: "horizontal",
  invert: false,
  maxLinesPerField: 1,
};

/** Curated font families → safe CSS stacks (no bundled fonts; identical across OSes). */
export const FONT_STACKS: Record<LabelFontFamily, string> = {
  sans: "Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'Courier New', Courier, monospace",
  condensed: "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif",
};

/** Base text height in print dots per size. The renderer shrinks below this
 *  as needed so all stacked lines fit the 128-dot print head. */
export const FONT_SIZE_DOTS: Record<LabelFontSize, number> = { s: 28, m: 40, l: 54 };

/**
 * Line box height as a multiple of font px.
 *
 * Lives here, not in a renderer, because BOTH renderers need it and both need
 * to agree: src/lib/labelBitmap.ts (browser canvas) and
 * src/lib/labelBitmapServer.ts (Node/sharp). It used to be declared separately
 * in each, which is precisely how they drifted apart (GH #1195).
 */
export const LINE_LEADING = 1.18;

/**
 * Convert a size token to the starting FONT SIZE in dots.
 *
 * `FONT_SIZE_DOTS` is a text *height* (a line box), not a font size, so it
 * must be divided by the leading before it is used as one. Getting this wrong
 * is not cosmetic: passing the raw constant renders ~21% larger type than the
 * app's own preview at the default format, which is exactly the preview-vs-print
 * drift the Brother pipeline is meant to avoid. Both renderers call this so the
 * derivation exists in one place.
 */
export function baseFontPx(size: LabelFontSize): number {
  return Math.floor(FONT_SIZE_DOTS[size] / LINE_LEADING);
}

/**
 * Named layout presets — applied as a partial over the current format.
 *
 * GH #1007 F3: carry an i18n KEY (not a hardcoded English label) so the editor
 * can translate the preset names — they render untranslated in German Settings
 * otherwise, and the i18n parity test (which only scans literal string-argument
 * translation calls) can never catch a hardcoded string here.
 */
export const LABEL_PRESETS: Record<string, { labelKey: string; patch: Partial<LabelFormat> }> = {
  nameOnly: { labelKey: "settings.labelFormat.preset.nameOnly", patch: { lines: ["name"] } },
  vendorType: { labelKey: "settings.labelFormat.preset.vendorType", patch: { lines: ["vendorType"] } },
  vendorOverType: { labelKey: "settings.labelFormat.preset.vendorOverType", patch: { lines: ["vendor", "type"] } },
  typeColor: { labelKey: "settings.labelFormat.preset.typeColor", patch: { lines: ["type", "colorName"] } },
};

/** Representative filament for the Settings live preview (so it works with no real filament in context). */
export const SAMPLE_FILAMENT: Required<LabelFilament> = {
  name: "Galaxy Black",
  vendor: "Prusament",
  type: "PLA",
  colorName: "Galaxy Black",
};

const FIELD_VALUE: Record<LabelFieldId, (f: LabelFilament) => string> = {
  name: (f) => (f.name ?? "").trim(),
  vendor: (f) => (f.vendor ?? "").trim(),
  type: (f) => (f.type ?? "").trim(),
  vendorType: (f) =>
    [f.vendor, f.type].map((s) => (s ?? "").trim()).filter(Boolean).join(" "),
  colorName: (f) => (f.colorName ?? "").trim(),
};

/**
 * Resolve the ordered, non-empty display strings for a filament under a
 * format. Empty/whitespace fields are dropped so a missing vendor/color
 * doesn't print a blank line.
 */
export function composeLabelLines(filament: LabelFilament, format: LabelFormat): string[] {
  return format.lines
    .map((id) => FIELD_VALUE[id]?.(filament) ?? "")
    .filter((s) => s.length > 0);
}

/**
 * #745: word-wrap a single field's text into at most `maxLines` lines,
 * BALANCED so each line carries roughly the same number of words, with any
 * remainder going on the FIRST lines (the reporter's "divide words by N,
 * remainder to the first lines"). Pure string math — no width measurement; the
 * canvas renderer shrinks the font so the wrapped lines fit the print head.
 *
 * A single unbreakable token (or maxLines <= 1) returns one line unchanged — a
 * 40-char single word still goes on one line, which is correct for word-wrap.
 */
export function wrapLabelLine(text: string, maxLines: number): string[] {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= 1 || maxLines <= 1) return [trimmed];
  const lineCount = Math.min(maxLines, words.length);
  const base = Math.floor(words.length / lineCount);
  const rem = words.length % lineCount;
  const out: string[] = [];
  let i = 0;
  for (let line = 0; line < lineCount; line++) {
    const take = base + (line < rem ? 1 : 0); // first `rem` lines get one extra
    out.push(words.slice(i, i + take).join(" "));
    i += take;
  }
  return out;
}

/**
 * Like `composeLabelLines`, but each field's value is word-wrapped into up to
 * `format.maxLinesPerField` lines (#745), then flattened top→bottom. With the
 * default `maxLinesPerField === 1` this returns exactly what `composeLabelLines`
 * does, so the un-wrapped path is unchanged.
 */
export function composeWrappedLabelLines(filament: LabelFilament, format: LabelFormat): string[] {
  const maxLines = format.maxLinesPerField ?? 1;
  return composeLabelLines(filament, format).flatMap((s) => wrapLabelLine(s, maxLines));
}

const FONT_FAMILIES: LabelFontFamily[] = ["sans", "serif", "mono", "condensed"];
const FONT_SIZES: LabelFontSize[] = ["s", "m", "l"];
const FIELD_IDS: LabelFieldId[] = ["name", "vendor", "type", "vendorType", "colorName"];

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Coerce arbitrary parsed input (persisted JSON, possibly partial or from an
 * older/newer version) into a valid LabelFormat, falling back to the default
 * for any missing/invalid field. Always returns a usable format.
 */
/**
 * Strictly validate a CALLER-SUPPLIED partial LabelFormat.
 *
 * `normalizeLabelFormat` below is a PERSISTENCE normalizer: it coerces
 * anything unrecognised to a default so a hand-edited or older stored format
 * still loads. That is right for storage and wrong for a request — a caller
 * sending `{ qr: { enabled: "false" } }` would have it silently become the
 * default `true` and PRINT a QR they tried to disable (GH #1195). Misspelled
 * nested keys and invalid enum values degrade the same way.
 *
 * Returns a human-readable reason, or null when the override is acceptable.
 * Only checks the shape; `normalizeLabelFormat` still runs afterwards to fill
 * in whatever the caller omitted.
 */
export function validateLabelFormatOverride(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "format must be an object.";
  }
  const o = raw as Record<string, unknown>;

  const allowed = ["qr", "lines", "font", "orientation", "invert", "maxLinesPerField"];
  const unknown = Object.keys(o).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return `format has unknown field(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`;
  }

  if (o.qr !== undefined) {
    if (typeof o.qr !== "object" || o.qr === null || Array.isArray(o.qr)) {
      return "format.qr must be an object.";
    }
    const qr = o.qr as Record<string, unknown>;
    const qrUnknown = Object.keys(qr).filter((k) => !["enabled", "placement"].includes(k));
    if (qrUnknown.length > 0) return `format.qr has unknown field(s): ${qrUnknown.join(", ")}.`;
    if (qr.enabled !== undefined && typeof qr.enabled !== "boolean") {
      return "format.qr.enabled must be a boolean.";
    }
    if (qr.placement !== undefined && qr.placement !== "left" && qr.placement !== "right") {
      return 'format.qr.placement must be "left" or "right".';
    }
  }

  if (o.font !== undefined) {
    if (typeof o.font !== "object" || o.font === null || Array.isArray(o.font)) {
      return "format.font must be an object.";
    }
    const font = o.font as Record<string, unknown>;
    const fUnknown = Object.keys(font).filter((k) => !["family", "size"].includes(k));
    if (fUnknown.length > 0) return `format.font has unknown field(s): ${fUnknown.join(", ")}.`;
    if (font.family !== undefined && !(FONT_FAMILIES as string[]).includes(font.family as string)) {
      return `format.font.family must be one of: ${FONT_FAMILIES.join(", ")}.`;
    }
    if (font.size !== undefined && !(FONT_SIZES as string[]).includes(font.size as string)) {
      return `format.font.size must be one of: ${FONT_SIZES.join(", ")}.`;
    }
  }

  if (o.lines !== undefined) {
    if (!Array.isArray(o.lines)) return "format.lines must be an array.";
    // An EXPLICIT empty list is not "no preference": normalizeLabelFormat
    // replaces it with DEFAULT_LABEL_FORMAT.lines (["name"]), so a caller
    // asking for a QR-only label would get the filament name printed too.
    // Omit `lines` to accept the default; use qr.enabled + a field list to say
    // what you actually want.
    if (o.lines.length === 0) {
      return "format.lines must not be empty — omit it to use the default.";
    }
    for (const l of o.lines) {
      if (typeof l !== "string" || !(FIELD_IDS as string[]).includes(l)) {
        return `format.lines entries must be one of: ${FIELD_IDS.join(", ")}.`;
      }
    }
  }

  if (o.orientation !== undefined && o.orientation !== "horizontal" && o.orientation !== "vertical") {
    return 'format.orientation must be "horizontal" or "vertical".';
  }
  if (o.invert !== undefined && typeof o.invert !== "boolean") {
    return "format.invert must be a boolean.";
  }
  if (o.maxLinesPerField !== undefined) {
    const n = o.maxLinesPerField;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_LINES_PER_FIELD) {
      return `format.maxLinesPerField must be an integer between 1 and ${MAX_LINES_PER_FIELD}.`;
    }
  }
  return null;
}

export function normalizeLabelFormat(input: unknown): LabelFormat {
  const o = (input ?? {}) as Record<string, unknown>;
  const qr = (o.qr ?? {}) as Record<string, unknown>;
  const font = (o.font ?? {}) as Record<string, unknown>;

  const rawLines = Array.isArray(o.lines) ? o.lines : DEFAULT_LABEL_FORMAT.lines;
  // GH #954: dedupe (a field is either shown or not — never stacked) so a
  // persisted/hand-edited format can't repeat a field N times and overflow the
  // print head. A Set also caps the list at the number of valid field ids.
  const lines = [
    ...new Set(
      (rawLines as unknown[]).filter(
        (l): l is LabelFieldId => typeof l === "string" && (FIELD_IDS as string[]).includes(l),
      ),
    ),
  ];

  return {
    qr: {
      enabled: typeof qr.enabled === "boolean" ? qr.enabled : DEFAULT_LABEL_FORMAT.qr.enabled,
      placement: oneOf<QrPlacement>(qr.placement, ["left", "right"], DEFAULT_LABEL_FORMAT.qr.placement),
    },
    // Never persist an empty line list — a label with no QR and no text is useless.
    lines: lines.length > 0 ? lines : DEFAULT_LABEL_FORMAT.lines,
    font: {
      family: oneOf<LabelFontFamily>(font.family, FONT_FAMILIES, DEFAULT_LABEL_FORMAT.font.family),
      size: oneOf<LabelFontSize>(font.size, FONT_SIZES, DEFAULT_LABEL_FORMAT.font.size),
    },
    orientation: oneOf<LabelOrientation>(
      o.orientation,
      ["horizontal", "vertical"],
      DEFAULT_LABEL_FORMAT.orientation,
    ),
    invert: typeof o.invert === "boolean" ? o.invert : DEFAULT_LABEL_FORMAT.invert,
    maxLinesPerField: clampInt(
      o.maxLinesPerField,
      1,
      MAX_LINES_PER_FIELD,
      DEFAULT_LABEL_FORMAT.maxLinesPerField,
    ),
  };
}

/** Coerce a value to an integer in [min, max]; fall back when not a finite number. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
