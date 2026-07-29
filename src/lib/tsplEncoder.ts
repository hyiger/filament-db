/**
 * KNAON Y813BT (and other TSPL-speaking) label command emitter.
 *
 * Pure TypeScript, no Node or browser dependencies — usable from the
 * Electron main process, the sandboxed renderer (for an on-screen
 * preview built from the same document), and a standalone CLI. Returns
 * `Uint8Array` rather than `Buffer` for exactly that reason: `node:buffer`
 * must not enter the client bundle. Mirrors `src/lib/labelEncoder.ts`.
 *
 * PROTOCOL REFERENCE
 *   TSC TSPL/TSPL2 Programming Manual. The KNAON firmware is a superset
 *   of the subset its own CUPS filter emits (see HARDWARE CAPABILITY).
 *
 * HOW THE COMMAND SET WAS ESTABLISHED
 *   KNAON publishes no command language for the Y813BT. The vendor Linux
 *   driver settles it: `/usr/lib/cups/filter/knaon/Filter/rastertolabel`
 *   is a fork of CUPS 2.2.7's stock `rastertolabel.c` (the build path
 *   /home/ben/Desktop/cups-2.2.7/... is still in the binary) with a new
 *   branch appended at model number 20 decimal — `*cupsModelNumber: 20`
 *   in KnaonLabel.ppd. Stock CUPS uses 0 (Dymo), 0x10/0x11 (Zebra EPL),
 *   0x12 (ZPL), 0x13 (CPCL), 0x20 (Intellitech PCL); 20 decimal is new.
 *
 *   All the Zebra and Dymo command strings remain in the binary as dead
 *   code, so `strings | grep` is actively misleading. Resolving which
 *   literals StartPage/EndPage reference under the model-20 branch gives
 *   the real vocabulary: SIZE, REFERENCE, GAP, BLINE, DENSITY (0–15),
 *   SPEED (1–8 ips), SETC AUTODOTTED|PAUSEKEY|WATERMARK (vendor
 *   extensions, not in TSC's published set), CLS, BITMAP, PRINT.
 *
 * HARDWARE CAPABILITY — Task 0, confirmed on hardware 2026-07-26
 *   The vendor driver only ever emits BITMAP, so it proves nothing about
 *   whether the firmware implements the text/barcode/2D primitives; many
 *   ODM firmwares ship a raster-only subset. Printing 03_probe_full.prn
 *   settled it: **all nine numbered probe items rendered**, including
 *   item 7 (BARCODE, Code 128) and item 8 (QRCODE).
 *
 *   So this emitter targets NATIVE primitives throughout. A 4×6 label as
 *   TSPL is ~600 bytes and renders from the printer's font ROM at native
 *   resolution; the same label rasterized 1-bit at 203 dpi is 812 × 1218
 *   px ≈ 124 KB through a threshold-and-dither path. `bitmap` remains in
 *   the command union for future logo support, but no rasterization path
 *   exists and none is needed. Do not re-derive this — it cost a printed
 *   label to establish.
 *
 * FRAMING
 *   Every command is terminated with CRLF. This is not stylistic: an
 *   LF-only job is silently ignored by the firmware — no error, no
 *   output, no paper movement. `render()` asserts it.
 */

/** Dots per inch. The Y813BT is 203 dpi; the PPD exposes no other value. */
export const DPI_203 = 203 as const;

/** Millimetres per inch, for the mm ⇄ dots conversion. */
const MM_PER_INCH = 25.4;

/** TSPL internal bitmap fonts, selected by the quoted font argument to
 *  TEXT. 1 = 8×12, 2 = 12×20, 3 = 16×24, 4 = 24×32, 5 = 32×48; 6–8 are
 *  firmware-dependent. Probe items 1–3 confirm 2/3/4 on this hardware. */
export type TsplFont = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";

/** Clockwise rotation in degrees. Probe item 9 confirms 90 works. */
export type TsplRotation = 0 | 90 | 180 | 270;

/** QR error-correction level. Higher corrects more damage but costs
 *  capacity: L≈7%, M≈15%, Q≈25%, H≈30%. */
