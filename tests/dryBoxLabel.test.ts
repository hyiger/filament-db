import { describe, it, expect } from "vitest";
import {
  dryBoxLabel,
  describeItem,
  maxContentRows,
  DRY_BOX_SPEC,
  DRY_BOX_LAYOUT,
  DEFAULT_DRY_BOX_STRINGS,
  type DryBoxLabelInput,
  type DryBoxLabelItem,
} from "@/lib/dryBoxLabel";
import { render, mmToDots, type TsplCommand } from "@/lib/tsplEncoder";

/**
 * Coverage for the dry-box label template.
 *
 * The template's job is to turn a Location plus its spools into a
 * LabelDocument matching the hardware-verified 04_drybox_label.prn geometry,
 * with the contents list reflowed to fill the sheet. These tests pin the
 * layout invariants that a printed label would otherwise expose only by
 * running off the bottom of the stock.
 */

const AS_OF = new Date("2026-07-28T12:00:00.000Z");

function input(over: Partial<DryBoxLabelInput> = {}): DryBoxLabelInput {
  return {
    location: { name: "BOX-07" },
    items: [],
    qrPayload: "https://example.test/inventory?location=abc123",
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

describe("maxContentRows", () => {
  it("derives capacity from the configured stock height", () => {
    const rows = maxContentRows(DRY_BOX_SPEC);
    const height = mmToDots(DRY_BOX_SPEC.heightMm, DRY_BOX_SPEC.dpi);
    const available = height - DRY_BOX_LAYOUT.footerHeight - DRY_BOX_LAYOUT.rows.firstY;
    expect(rows).toBe(Math.floor(available / DRY_BOX_LAYOUT.rows.pitch));
    // Sanity: the whole point of reflowing is fitting well more than the
    // three rows the original fixture hardcoded.
    expect(rows).toBeGreaterThan(12);
  });

  it("taller stock fits more rows; stock too short fits none rather than going negative", () => {
    expect(maxContentRows({ ...DRY_BOX_SPEC, heightMm: 300 })).toBeGreaterThan(maxContentRows(DRY_BOX_SPEC));
    expect(maxContentRows({ ...DRY_BOX_SPEC, heightMm: 20 })).toBe(0);
  });
});

describe("dryBoxLabel — structure", () => {
  it("renders to valid TSPL through the encoder", () => {
    const bytes = render(dryBoxLabel(input({ items: [{ filamentName: "PLA" }] })));
    const job = new TextDecoder().decode(bytes);
    expect(job).toContain("SIZE 100 mm,150 mm\r\n");
    expect(job).toContain("QRCODE");
    expect(job).toContain('BARCODE 40,');
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
    expect(qr && qr.kind === "qrcode" && qr.content).toBe("https://example.test/inventory?location=abc123");
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
    const capacity = maxContentRows(DRY_BOX_SPEC);
    const out = texts(dryBoxLabel(input({ items: many(capacity + 10) })).commands);
    const shown = out.filter((s) => s.startsWith("- ")).length;
    expect(shown).toBe(capacity - 1);
    expect(out).toContain(`+${capacity + 10 - (capacity - 1)} more`);
  });

  it("fills the sheet exactly at capacity with no overflow row", () => {
    const capacity = maxContentRows(DRY_BOX_SPEC);
    const out = texts(dryBoxLabel(input({ items: many(capacity) })).commands);
    expect(out.filter((s) => s.startsWith("- ")).length).toBe(capacity);
    expect(out.some((s) => s.includes("more"))).toBe(false);
  });

  it("keeps every row above the footer, whatever the stock height", () => {
    // The invariant a printed label would otherwise reveal by running rows
    // off the bottom edge or over the barcode.
    for (const heightMm of [100, 150, 200]) {
      const spec = { ...DRY_BOX_SPEC, heightMm };
      const doc = dryBoxLabel(input({ items: many(200), spec: { heightMm } }));
      const footerTop = mmToDots(heightMm, spec.dpi) - DRY_BOX_LAYOUT.footerHeight;
      const rowYs = doc.commands
        .filter((c): c is Extract<TsplCommand, { kind: "text" }> => c.kind === "text")
        .map((c) => c.y)
        .filter((y) => y >= DRY_BOX_LAYOUT.rows.firstY && y < footerTop);
      for (const y of rowYs) expect(y).toBeLessThan(footerTop);
      // And the barcode stays on the sheet.
      const bc = doc.commands.find((c): c is Extract<TsplCommand, { kind: "barcode" }> => c.kind === "barcode")!;
      expect(bc.y + bc.height).toBeLessThan(mmToDots(heightMm, spec.dpi));
    }
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
          formatDate: (d) => `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`,
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
    const capacity = maxContentRows(DRY_BOX_SPEC);
    const out = texts(
      dryBoxLabel(
        input({ items: Array.from({ length: capacity + 5 }, (_, i) => ({ filamentName: `F${i}` })) }),
        { ...DEFAULT_DRY_BOX_STRINGS, more: "und {count} weitere" },
      ).commands,
    );
    expect(out).toContain(`und ${capacity + 5 - (capacity - 1)} weitere`);
  });
});
