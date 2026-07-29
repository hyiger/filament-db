import { describe, it, expect } from "vitest";
import {
  dryBoxLabel,
  describeItem,
  dryBoxGeometry,
  fitQr,
  fitRowText,
  fitBarcode,
  maxRowChars,
  DRY_BOX_SPEC,
  DRY_BOX_LAYOUT,
  DEFAULT_DRY_BOX_STRINGS,
  type DryBoxLabelInput,
  type DryBoxLabelItem,
} from "@/lib/dryBoxLabel";
import { render, mmToDots, sanitizeTsplLiteral, qrModuleCount, type TsplCommand } from "@/lib/tsplEncoder";

/**
 * Coverage for the dry-box label template.
 *
 * The template's job is to turn a Location plus its spools into a
 * LabelDocument matching the hardware-verified 04_drybox_label.prn geometry,
 * with the contents list reflowed to fill the sheet. These tests pin the
 * layout invariants that a printed label would otherwise expose only by
 * running off the bottom of the stock.
 */

// Local noon, not a UTC instant: isoDate reads LOCAL components so that it
// agrees with an injected locale formatter, and a UTC literal would make
// this expectation timezone-dependent.
const AS_OF = new Date(2026, 6, 28, 12, 0, 0);
const QR = "https://example.test/inventory?location=abc123";
const capacityOf = (spec = DRY_BOX_SPEC, qr = QR) => dryBoxGeometry(spec, qr).capacity;

function input(over: Partial<DryBoxLabelInput> = {}): DryBoxLabelInput {
  return {
    location: { name: "BOX-07" },
    items: [],
    qrPayload: QR,
    asOf: AS_OF,
    ...over,
  };
}

const texts = (cmds: TsplCommand[]): string[] =>
  cmds.filter((c): c is Extract<TsplCommand, { kind: "text" }> => c.kind === "text").map((c) => c.content);

describe("describeItem", () => {
  const item = (o: Partial<DryBoxLabelItem>): DryBoxLabelItem => ({ filamentName: "", ...o });

  it("prefers the spool's own label — it is what's written on the physical roll", () => {
    expect(describeItem(item({ label: "Roll 12", filamentName: "PLA", filamentVendor: "Prusa" }))).toBe("Roll 12");
  });

  it("falls back to vendor + name + type", () => {
    expect(describeItem(item({ filamentName: "Galaxy Black", filamentVendor: "Prusa", filamentType: "PLA" })))
      .toBe("Prusa Galaxy Black PLA");
  });

  it("does not repeat a vendor already leading the name", () => {
    // "Prusament PLA" must not become "Prusament Prusament PLA".
    expect(describeItem(item({ filamentName: "Prusament PLA", filamentVendor: "Prusament" }))).toBe("Prusament PLA");
  });

  it("does not repeat a type already present in vendor or name", () => {
    expect(describeItem(item({ filamentName: "PLA Galaxy", filamentVendor: "Prusa", filamentType: "PLA" })))
      .toBe("Prusa PLA Galaxy");
  });

  it("tolerates missing, null and whitespace-only fields", () => {
    expect(describeItem(item({ filamentName: "PLA" }))).toBe("PLA");
    expect(describeItem(item({ filamentName: "PLA", filamentVendor: null, filamentType: null }))).toBe("PLA");
    expect(describeItem(item({ filamentName: "  ", label: "   " }))).toBe("");
    expect(describeItem(item({ filamentName: "", filamentVendor: "Prusa" }))).toBe("Prusa");
  });
});

describe("dryBoxGeometry — capacity", () => {
  it("derives capacity from the stock height and the space the QR leaves", () => {
    const g = dryBoxGeometry(DRY_BOX_SPEC, QR);
    expect(g.capacity).toBe(Math.floor((g.footerTop - g.firstRowY) / DRY_BOX_LAYOUT.rows.pitch));
    // The whole point of reflowing is fitting well more than the three rows
    // the original fixture hardcoded.
    expect(g.capacity).toBeGreaterThan(8);
  });

  it("taller stock fits more rows; stock too short fits none rather than going negative", () => {
    expect(capacityOf({ ...DRY_BOX_SPEC, heightMm: 300 })).toBeGreaterThan(capacityOf());
    expect(() => capacityOf({ ...DRY_BOX_SPEC, heightMm: 20 })).toThrow(/too small|too short/);
  });

  it("keeps the QR inside the sheet and the header box for any payload length", () => {
    // The bug this guards: the fixture's cell 7 was fine for its 16-byte
    // payload (29 modules = 203 dots) but a real 67-byte deep link is 49
    // modules = 343 dots, which runs 104 dots past the edge of 100mm stock
    // and simply is not printed. Note a SHORT payload can yield a LARGER
    // symbol than a long one, because it saturates the max cell size — so
    // the invariant is containment, not monotonicity.
    for (const payload of [
      "x",
      "fdb://box/B1",
      QR,
      "https://filament-db.example.com/inventory?location=507f1f77bcf86cd799439011",
      "https://filament-db.example.com/inventory?location=507f1f77bcf86cd799439011&spool=507f191e810c19729de860ea",
    ]) {
      const g = dryBoxGeometry(DRY_BOX_SPEC, payload);
      expect(DRY_BOX_LAYOUT.qr.x + g.qr.sizeDots).toBeLessThanOrEqual(g.widthDots);
      expect(DRY_BOX_LAYOUT.qr.y + g.qr.sizeDots).toBeLessThanOrEqual(g.headerBottom);
      expect(g.capacity).toBeGreaterThan(0);
      expect(g.firstRowY).toBeGreaterThan(g.headerBottom);
    }
  });
});

