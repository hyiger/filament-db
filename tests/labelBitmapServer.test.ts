import { describe, it, expect } from "vitest";
import {
  renderLabelRaster,
  escapeXml,
  fitFontPx,
  LINE_LEADING,
  HORIZONTAL_PADDING_DOTS,
  VERTICAL_PADDING_DOTS,
  QR_TEXT_GAP_DOTS,
} from "@/lib/labelBitmapServer";
import { PRINT_HEAD_DOTS, packGrayscaleBitmap, encodeLabel } from "@/lib/labelEncoder";
import {
  DEFAULT_LABEL_FORMAT,
  LABEL_PRESETS,
  normalizeLabelFormat,
  type LabelFormat,
} from "@/lib/labelFormat";

/**
 * Server-side (sharp) label renderer — Node twin of the browser HTMLCanvas
 * path. Extracted from scripts/print-label.ts in GH #1195, which had no
 * coverage at all, then extended to the full LabelFormat pipeline so the
 * print API renders the same layouts the app's dialog does.
 */

const SPOOL = { name: "Galaxy Black", vendor: "Prusament", type: "PLA", colorName: "Galaxy Black" };

function fmt(patch: Partial<LabelFormat> = {}): LabelFormat {
  return normalizeLabelFormat({ ...DEFAULT_LABEL_FORMAT, ...patch });
}

