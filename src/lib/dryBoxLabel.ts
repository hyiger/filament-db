/**
 * Dry-box label template — a Location rendered as a 4x6 TSPL label.
 *
 * Pure and DB-free: takes plain data, returns a `LabelDocument` for
 * `render()` in src/lib/tsplEncoder.ts. That keeps it unit-testable and lets
 * the renderer build an on-screen preview from the same document it prints.
 *
 * The layout is the hardware-verified `04_drybox_label.prn` fixture,
 * generalized: the header block, contents rule, desiccant line and Code 128
 * keep their proven geometry, while the contents list reflows to fill the
 * sheet instead of being three hardcoded rows.
 *
 * WHY THE MANIFEST CARRIES AN "AS OF" STAMP
 *   A printed contents list is a point-in-time snapshot and spools move. The
 *   app already made this call for Brother spool labels — no remaining-grams
 *   field, because a printed amount goes stale — and the same reasoning
 *   applies here, except that for a dry box the manifest IS the point of the
 *   label. So it prints, dated, and the QR resolves the live view.
 */

import {
  DPI_203,
  mmToDots,
  type LabelDocument,
  type LabelSpec,
  type TsplCommand,
} from "./tsplEncoder";

/**
 * Layout geometry, in dots at 203 dpi, kept in one object so the label can be
 * tuned without hunting through the builder.
 *
 * Values below y=640 are derived rather than fixed: the footer is pinned to
 * the bottom of whatever stock is configured so the contents list gets every
 * remaining row.
 */
export const DRY_BOX_LAYOUT = {
  /** Header box enclosing the location name + QR. */
  headerBox: { x0: 16, y0: 16, x1: 796, y1: 180, thickness: 5 },
  name: { x: 40, y: 50, font: "5" as const },
  subtitle: { x: 40, y: 130, font: "3" as const },
  qr: { x: 560, y: 40, cell: 7, ecc: "H" as const },
  contentsHeading: { x: 40, y: 230, font: "3" as const },
  contentsRule: { x: 40, y: 268, width: 740, height: 3 },
  /** First contents row, and the vertical pitch between rows. */
  rows: { x: 56, firstY: 290, pitch: 40, font: "3" as const },
  /** Height reserved at the bottom for the footer block (rule, desiccant
   *  line, replace hint, barcode). Contents stop above this. */
  footerHeight: 240,
  footer: {
    ruleWidth: 740,
    ruleHeight: 3,
    x: 40,
    font: "3" as const,
    hintFont: "2" as const,
    barcode: { height: 60, narrow: 2, wide: 2 },
  },
} as const;

/** The 4x6 stock the Y813BT ships with, declared as the fixtures do. The
 *  fixtures use 100x150mm rather than a true 4x6 (101.6x152.4mm) and print
 *  correctly, so that is what ships as the default. */
export const DRY_BOX_SPEC: LabelSpec = {
  widthMm: 100,
  heightMm: 150,
  gapMm: 3,
  gapOffsetMm: 0,
  density: 8,
  speed: 4,
  reference: { x: 0, y: 0 },
  direction: 1,
  dpi: DPI_203,
};

export interface DryBoxLabelLocation {
  name: string;
  humidity?: number | null;
  /** ISO string (from the API) or a Date (server-side). */
  desiccantChangedAt?: string | Date | null;
}

/** One spool on the shelf. Field names mirror the rows
 *  `GET /api/spools/by-location` already returns, so the caller can pass
 *  them through without remapping. */
export interface DryBoxLabelItem {
  filamentName: string;
  filamentVendor?: string | null;
  filamentType?: string | null;
  /** The user's own label for this spool, preferred over the filament name
   *  when set — it is what's written on the physical roll. */
  label?: string | null;
}

export interface DryBoxLabelInput {
  location: DryBoxLabelLocation;
  items: DryBoxLabelItem[];
  /** QR payload — a deep link to the live location view. */
  qrPayload: string;
  /** Code 128 payload. Defaults to the location name. */
  barcodePayload?: string;
  /**
   * Timestamp for the "as of" stamp.
   *
   * Passed in rather than read from the clock so `dryBoxLabel` stays pure and
   * deterministic — the same input always produces the same document, which
   * is what makes it snapshot-testable and lets the preview match the print.
   */
  asOf: Date;
  /** Overrides for the label stock. */
  spec?: Partial<LabelSpec>;
  /**
   * Locale-aware date formatter. Defaults to ISO `YYYY-MM-DD`.
   *
   * Deliberately injected: calling `toLocaleDateString` in here would make
   * output depend on the host's locale and time zone, so the same document
   * would render differently on the preview canvas and the print head.
   */
  formatDate?: (date: Date) => string;
}

/** Strings the caller supplies so the template carries no English. */
export interface DryBoxLabelStrings {
  subtitle: string;
  contents: string;
  desiccantChanged: string;
  desiccantNever: string;
  replaceHint: string;
  empty: string;
  /** Rendered with a `{count}` token when the list overflows the sheet. */
  more: string;
  asOf: string;
}