describe("dryBoxLabel — structure", () => {
  it("renders to valid TSPL through the encoder", () => {
    const bytes = render(dryBoxLabel(input({ items: [{ filamentName: "PLA" }] })));
    const job = new TextDecoder().decode(bytes);
    expect(job).toContain("SIZE 100 mm,150 mm\r\n");
    expect(job).toContain("QRCODE");
    // Not a hardcoded x — the barcode is inset by its quiet zone.
    expect(job).toMatch(/BARCODE \d+,\d+,"128"/);
    expect(job.endsWith("PRINT 1,1\r\n")).toBe(true);
  });

  it("is deterministic — same input, byte-identical output", () => {
    const doc = () => render(dryBoxLabel(input({ items: [{ filamentName: "PLA" }] })));
    expect(doc()).toEqual(doc());
  });

  it("puts the location name in the header and the QR payload in the QR", () => {
    const doc = dryBoxLabel(input());
    expect(texts(doc.commands)).toContain("BOX-07");
    const qr = doc.commands.find((c) => c.kind === "qrcode");
    expect(qr && qr.kind === "qrcode" && qr.content).toBe(QR);
  });

  it("defaults the barcode to the location name but honours an override", () => {
    const bc = (d: ReturnType<typeof dryBoxLabel>) =>
      d.commands.find((c): c is Extract<TsplCommand, { kind: "barcode" }> => c.kind === "barcode")!.content;
    expect(bc(dryBoxLabel(input()))).toBe("BOX-07");
    expect(bc(dryBoxLabel(input({ barcodePayload: "LOC-42" })))).toBe("LOC-42");
  });

  it("appends humidity to the subtitle only when it is set", () => {
    expect(texts(dryBoxLabel(input()).commands)).toContain("FILAMENT DRY BOX");
    expect(texts(dryBoxLabel(input({ location: { name: "B", humidity: 18 } })).commands))
      .toContain("FILAMENT DRY BOX  18% RH");
    // 0% RH is a real reading, not "unset" — it must still render.
    expect(texts(dryBoxLabel(input({ location: { name: "B", humidity: 0 } })).commands))
      .toContain("FILAMENT DRY BOX  0% RH");
  });
});

