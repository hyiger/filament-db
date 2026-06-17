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

/** Named layout presets — applied as a partial over the current format. */
export const LABEL_PRESETS: Record<string, { label: string; patch: Partial<LabelFormat> }> = {
  nameOnly: { label: "Name only", patch: { lines: ["name"] } },
  vendorType: { label: "Vendor + Type", patch: { lines: ["vendorType"] } },
  vendorOverType: { label: "Vendor over Type", patch: { lines: ["vendor", "type"] } },
  typeColor: { label: "Type + Color", patch: { lines: ["type", "colorName"] } },
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
export function normalizeLabelFormat(input: unknown): LabelFormat {
  const o = (input ?? {}) as Record<string, unknown>;
  const qr = (o.qr ?? {}) as Record<string, unknown>;
  const font = (o.font ?? {}) as Record<string, unknown>;

  const rawLines = Array.isArray(o.lines) ? o.lines : DEFAULT_LABEL_FORMAT.lines;
  const lines = (rawLines as unknown[]).filter(
    (l): l is LabelFieldId => typeof l === "string" && (FIELD_IDS as string[]).includes(l),
  );

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