export const DEFAULT_DRY_BOX_STRINGS: DryBoxLabelStrings = {
  subtitle: "FILAMENT DRY BOX",
  contents: "CONTENTS",
  desiccantChanged: "DESICCANT CHANGED",
  desiccantNever: "not recorded",
  replaceHint: "Replace every 90 days or when indicator turns pink",
  empty: "(empty)",
  more: "+{count} more",
  asOf: "as of",
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** One manifest line: the spool's own label when it has one, else the
 *  filament identity. Vendor is prefixed only when it isn't already the
 *  first word of the name, so "Prusament PLA" doesn't become
 *  "Prusament Prusament PLA". */
export function describeItem(item: DryBoxLabelItem): string {
  const own = item.label?.trim();
  if (own) return own;
  const name = item.filamentName?.trim() || "";
  const vendor = item.filamentVendor?.trim() || "";
  const type = item.filamentType?.trim() || "";
  const parts: string[] = [];
  if (vendor && !name.toLowerCase().startsWith(vendor.toLowerCase())) parts.push(vendor);
  if (name) parts.push(name);
  if (type && !`${vendor} ${name}`.toLowerCase().includes(type.toLowerCase())) parts.push(type);
  return parts.join(" ").trim();
}

/** How many manifest rows fit between the contents rule and the footer. */
export function maxContentRows(spec: LabelSpec): number {
  const heightDots = mmToDots(spec.heightMm, spec.dpi);
  const available = heightDots - DRY_BOX_LAYOUT.footerHeight - DRY_BOX_LAYOUT.rows.firstY;
  return Math.max(0, Math.floor(available / DRY_BOX_LAYOUT.rows.pitch));
}

/**
 * Build the label document for a dry box.
 *
 * Overflow is reported, never silently dropped: when the shelf holds more
 * spools than fit on the sheet, the last row reads "+N more" so the label
 * cannot be mistaken for a complete inventory.
 */
export function dryBoxLabel(
  input: DryBoxLabelInput,
  strings: DryBoxLabelStrings = DEFAULT_DRY_BOX_STRINGS,
): LabelDocument {
  const spec: LabelSpec = { ...DRY_BOX_SPEC, ...input.spec };
  const fmt = input.formatDate ?? isoDate;
  const L = DRY_BOX_LAYOUT;
  const heightDots = mmToDots(spec.heightMm, spec.dpi);

  const commands: TsplCommand[] = [
    { kind: "box", ...L.headerBox },
    {
      kind: "text",
      x: L.name.x,
      y: L.name.y,
      font: L.name.font,
      rotation: 0,
      xScale: 1,
      yScale: 1,
      content: input.location.name,
    },
    {
      kind: "text",
      x: L.subtitle.x,
      y: L.subtitle.y,
      font: L.subtitle.font,
      rotation: 0,
      xScale: 1,
      yScale: 1,
      content:
        input.location.humidity != null
          ? `${strings.subtitle}  ${input.location.humidity}% RH`
          : strings.subtitle,
    },
    {
      kind: "qrcode",
      x: L.qr.x,
      y: L.qr.y,
      ecc: L.qr.ecc,
      cell: L.qr.cell,
      mode: "A",
      rotation: 0,
      content: input.qrPayload,
    },
    {
      kind: "text",
      x: L.contentsHeading.x,
      y: L.contentsHeading.y,
      font: L.contentsHeading.font,
      rotation: 0,
      xScale: 1,
      yScale: 1,
      content: `${strings.contents}  (${strings.asOf} ${fmt(input.asOf)})`,
    },
    { kind: "bar", x: L.contentsRule.x, y: L.contentsRule.y, width: L.contentsRule.width, height: L.contentsRule.height },
  ];

  // --- contents manifest -------------------------------------------------
  const capacity = maxContentRows(spec);
  const labels = input.items.map(describeItem).filter((s) => s.length > 0);
  const rowText: string[] = [];
  if (labels.length === 0) {
    rowText.push(strings.empty);
  } else if (labels.length <= capacity) {
    rowText.push(...labels.map((s) => `- ${s}`));
  } else {
    // Reserve the final row for the overflow count so the label never
    // implies it is showing everything.
    const shown = Math.max(0, capacity - 1);
    rowText.push(...labels.slice(0, shown).map((s) => `- ${s}`));
    rowText.push(strings.more.replace("{count}", String(labels.length - shown)));
  }
  rowText.forEach((content, i) => {
    commands.push({
      kind: "text",
      x: L.rows.x,
      y: L.rows.firstY + i * L.rows.pitch,
      font: L.rows.font,
      rotation: 0,
      xScale: 1,
      yScale: 1,
      content,
    });
  });

  // --- footer, pinned to the bottom of the stock -------------------------
  const footerTop = heightDots - L.footerHeight;
  const desiccant = input.location.desiccantChangedAt
    ? fmt(new Date(input.location.desiccantChangedAt))
    : strings.desiccantNever;

  commands.push(
    { kind: "bar", x: L.footer.x, y: footerTop, width: L.footer.ruleWidth, height: L.footer.ruleHeight },
    {
      kind: "text",
      x: L.footer.x,
      y: footerTop + 20,
      font: L.footer.font,
      rotation: 0,
      xScale: 1,
      yScale: 1,
      content: `${strings.desiccantChanged}  ${desiccant}`,
    },
    {
      kind: "text",
      x: L.footer.x,
      y: footerTop + 64,
      font: L.footer.hintFont,
      rotation: 0,
      xScale: 1,
      yScale: 1,
      content: strings.replaceHint,
    },
    {
      kind: "barcode",
      x: L.footer.x,
      y: footerTop + 120,
      symbology: "128",
      height: L.footer.barcode.height,
      humanReadable: 1,
      rotation: 0,
      narrow: L.footer.barcode.narrow,
      wide: L.footer.barcode.wide,
      content: input.barcodePayload ?? input.location.name,
    },
  );

  return { spec, commands };
}