describe("dryBoxLabel — contents manifest", () => {
  const many = (n: number): DryBoxLabelItem[] =>
    Array.from({ length: n }, (_, i) => ({ filamentName: `Filament ${i + 1}` }));

  it("lists each spool on its own row, bulleted", () => {
    const out = texts(dryBoxLabel(input({ items: [{ filamentName: "PLA" }, { filamentName: "PETG" }] })).commands);
    expect(out).toContain("- PLA");
    expect(out).toContain("- PETG");
  });

  it("says so when the box is empty rather than printing a bare rule", () => {
    expect(texts(dryBoxLabel(input({ items: [] })).commands)).toContain("(empty)");
  });

  it("drops items that describe to nothing", () => {
    const out = texts(dryBoxLabel(input({ items: [{ filamentName: "  " }, { filamentName: "PLA" }] })).commands);
    expect(out).toContain("- PLA");
    expect(out).not.toContain("- ");
  });

  it("reports overflow instead of silently truncating", () => {
    // A label that shows 16 of 40 spools with no indication would read as a
    // complete inventory — the failure mode this guards.
    const capacity = capacityOf();
    const out = texts(dryBoxLabel(input({ items: many(capacity + 10) })).commands);
    const shown = out.filter((s) => s.startsWith("- ")).length;
    expect(shown).toBe(capacity - 1);
    expect(out).toContain(`+${capacity + 10 - (capacity - 1)} more`);
  });

  it("fills the sheet exactly at capacity with no overflow row", () => {
    const capacity = capacityOf();
    const out = texts(dryBoxLabel(input({ items: many(capacity) })).commands);
    expect(out.filter((s) => s.startsWith("- ")).length).toBe(capacity);
    expect(out.some((s) => s.includes("more"))).toBe(false);
  });

  it("keeps every row above the footer, whatever the stock height", () => {
    // Rows are selected STRUCTURALLY (x === rows.x is unique to manifest rows;
    // every other text sits at x=40) rather than by a y-range filter. The
    // previous version filtered on `y < footerTop` and then asserted
    // `y < footerTop`, so any offending row was removed before the assertion
    // and the test could not fail for any implementation.
    for (const heightMm of [65, 70, 100, 150, 200]) {
      const spec = { ...DRY_BOX_SPEC, heightMm };
      const g = dryBoxGeometry(spec, QR);
      const doc = dryBoxLabel(input({ items: many(200), spec: { heightMm } }));
      const rows = doc.commands.filter(
        (c): c is Extract<TsplCommand, { kind: "text" }> =>
          c.kind === "text" && c.x === DRY_BOX_LAYOUT.rows.x,
      );
      expect(rows.length).toBeLessThanOrEqual(g.capacity);
      for (const r of rows) {
        expect(r.y).toBeGreaterThanOrEqual(g.firstRowY);
        expect(r.y).toBeLessThan(g.footerTop);
      }
      // And the barcode stays on the sheet.
      const bc = doc.commands.find((c): c is Extract<TsplCommand, { kind: "barcode" }> => c.kind === "barcode")!;
      expect(bc.y + bc.height).toBeLessThan(mmToDots(heightMm, spec.dpi));
    }
  });

  it("emits no manifest at all on stock too short for one row", () => {
    // 65mm leaves capacity 0. Emitting a row anyway printed it over the
    // footer rule and barcode.
    const g = dryBoxGeometry({ ...DRY_BOX_SPEC, heightMm: 65 }, QR);
    expect(g.capacity).toBe(0);
    const doc = dryBoxLabel(input({ items: many(5), spec: { heightMm: 65 } }));
    expect(doc.commands.filter((c) => c.kind === "text" && c.x === DRY_BOX_LAYOUT.rows.x)).toHaveLength(0);
  });
});

describe("dryBoxLabel — dates", () => {
  it("formats the desiccant date, and says so when it was never recorded", () => {
    expect(texts(dryBoxLabel(input({ location: { name: "B", desiccantChangedAt: "2026-07-12T00:00:00.000Z" } })).commands))
      .toContain("DESICCANT CHANGED  2026-07-12");
    expect(texts(dryBoxLabel(input({ location: { name: "B", desiccantChangedAt: new Date("2026-01-02T00:00:00Z") } })).commands))
      .toContain("DESICCANT CHANGED  2026-01-02");
    expect(texts(dryBoxLabel(input()).commands)).toContain("DESICCANT CHANGED  not recorded");
    expect(texts(dryBoxLabel(input({ location: { name: "B", desiccantChangedAt: null } })).commands))
      .toContain("DESICCANT CHANGED  not recorded");
  });

  it("stamps the manifest with the as-of date so a stale label is obvious", () => {
    expect(texts(dryBoxLabel(input()).commands)).toContain("CONTENTS  (as of 2026-07-28)");
  });

  it("uses an injected formatter so preview and print agree across locales", () => {
    // Reading the host locale inside the template would make the same
    // document render differently on the preview canvas and the print head.
    const out = texts(
      dryBoxLabel(
        input({
          location: { name: "B", desiccantChangedAt: "2026-07-12T00:00:00.000Z" },
          formatDate: (d) => `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`,
        }),
      ).commands,
    );
    expect(out).toContain("DESICCANT CHANGED  12.7.2026");
    expect(out).toContain("CONTENTS  (as of 28.7.2026)");
  });
});

describe("dryBoxLabel — localization", () => {
  it("carries no English of its own when strings are supplied", () => {
    const de = {
      ...DEFAULT_DRY_BOX_STRINGS,
      subtitle: "FILAMENT-TROCKENBOX",
      contents: "INHALT",
      desiccantChanged: "TROCKENMITTEL GEWECHSELT",
      desiccantNever: "nicht erfasst",
      empty: "(leer)",
      asOf: "Stand",
      more: "+{count} weitere",
    };
    const out = texts(dryBoxLabel(input({ items: [] }), de).commands);
    expect(out).toContain("FILAMENT-TROCKENBOX");
    expect(out).toContain("INHALT  (Stand 2026-07-28)");
    expect(out).toContain("TROCKENMITTEL GEWECHSELT  nicht erfasst");
    expect(out).toContain("(leer)");
    expect(out.join("|")).not.toMatch(/DRY BOX|CONTENTS|DESICCANT/);
  });

  it("substitutes the overflow count into the supplied template", () => {
    const capacity = capacityOf();
    const out = texts(
      dryBoxLabel(
        input({ items: Array.from({ length: capacity + 5 }, (_, i) => ({ filamentName: `F${i}` })) }),
        { ...DEFAULT_DRY_BOX_STRINGS, more: "und {count} weitere" },
      ).commands,
    );
    expect(out).toContain(`und ${capacity + 5 - (capacity - 1)} weitere`);
  });
});

