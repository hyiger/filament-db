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
  qrModuleCount,
  sanitizeTsplLiteral,
  type LabelDocument,
  type LabelSpec,
  type TsplCommand,
  type TsplEcc,
} from "./tsplEncoder";

/** Largest module size we will use. Bigger scans easier but wastes sheet. */
const QR_MAX_CELL = 8;
/** Below this, a 203 dpi thermal print is unreliable to scan in a garage. */
const QR_MIN_CELL = 4;
/** Clear modules required on every side of a QR by the spec. Matches
 *  QR_QUIET_ZONE_MODULES in src/lib/labelBitmap.ts, which passes it to the
 *  qrcode renderer as `margin: 4` for the same reason. */
const QR_QUIET_ZONE_MODULES = 4;
/** Right-hand margin kept clear of the printable edge. */
const EDGE_MARGIN = 8;
/** Advance width in dots of TSPL internal font "3" (16x24). */
const FONT3_WIDTH = 16;
/** Advance width in dots of TSPL internal font "2" (12x20) — the footer
 *  hint's font. Budgeting the hint with FONT3_WIDTH truncated it 16
 *  characters early on the first physical label ("...indicator tu...")
 *  while a third of the line's real width sat unused. */
const FONT2_WIDTH = 12;
/** Advance width in dots of TSPL internal font "5" (32x48). */
const FONT5_WIDTH = 32;

export interface FittedQr {
  ecc: TsplEcc;
  cell: number;
  /** The data symbol itself, excluding its quiet zone. */
  sizeDots: number;
  /** Clear space required on EACH side. */
  quietDots: number;
  /** sizeDots + 2 * quietDots — the space the symbol actually needs. */
  footprintDots: number;
}

/**
 * Choose the ECC level and module size for a QR that must fit `maxDots`.
 *
 * A `QRCODE` command's printed size is NOT implied by its arguments — the
 * firmware picks the symbol version from the payload at print time. Hardcoding
 * a cell size therefore prints a symbol whose dimensions depend on the data:
 * the 16-byte payload in the original fixture is 29 modules, but a real deep
 * link is 67 bytes and 49 modules, which at the fixture's cell 7 runs 104 dots
 * past the edge of 100mm stock and simply isn't printed.
 *
 * Prefers the STRONGEST error correction that still prints at a scannable
 * module size — a dry-box label gets handled, smudged and scanned in a
 * workshop, so ECC earns its space — and steps down only when geometry
 * forces it. That is the trade-off the handoff spec calls for ("beyond ~60
 * characters, drop to ECC M and document the tradeoff").
 */
export function fitQr(payload: string, maxDots: number): FittedQr {
  for (const ecc of ["H", "Q", "M", "L"] as const) {
    const modules = qrModuleCount(payload, ecc);
    if (modules == null) continue;
    // Fit the FOOTPRINT, not the symbol. A QR needs four clear modules on
    // every side; sizing the data area alone lets a neighbouring border sit
    // inside the quiet zone, which is another "prints fine, never scans"
    // failure. Counting the quiet zone as part of what must fit makes it
    // impossible to squeeze out.
    const perSide = QR_QUIET_ZONE_MODULES;
    const cell = Math.min(QR_MAX_CELL, Math.floor(maxDots / (modules + 2 * perSide)));
    // First (strongest) ECC that reaches a readable module size wins.
    if (cell >= QR_MIN_CELL) {
      const quietDots = perSide * cell;
      return {
        ecc,
        cell,
        sizeDots: modules * cell,
        quietDots,
        footprintDots: modules * cell + 2 * quietDots,
      };
    }
  }
  // QR_MIN_CELL is a floor, not a preference. Returning a 2- or 3-dot symbol
  // "so something prints" hands the user a label whose QR does not scan at
  // 203 dpi — indistinguishable from a working one until they try it. A
  // payload that cannot reach the floor at ANY ECC level is too long for this
  // label, and saying so is more useful than printing decoration.
  throw new Error(
    `QR payload is too long to print legibly in ${maxDots} dots ` +
      `(${payload.length} chars needs modules under ${QR_MIN_CELL} dots at every ECC level). ` +
      `Shorten the deep link or use a larger label.`,
  );
}