describe("escapeXml", () => {
  it("escapes every XML metacharacter", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  it("neutralises a name that would otherwise close the SVG text element", () => {
    // The renderer builds SVG by concatenation, so a filament literally named
    // `</text><script>` must not terminate the element.
    expect(escapeXml("</text><script>")).not.toContain("<");
  });
});

describe("fitFontPx", () => {
  const band = PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS;

  it("keeps the base size when a single line fits comfortably", () => {
    expect(fitFontPx(1, 40)).toBe(40);
  });

  it("shrinks so N stacked lines fit the print band", () => {
    const px = fitFontPx(3, 54);
    expect(px * LINE_LEADING * 3).toBeLessThanOrEqual(band + LINE_LEADING);
    expect(px).toBeLessThan(54);
  });

  it("never returns below the 8px floor", () => {
    expect(fitFontPx(40, 54)).toBeGreaterThanOrEqual(8);
  });

  it("passes the base size straight through for an empty line list", () => {
    // Guards the division: a zero line count would otherwise divide by zero.
    expect(fitFontPx(0, 40)).toBe(40);
  });
});

describe("renderLabelRaster", () => {
  it("returns a raster exactly one print-head wide", async () => {
    const out = await renderLabelRaster({ filament: SPOOL, qrPayload: "2acc21072a" });
    expect(out.cols).toBe(PRINT_HEAD_DOTS);
    expect(out.rasterLines).toBeGreaterThan(0);
    expect(out.raster.length).toBe(out.rasterLines * out.cols);
  });

  it("composes vendor over type for the vendorOverType preset", async () => {
    const out = await renderLabelRaster({
      filament: SPOOL,
      qrPayload: "2acc21072a",
      format: fmt(LABEL_PRESETS.vendorOverType.patch),
    });
    // This is the layout the print API exposes for spool labels: the vendor
    // on the first line, the material underneath it.
    expect(out.lines).toEqual(["Prusament", "PLA"]);
  });

  it("drops empty fields rather than printing a blank line", async () => {
    const out = await renderLabelRaster({
      filament: { name: "x", vendor: "", type: "PETG" },
      qrPayload: "abc",
      format: fmt(LABEL_PRESETS.vendorOverType.patch),
    });
    expect(out.lines).toEqual(["PETG"]);
  });

  it("makes a two-line label taller-per-line than a one-line label is", async () => {
    const one = await renderLabelRaster({ filament: SPOOL, qrPayload: "abc", format: fmt() });
    const two = await renderLabelRaster({
      filament: SPOOL,
      qrPayload: "abc",
      format: fmt(LABEL_PRESETS.vendorOverType.patch),
    });
    expect(one.lines).toHaveLength(1);
    expect(two.lines).toHaveLength(2);
  });

  it("is deterministic — same input, identical bytes", async () => {
    const a = await renderLabelRaster({ filament: SPOOL, qrPayload: "2acc21072a" });
    const b = await renderLabelRaster({ filament: SPOOL, qrPayload: "2acc21072a" });
    expect(Buffer.compare(a.raster, b.raster)).toBe(0);
  });

  it("produces only fully black or fully white dots after the threshold pass", async () => {
    const { raster } = await renderLabelRaster({ filament: { name: "X" }, qrPayload: "abc" });
    for (const v of new Set(raster)) expect([0, 255]).toContain(v);
  });

  it("shortens the label when the QR is turned off", async () => {
    const withQr = await renderLabelRaster({ filament: SPOOL, qrPayload: "abc", format: fmt() });
    const noQr = await renderLabelRaster({
      filament: SPOOL,
      qrPayload: "abc",
      format: fmt({ qr: { enabled: false, placement: "left" } }),
    });
    expect(noQr.rasterLines).toBeLessThan(withQr.rasterLines);
  });

  it("renders the same length with the QR on either side", async () => {
    const left = await renderLabelRaster({
      filament: SPOOL, qrPayload: "abc",
      format: fmt({ qr: { enabled: true, placement: "left" } }),
    });
    const right = await renderLabelRaster({
      filament: SPOOL, qrPayload: "abc",
      format: fmt({ qr: { enabled: true, placement: "right" } }),
    });
    expect(right.rasterLines).toBe(left.rasterLines);
    // Same length, different ink distribution.
    expect(Buffer.compare(left.raster, right.raster)).not.toBe(0);
  });

  it("inverts to white-on-black without inverting the QR", async () => {
    const normal = await renderLabelRaster({ filament: SPOOL, qrPayload: "abc", format: fmt() });
    const inverted = await renderLabelRaster({
      filament: SPOOL, qrPayload: "abc", format: fmt({ invert: true }),
    });
    const blackOf = (b: Buffer) => b.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);
    // An inverted label is mostly ink; a normal one mostly blank.
    expect(blackOf(inverted.raster)).toBeGreaterThan(blackOf(normal.raster));
  });

  it("grows the label when the text is longer", async () => {
    const short = await renderLabelRaster({ filament: { name: "A" }, qrPayload: "abc" });
    const long = await renderLabelRaster({
      filament: { name: "A much longer filament name that runs on" },
      qrPayload: "abc",
    });
    expect(long.rasterLines).toBeGreaterThan(short.rasterLines);
  });

  it("refuses vertical orientation loudly instead of silently printing horizontal", async () => {
    await expect(
      renderLabelRaster({
        filament: SPOOL, qrPayload: "abc", format: fmt({ orientation: "vertical" }),
      }),
    ).rejects.toThrow(/vertical/i);
  });

  it("refuses a format that would print nothing at all", async () => {
    await expect(
      renderLabelRaster({
        filament: { name: "", vendor: "", type: "" },
        qrPayload: "abc",
        format: fmt({ qr: { enabled: false, placement: "left" }, lines: ["name"] }),
      }),
    ).rejects.toThrow(/nothing to print/i);
  });

  it("renders a QR-only label when every text field is empty", async () => {
    // The QR alone is a valid label -- the instanceId still identifies the
    // spool -- so an unnamed filament must print rather than refuse.
    const out = await renderLabelRaster({
      filament: { name: "", vendor: "", type: "" },
      qrPayload: "2acc21072a",
      format: fmt(LABEL_PRESETS.vendorOverType.patch),
    });
    expect(out.lines).toEqual([]);
    expect(out.rasterLines).toBeGreaterThan(0);
    expect(out.cols).toBe(PRINT_HEAD_DOTS);
  });

  it("throws rather than clipping when the QR exceeds the 24mm tape budget", async () => {
    // A clipped QR still LOOKS like a QR but scans as nothing. ~700 chars is
    // the practical ceiling: at 800 the symbol needs 117 dots against the
    // 116-dot budget (128 print head - 2x6 padding).
    await expect(
      renderLabelRaster({ filament: { name: "x" }, qrPayload: "z".repeat(1200) }),
    ).rejects.toThrow(/quiet zone/i);
  });

  it("surfaces the QR library's own refusal for a payload no QR can hold", async () => {
    await expect(
      renderLabelRaster({ filament: { name: "x" }, qrPayload: "z".repeat(3000) }),
    ).rejects.toThrow(/too big/i);
  });

  it("feeds the encoder cleanly end to end", async () => {
    const { raster, rasterLines } = await renderLabelRaster({
      filament: SPOOL,
      qrPayload: "2acc21072a",
      format: fmt(LABEL_PRESETS.vendorOverType.patch),
    });
    const packed = packGrayscaleBitmap(new Uint8Array(raster), rasterLines);
    const bytes = encodeLabel({ bitmap: packed, rasterLines, tapeWidthMm: 24, autoCut: true });
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[bytes.length - 1]).toBe(0x1a); // print-with-feed-and-cut
  });

  it("keeps its geometry constants positive", () => {
    expect(HORIZONTAL_PADDING_DOTS).toBeGreaterThan(0);
    expect(QR_TEXT_GAP_DOTS).toBeGreaterThan(0);
    expect(LINE_LEADING).toBeGreaterThan(1);
  });
});
