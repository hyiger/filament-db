import { describe, it, expect } from "vitest";
import {
  renderLabelRaster,
  escapeXml,
  HORIZONTAL_PADDING_DOTS,
  VERTICAL_PADDING_DOTS,
  QR_TEXT_GAP_DOTS,
} from "@/lib/labelBitmapServer";
import { PRINT_HEAD_DOTS, packGrayscaleBitmap, encodeLabel } from "@/lib/labelEncoder";

/**
 * Server-side (sharp) label renderer — the Node twin of the browser
 * HTMLCanvas path. Extracted from scripts/print-label.ts in GH #1195; these
 * tests exist because that CLI had no coverage at all.
 */
describe("escapeXml", () => {
  it("escapes every XML metacharacter", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeXml("Drybox 01")).toBe("Drybox 01");
  });

  it("neutralises a name that would otherwise close the SVG text element", () => {
    // A filament literally named `</text><script>` must not terminate the
    // element — the renderer builds SVG by string concatenation.
    expect(escapeXml("</text><script>")).not.toContain("<");
  });
});

describe("geometry constants", () => {
  it("keeps the QR budget inside the print head", () => {
    expect(PRINT_HEAD_DOTS - 2 * VERTICAL_PADDING_DOTS).toBeLessThan(PRINT_HEAD_DOTS);
    expect(HORIZONTAL_PADDING_DOTS).toBeGreaterThan(0);
    expect(QR_TEXT_GAP_DOTS).toBeGreaterThan(0);
  });
});

describe("renderLabelRaster", () => {
  it("returns a raster exactly one print-head wide", async () => {
    const out = await renderLabelRaster({ name: "Drybox 01", qrPayload: "2acc21072a" });
    expect(out.cols).toBe(PRINT_HEAD_DOTS);
    expect(out.rasterLines).toBeGreaterThan(0);
    expect(out.raster.length).toBe(out.rasterLines * out.cols);
  });

  it("is deterministic — same input, identical bytes", async () => {
    const a = await renderLabelRaster({ name: "Drybox 01", qrPayload: "2acc21072a" });
    const b = await renderLabelRaster({ name: "Drybox 01", qrPayload: "2acc21072a" });
    expect(Buffer.compare(a.raster, b.raster)).toBe(0);
  });

  it("produces only fully black or fully white dots after the threshold pass", async () => {
    const { raster } = await renderLabelRaster({ name: "X", qrPayload: "abc" });
    const distinct = new Set(raster);
    for (const v of distinct) expect([0, 255]).toContain(v);
  });

  it("grows the label when the text is longer", async () => {
    const short = await renderLabelRaster({ name: "A", qrPayload: "abc" });
    const long = await renderLabelRaster({
      name: "A much longer filament name that runs on",
      qrPayload: "abc",
    });
    expect(long.rasterLines).toBeGreaterThan(short.rasterLines);
  });

  it("throws rather than clipping when the QR exceeds the 24mm tape budget", async () => {
    // A clipped QR still LOOKS like a QR but scans as nothing, so silently
    // cropping would hand the user an unusable label that appears fine.
    // ~700 chars is the practical ceiling: at 800 the symbol needs 117 dots
    // against the 116-dot budget (128 print head - 2x6 padding).
    await expect(
      renderLabelRaster({ name: "x", qrPayload: "z".repeat(1200) }),
    ).rejects.toThrow(/quiet zone/i);
  });

  it("surfaces the QR library's own refusal for a payload no QR can hold", async () => {
    // Past QR version 40 the encoder itself refuses; that path must also
    // reject rather than fall through to a partial render.
    await expect(
      renderLabelRaster({ name: "x", qrPayload: "z".repeat(3000) }),
    ).rejects.toThrow(/too big/i);
  });

  it("feeds the encoder cleanly end to end", async () => {
    const { raster, rasterLines } = await renderLabelRaster({
      name: "Drybox 01",
      qrPayload: "http://192.168.4.93:3456/inventory?location=abc123",
    });
    const packed = packGrayscaleBitmap(new Uint8Array(raster), rasterLines);
    const bytes = encodeLabel({
      bitmap: packed,
      rasterLines,
      tapeWidthMm: 24,
      autoCut: true,
    });
    expect(bytes.length).toBeGreaterThan(0);
    // Brother trailer for print-with-feed-and-cut.
    expect(bytes[bytes.length - 1]).toBe(0x1a);
  });
});
