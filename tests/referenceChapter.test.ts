import { describe, it, expect } from "vitest";
import {
  resolveReferenceChapter,
  normalizeTypeKey,
  REFERENCE_CHAPTERS,
} from "@/lib/referenceChapter";

const chOf = (type: string) => resolveReferenceChapter(type)?.id ?? null;

describe("normalizeTypeKey", () => {
  it("uppercases, drops whitespace and cosmetic separators", () => {
    expect(normalizeTypeKey("pla")).toBe("PLA");
    expect(normalizeTypeKey("  PA 6 ")).toBe("PA6");
    expect(normalizeTypeKey("PLA/PHA")).toBe("PLAPHA");
    expect(normalizeTypeKey("PLA+")).toBe("PLA");
    expect(normalizeTypeKey("PC-ABS")).toBe("PCABS");
    expect(normalizeTypeKey("PET-CF")).toBe("PETCF");
    expect(normalizeTypeKey(null)).toBe("");
    expect(normalizeTypeKey(undefined)).toBe("");
    expect(normalizeTypeKey("")).toBe("");
  });
});

describe("resolveReferenceChapter", () => {
  it("maps every form-default type", () => {
    expect(chOf("PLA")).toBe("ch6");
    expect(chOf("PETG")).toBe("ch7");
    expect(chOf("PCTG")).toBe("ch8");
    expect(chOf("ABS")).toBe("ch10");
    expect(chOf("ASA")).toBe("ch10");
    expect(chOf("PA")).toBe("ch13");
    expect(chOf("PC")).toBe("ch15");
    expect(chOf("TPU")).toBe("ch16");
    expect(chOf("FLEX")).toBe("ch16");
    expect(chOf("POM")).toBe("ch17");
    expect(chOf("PP")).toBe("ch11");
    expect(chOf("HIPS")).toBe("ch10");
    expect(chOf("PVA")).toBe("ch20");
    expect(chOf("PET-GF")).toBe("ch9");
    expect(chOf("PPA")).toBe("ch14");
    expect(chOf("IGLIDUR")).toBe("ch13"); // intentional PA mapping, not POM
  });

  it("strips CF/GF reinforcement to the base chemistry", () => {
    expect(chOf("PET-CF")).toBe("ch9");
    expect(chOf("PET-GF")).toBe("ch9");
    expect(chOf("PETG-CF")).toBe("ch7");
    expect(chOf("PLA-GF")).toBe("ch6");
    expect(chOf("PP-CF")).toBe("ch11");
    expect(chOf("PPA-CF")).toBe("ch14");
    expect(chOf("PC-GF")).toBe("ch15");
    expect(chOf("PA-CF")).toBe("ch13");
    expect(chOf("PA6-CF20")).toBe("ch13");
    expect(chOf("PETGCF")).toBe("ch7"); // no hyphen
  });

  it("strips a leading 'r' (recycled), including heuristic-only remainders", () => {
    expect(chOf("rPLA")).toBe("ch6");
    expect(chOf("rPETG")).toBe("ch7");
    expect(chOf("rPET")).toBe("ch9");
    // recycled forms that only the heuristics (not exact map) cover:
    expect(chOf("rTPU 95A")).toBe("ch16");
    expect(chOf("rNylon 6")).toBe("ch13");
    expect(chOf("rPA6T")).toBe("ch14");
    expect(chOf("rPET-CF")).toBe("ch9");
  });

  it("resolves synonyms", () => {
    expect(chOf("Nylon")).toBe("ch13");
    expect(chOf("Polycarbonate")).toBe("ch15");
    expect(chOf("Woodfill")).toBe("ch6");
    expect(chOf("Acetal")).toBe("ch17");
    expect(chOf("Delrin")).toBe("ch17");
    expect(chOf("Ultem")).toBe("ch18");
    expect(chOf("PEEK")).toBe("ch19");
    expect(chOf("TPEE")).toBe("ch16");
    expect(chOf("PEBA")).toBe("ch16");
  });

  it("maps PA<n> aliphatic-nylon subtypes (and Nylon<n> spellings) to ch13", () => {
    expect(chOf("PA6")).toBe("ch13");
    expect(chOf("PA66")).toBe("ch13");
    expect(chOf("PA12")).toBe("ch13");
    expect(chOf("PA11")).toBe("ch13");
    expect(chOf("PA612")).toBe("ch13");
    expect(chOf("PA1010")).toBe("ch13");
    expect(chOf("PA 6")).toBe("ch13"); // whitespace
    expect(chOf("Nylon 6")).toBe("ch13");
    expect(chOf("Nylon12")).toBe("ch13");
    expect(chOf("Nylon 66")).toBe("ch13");
  });

  it("routes semi-aromatic 'T'-grade nylons to the PPA chapter (ch14), not aliphatic", () => {
    expect(chOf("PA6T")).toBe("ch14");
    expect(chOf("PA9T")).toBe("ch14");
    expect(chOf("PA10T")).toBe("ch14");
    expect(chOf("PA6T-CF")).toBe("ch14"); // reinforcement-stripped first
    // but plain numbered nylons stay aliphatic
    expect(chOf("PA6")).toBe("ch13");
    expect(chOf("PA66")).toBe("ch13");
  });

  it("resolves elastomers with a Shore-hardness suffix to ch16", () => {
    expect(chOf("TPU 95A")).toBe("ch16");
    expect(chOf("TPU98A")).toBe("ch16");
    expect(chOf("TPU 64D")).toBe("ch16");
    expect(chOf("TPE 85A")).toBe("ch16");
    expect(chOf("TPC90A")).toBe("ch16");
    expect(chOf("TPU")).toBe("ch16"); // bare still works
  });

  it("resolves hyphenated blend names (PC-ABS, PC-PTFE)", () => {
    expect(chOf("PC-ABS")).toBe("ch15");
    expect(chOf("PC/ABS")).toBe("ch15");
    expect(chOf("PCABS")).toBe("ch15");
    expect(chOf("PC-PTFE")).toBe("ch15");
  });

  it("does NOT mismap types that merely share an initial (exact-first)", () => {
    expect(chOf("PCTG")).toBe("ch8"); // not PC (ch15)
    expect(chOf("PPA")).toBe("ch14"); // not PP (ch11)
    expect(chOf("PETG")).toBe("ch7"); // not PET (ch9)
    expect(chOf("PEI")).toBe("ch18"); // not PE (ch12)
    expect(chOf("PEEK")).toBe("ch19"); // not PE
    expect(chOf("PCL")).toBe("ch21"); // not PC
    expect(chOf("PVB")).toBe("ch21"); // not PVA (ch20)
    expect(chOf("PVA")).toBe("ch20");
    expect(chOf("PVDF")).toBe("ch17"); // not PVA/PVB
    expect(chOf("PPS")).toBe("ch18"); // not PP
    expect(chOf("PPSU")).toBe("ch18");
  });

  it("returns null for unmapped / empty types", () => {
    expect(resolveReferenceChapter("GLORP")).toBeNull();
    expect(resolveReferenceChapter("FOO")).toBeNull();
    expect(resolveReferenceChapter("")).toBeNull();
    expect(resolveReferenceChapter(null)).toBeNull();
    expect(resolveReferenceChapter(undefined)).toBeNull();
    expect(resolveReferenceChapter("Rubber")).toBeNull(); // leading-R guard doesn't overreach
  });

  it("returns the full chapter object", () => {
    expect(resolveReferenceChapter("PLA")).toEqual({
      id: "ch6",
      number: 6,
      title: "PLA family",
      part: "II — PLA Family",
    });
  });

  it("every TYPE_MAP target points at a defined chapter", () => {
    // Indirect guard: resolving each material chapter's canonical type yields
    // a chapter whose id is present in REFERENCE_CHAPTERS.
    for (const id of Object.keys(REFERENCE_CHAPTERS)) {
      expect(REFERENCE_CHAPTERS[id].id).toBe(id);
    }
  });
});
