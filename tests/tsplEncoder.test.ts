import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  render,
  mmToDots,
  dotsToMm,
  toAscii,
  sanitizeTsplLiteral,
  assertCrlfFramed,
  TsplRenderError,
  DPI_203,
  type LabelDocument,
  type LabelSpec,
  type TsplCommand,
} from "@/lib/tsplEncoder";

/**
 * Coverage for the KNAON Y813BT TSPL emitter.
 *
 * The four .prn fixtures under tests/fixtures/tspl/ are GOLDEN FILES:
 * byte-for-byte captures of jobs that printed correctly on the physical
 * printer. Reconstructing each as a LabelDocument and asserting
 * byte-equality is what pins the wire format — if the emitter drifts, a
 * job that no longer matches hardware-verified output fails here rather
 * than on a wasted roll of 4×6 stock.
 *
 * All four fixtures are pure ASCII, so they deliberately do NOT cover the
 * encoding decision. That has its own describe block below.
 */

const FIXTURE_DIR = path.resolve(__dirname, "fixtures/tspl");

function goldenFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

/** Header shared by fixtures 02–04. Fixture 01 deliberately omits it. */
const FULL_HEADER: LabelSpec = {
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

describe("render — golden fixtures from hardware", () => {
  it("01_probe_minimal: SIZE/GAP/CLS/PRINT only, no optional header lines", () => {
    // The job that proves the TSPL parser is live. Its whole point is that
    // it uses ONLY commands the vendor driver provably emits, so the
    // optional header block must be omittable in full — not merely
    // defaulted. Success on hardware = one blank label feeds.
    const doc: LabelDocument = {
      spec: {
        widthMm: 100,
        heightMm: 150,
        gapMm: 3,
        gapOffsetMm: 0,
        dpi: DPI_203,
      },
      commands: [],
    };
    expect(render(doc)).toEqual(goldenFixture("01_probe_minimal.prn"));
  });

  it("02_probe_text: full header plus a single TEXT primitive", () => {
    const doc: LabelDocument = {
      spec: FULL_HEADER,
      commands: [
        {
          kind: "text",
          x: 40,
          y: 40,
          font: "4",
          rotation: 0,
          xScale: 1,
          yScale: 1,
          content: "TSPL STAGE 02 - TEXT OK",
        },
      ],
    };
    expect(render(doc)).toEqual(goldenFixture("02_probe_text.prn"));
  });

  it("03_probe_full: every primitive, the capability matrix", () => {
    // Task 0 result, confirmed on hardware 2026-07-26: ALL NINE numbered
    // items rendered, including 7 (BARCODE) and 8 (QRCODE). That is what
    // licenses the native-primitive design — no rasterization path.
    const commands: TsplCommand[] = [
      { kind: "text", x: 24, y: 24, font: "4", rotation: 0, xScale: 1, yScale: 1, content: "TSPL CAPABILITY PROBE" },
      { kind: "text", x: 24, y: 64, font: "2", rotation: 0, xScale: 1, yScale: 1, content: "KNAON Y813BT / 203 dpi / 100x150mm" },
      { kind: "bar", x: 24, y: 100, width: 760, height: 4 },
      { kind: "text", x: 24, y: 120, font: "2", rotation: 0, xScale: 1, yScale: 1, content: "1  TEXT font 2  12x20" },
      { kind: "text", x: 24, y: 152, font: "3", rotation: 0, xScale: 1, yScale: 1, content: "2  TEXT font 3  16x24" },
      { kind: "text", x: 24, y: 190, font: "4", rotation: 0, xScale: 1, yScale: 1, content: "3  TEXT font 4  24x32" },
      { kind: "text", x: 24, y: 236, font: "3", rotation: 0, xScale: 2, yScale: 2, content: "4  TEXT 2x scale" },
      { kind: "box", x0: 24, y0: 300, x1: 300, y1: 376, thickness: 4 },
      { kind: "text", x: 44, y: 326, font: "2", rotation: 0, xScale: 1, yScale: 1, content: "5  BOX" },
      { kind: "reverse", x: 330, y: 300, width: 300, height: 76 },
      { kind: "text", x: 350, y: 326, font: "2", rotation: 0, xScale: 1, yScale: 1, content: "6  REVERSE" },
      { kind: "barcode", x: 24, y: 410, symbology: "128", height: 70, humanReadable: 1, rotation: 0, narrow: 2, wide: 2, content: "FDB-PROBE-128" },
      { kind: "text", x: 24, y: 516, font: "2", rotation: 0, xScale: 1, yScale: 1, content: "7  BARCODE code128" },
      { kind: "qrcode", x: 24, y: 560, ecc: "H", cell: 6, mode: "A", rotation: 0, content: "fdb://probe/qrcode-test" },
      { kind: "text", x: 260, y: 560, font: "2", rotation: 0, xScale: 1, yScale: 1, content: "8  QRCODE" },
      { kind: "text", x: 260, y: 592, font: "1", rotation: 0, xScale: 1, yScale: 1, content: "ECC H, cell 6" },
      { kind: "text", x: 700, y: 760, font: "3", rotation: 90, xScale: 1, yScale: 1, content: "9  ROTATED 90" },
      { kind: "bar", x: 24, y: 1100, width: 760, height: 4 },
      { kind: "text", x: 24, y: 1120, font: "2", rotation: 0, xScale: 1, yScale: 1, content: "Missing items = unimplemented in firmware" },
    ];
    expect(render({ spec: FULL_HEADER, commands })).toEqual(goldenFixture("03_probe_full.prn"));
  });

  it("04_drybox_label: the production dry-box template layout", () => {
    const contents = ["PA6-CF20 Fiberon", "PPA-CF Siraya", "PC Blend Prusament"];
    const commands: TsplCommand[] = [
      { kind: "box", x0: 16, y0: 16, x1: 796, y1: 180, thickness: 5 },
      { kind: "text", x: 40, y: 50, font: "5", rotation: 0, xScale: 1, yScale: 1, content: "BOX-07" },
      { kind: "text", x: 40, y: 130, font: "3", rotation: 0, xScale: 1, yScale: 1, content: "FILAMENT DRY BOX" },
      { kind: "qrcode", x: 560, y: 40, ecc: "H", cell: 7, mode: "A", rotation: 0, content: "fdb://box/BOX-07" },
      { kind: "text", x: 40, y: 230, font: "3", rotation: 0, xScale: 1, yScale: 1, content: "CONTENTS" },
      { kind: "bar", x: 40, y: 268, width: 740, height: 3 },
      ...contents.map((item, i): TsplCommand => ({
        kind: "text",
        x: 56,
        y: 290 + i * 40,
        font: "3",
        rotation: 0,
        xScale: 1,
        yScale: 1,
        content: `- ${item}`,
      })),
      { kind: "bar", x: 40, y: 460, width: 740, height: 3 },
      { kind: "text", x: 40, y: 480, font: "3", rotation: 0, xScale: 1, yScale: 1, content: "DESICCANT CHANGED  2026-07-12" },
      { kind: "text", x: 40, y: 524, font: "2", rotation: 0, xScale: 1, yScale: 1, content: "Replace every 90 days or when indicator turns pink" },
      { kind: "barcode", x: 40, y: 580, symbology: "128", height: 60, humanReadable: 1, rotation: 0, narrow: 2, wide: 2, content: "BOX-07" },
    ];
    expect(render({ spec: FULL_HEADER, commands })).toEqual(goldenFixture("04_drybox_label.prn"));
  });
});

describe("render — framing and determinism", () => {
  const doc: LabelDocument = {
    spec: FULL_HEADER,
    commands: [{ kind: "text", x: 1, y: 2, font: "3", rotation: 0, xScale: 1, yScale: 1, content: "hi" }],
  };

  it("is deterministic — same document, byte-identical output", () => {
    expect(render(doc)).toEqual(render(doc));
  });

  it("terminates every command with CRLF and never a bare LF", () => {
    const bytes = render(doc);
    expect(bytes[bytes.length - 2]).toBe(0x0d);
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0a) expect(bytes[i - 1]).toBe(0x0d);
    }
  });

  it("emits PRINT with both sets and copies, defaulting each to 1", () => {
    const text = new TextDecoder().decode(render(doc));
    expect(text.endsWith("PRINT 1,1\r\n")).toBe(true);
    const many = new TextDecoder().decode(render({ ...doc, sets: 2, copies: 3 }));
    expect(many.endsWith("PRINT 2,3\r\n")).toBe(true);
  });

  it("omits DIRECTION when undefined — the first line to drop when a job prints nothing", () => {
    const noDirection: LabelSpec = { ...FULL_HEADER, direction: undefined };
    const text = new TextDecoder().decode(render({ spec: noDirection, commands: [] }));
    expect(text).not.toContain("DIRECTION");
    expect(text).toContain("SPEED 4\r\n");
  });

  it("omits DENSITY, SPEED and REFERENCE independently", () => {
    const text = new TextDecoder().decode(
      render({
        spec: { widthMm: 100, heightMm: 150, gapMm: 0, gapOffsetMm: 0, speed: 2, dpi: DPI_203 },
        commands: [],
      }),
    );
    expect(text).not.toContain("DENSITY");
    expect(text).not.toContain("REFERENCE");
    expect(text).toContain("SPEED 2\r\n");
  });

  it("supports continuous stock via GAP 0 mm,0 mm", () => {
    const text = new TextDecoder().decode(
      render({ spec: { ...FULL_HEADER, gapMm: 0 }, commands: [] }),
    );
    expect(text).toContain("GAP 0 mm,0 mm\r\n");
  });
});