describe("fitQr — payload-aware sizing", () => {
  it("prefers the strongest ECC that still prints at a scannable module size", () => {
    // A short payload leaves room for full error correction.
    expect(fitQr("fdb://box/B1", 231).ecc).toBe("H");
  });

  it("steps ECC down rather than shrinking modules below readability", () => {
    // Squeezed into a small region, a long payload at H would need 2-dot
    // modules; dropping ECC keeps the symbol scannable instead. This is the
    // trade-off the handoff spec calls for past ~60 characters.
    const long = "https://filament-db.example.com/inventory?location=507f1f77bcf86cd799439011&spool=507f191e810c19729de860ea";
    // 200 dots: H needs a 260-dot footprint at the 4-dot floor, so it steps
    // down to M, which fits in 196. (The numbers moved when the quiet zone
    // became part of the footprint — the behaviour did not.)
    const fitted = fitQr(long, 200);
    expect(fitted.cell).toBeGreaterThanOrEqual(4);
    expect(fitted.ecc).toBe("M");
    // Given more room it keeps the stronger correction.
    expect(fitQr(long, 260).ecc).toBe("H");
  });

  it("never returns a symbol larger than the region it was given", () => {
    // Not every payload fits every region — a 46-char link needs 41 modules
    // at H, so 164 dots minimum. The invariant is conditional: WHEN fitQr
    // returns, the symbol fits; otherwise it throws rather than overflow.
    for (const dots of [84, 100, 160, 231, 300]) {
      for (const payload of ["x", QR, "y".repeat(120)]) {
        let fitted: ReturnType<typeof fitQr> | null = null;
        try {
          fitted = fitQr(payload, dots);
        } catch {
          fitted = null; // too long for this region — the documented outcome
        }
        if (fitted) expect(fitted.sizeDots).toBeLessThanOrEqual(dots);
      }
    }
  });

  it("throws rather than emit an unprintable symbol", () => {
    // Better a caught error in the dialog than a label with a QR clipped at
    // the sheet edge that scans as nothing.
    expect(() => fitQr("z".repeat(400), 40)).toThrow(/too long to print/);
  });
});

describe("fitRowText / maxRowChars", () => {
  it("computes how many font-3 characters fit the stock", () => {
    // 799 printable dots - 56 (row x) - 8 (edge margin) = 735; / 16 = 45.
    expect(maxRowChars(DRY_BOX_SPEC)).toBe(45);
    expect(maxRowChars({ ...DRY_BOX_SPEC, widthMm: 200 })).toBeGreaterThan(maxRowChars(DRY_BOX_SPEC));
  });

  it("truncates with an ellipsis rather than running off the edge", () => {
    // TSPL TEXT neither wraps nor clips — an over-long label silently loses
    // its tail with no indication that anything was cut.
    expect(fitRowText("short", 46)).toBe("short");
    expect(fitRowText("x".repeat(60), 10)).toBe("xxxxxxx...");
    expect(fitRowText("x".repeat(60), 10)).toHaveLength(10);
  });

  it("degrades sanely at tiny widths", () => {
    expect(fitRowText("abcdef", 3)).toBe("abc");
    expect(fitRowText("abcdef", 0)).toBe("");
    expect(fitRowText("abcdef", -1)).toBe("");
  });

  it("truncates over-long manifest rows in a real label", () => {
    const doc = dryBoxLabel(input({ items: [{ filamentName: "Q".repeat(200) }] }));
    const row = texts(doc.commands).find((s) => s.startsWith("- Q"))!;
    expect(row.length).toBeLessThanOrEqual(maxRowChars(DRY_BOX_SPEC));
    expect(row.endsWith("...")).toBe(true);
  });
});