export type TsplEcc = "L" | "M" | "Q" | "H";

/** QR data-encoding mode: A = auto (firmware picks the compaction),
 *  M = manual. The fixtures all use A. */
export type TsplQrMode = "A" | "M";

/** Linear symbologies. Only Code 128 is hardware-confirmed (probe item 7). */
export type TsplBarcodeSymbology = "128" | "39" | "EAN13";

/** Human-readable interpretation placement under a barcode:
 *  0 = none, 1 = centred, 2 = left, 3 = right. */
export type TsplHumanReadable = 0 | 1 | 2 | 3;

export type TsplCommand =
  | {
      kind: "text";
      x: number;
      y: number;
      font: TsplFont;
      rotation: TsplRotation;
      xScale: number;
      yScale: number;
      content: string;
    }
  | {
      kind: "qrcode";
      x: number;
      y: number;
      ecc: TsplEcc;
      /** Module size in dots, 1–10. Drives the symbol's physical size. */
      cell: number;
      mode: TsplQrMode;
      rotation: TsplRotation;
      content: string;
    }
  | {
      kind: "barcode";
      x: number;
      y: number;
      symbology: TsplBarcodeSymbology;
      /** Bar height in dots. */
      height: number;
      humanReadable: TsplHumanReadable;
      rotation: TsplRotation;
      /** Narrow-bar width in dots. */
      narrow: number;
      /** Wide-bar width in dots. */
      wide: number;
      content: string;
    }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; thickness: number }
  | { kind: "bar"; x: number; y: number; width: number; height: number }
  | { kind: "reverse"; x: number; y: number; width: number; height: number }
  | {
      kind: "bitmap";
      x: number;
      y: number;
      /** Width in BYTES, not dots — see the BITMAP note below. */
      widthBytes: number;
      /** Height in DOTS, not bytes. */
      heightDots: number;
      /** 0 = OVERWRITE, 1 = OR, 2 = XOR. */
      mode: 0 | 1 | 2;
      data: Uint8Array;
    };

export interface LabelSpec {
  widthMm: number;
  heightMm: number;
  /** Vertical gap between die-cut labels, in mm. `0` means continuous
   *  stock and sidesteps gap sensing entirely — the safe value during
   *  bring-up, since gap values are label-stock-dependent. */
  gapMm: number;
  gapOffsetMm: number;
  /** Print darkness, 0–15. Omitted entirely when undefined (the minimal
   *  probe job emits no DENSITY line at all). */
  density?: number;
  /** Print speed in inches/sec, 1–8. Omitted when undefined. */
  speed?: number;
  /** Origin offset in dots. Omitted when undefined. */
  reference?: { x: number; y: number };
  /**
   * Print direction / feed orientation.
   *
   * NOT present in the vendor driver's string table — this command is
   * unverified on this firmware even though it appears to work. It is
   * therefore optional and omitted by default: if a job produces no
   * output at all, dropping DIRECTION is the first thing to try.
   */
  direction?: 0 | 1;
  dpi: typeof DPI_203;
}

export interface LabelDocument {
  spec: LabelSpec;
  commands: TsplCommand[];
  /** PRINT's first argument — number of label sets. Default 1. */
  sets?: number;
  /** PRINT's second argument — copies of each label. Default 1. */
  copies?: number;
}

/**
 * QR byte-mode data capacity per symbol version, indexed by ECC level.
 *
 * Versions 1–20; a label QR past v20 has modules too fine to scan reliably
 * off a 203 dpi thermal print anyway. Symbol side in modules is
 * `17 + 4 * version`, so the printed size is `(17 + 4v) * cell` dots.
 *
 * This exists because the physical size of a `QRCODE` command is NOT implied
 * by its arguments — it is driven by the payload length, which the firmware
 * resolves at print time. Placing a QR without computing this prints a symbol
 * that silently runs off the edge of the stock.
 */
const QR_BYTE_CAPACITY: Readonly<Record<TsplEcc, readonly number[]>> = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322, 364, 394, 442, 482],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250, 280, 310, 338, 382],
};