describe("render — every command kind", () => {
  const emit = (cmd: TsplCommand): string => {
    const text = new TextDecoder().decode(
      render({ spec: { widthMm: 100, heightMm: 150, gapMm: 3, gapOffsetMm: 0, dpi: DPI_203 }, commands: [cmd] }),
    );
    return text.split("\r\n")[3];
  };

  it("renders qrcode with ecc and mode as BARE tokens, content quoted", () => {
    // Regression pin: quoting ecc/mode produces a job the firmware
    // rejects. The hardware fixture is QRCODE 24,560,H,6,A,0,"..." —
    // note H and A carry no quotes while the payload does.
    expect(emit({ kind: "qrcode", x: 5, y: 6, ecc: "M", cell: 4, mode: "M", rotation: 180, content: "x" })).toBe(
      'QRCODE 5,6,M,4,M,180,"x"',
    );
  });

  it("renders barcode with a QUOTED symbology", () => {
    expect(
      emit({ kind: "barcode", x: 1, y: 2, symbology: "39", height: 50, humanReadable: 2, rotation: 270, narrow: 3, wide: 6, content: "ABC" }),
    ).toBe('BARCODE 1,2,"39",50,2,270,3,6,"ABC"');
  });

  it("renders box, bar and reverse", () => {
    expect(emit({ kind: "box", x0: 1, y0: 2, x1: 3, y1: 4, thickness: 5 })).toBe("BOX 1,2,3,4,5");
    expect(emit({ kind: "bar", x: 1, y: 2, width: 3, height: 4 })).toBe("BAR 1,2,3,4");
    expect(emit({ kind: "reverse", x: 1, y: 2, width: 3, height: 4 })).toBe("REVERSE 1,2,3,4");
  });

  it("renders bitmap with width in BYTES and height in DOTS, payload raw after the comma", () => {
    // The classic TSPL BITMAP trap: the two size arguments use different
    // units. No rasterization path ships today (all nine primitives are
    // native), but the command stays in the union for future logo work.
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x0d]);
    const bytes = render({
      spec: { widthMm: 100, heightMm: 150, gapMm: 3, gapOffsetMm: 0, dpi: DPI_203 },
      commands: [{ kind: "bitmap", x: 8, y: 9, widthBytes: 3, heightDots: 2, mode: 1, data }],
    });
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("BITMAP 8,9,3,2,1,\u00de\u00ad\u00be\u00ef\u0000\r");
  });

  it("rejects a bitmap whose data length contradicts its declared geometry", () => {
    expect(() =>
      render({
        spec: { widthMm: 100, heightMm: 150, gapMm: 3, gapOffsetMm: 0, dpi: DPI_203 },
        commands: [{ kind: "bitmap", x: 0, y: 0, widthBytes: 4, heightDots: 4, mode: 0, data: new Uint8Array(5) }],
      }),
    ).toThrow(/does not match .*4.*4.*16/);
  });
});