/**
 * Truncate a manifest row to what actually fits the sheet.
 *
 * TSPL `TEXT` does not wrap and does not clip — it just runs off the edge, so
 * an over-long spool label silently loses its tail with no indication. An
 * explicit "..." at least shows the row was cut.
 *
 * Measures the SANITIZED string, not the input. The encoder folds text to
 * 7-bit ASCII on the way out and several of those substitutions are
 * length-INCREASING — "ß" becomes "ss", "°" becomes "deg", "€" becomes "EUR"
 * — so budgeting against the raw string under-counts the printed width and
 * lets a fitted row overflow anyway. Sixteen "ß" characters print as
 * thirty-two. Sanitisation is idempotent, so re-folding at encode time is a
 * no-op.
 */
export function fitRowText(text: string, maxChars: number): string {
  const printed = sanitizeTsplLiteral(text);
  if (maxChars <= 0) return "";
  if (printed.length <= maxChars) return printed;
  if (maxChars <= 3) return printed.slice(0, maxChars);
  return `${printed.slice(0, maxChars - 3)}...`;
}

/** Code 128 overhead in modules: start (11) + checksum (11) + stop (13). */
const CODE128_FIXED_MODULES = 35;
/** Each encoded character is 11 modules wide. */
const CODE128_MODULES_PER_CHAR = 11;
/** Clear modules required on EACH side of a Code 128 symbol. The QR fix one
 *  commit ago reserved the 2D quiet zone and left this one unreserved — same
 *  defect, sibling symbology. */
const CODE128_QUIET_ZONE_MODULES = 10;

/**
 * Pick a bar width for a Code 128 payload, or null when it cannot fit.
 *
 * Like the QR, a barcode's printed width is driven by its payload, and
 * location names have no schema or form length limit — a 40-character name at
 * the fixture's 2-dot bars is 950 dots against 751 available. A clipped
 * Code 128 has no stop pattern, so it scans as nothing while still looking
 * like a barcode; returning null lets the caller OMIT it rather than print
 * something that only appears to work. The QR still carries the identity.
 */
export function fitBarcode(payload: string, maxDots: number): { narrow: number } | null {
  // Fit the FOOTPRINT — bars plus both quiet zones — not the bars alone. A
  // scanner needs the clear space to find the symbol's edges, so a barcode
  // whose quiet zone is clipped by the sheet edge reads as nothing while
  // still looking printed. Exactly the QR mistake, one symbology over.
  const modules =
    CODE128_MODULES_PER_CHAR * payload.length +
    CODE128_FIXED_MODULES +
    2 * CODE128_QUIET_ZONE_MODULES;
  for (const narrow of [2, 1]) {
    if (modules * narrow <= maxDots) return { narrow };
  }
  return null;
}

/** How many font-3 characters fit on a manifest row for this stock. */
export function maxRowChars(spec: LabelSpec): number {
  const usable = mmToDots(spec.widthMm, spec.dpi) - DRY_BOX_LAYOUT.rows.x - EDGE_MARGIN;
  return Math.max(0, Math.floor(usable / FONT3_WIDTH));
}

/**
 * Layout geometry, in dots at 203 dpi, kept in one object so the label can be
 * tuned without hunting through the builder.
 *
 * Only the header block is fixed. Everything below it is DERIVED, because the
 * QR's printed size depends on the payload (see fitQr) — a fixed contents
 * position would either collide with a large QR or waste a band of sheet
 * under a small one.
 */