/**
 * Symbol side, in modules, for a payload at the given ECC level.
 *
 * Returns null when the payload exceeds v20 capacity — the caller must then
 * shorten it or drop to a weaker ECC rather than emit an unprintable symbol.
 * Counts UTF-8 BYTES, not characters, because QR byte mode encodes bytes.
 */
export function qrModuleCount(payload: string, ecc: TsplEcc): number | null {
  const bytes = new TextEncoder().encode(payload).length;
  const table = QR_BYTE_CAPACITY[ecc];
  for (let v = 0; v < table.length; v++) {
    if (bytes <= table[v]) return 17 + 4 * (v + 1);
  }
  return null;
}

/** Thrown when a document cannot be rendered to valid TSPL. */
export class TsplRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TsplRenderError";
  }
}

/**
 * Millimetres → dots at the given DPI.
 *
 * At 203 dpi, 1 mm = 7.992 dots, 4 in = 812 dots, 6 in = 1218 dots.
 * Rounds half away from zero symmetrically so negative offsets (valid
 * for REFERENCE) behave like their positive mirror rather than drifting
 * one dot, which `Math.round`'s round-half-up would do at .5.
 */
export function mmToDots(mm: number, dpi: number = DPI_203): number {
  if (!Number.isFinite(mm)) {
    throw new TsplRenderError(`mmToDots: mm must be finite, got ${mm}`);
  }
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new TsplRenderError(`mmToDots: dpi must be a positive finite number, got ${dpi}`);
  }
  const dots = (mm * dpi) / MM_PER_INCH;
  return dots < 0 ? -Math.round(-dots) : Math.round(dots);
}

/** Dots → millimetres. Inverse of `mmToDots`, without the rounding. */
export function dotsToMm(dots: number, dpi: number = DPI_203): number {
  if (!Number.isFinite(dots)) {
    throw new TsplRenderError(`dotsToMm: dots must be finite, got ${dots}`);
  }
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new TsplRenderError(`dotsToMm: dpi must be a positive finite number, got ${dpi}`);
  }
  return (dots * MM_PER_INCH) / dpi;
}

/**
 * Transliteration table for characters outside 7-bit ASCII.
 *
 * WHY TRANSLITERATE RATHER THAN PICK A CODEPAGE
 *   TSPL wants single bytes, but which byte depends on the printer's
 *   active codepage, and the two obvious candidates disagree on exactly
 *   the characters this app produces: `°` is 0xF8 in cp437 but 0xB0 in
 *   latin1, and `³` exists in latin1 (0xB3) but has NO cp437 codepoint
 *   at all. The reference generator used cp437 with errors="replace", so
 *   `mm³/s` silently degraded to `mm?/s` there.
 *
 *   All four golden fixtures are pure ASCII, so they cannot validate any
 *   encoding choice — this needs its own targeted test, and ultimately a
 *   codepage probe on hardware. Until that lands, transliterating to
 *   strict ASCII is the choice that is deterministic, testable, needs no
 *   CODEPAGE command, and cannot silently emit a byte the firmware reads
 *   as something else. Swap in a real codepage map here once the probe
 *   settles it; the rest of the emitter is unaffected.
 */