describe("render — validation", () => {
  const spec: LabelSpec = { widthMm: 100, heightMm: 150, gapMm: 3, gapOffsetMm: 0, dpi: DPI_203 };
  const withCommand = (cmd: TsplCommand): LabelDocument => ({ spec, commands: [cmd] });
  const text = (over: Partial<Extract<TsplCommand, { kind: "text" }>> = {}): TsplCommand => ({
    kind: "text", x: 0, y: 0, font: "3", rotation: 0, xScale: 1, yScale: 1, content: "a", ...over,
  });

  it("rejects non-integer coordinates — mm rounding must happen in the caller", () => {
    // Coordinates are dots, matching TSPL natively. Accepting millimetres
    // at the public surface would round at mm granularity and lose ~8
    // dots of placement precision, visible at this label size.
    expect(() => render(withCommand(text({ x: 12.5 })))).toThrow(TsplRenderError);
    expect(() => render(withCommand(text({ y: 0.1 })))).toThrow(/integer \(dots\)/);
  });

  it("rejects out-of-range density and speed against the PPD's exposed ranges", () => {
    expect(() => render({ spec: { ...spec, density: 16 }, commands: [] })).toThrow(/\[0, 15\]/);
    expect(() => render({ spec: { ...spec, density: -1 }, commands: [] })).toThrow(/\[0, 15\]/);
    expect(() => render({ spec: { ...spec, speed: 0 }, commands: [] })).toThrow(/\[1, 8\]/);
    expect(() => render({ spec: { ...spec, speed: 9 }, commands: [] })).toThrow(/\[1, 8\]/);
  });

  it("rejects a non-positive label size and a negative gap", () => {
    expect(() => render({ spec: { ...spec, widthMm: 0 }, commands: [] })).toThrow(/must be positive/);
    expect(() => render({ spec: { ...spec, heightMm: -1 }, commands: [] })).toThrow(/must be positive/);
    expect(() => render({ spec: { ...spec, gapMm: -1 }, commands: [] })).toThrow(/gapMm must be >= 0/);
  });

  it("rejects out-of-range text scale and qr cell size", () => {
    expect(() => render(withCommand(text({ xScale: 0 })))).toThrow(/\[1, 10\]/);
    expect(() => render(withCommand(text({ yScale: 11 })))).toThrow(/\[1, 10\]/);
    expect(() =>
      render(withCommand({ kind: "qrcode", x: 0, y: 0, ecc: "H", cell: 11, mode: "A", rotation: 0, content: "x" })),
    ).toThrow(/\[1, 10\]/);
  });

  it("rejects empty barcode and qrcode payloads", () => {
    expect(() =>
      render(withCommand({ kind: "qrcode", x: 0, y: 0, ecc: "H", cell: 6, mode: "A", rotation: 0, content: "" })),
    ).toThrow(/must not be empty/);
    expect(() =>
      render(withCommand({ kind: "barcode", x: 0, y: 0, symbology: "128", height: 10, humanReadable: 0, rotation: 0, narrow: 2, wide: 2, content: "" })),
    ).toThrow(/must not be empty/);
  });

  it("rejects invalid geometry on box, bar, reverse and barcode", () => {
    expect(() => render(withCommand({ kind: "box", x0: 0.5, y0: 0, x1: 1, y1: 1, thickness: 1 }))).toThrow(/box.x0/);
    expect(() => render(withCommand({ kind: "box", x0: 0, y0: 0.5, x1: 1, y1: 1, thickness: 1 }))).toThrow(/box.y0/);
    expect(() => render(withCommand({ kind: "box", x0: 0, y0: 0, x1: 1.5, y1: 1, thickness: 1 }))).toThrow(/box.x1/);
    expect(() => render(withCommand({ kind: "box", x0: 0, y0: 0, x1: 1, y1: 1.5, thickness: 1 }))).toThrow(/box.y1/);
    expect(() => render(withCommand({ kind: "box", x0: 0, y0: 0, x1: 1, y1: 1, thickness: 0 }))).toThrow(/box.thickness/);
    expect(() => render(withCommand({ kind: "bar", x: 0.5, y: 0, width: 1, height: 1 }))).toThrow(/bar.x/);
    expect(() => render(withCommand({ kind: "bar", x: 0, y: 0.5, width: 1, height: 1 }))).toThrow(/bar.y/);
    expect(() => render(withCommand({ kind: "bar", x: 0, y: 0, width: 0, height: 1 }))).toThrow(/bar.width/);
    expect(() => render(withCommand({ kind: "bar", x: 0, y: 0, width: 1, height: 0 }))).toThrow(/bar.height/);
    expect(() => render(withCommand({ kind: "reverse", x: 0.5, y: 0, width: 1, height: 1 }))).toThrow(/reverse.x/);
    expect(() => render(withCommand({ kind: "reverse", x: 0, y: 0.5, width: 1, height: 1 }))).toThrow(/reverse.y/);
    expect(() => render(withCommand({ kind: "reverse", x: 0, y: 0, width: 0, height: 1 }))).toThrow(/reverse.width/);
    expect(() => render(withCommand({ kind: "reverse", x: 0, y: 0, width: 1, height: 0 }))).toThrow(/reverse.height/);
    const bc = { kind: "barcode", x: 0, y: 0, symbology: "128", height: 10, humanReadable: 0, rotation: 0, narrow: 2, wide: 2, content: "A" } as const;
    expect(() => render(withCommand({ ...bc, x: 0.5 }))).toThrow(/barcode.x/);
    expect(() => render(withCommand({ ...bc, y: 0.5 }))).toThrow(/barcode.y/);
    expect(() => render(withCommand({ ...bc, height: 0 }))).toThrow(/barcode.height/);
    expect(() => render(withCommand({ ...bc, narrow: 0 }))).toThrow(/barcode.narrow/);
    expect(() => render(withCommand({ ...bc, wide: 256 }))).toThrow(/barcode.wide/);
    expect(() => render(withCommand({ kind: "qrcode", x: 0.5, y: 0, ecc: "H", cell: 6, mode: "A", rotation: 0, content: "x" }))).toThrow(/qrcode.x/);
    expect(() => render(withCommand({ kind: "qrcode", x: 0, y: 0.5, ecc: "H", cell: 6, mode: "A", rotation: 0, content: "x" }))).toThrow(/qrcode.y/);
    const bm = { kind: "bitmap", x: 0, y: 0, widthBytes: 1, heightDots: 1, mode: 0, data: new Uint8Array(1) } as const;
    expect(() => render(withCommand({ ...bm, x: 0.5 }))).toThrow(/bitmap.x/);
    expect(() => render(withCommand({ ...bm, y: 0.5 }))).toThrow(/bitmap.y/);
    expect(() => render(withCommand({ ...bm, widthBytes: 0, data: new Uint8Array(0) }))).toThrow(/bitmap.widthBytes/);
    expect(() => render(withCommand({ ...bm, heightDots: 0, data: new Uint8Array(0) }))).toThrow(/bitmap.heightDots/);
  });

  it("rejects invalid reference coordinates, sets and copies", () => {
    expect(() => render({ spec: { ...spec, reference: { x: 0.5, y: 0 } }, commands: [] })).toThrow(/reference.x/);
    expect(() => render({ spec: { ...spec, reference: { x: 0, y: 0.5 } }, commands: [] })).toThrow(/reference.y/);
    expect(() => render({ spec, commands: [], sets: 0 })).toThrow(/doc.sets/);
    expect(() => render({ spec, commands: [], copies: 0 })).toThrow(/doc.copies/);
  });
});