export const DRY_BOX_LAYOUT = {
  headerBox: { x0: 16, y0: 16, x1: 796, thickness: 5, minBottom: 180 },
  name: { x: 40, y: 50, font: "5" as const },
  subtitle: { x: 40, y: 130, font: "3" as const },
  /** QR origin, and the tallest square region it may occupy. */
  qr: { x: 560, y: 40, maxRegion: 300 },
  /** Offsets below the header box for the contents block. */
  headingOffset: 50,
  ruleOffset: 88,
  rowsOffset: 110,
  rows: { x: 56, pitch: 40, font: "3" as const },
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

/** Default formatter: ISO `YYYY-MM-DD` from LOCAL components, so it agrees
 *  with an injected locale-aware formatter rather than disagreeing by a day. */
function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Re-anchor a stored calendar date to local midnight.
 *
 * `desiccantChangedAt` comes from a `<input type="date">` and is stored as
 * midnight UTC, so handing that instant to any local-time formatter renders
 * the PREVIOUS day for every user west of UTC. This repo has already been
 * bitten by exactly that (v1.60.1 added a `timeZone` option to formatDate for
 * the analytics day labels). Re-anchoring keeps the calendar day intact no
 * matter which formatter the caller injects.
 */
function toCalendarDate(value: string | Date): Date {
  const d = new Date(value);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}


/** Case-folded, separator-normalised and space-padded, so a containment test
 *  matches only WHOLE tokens. Padding is what supplies the word boundaries:
 *  " prusa space gray " does not contain " pa ", where a raw substring test
 *  would find the "pa" inside "space".
 *
 *  "+" survives normalisation because it is a MATERIAL DISTINCTION, not
 *  punctuation: collapsing it made tokenized("PLA+") equal tokenized("PLA"),
 *  so a PLA+ spool whose name mentions PLA printed as plain "PLA" and the
 *  label understated the material. Hyphens and slashes still collapse, which
 *  is what lets a "PC-ABS" type match a "PC ABS" name. */
function tokenized(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim()} `;
}

/** One manifest line: the spool's own label when it has one, else the
 *  filament identity. Vendor is prefixed only when it isn't already the
 *  first word of the name, so "Prusament PLA" doesn't become
 *  "Prusament Prusament PLA".
 *
 *  The type dedup matches WHOLE TOKENS, not substrings. A bare
 *  `includes(type)` silently swallowed short material codes that happen to
 *  occur inside a colour or vendor word — "Prusa Space Gray" + "PA" printed
 *  without its material, as did "Papaya"/PA, "Sapphire"/PP and
 *  "Petrol Blue"/PET. On a dry-box manifest the material is the one thing a
 *  glance needs, so dropping it is the worst available failure. Normalising
 *  separators also keeps hyphenated types like "PC-ABS" matching a
 *  "PC ABS" name. */
export function describeItem(item: DryBoxLabelItem): string {
  const own = item.label?.trim();
  if (own) return own;
  const name = item.filamentName?.trim() || "";
  const vendor = item.filamentVendor?.trim() || "";
  const type = item.filamentType?.trim() || "";
  const parts: string[] = [];
  // Match the vendor as WHOLE LEADING TOKENS, not a raw prefix. `startsWith`
  // suppressed any vendor that merely began the name — "Sun" vanished from
  // "Sunset Orange", "Pol" from "Polar White" — losing the brand from the
  // manifest. Same prefix-collision flaw the type dedup below already had.
  //
  // The trade-off: "Prusa" + "Prusament PLA" now renders "Prusa Prusament
  // PLA" rather than suppressing. A redundant word costs nothing; a dropped
  // vendor loses information. The case this guard was actually written for —
  // "Prusament" + "Prusament PLA" — still collapses correctly.
  if (vendor && !tokenized(name).startsWith(tokenized(vendor))) parts.push(vendor);
  if (name) parts.push(name);
  if (type && !tokenized(`${vendor} ${name}`).includes(tokenized(type))) parts.push(type);
  return parts.join(" ").trim();
}

/** Everything about the label's geometry that depends on the stock and the
 *  QR payload. Exported so the preview and the tests can assert placement
 *  without re-deriving it. */
export interface DryBoxGeometry {
  widthDots: number;
  heightDots: number;
  qr: FittedQr;
  headerBottom: number;
  headingY: number;
  ruleY: number;
  firstRowY: number;
  footerTop: number;
  /** Manifest rows that fit between the rule and the footer. */
  capacity: number;
  /** Characters that fit on one manifest row. */
  rowChars: number;
  /** Characters of the location name that fit before the QR column. */
  nameChars: number;
  /** Characters of the subtitle that fit before the QR column. */
  subtitleChars: number;
  /** Characters that fit on a font-3 footer line (x = footer.x). */
  footerChars: number;
  /** Characters that fit on the font-2 footer hint line. Budgeted with its
   *  OWN font width — see FONT2_WIDTH. */
  hintChars: number;
  /** Right edge of the header box, derived from the stock width. */
  headerRight: number;
  /** Width of the contents and footer rules, derived from the stock width. */
  ruleWidth: number;
}

export function dryBoxGeometry(spec: LabelSpec, qrPayload: string): DryBoxGeometry {
  const L = DRY_BOX_LAYOUT;
  const widthDots = mmToDots(spec.widthMm, spec.dpi);
  const heightDots = mmToDots(spec.heightMm, spec.dpi);

  // The QR gets whatever square fits between its origin and the right edge,
  // capped so a short payload doesn't swallow the sheet.
  // Bound the QR by BOTH axes. Sizing off width alone let wide-but-short
  // stock (120x70mm) grow a 287-dot symbol that pushed the header past the
  // footer and turned a printable label into an error; shrinking the symbol
  // to the available height is the more useful outcome.
  //
  // The width bound also reserves the header box's RIGHT BORDER INK: `BOX`
  // draws its stroke inward from (x1, y1), so the right border occupies
  // [headerRight - thickness, headerRight]. Bounding the footprint at
  // headerRight alone let a tight fit park the border's 5 dots inside the
  // QR's right quiet zone (GH #1084) — the same "prints fine, never scans"
  // failure fitQr exists to prevent. The height bound needs no thickness
  // term: headerBottom grows to clear the footprint plus the bottom border
  // (see below), and EDGE_MARGIN > thickness keeps the footer guard intact.
  const qrRegion = Math.min(
    L.qr.maxRegion,
    widthDots - L.qr.x - EDGE_MARGIN - L.headerBox.thickness,
    heightDots - L.footerHeight - L.qr.y - EDGE_MARGIN,
  );
  if (qrRegion < 1) {
    throw new Error(
      `Stock is too small for a dry-box label ` +
        `(${spec.widthMm}x${spec.heightMm}mm leaves no room for the QR).`,
    );
  }
  const qr = fitQr(qrPayload, qrRegion);

  // Grow the header box to clear the QR's FOOTPRINT — plus the border's own
  // INK, so the border never lands inside the quiet zone. `BOX` strokes
  // inward from (x1, y1): the bottom border spans [y1 - thickness, y1]
  // (TsplLabelPreview.tsx renders exactly this, and it is hardware-exact).
  // Setting y1 to the footprint edge alone put those 5 dots INSIDE the
  // bottom quiet zone on every QR-driven label (GH #1084).
  const headerBottom = Math.max(
    L.headerBox.minBottom,
    L.qr.y + qr.footprintDots + L.headerBox.thickness,
  );
  const firstRowY = headerBottom + L.rowsOffset;
  const footerTop = heightDots - L.footerHeight;
  // Without this the footer lands at a NEGATIVE y on very short stock (20mm
  // gives 160 - 240 = -80) and the label is emitted with off-sheet
  // coordinates instead of a diagnosable error.
  if (footerTop <= headerBottom) {
    throw new Error(
      `Stock is too short for a dry-box label (${spec.heightMm}mm leaves no room ` +
        `between the header and the footer).`,
    );
  }

  return {
    widthDots,
    heightDots,
    qr,
    // Decorations are DERIVED from the stock, not fixed: the fixture's
    // x1=796 header box and 740-dot rules overflow 90mm stock (719 dots).
    headerRight: widthDots - EDGE_MARGIN,
    ruleWidth: widthDots - 2 * L.footer.x,
    headerBottom,
    headingY: headerBottom + L.headingOffset,
    ruleY: headerBottom + L.ruleOffset,
    firstRowY,
    footerTop,
    capacity: Math.max(0, Math.floor((footerTop - firstRowY) / L.rows.pitch)),
    rowChars: maxRowChars(spec),
    // The header's two text fields share their row with the QR, so they get
    // their own budget ending at the QR column — the manifest's full-width
    // budget would let a normal location name overprint the symbol.
    nameChars: Math.max(0, Math.floor((L.qr.x - L.name.x - EDGE_MARGIN) / FONT5_WIDTH)),
    subtitleChars: Math.max(0, Math.floor((L.qr.x - L.subtitle.x - EDGE_MARGIN) / FONT3_WIDTH)),
    footerChars: Math.max(0, Math.floor((widthDots - L.footer.x - EDGE_MARGIN) / FONT3_WIDTH)),
    hintChars: Math.max(0, Math.floor((widthDots - L.footer.x - EDGE_MARGIN) / FONT2_WIDTH)),
  };
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

  // Sanitize EVERY payload once, here, and use the sanitized string for both
  // sizing and emission. renderCommand sanitizes on the way out anyway, and
  // several of those substitutions GROW the string ("GBP" for "£"), so any
  // measurement taken against the raw input under-counts what the printer
  // receives — twelve "£" size a 203-dot symbol and print a 259-dot one.
  // Measuring the raw string bit the manifest rows first and then the QR; the
  // fix is structural so a third call site cannot repeat it.
  const qrPayload = sanitizeTsplLiteral(input.qrPayload);
  const barcodePayload = sanitizeTsplLiteral(input.barcodePayload ?? input.location.name);
  const g = dryBoxGeometry(spec, qrPayload);

  const text = (
    x: number,
    y: number,
    font: "2" | "3" | "5",
    content: string,
  ): TsplCommand => ({ kind: "text", x, y, font, rotation: 0, xScale: 1, yScale: 1, content });

  const commands: TsplCommand[] = [
    {
      kind: "box",
      x0: L.headerBox.x0,
      y0: L.headerBox.y0,
      x1: g.headerRight,
      y1: g.headerBottom,
      thickness: L.headerBox.thickness,
    },
    text(L.name.x, L.name.y, L.name.font, fitRowText(input.location.name, g.nameChars)),
    text(
      L.subtitle.x,
      L.subtitle.y,
      L.subtitle.font,
      fitRowText(
        input.location.humidity != null
          ? `${strings.subtitle}  ${input.location.humidity}% RH`
          : strings.subtitle,
        g.subtitleChars,
      ),
    ),
    {
      kind: "qrcode",
      // L.qr.{x,y} is the FOOTPRINT origin; inset the symbol by its quiet
      // zone so the clear space is reserved on the leading edges too.
      x: L.qr.x + g.qr.quietDots,
      y: L.qr.y + g.qr.quietDots,
      ecc: g.qr.ecc,
      cell: g.qr.cell,
      mode: "A",
      rotation: 0,
      content: qrPayload,
    },
  ];

  // The contents block is emitted as a UNIT — heading, rule and rows — or not
  // at all. Suppressing only the rows still printed a "CONTENTS" heading and
  // its rule on top of the footer on short stock (at 65mm the heading lands
  // at y=303 against a footer starting at 279).
  if (g.capacity > 0) {
    commands.push(
      text(
        L.headerBox.x0 + 24,
        g.headingY,
        L.subtitle.font,
        fitRowText(`${strings.contents}  (${strings.asOf} ${fmt(input.asOf)})`, g.rowChars),
      ),
      {
        kind: "bar",
        x: L.footer.x,
        y: g.ruleY,
        width: g.ruleWidth,
        height: L.footer.ruleHeight,
      },
    );
  }

  // --- contents manifest -------------------------------------------------
  const labels = input.items.map(describeItem).filter((s) => s.length > 0);
  const rowText: string[] = [];
  if (g.capacity === 0) {
    // Stock too short for even one row — see the contents-block guard above.
  } else if (labels.length === 0) {
    rowText.push(strings.empty);
  } else if (labels.length <= g.capacity) {
    rowText.push(...labels.map((s) => `- ${s}`));
  } else {
    // Reserve the final row for the overflow count so the label never
    // implies it is showing everything.
    const shown = Math.max(0, g.capacity - 1);
    rowText.push(...labels.slice(0, shown).map((s) => `- ${s}`));
    rowText.push(strings.more.replace("{count}", String(labels.length - shown)));
  }
  rowText.forEach((content, i) => {
    commands.push(
      text(L.rows.x, g.firstRowY + i * L.rows.pitch, L.rows.font, fitRowText(content, g.rowChars)),
    );
  });

  // --- footer, pinned to the bottom of the stock -------------------------
  const desiccant = input.location.desiccantChangedAt
    ? fmt(toCalendarDate(input.location.desiccantChangedAt))
    : strings.desiccantNever;

  commands.push(
    {
      kind: "bar",
      x: L.footer.x,
      y: g.footerTop,
      width: g.ruleWidth,
      height: L.footer.ruleHeight,
    },
    text(
      L.footer.x,
      g.footerTop + 20,
      L.footer.font,
      fitRowText(`${strings.desiccantChanged}  ${desiccant}`, g.footerChars),
    ),
    text(L.footer.x, g.footerTop + 64, L.footer.hintFont, fitRowText(strings.replaceHint, g.hintChars)),
  );

  // Omit the barcode entirely rather than print a clipped one — a Code 128
  // without its stop pattern scans as nothing while still looking like a
  // barcode. The QR carries the identity regardless.
  const bars = fitBarcode(barcodePayload, g.widthDots - L.footer.x - EDGE_MARGIN);
  if (bars) {
    commands.push({
      kind: "barcode",
      // Inset by the quiet zone so the clear space is ON the sheet.
      x: L.footer.x + CODE128_QUIET_ZONE_MODULES * bars.narrow,
      y: g.footerTop + 120,
      symbology: "128",
      height: L.footer.barcode.height,
      humanReadable: 1,
      rotation: 0,
      narrow: bars.narrow,
      wide: bars.narrow,
      content: barcodePayload,
    });
  }

  return { spec, commands };
}