describe("describeItem — whole-token type dedup", () => {
  it("keeps the material when its code merely occurs inside another word", () => {
    // A bare substring test swallowed short material codes hiding in colour
    // and vendor words. On a dry-box manifest the material is the one thing a
    // glance needs, so dropping it is the worst available failure.
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "Space Gray", filamentType: "PA" }))
      .toBe("Prusa Space Gray PA");
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "Papaya", filamentType: "PA" }))
      .toBe("Prusa Papaya PA");
    expect(describeItem({ filamentVendor: "Elegoo", filamentName: "Sapphire Blue", filamentType: "PP" }))
      .toBe("Elegoo Sapphire Blue PP");
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "Petrol Blue", filamentType: "PET" }))
      .toBe("Prusa Petrol Blue PET");
  });

  it("still drops a genuinely duplicated material token", () => {
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "PLA Galaxy", filamentType: "PLA" }))
      .toBe("Prusa PLA Galaxy");
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "Galaxy PLA", filamentType: "pla" }))
      .toBe("Prusa Galaxy PLA");
  });

  it("normalises separators so a hyphenated type matches a spaced name", () => {
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "PC ABS Blend", filamentType: "PC-ABS" }))
      .toBe("Prusa PC ABS Blend");
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "Tough Blend", filamentType: "PC-ABS" }))
      .toBe("Prusa Tough Blend PC-ABS");
  });
});

describe("header fields share their row with the QR", () => {
  it("truncates a long location name rather than overprinting the QR", () => {
    // The name is font 5 (32 dots wide) at x=40 and the QR column starts at
    // x=560, so only 16 characters fit — well inside normal naming.
    const g = dryBoxGeometry(DRY_BOX_SPEC, QR);
    const doc = dryBoxLabel(input({ location: { name: "Garage Cabinet Drybox #2" } }));
    const name = texts(doc.commands)[0];
    expect(name.length).toBeLessThanOrEqual(g.nameChars);
    expect(name.endsWith("...")).toBe(true);
    expect(DRY_BOX_LAYOUT.name.x + name.length * 32).toBeLessThanOrEqual(DRY_BOX_LAYOUT.qr.x);
  });

  it("truncates the subtitle too", () => {
    const g = dryBoxGeometry(DRY_BOX_SPEC, QR);
    const doc = dryBoxLabel(input({ location: { name: "B", humidity: 18 } }), {
      ...DEFAULT_DRY_BOX_STRINGS,
      subtitle: "A VERY LONG LOCALIZED SUBTITLE THAT WOULD RUN INTO THE QR",
    });
    const subtitle = texts(doc.commands)[1];
    expect(subtitle.length).toBeLessThanOrEqual(g.subtitleChars);
  });

  it("leaves a short name untouched", () => {
    expect(texts(dryBoxLabel(input()).commands)[0]).toBe("BOX-07");
  });
});

describe("PR #1042 review round 2", () => {
  it("suppresses the whole contents block — heading and rule too — when nothing fits", () => {
    // Suppressing only the rows still printed a "CONTENTS" heading and its
    // rule on top of the footer: at 65mm the heading lands at y=303 against a
    // footer starting at 279.
    const g = dryBoxGeometry({ ...DRY_BOX_SPEC, heightMm: 65 }, QR);
    expect(g.capacity).toBe(0);
    const doc = dryBoxLabel(input({ items: [{ filamentName: "PLA" }], spec: { heightMm: 65 } }));
    expect(texts(doc.commands).some((s) => s.includes("CONTENTS"))).toBe(false);
    // No command anywhere may land in the footer band except the footer's own.
    const strays = doc.commands.filter(
      (c) => (c.kind === "text" || c.kind === "bar") && c.y >= g.headingY && c.y < g.footerTop,
    );
    expect(strays).toEqual([]);
  });

  it("still emits the contents block on normal stock", () => {
    expect(texts(dryBoxLabel(input()).commands).some((s) => s.includes("CONTENTS"))).toBe(true);
  });

  it("budgets width AFTER ASCII expansion, not before", () => {
    // The encoder folds to 7-bit ASCII on the way out and several of those
    // substitutions GROW the string, so measuring the raw input under-counts
    // the printed width. Sixteen "ß" print as thirty-two "s".
    for (const raw of ["ß".repeat(16), "240°C ".repeat(6), "€".repeat(20), "±3 mm³/s"]) {
      const fitted = fitRowText(raw, 16);
      expect(fitted.length).toBeLessThanOrEqual(16);
      // Already sanitized, so the encoder's own fold cannot grow it further.
      expect(sanitizeTsplLiteral(fitted).length).toBeLessThanOrEqual(16);
    }
  });

  it("keeps a manifest row within budget even when its text expands", () => {
    const doc = dryBoxLabel(input({ items: [{ filamentName: "ß".repeat(60) }] }));
    const row = texts(doc.commands).find((s) => s.startsWith("- s"))!;
    expect(row.length).toBeLessThanOrEqual(maxRowChars(DRY_BOX_SPEC));
  });

  it("treats PLA+ as a distinct material from PLA", () => {
    // Collapsing "+" made tokenized("PLA+") equal tokenized("PLA"), so a PLA+
    // spool whose name mentions PLA printed as plain PLA — the label
    // understating the material.
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "PLA Galaxy", filamentType: "PLA+" }))
      .toBe("Prusa PLA Galaxy PLA+");
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "PLA+ Galaxy", filamentType: "PLA+" }))
      .toBe("Prusa PLA+ Galaxy");
    // Hyphen collapsing still works — that is what matches PC-ABS to PC ABS.
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "PC ABS Blend", filamentType: "PC-ABS" }))
      .toBe("Prusa PC ABS Blend");
  });
});