describe("mmToDots / dotsToMm", () => {
  it("converts the canonical 4×6 label at 203 dpi", () => {
    expect(mmToDots(100)).toBe(799);
    expect(mmToDots(150)).toBe(1199);
    // 4 in = 812 dots, 6 in = 1218 dots — the true 4×6 sheet, slightly
    // larger than the 100×150mm the fixtures declare.
    expect(mmToDots(4 * 25.4)).toBe(812);
    expect(mmToDots(6 * 25.4)).toBe(1218);
  });

  it("rounds symmetrically about zero so negative offsets mirror positives", () => {
    expect(mmToDots(0)).toBe(0);
    expect(mmToDots(1)).toBe(8); // 7.992 → 8
    expect(mmToDots(-1)).toBe(-8);
    expect(mmToDots(-100)).toBe(-799);
    // The exact .5 case is where Math.round's round-half-up breaks the
    // mirror: round(0.5) is 1 but round(-0.5) is -0. Construct it at
    // dpi = 25.4 so the conversion is exactly 0.5 — deriving a .5 from
    // 203 dpi lands on 0.49999999999999994 and tests nothing.
    expect(mmToDots(0.5, 25.4)).toBe(1);
    expect(mmToDots(-0.5, 25.4)).toBe(-1);
    // The property itself, swept: |f(-x)| === |f(x)| for every input.
    for (const mm of [0, 0.03, 0.5, 1, 7.5, 12.7, 100, 150.25]) {
      expect(mmToDots(-mm)).toBe(-mmToDots(mm));
    }
  });

  it("accepts a non-default dpi", () => {
    expect(mmToDots(25.4, 300)).toBe(300);
  });

  it("round-trips through dotsToMm within rounding tolerance", () => {
    for (const mm of [0, 1, 12.7, 100, 150]) {
      expect(Math.abs(dotsToMm(mmToDots(mm)) - mm)).toBeLessThan(0.07);
    }
    expect(dotsToMm(812)).toBeCloseTo(101.6, 1);
  });

  it("rejects non-finite input and non-positive dpi", () => {
    expect(() => mmToDots(NaN)).toThrow(/must be finite/);
    expect(() => mmToDots(Infinity)).toThrow(/must be finite/);
    expect(() => mmToDots(1, 0)).toThrow(/positive finite/);
    expect(() => mmToDots(1, NaN)).toThrow(/positive finite/);
    expect(() => dotsToMm(NaN)).toThrow(/must be finite/);
    expect(() => dotsToMm(1, -1)).toThrow(/positive finite/);
  });
});