const TRANSLITERATIONS: ReadonlyMap<string, string> = new Map([
  // Units and symbols this app actually produces.
  ["°", "deg"],
  ["³", "3"],
  ["²", "2"],
  ["µ", "u"],
  ["±", "+/-"],
  ["×", "x"],
  ["÷", "/"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["¥", "JPY"],
  // Typographic characters that arrive via copy-paste and would
  // otherwise trip the ASCII assertion on user-entered names/notes.
  ["‘", "'"],
  ["’", "'"],
  ["“", '"'],
  ["”", '"'],
  ["–", "-"],
  ["—", "-"],
  ["…", "..."],
  // Space variants, written as escapes so no invisible character ever
  // lives in this source. U+202F is not hypothetical: it is GROUP_SPACE,
  // the thousands separator the v1.66 "Space" number format emits, so it
  // reaches a label through any formatted weight or price.
  ["\u00a0", " "], // NO-BREAK SPACE
  ["\u202f", " "], // NARROW NO-BREAK SPACE
  ["\u2007", " "], // FIGURE SPACE
  ["\u2009", " "], // THIN SPACE
]);

/**
 * Fold a string to 7-bit ASCII.
 *
 * Unicode NFD decomposition strips diacritics generically (é → e, ü → u,
 * å → a) so the table above only needs the characters decomposition
 * can't handle. German ß and the Nordic ø/đ have no decomposition, hence
 * the explicit cases.
 */
export function toAscii(input: string): string {
  let out = "";
  // Decompose first so combining marks become separate codepoints that
  // the strip below removes, turning "ü" into "u".
  //
  // U+0300–U+036F is Combining Diacritical Marks, which is exactly what
  // NFD emits for every Latin-script accented letter (é → e + U+0301,
  // ş → s + U+0327, ő → o + U+030B). Deliberately an explicit range and
  // not \p{M}: property escapes are ES2018 while this repo targets
  // ES2017, and tsc validates regex FLAGS against the target but not
  // regex body syntax — so \p{M} would pass the typecheck and only be a
  // runtime concern. Non-Latin marks fall through to the "?" placeholder
  // below, which is the correct outcome for an ASCII-folding emitter.
  const decomposed = input.normalize("NFD").replace(/[\u0300-\u036f]+/g, "");
  for (const ch of decomposed) {
    const mapped = TRANSLITERATIONS.get(ch);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    // charCodeAt rather than codePointAt: it is typed `number` (no
    // optional to unwrap through an unreachable `?? 0` branch), and the
    // difference is immaterial here. `ch` comes from for..of, so an
    // astral character arrives whole and charCodeAt(0) returns its high
    // surrogate — which is above 0x7e and therefore lands on the "?"
    // placeholder, exactly where the codepoint itself would have landed.
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else if (ch === "ß") {
      out += "ss";
    } else if (ch === "ø" || ch === "Ø") {
      out += ch === "ø" ? "o" : "O";
    } else if (ch === "đ" || ch === "Đ") {
      out += ch === "đ" ? "d" : "D";
    } else {
      // Everything else (CJK, emoji, control characters) collapses to a
      // visible placeholder rather than vanishing, so a mis-encoded
      // label is obvious on inspection instead of subtly wrong.
      out += "?";
    }
  }
  return out;
}

/**
 * Make a string safe to sit inside TSPL's double-quoted literal syntax.
 *
 * TSPL quotes literals with `"`. Behaviour for embedded quotes and
 * backslashes is UNVERIFIED on this firmware, and a filament name or a
 * dry-box note is user-entered, so a parser break here is reachable from
 * ordinary data. Until an escape convention is confirmed on hardware the
 * conservative choice is substitution rather than escaping: a label that
 * reads `PLA 'Galaxy'` is a cosmetic compromise, whereas one that
 * silently truncates the job at an unbalanced quote is a support ticket.
 *
 * Also strips CR and LF, which would otherwise terminate the command
 * mid-literal and inject whatever followed as a new command — the one
 * genuinely dangerous case, since dry-box notes are free text.
 */
export function sanitizeTsplLiteral(input: string): string {
  // Collapse line terminators BEFORE folding to ASCII. Order matters and
  // getting it wrong is silent: toAscii maps control characters to "?",
  // so folding first leaves nothing for a CR/LF strip to match and the
  // injection guard degrades into cosmetic mangling.
  const singleLine = input.replace(/[\r\n\u2028\u2029]+/g, " ");
  return toAscii(singleLine).replace(/"/g, "'").replace(/\\/g, "/");
}

/**
 * Encode an already-ASCII string to bytes.
 *
 * Returns a Uint8Array rather than number[] so callers can append it to
 * the output with `set()` instead of spreading it into `push(...)` —
 * spreading a large payload passes one argument per byte and blows V8's
 * call-stack limit (a 812x1218 one-bit raster is 124,236 bytes, well
 * past it).
 */
function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    /* c8 ignore start -- unreachable internal-consistency asserts. Every
       caller routes user content through sanitizeTsplLiteral (which folds
       to ASCII and strips line terminators) and every other fragment comes
       from a numeric interpolation or a closed string-union, so neither
       branch is reachable today. They are kept so a future caller that
       bypasses sanitisation fails loudly rather than emitting a mangled
       byte or, worse, splicing an extra command into the job. */
    if (code > 0x7f) {
      throw new TsplRenderError(
        `Non-ASCII codepoint U+${code.toString(16).toUpperCase()} reached the byte encoder`,
      );
    }
    if (code === 0x0a || code === 0x0d) {
      throw new TsplRenderError(
        `Raw line terminator at offset ${i} inside a TSPL command: ${JSON.stringify(text)}`,
      );
    }
    /* c8 ignore stop */
    out[i] = code;
  }
  return out;
}