describe("PR #1042 review round 3", () => {
  it("sizes the QR from the SANITIZED payload the printer receives", () => {
    // renderCommand sanitizes on the way out and some substitutions GROW the
    // string ("GBP" for "£"), so sizing against the raw input under-counts.
    // Twelve "£" sized a 203-dot symbol and printed a 259-dot one. This bit
    // the manifest rows first, then the QR — hence a structural fix.
    const payload = "£".repeat(12);
    const g = dryBoxGeometry(DRY_BOX_SPEC, sanitizeTsplLiteral(payload));
    const doc = dryBoxLabel(input({ qrPayload: payload }));
    const qr = doc.commands.find((c): c is Extract<TsplCommand, { kind: "qrcode" }> => c.kind === "qrcode")!;
    // The emitted payload is the sanitized one...
    expect(qr.content).toBe("GBP".repeat(12));
    // ...and the symbol it produces genuinely fits.
    const actual = qrModuleCount(qr.content, qr.ecc)! * qr.cell;
    expect(DRY_BOX_LAYOUT.qr.x + actual).toBeLessThanOrEqual(g.widthDots);
    expect(actual).toBeLessThanOrEqual(g.qr.sizeDots);
  });

  it("emits the sanitized barcode payload too", () => {
    const doc = dryBoxLabel(input({ barcodePayload: "BOX £7" }));
    const bc = doc.commands.find((c): c is Extract<TsplCommand, { kind: "barcode" }> => c.kind === "barcode")!;
    expect(bc.content).toBe("BOX GBP7");
  });
});

describe("fitBarcode", () => {
  it("uses 2-dot bars when they fit and falls back to 1", () => {
    expect(fitBarcode("BOX-07", 751)).toEqual({ narrow: 2 });
    // 40 chars at 2 dots is 950 dots; at 1 dot it is 475 and fits.
    expect(fitBarcode("X".repeat(40), 751)).toEqual({ narrow: 1 });
  });

  it("returns null rather than a clipped barcode", () => {
    // A Code 128 without its stop pattern scans as nothing while still
    // LOOKING like a barcode — worse than no barcode at all.
    expect(fitBarcode("X".repeat(200), 751)).toBeNull();
  });

  it("omits the barcode from the label when it cannot fit", () => {
    const long = dryBoxLabel(input({ location: { name: "X".repeat(200) } }));
    expect(long.commands.some((c) => c.kind === "barcode")).toBe(false);
    // The QR still carries the identity.
    expect(long.commands.some((c) => c.kind === "qrcode")).toBe(true);
  });

  it("keeps the barcode within the printable width for every name length", () => {
    for (const n of [1, 6, 24, 30, 40, 60]) {
      const doc = dryBoxLabel(input({ location: { name: "X".repeat(n) } }));
      const bc = doc.commands.find((c): c is Extract<TsplCommand, { kind: "barcode" }> => c.kind === "barcode");
      if (!bc) continue;
      const modules = 11 * bc.content.length + 35;
      expect(DRY_BOX_LAYOUT.footer.x + modules * bc.narrow).toBeLessThanOrEqual(
        mmToDots(DRY_BOX_SPEC.widthMm, DRY_BOX_SPEC.dpi),
      );
    }
  });
});