describe("toAscii — the encoding decision the fixtures cannot cover", () => {
  it("transliterates the units this app actually produces", () => {
    // °C and mm³/s are everywhere in filament data and neither is ASCII.
    // cp437 has ° but NO ³ at all; latin1 has both at different bytes.
    // Rather than bet on the firmware's active codepage, fold to ASCII.
    expect(toAscii("240°C")).toBe("240degC");
    expect(toAscii("12 mm³/s")).toBe("12 mm3/s");
    expect(toAscii("area² ±0.02 3×4 6÷2")).toBe("area2 +/-0.02 3x4 6/2");
    expect(toAscii("µm")).toBe("um");
  });

  it("strips diacritics via NFD decomposition", () => {
    expect(toAscii("Grün")).toBe("Grun");
    expect(toAscii("café crème")).toBe("cafe creme");
    expect(toAscii("Ångström")).toBe("Angstrom");
    expect(toAscii("naïve")).toBe("naive");
  });

  it("handles the letters that have no decomposition", () => {
    expect(toAscii("Straße")).toBe("Strasse");
    expect(toAscii("Ø ø")).toBe("O o");
    expect(toAscii("Đ đ")).toBe("D d");
  });

  it("normalises typographic characters that arrive by copy-paste", () => {
    expect(toAscii("\u201cquoted\u201d")).toBe('"quoted"');
    expect(toAscii("it\u2019s")).toBe("it's");
    expect(toAscii("a\u2013b\u2014c")).toBe("a-b-c");
    expect(toAscii("wait\u2026")).toBe("wait...");
    expect(toAscii("1\u202f234")).toBe("1 234");
  });

  it("maps currency symbols used by the price fields", () => {
    expect(toAscii("€10 £5 ¥900")).toBe("EUR10 GBP5 JPY900");
  });

  it("collapses anything else to a visible placeholder rather than dropping it", () => {
    // Silent loss would make a mis-encoded label subtly wrong; a "?" makes
    // it obvious on inspection.
    expect(toAscii("日本語")).toBe("???");
    expect(toAscii("a\u0000b")).toBe("a?b");
    expect(toAscii("")).toBe("");
  });

  it("leaves plain ASCII untouched", () => {
    const ascii = "PLA 0.4 Brass HF / BOX-07 #12 (50%)";
    expect(toAscii(ascii)).toBe(ascii);
  });
});