function assertInt(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new TsplRenderError(`${label} must be an integer (dots), got ${value}`);
  }
}

function assertRange(value: number, min: number, max: number, label: string): void {
  assertInt(value, label);
  if (value < min || value > max) {
    throw new TsplRenderError(`${label} must be in [${min}, ${max}], got ${value}`);
  }
}

/**
 * Render one command to its TSPL line, as a list of byte chunks.
 *
 * Chunks rather than a single array because a BITMAP's payload is raw
 * binary spliced in after the comma: keeping it as its own chunk means it
 * is never copied element-by-element and never passes through the ASCII
 * encoder.
 */
function renderCommand(cmd: TsplCommand): Uint8Array[] {
  switch (cmd.kind) {
    case "text": {
      assertInt(cmd.x, "text.x");
      assertInt(cmd.y, "text.y");
      assertRange(cmd.xScale, 1, 10, "text.xScale");
      assertRange(cmd.yScale, 1, 10, "text.yScale");
      const content = sanitizeTsplLiteral(cmd.content);
      return [
        asciiBytes(
          `TEXT ${cmd.x},${cmd.y},"${cmd.font}",${cmd.rotation},${cmd.xScale},${cmd.yScale},"${content}"`,
        ),
      ];
    }
    case "qrcode": {
      assertInt(cmd.x, "qrcode.x");
      assertInt(cmd.y, "qrcode.y");
      assertRange(cmd.cell, 1, 10, "qrcode.cell");
      const content = sanitizeTsplLiteral(cmd.content);
      if (content.length === 0) {
        throw new TsplRenderError("qrcode.content must not be empty");
      }
      // ecc and mode are bare tokens here, NOT quoted — matches the
      // hardware-verified fixtures (QRCODE 24,560,H,6,A,0,"...").
      return [
        asciiBytes(
          `QRCODE ${cmd.x},${cmd.y},${cmd.ecc},${cmd.cell},${cmd.mode},${cmd.rotation},"${content}"`,
        ),
      ];
    }
    case "barcode": {
      assertInt(cmd.x, "barcode.x");
      assertInt(cmd.y, "barcode.y");
      assertRange(cmd.height, 1, 32767, "barcode.height");
      assertRange(cmd.narrow, 1, 255, "barcode.narrow");
      assertRange(cmd.wide, 1, 255, "barcode.wide");
      const content = sanitizeTsplLiteral(cmd.content);
      if (content.length === 0) {
        throw new TsplRenderError("barcode.content must not be empty");
      }
      return [
        asciiBytes(
          `BARCODE ${cmd.x},${cmd.y},"${cmd.symbology}",${cmd.height},${cmd.humanReadable},` +
            `${cmd.rotation},${cmd.narrow},${cmd.wide},"${content}"`,
        ),
      ];
    }
    case "box": {
      assertInt(cmd.x0, "box.x0");
      assertInt(cmd.y0, "box.y0");
      assertInt(cmd.x1, "box.x1");
      assertInt(cmd.y1, "box.y1");
      assertRange(cmd.thickness, 1, 32767, "box.thickness");
      return [asciiBytes(`BOX ${cmd.x0},${cmd.y0},${cmd.x1},${cmd.y1},${cmd.thickness}`)];
    }
    case "bar": {
      assertInt(cmd.x, "bar.x");
      assertInt(cmd.y, "bar.y");
      assertRange(cmd.width, 1, 32767, "bar.width");
      assertRange(cmd.height, 1, 32767, "bar.height");
      return [asciiBytes(`BAR ${cmd.x},${cmd.y},${cmd.width},${cmd.height}`)];
    }
    case "reverse": {
      assertInt(cmd.x, "reverse.x");
      assertInt(cmd.y, "reverse.y");
      assertRange(cmd.width, 1, 32767, "reverse.width");
      assertRange(cmd.height, 1, 32767, "reverse.height");
      return [asciiBytes(`REVERSE ${cmd.x},${cmd.y},${cmd.width},${cmd.height}`)];
    }
    case "bitmap": {
      assertInt(cmd.x, "bitmap.x");
      assertInt(cmd.y, "bitmap.y");
      assertRange(cmd.widthBytes, 1, 32767, "bitmap.widthBytes");
      assertRange(cmd.heightDots, 1, 32767, "bitmap.heightDots");
      const expected = cmd.widthBytes * cmd.heightDots;
      if (cmd.data.length !== expected) {
        throw new TsplRenderError(
          `bitmap.data length ${cmd.data.length} does not match ` +
            `widthBytes (${cmd.widthBytes}) x heightDots (${cmd.heightDots}) = ${expected}`,
        );
      }
      // Width is in BYTES and height in DOTS — the argument units differ,
      // which is the classic TSPL BITMAP trap. Payload follows the comma
      // as raw binary with no quoting and no terminator of its own, and
      // rides as its own chunk so it is never spread or re-encoded.
      return [
        asciiBytes(`BITMAP ${cmd.x},${cmd.y},${cmd.widthBytes},${cmd.heightDots},${cmd.mode},`),
        cmd.data,
      ];
    }
    /* c8 ignore next 4 -- exhaustiveness guard: the union is closed, so
       this is unreachable while the switch stays complete. It exists so
       adding a command without handling it fails the TYPE check at
       `never`, per the spec's test plan. */
    default: {
      const unhandled: never = cmd;
      throw new TsplRenderError(`Unhandled TSPL command: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** CRLF. Mandatory — an LF-only job is silently discarded by the firmware. */
const CRLF = new Uint8Array([0x0d, 0x0a]);

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Render a label document to the TSPL byte stream.
 *
 * Pure and deterministic: the same document always produces byte-identical
 * output. The golden-fixture tests and any version-controlled diff of
 * emitted jobs both depend on that.
 *
 * Emission order (matching the hardware-verified fixtures):
 *   SIZE → GAP → [DENSITY] → [SPEED] → [REFERENCE] → [DIRECTION] → CLS
 *   → commands → PRINT
 *
 * The four bracketed lines are omitted entirely when their spec field is
 * undefined. That is not a micro-optimisation: the minimal probe job that
 * proves the parser is alive consists of SIZE/GAP/CLS/PRINT and nothing
 * else, so the header has to be structurally optional, not merely
 * value-optional.
 *
 * CRLF framing is guaranteed BY CONSTRUCTION: every fragment is appended
 * through a helper that follows it with CRLF, and asciiBytes rejects a raw
 * terminator inside a command. That is what makes the framing correct even
 * for jobs carrying a binary BITMAP payload, where a byte-level scan
 * cannot tell a payload 0x0A from a line terminator.
 */
export function render(doc: LabelDocument): Uint8Array {
  const { spec } = doc;
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    totalLength += bytes.length;
  };
  const line = (text: string): void => {
    push(asciiBytes(text));
    push(CRLF);
  };

  // Finite first: Infinity satisfies `> 0` and NaN satisfies nothing, so
  // without this an Infinity width or a NaN gap offset would sail through
  // the comparisons below and emit `SIZE Infinity mm,...` — a job the
  // printer cannot parse, produced without a single error.
  for (const [label, value] of [
    ["widthMm", spec.widthMm],
    ["heightMm", spec.heightMm],
    ["gapMm", spec.gapMm],
    ["gapOffsetMm", spec.gapOffsetMm],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new TsplRenderError(`LabelSpec.${label} must be a finite number, got ${value}`);
    }
  }
  if (spec.widthMm <= 0 || spec.heightMm <= 0) {
    throw new TsplRenderError(
      `LabelSpec width/height must be positive, got ${spec.widthMm}x${spec.heightMm} mm`,
    );
  }
  if (spec.gapMm < 0) {
    throw new TsplRenderError(`LabelSpec gapMm must be >= 0, got ${spec.gapMm}`);
  }

  line(`SIZE ${spec.widthMm} mm,${spec.heightMm} mm`);
  line(`GAP ${spec.gapMm} mm,${spec.gapOffsetMm} mm`);

  if (spec.density !== undefined) {
    assertRange(spec.density, 0, 15, "spec.density");
    line(`DENSITY ${spec.density}`);
  }
  if (spec.speed !== undefined) {
    assertRange(spec.speed, 1, 8, "spec.speed");
    line(`SPEED ${spec.speed}`);
  }
  if (spec.reference !== undefined) {
    assertInt(spec.reference.x, "spec.reference.x");
    assertInt(spec.reference.y, "spec.reference.y");
    line(`REFERENCE ${spec.reference.x},${spec.reference.y}`);
  }
  if (spec.direction !== undefined) {
    line(`DIRECTION ${spec.direction}`);
  }

  line("CLS");

  for (const cmd of doc.commands) {
    for (const chunk of renderCommand(cmd)) {
      push(chunk);
    }
    push(CRLF);
  }

  const sets = doc.sets ?? 1;
  const copies = doc.copies ?? 1;
  assertRange(sets, 1, 999999999, "doc.sets");
  assertRange(copies, 1, 999999999, "doc.copies");
  line(`PRINT ${sets},${copies}`);

  const out = concatChunks(chunks, totalLength);
  assertEndsWithCrlf(out);
  return out;
}

function assertEndsWithCrlf(bytes: Uint8Array): void {
  if (bytes.length < 2) {
    throw new TsplRenderError("Rendered job is empty");
  }
  if (bytes[bytes.length - 2] !== 0x0d || bytes[bytes.length - 1] !== 0x0a) {
    throw new TsplRenderError("Rendered job does not end with CRLF");
  }
}

/**
 * Assert a job is CRLF-framed throughout.
 *
 * Cheap insurance against the single failure mode with no diagnostic: an
 * LF-only job produces no error, no output, and no paper movement, so it
 * presents identically to a dead printer.
 *
 * ONLY VALID FOR JOBS WITH NO BITMAP COMMAND. A BITMAP payload is
 * arbitrary binary and may legitimately contain a 0x0A that is not
 * preceded by 0x0D; this scan cannot distinguish that from a broken line
 * terminator and would reject a perfectly good raster. `render()` therefore
 * does not call it — its output is framed by construction — and this is
 * exported for validating jobs from OUTSIDE the emitter, such as a .prn
 * file read from disk.
 */
export function assertCrlfFramed(bytes: Uint8Array): void {
  assertEndsWithCrlf(bytes);
  // Both halves of the pair are checked. Scanning only for unpaired LF
  // would let `A\rB\r\n` through — its first CR terminates nothing — and
  // the whole point of this helper is that a job it approves is framed
  // THROUGHOUT, not merely at the end. In a bitmap-free job every byte is
  // ASCII command text or a terminator (asciiBytes rejects CR and LF
  // inside a command), so a CR that is not followed by LF is malformed
  // with no legitimate reading.
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) {
      throw new TsplRenderError(`Bare LF at byte ${i} — TSPL requires CRLF framing`);
    }
    if (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a) {
      throw new TsplRenderError(`Bare CR at byte ${i} — TSPL requires CRLF framing`);
    }
  }
}