describe("PR #1042 review round 4", () => {
  it("refuses a QR that cannot reach the readable module floor", () => {
    // QR_MIN_CELL is a floor, not a preference. A 2- or 3-dot symbol at
    // 203 dpi does not scan, and a label carrying one is indistinguishable
    // from a working label until the user tries it.
    expect(() => fitQr("x".repeat(400), 231)).toThrow(/too long to print legibly/);
    // Still fits comfortably at realistic deep-link lengths.
    expect(fitQr(QR, 231).cell).toBeGreaterThanOrEqual(4);
  });

  it("renders the desiccant calendar date without a timezone shift", () => {
    // Stored as midnight UTC by the date input; handing that instant to a
    // local-time formatter renders the PREVIOUS day west of UTC. This repo
    // hit exactly that in v1.60.1's analytics day labels.
    const out = texts(
      dryBoxLabel(input({
        location: { name: "B", desiccantChangedAt: "2026-07-12T00:00:00.000Z" },
        formatDate: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      })).commands,
    );
    expect(out).toContain("DESICCANT CHANGED  2026-07-12");
  });

  it("rejects stock with no room between header and footer", () => {
    // 20mm gives footerTop = 160 - 240 = -80; the label was previously
    // emitted with off-sheet negative coordinates. Now that the QR is bounded
    // on both axes this trips the size check first — either message is a
    // diagnosable refusal, which is the point.
    expect(() => dryBoxLabel(input({ spec: { heightMm: 20 } }))).toThrow(/too small|too short/);
    expect(() => dryBoxLabel(input({ spec: { widthMm: 60 } }))).toThrow(/too small|too short/);
    // The footer guard has its own narrow window: a SHORT payload shrinks the
    // QR fine, but the 180-dot MINIMUM header still overruns the footer.
    // Reserving the quiet zone narrowed it to roughly 52-53mm — below that
    // the QR itself can no longer fit, above it the header clears.
    expect(() => dryBoxLabel(input({ qrPayload: "x", spec: { heightMm: 52 } })))
      .toThrow(/too short/);
    expect(() => dryBoxLabel(input({ qrPayload: "x", spec: { heightMm: 53 } }))).not.toThrow();
  });

  it("derives header box and rules from the stock width", () => {
    // The fixture's fixed x1=796 header box and 740-dot rules overflow 90mm
    // stock, which is only 719 dots wide.
    for (const widthMm of [90, 100, 120]) {
      const doc = dryBoxLabel(input({ spec: { widthMm } }));
      const dots = mmToDots(widthMm, DRY_BOX_SPEC.dpi);
      const box = doc.commands.find((c): c is Extract<TsplCommand, { kind: "box" }> => c.kind === "box")!;
      expect(box.x1).toBeLessThanOrEqual(dots);
      for (const bar of doc.commands.filter((c): c is Extract<TsplCommand, { kind: "bar" }> => c.kind === "bar")) {
        expect(bar.x + bar.width).toBeLessThanOrEqual(dots);
      }
    }
  });

  it("emits no negative coordinates on any supported stock", () => {
    for (const widthMm of [90, 100, 120]) {
      for (const heightMm of [70, 100, 150, 200]) {
        const doc = dryBoxLabel(input({ items: [{ filamentName: "PLA" }], spec: { widthMm, heightMm } }));
        for (const c of doc.commands) {
          for (const v of [
            (c as { x?: number }).x,
            (c as { y?: number }).y,
            (c as { x0?: number }).x0,
            (c as { y0?: number }).y0,
          ]) {
            if (v !== undefined) expect(v).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });
});

describe("PR #1042 review round 5 — QR quiet zone", () => {
  const symbolBox = (spec = DRY_BOX_SPEC, qr = QR) => {
    const g = dryBoxGeometry(spec, qr);
    const x = DRY_BOX_LAYOUT.qr.x + g.qr.quietDots;
    const y = DRY_BOX_LAYOUT.qr.y + g.qr.quietDots;
    return { g, x, y, right: x + g.qr.sizeDots, bottom: y + g.qr.sizeDots };
  };

  it("reserves four clear modules on every side of the symbol", () => {
    // A QR with an intruded quiet zone is the same failure class as one
    // clipped at the edge: it prints, it looks correct, and it never scans.
    // src/lib/labelBitmap.ts already reserves this via `margin: 4`.
    for (const widthMm of [100, 120]) {
      for (const heightMm of [100, 150, 200]) {
        const spec = { ...DRY_BOX_SPEC, widthMm, heightMm };
        const { g, x, y, right, bottom } = symbolBox(spec);
        const q = g.qr.quietDots;
        expect(q).toBe(4 * g.qr.cell);
        expect(g.headerBottom - bottom).toBeGreaterThanOrEqual(q);
        expect(g.headerRight - right).toBeGreaterThanOrEqual(q);
        expect(y - DRY_BOX_LAYOUT.headerBox.y0).toBeGreaterThanOrEqual(q);
        expect(x - DRY_BOX_LAYOUT.headerBox.x0).toBeGreaterThanOrEqual(q);
      }
    }
  });

  it("emits the symbol inset by its quiet zone, not at the footprint origin", () => {
    const { g } = symbolBox();
    const qr = dryBoxLabel(input()).commands.find(
      (c): c is Extract<TsplCommand, { kind: "qrcode" }> => c.kind === "qrcode",
    )!;
    expect(qr.x).toBe(DRY_BOX_LAYOUT.qr.x + g.qr.quietDots);
    expect(qr.y).toBe(DRY_BOX_LAYOUT.qr.y + g.qr.quietDots);
  });

  it("counts the quiet zone as part of what must fit", () => {
    // Sizing the data area alone let a symbol claim to fit while its clear
    // space overflowed the region.
    for (const dots of [200, 231, 300]) {
      const f = fitQr(QR, dots);
      expect(f.footprintDots).toBe(f.sizeDots + 2 * f.quietDots);
      expect(f.footprintDots).toBeLessThanOrEqual(dots);
    }
  });

  it("still keeps the whole footprint on the sheet", () => {
    const { g, right } = symbolBox();
    expect(right + g.qr.quietDots).toBeLessThanOrEqual(g.widthDots);
  });
});

describe("PR #1042 review round 6 — Code 128 quiet zone", () => {
  const CODE128_QUIET_MODULES = 10;
  const modulesFor = (payload: string) => 11 * payload.length + 35;

  it("reserves 10 clear modules on each side when fitting", () => {
    // The QR fix one commit earlier reserved the 2D quiet zone and left this
    // one unreserved — same defect, sibling symbology. A 27-character payload
    // on 90mm stock fits on bars alone (664 of 671 dots) but needs 704 with
    // its quiet zones, so 2-dot bars must be refused in favour of 1.
    const avail = mmToDots(90, DRY_BOX_SPEC.dpi) - DRY_BOX_LAYOUT.footer.x - 8;
    const payload = "X".repeat(27);
    expect(modulesFor(payload) * 2).toBeLessThanOrEqual(avail); // bars alone fit
    expect(fitBarcode(payload, avail)).toEqual({ narrow: 1 }); // footprint does not
  });

  it("keeps both quiet zones on the sheet for every stock width", () => {
    for (const widthMm of [90, 100, 120]) {
      for (const nameLen of [1, 6, 20, 27, 40]) {
        const doc = dryBoxLabel(input({ location: { name: "X".repeat(nameLen) }, spec: { widthMm } }));
        const bc = doc.commands.find((c): c is Extract<TsplCommand, { kind: "barcode" }> => c.kind === "barcode");
        if (!bc) continue; // omitted rather than clipped — also valid
        const quiet = CODE128_QUIET_MODULES * bc.narrow;
        // Left quiet zone sits inside the sheet, not off the edge.
        expect(bc.x - DRY_BOX_LAYOUT.footer.x).toBeGreaterThanOrEqual(quiet);
        // Right quiet zone ends on the sheet.
        expect(bc.x + modulesFor(bc.content) * bc.narrow + quiet).toBeLessThanOrEqual(
          mmToDots(widthMm, DRY_BOX_SPEC.dpi),
        );
      }
    }
  });

  it("still omits the barcode outright when even 1-dot bars cannot fit", () => {
    expect(fitBarcode("X".repeat(200), 751)).toBeNull();
  });
});

describe("PR #1042 review round 7 — vendor prefix collision", () => {
  it("keeps a vendor that merely begins the name", () => {
    // `startsWith` suppressed any vendor that was a raw prefix, so real
    // brands vanished from the manifest whenever a colour name happened to
    // start with the same letters. Same flaw the type dedup already had.
    expect(describeItem({ filamentVendor: "Sun", filamentName: "Sunset Orange", filamentType: "PLA" }))
      .toBe("Sun Sunset Orange PLA");
    expect(describeItem({ filamentVendor: "Pol", filamentName: "Polar White", filamentType: "PETG" }))
      .toBe("Pol Polar White PETG");
  });

  it("still collapses a vendor that IS the leading token", () => {
    // The case the guard was written for.
    expect(describeItem({ filamentVendor: "Prusament", filamentName: "Prusament PLA", filamentType: "PLA" }))
      .toBe("Prusament PLA");
    // Multi-word vendors collapse too. No type here, so the assertion
    // isolates the vendor rule rather than mixing in the type dedup.
    expect(describeItem({ filamentVendor: "Fiberon PA6", filamentName: "Fiberon PA6 CF20" }))
      .toBe("Fiberon PA6 CF20");
  });

  it("prefers a redundant word over a lost brand", () => {
    // "Prusa" + "Prusament PLA" is a partial-token match. Repeating is
    // cosmetic; dropping the vendor loses information the manifest needs.
    expect(describeItem({ filamentVendor: "Prusa", filamentName: "Prusament PLA", filamentType: "PLA" }))
      .toBe("Prusa Prusament PLA");
  });
});