describe("sanitizeTsplLiteral — defensive quoting", () => {
  it("substitutes rather than escapes double quotes, since the escape convention is unverified", () => {
    expect(sanitizeTsplLiteral('PLA "Galaxy" Black')).toBe("PLA 'Galaxy' Black");
  });

  it("replaces backslashes", () => {
    expect(sanitizeTsplLiteral("C:\\labels\\box")).toBe("C:/labels/box");
  });

  it("strips CR and LF so a free-text note cannot inject a command", () => {
    // The genuinely dangerous case: dry-box notes are user-entered free
    // text, and a raw newline would terminate the TEXT command mid-literal
    // and hand whatever followed to the parser as a new command.
    expect(sanitizeTsplLiteral("line1\r\nPRINT 99,99")).toBe("line1 PRINT 99,99");
    expect(sanitizeTsplLiteral("a\nb\rc")).toBe("a b c");
  });

  it("composes with the ASCII fold", () => {
    expect(sanitizeTsplLiteral('Grün "240°C"')).toBe("Grun '240degC'");
  });

  it("keeps an injected newline out of the rendered byte stream", () => {
    const bytes = render({
      spec: { widthMm: 100, heightMm: 150, gapMm: 3, gapOffsetMm: 0, dpi: DPI_203 },
      commands: [{ kind: "text", x: 0, y: 0, font: "3", rotation: 0, xScale: 1, yScale: 1, content: "a\r\nPRINT 9,9" }],
    });
    const text = new TextDecoder().decode(bytes);
    // Exactly four CRLF pairs: SIZE, GAP, CLS, TEXT, PRINT = 5 lines.
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(5);
    expect(text).toContain('"a PRINT 9,9"');
  });
});

describe("assertCrlfFramed", () => {
  it("accepts a properly framed job", () => {
    expect(() => assertCrlfFramed(new Uint8Array([0x41, 0x0d, 0x0a]))).not.toThrow();
  });

  it("rejects an empty job", () => {
    expect(() => assertCrlfFramed(new Uint8Array([]))).toThrow(/empty/);
    expect(() => assertCrlfFramed(new Uint8Array([0x41]))).toThrow(/empty/);
  });

  it("rejects a job not ending in CRLF", () => {
    expect(() => assertCrlfFramed(new Uint8Array([0x41, 0x42]))).toThrow(/does not end with CRLF/);
    expect(() => assertCrlfFramed(new Uint8Array([0x0d, 0x41]))).toThrow(/does not end with CRLF/);
  });

  it("rejects a bare LF anywhere, including at byte 0", () => {
    expect(() => assertCrlfFramed(new Uint8Array([0x0a, 0x0d, 0x0a]))).toThrow(/Bare LF at byte 0/);
    expect(() => assertCrlfFramed(new Uint8Array([0x41, 0x0a, 0x42, 0x0d, 0x0a]))).toThrow(/Bare LF at byte 1/);
  });
});
