/**
 * Color facet — tests for src/lib/colorFamily.ts. Pure, no DB / DOM.
 *
 * The LIBRARY fixture pins every row of a real 94-row library (82 classified
 * rows + 12 templates) to what the approved prototype classifier produced —
 * brown's and pink's shade bands were retuned on that same data, so a
 * threshold change must show up here as a deliberate fixture diff.
 */
import { describe, it, expect } from "vitest";
import {
  COLOR_FAMILIES,
  COLOR_FACET_VALUES,
  COLOR_SHADES,
  FAMILY_SWATCH_HEX,
  SHADED_FAMILIES,
  SHADE_BANDS,
  classifyFilament,
  classifyOklch,
  hexToOklch,
  matchReason,
  matchesColorFacet,
  nameColorWords,
  parseColorFacet,
  relaxColorQuery,
  scopeByColorFacet,
  shadeOf,
  typeBreakdown,
  type ColorClassifiable,
  type ColorClassification,
  type ColorFamily,
} from "@/lib/colorFamily";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import de from "../src/i18n/locales/de.json" with { type: "json" };

type Row = ColorClassifiable & { _id: string; parentId: string | null };

/** "gray:dark,black" — members serialized in insertion order. */
function membersOf(c: ColorClassification | null): string {
  if (!c) return "";
  return [...c.members]
    .map(([fam, shades]) => (shades.size ? `${fam}:${[...shades].join("/")}` : fam))
    .join(",");
}

// [id, parentId, name, vendor, type, color, secondaryColors, optTags,
//  hasVariants, spools ("A" active / "R" retired per spool), legacy
//  totalWeight, expected primary, expected primaryShade, expected members]
type FixtureTuple = [
  string, string | null, string, string, string, string | null, string[], number[],
  boolean, string, number | null, ColorFamily | null, string | null, string,
];
const FIXTURE: FixtureTuple[] = [
  ["f0",null,"Atomic Filament PCTG PRO","Atomic Filament","PCTG","#FF4D06",[],[],false,"",1258,"orange","mid","orange:mid"],
  ["f1",null,"Atomic Filament PCTG PRO CF","Atomic Filament","PCTG-CF","#1A1A1A",[],[],false,"",null,"black",null,"black"],
  ["f2",null,"BambuLab PC","BambuLab","PC","#000000",[],[],false,"A",null,"black",null,"black"],
  ["f3",null,"BambuLab PLA Silk+","BambuLab","PLA","#ba9594",[],[],false,"A",null,"pink","mid","pink:mid"],
  ["f4",null,"CHCKX PCTG","CHCKX","PCTG",null,[],[],true,"",null,null,null,""],
  ["f5","f4","CHCKX PCTG Black","CHCKX","PCTG","#000000",[],[],false,"A",null,"black",null,"black"],
  ["f6","f4","CHCKX PCTG Orange","CHCKX","PCTG","#FF8000",[],[],false,"A",null,"orange","mid","orange:mid"],
  ["f7",null,"Comgrow PLA Red","Comgrow","PLA","#ff0000",[],[],false,"A",null,"red","mid","red:mid"],
  ["f8",null,"FIBERON PPS-CF10","Polymaker","PPS-CF","#302E2F",[],[],false,"A",null,"black",null,"black"],
  ["f9",null,"Fiberon PA6-CF20","Polymaker","PA-CF","#000000",[],[4,14,31,33],false,"R",null,"black",null,"black"],
  ["f10",null,"Fiberon PET-GF","Polymaker","PET-GF","#CC0033",[],[0],false,"A",null,"red","mid","red:mid"],
  ["f11",null,"Fibreheart PPA","Siraya Tech","PPA","#191919",[],[6,33,36],false,"AA",1178,"black",null,"black"],
  ["f12",null,"Fibreheart PPA-CF","Siraya Tech","PPA-CF","#000000",[],[4,6,31,33,36],false,"AR",null,"black",null,"black"],
  ["f13",null,"Gizmo Dorks HIPS MultiMaterial","Gizmo Dorks","HIPS","#FFFFD7",[],[14],false,"A",null,"beige",null,"beige"],
  ["f14",null,"Gizmo Dorks POM","Gizmo Dorks","POM","#FFFFFF",[],[15,36],false,"A",null,"white",null,"white"],
  ["f15",null,"Inslogic PA12-CF","Inslogic","PA12-CF","#202020",[],[4,31],false,"A",1232,"black",null,"black"],
  ["f16",null,"JUSTMAKER PLA Pro Red","JUSTMAKER","PLA","#8B0000",[],[],false,"A",null,"red","dark","red:dark"],
  ["f17","f21","OVV3D Cherry","OVV3D","Woodfill","#651A14",[],[],false,"A",null,"brown","dark","brown:dark"],
  ["f18","f21","OVV3D Oak","OVV3D","Woodfill","#b5651d",[],[],false,"A",null,"brown","mid","brown:mid"],
  ["f19","f21","OVV3D Teak","OVV3D","Woodfill","#8c522a",[],[],false,"A",null,"brown","mid","brown:mid"],
  ["f20","f21","OVV3D Walnut","OVV3D","Woodfill","#773f1a",[],[],false,"A",null,"brown","dark","brown:dark"],
  ["f21",null,"OVV3D Wood","OVV3D","Woodfill","#808080",[],[],true,"",null,null,null,""],
  ["f22",null,"Overture ASA","Overture","ASA","#000000",[],[],true,"",null,null,null,""],
  ["f23","f22","Overture ASA Black","Overture","ASA","#000000",[],[],false,"A",null,"black",null,"black"],
  ["f24","f22","Overture ASA Gray","Overture","ASA","#B5B9BA",[],[],false,"A",null,"gray","light","gray:light"],
  ["f25","f22","Overture ASA Red","Overture","ASA","#AF251E",[],[],false,"A",null,"red","mid","red:mid"],
  ["f26",null,"Overture Easy Nylon","Overture","PA","#000000",[],[14,33],false,"A",null,"black",null,"black"],
  ["f27",null,"Overture PETG","Overture","PETG",null,[],[],true,"",null,null,null,""],
  ["f28","f27","Overture PETG Black","Overture","PETG","#000000",[],[],false,"A",null,"black",null,"black"],
  ["f29","f27","Overture PETG Grey","Overture","PETG","#808080",[],[],false,"A",null,"gray","mid","gray:mid"],
  ["f30","f27","Overture PETG Pink","Overture","PETG","#F79DBC",[],[],false,"A",null,"pink","light","pink:light"],
  ["f31","f27","Overture PETG Red","Overture","PETG","#ff0000",[],[],false,"A",null,"red","mid","red:mid"],
  ["f32","f27","Overture PETG Transparent","Overture","PETG",null,[],[2],false,"A",null,"clear",null,"clear"],
  ["f33","f27","Overture PETG — White","Overture","PETG","#ffffff",[],[],false,"",797,"white",null,"white"],
  ["f34",null,"Overture PLA","Overture","PLA",null,[],[],true,"",null,null,null,""],
  ["f35","f34","Overture PLA Matte White","Overture","PLA","#E6DEDE",[],[12,15,16],false,"A",null,"white",null,"white"],
  ["f36","f34","Overture PLA Red","Overture","PLA","#E9301E",[],[],false,"A",null,"red","mid","red:mid"],
  ["f37","f34","Overture PLA White","Overture","PLA","#FFFEFA",[],[],false,"A",null,"white",null,"white"],
  ["f38","f34","Overture PLA — Original","Overture","PLA","#808080",[],[],false,"A",null,"unknown",null,"unknown"],
  ["f39","f34","Overture Silk PLA White","Overture","PLA","#DDD4CA",[],[17],false,"A",null,"white",null,"white"],
  ["f40",null,"Overture TPU 95A Black","Overture","TPU","#000000",[],[],false,"A",null,"black",null,"black"],
  ["f41",null,"PC Blend","Prusament","PC","#DEE0E6",[],[6,14],true,"",null,null,null,""],
  ["f42",null,"PC Blend Carbon Fiber Black","Prusament","PC-CF","#262727",[],[31,12,4,30],false,"A",null,"black",null,"black"],
  ["f43","f41","PC Blend Jet Black","Prusament","PC","#24292A",[],[6,14],false,"A",null,"black",null,"black"],
  ["f44","f41","PC Blend Prusa Orange","Prusament","PC","#EA5E19",[],[6,14],false,"A",null,"orange","mid","orange:mid"],
  ["f45",null,"PRILINE PC-CF","PRILINE","PC-CF","#000000",[],[],false,"A",null,"black",null,"black"],
  ["f46",null,"PVB Smoky Black","Prusament","PVB","#ADADAD",[],[3],false,"A",609,"black",null,"gray:mid,black,clear"],
  ["f47",null,"PolyLite PLA Teal","Polymaker","PLA","#48B9C2",[],[],false,"A",null,"teal","mid","teal:mid"],
  ["f48",null,"PolyTerra PLA Red","Polymaker","PLA","#ff0000",[],[],false,"A",null,"red","mid","red:mid"],
  ["f49",null,"Polychroma Green","Polymaker","PLA","#5eab71",[],[],false,"A",null,"green","mid","green:mid"],
  ["f50",null,"Polymaker HT-PLA-GF","Polymaker","PLA-GF",null,[],[4,0],true,"",null,null,null,""],
  ["f51","f50","Polymaker HT-PLA-GF Black","Polymaker","PLA-GF","#18191b",[],[4,0],false,"A",null,"black",null,"black"],
  ["f52","f50","Polymaker HT-PLA-GF White","Polymaker","PLA-GF","#eff0eb",[],[4,0],false,"A",null,"white",null,"white"],
  ["f53","f50","Polymaker HT-PLA-GF — Original","Polymaker","PLA-GF",null,[],[4,0],false,"A",null,"unknown",null,"unknown"],
  ["f54",null,"Polymaker PolyLite PC Transparent","Polymaker","PC","#dad5d4",[],[2],false,"A",null,"clear",null,"white,clear"],
  ["f55",null,"Polymax PC Grey","Polymaker","PC","#A5A5AB",[],[],false,"A",875,"gray","mid","gray:mid"],
  ["f56",null,"Pro PCTG","3D Fuel","PCTG",null,[],[],true,"",null,null,null,""],
  ["f57","f56","Pro PCTG Cobalt Blue","3D Fuel","PCTG","#18549B",[],[],false,"",1177,"blue","mid","blue:mid"],
  ["f58","f56","Pro PCTG Daffodil Yellow","3D Fuel","PCTG","#FABE3C",[],[],false,"",null,"yellow","mid","yellow:mid"],
  ["f59","f56","Pro PCTG Fire Engine Red","3D Fuel","PCTG","#C43438",[],[],false,"A",null,"red","mid","red:mid"],
  ["f60","f56","Pro PCTG Grass Green","3D Fuel","PCTG","#469854",[],[],false,"",1177,"green","mid","green:mid"],
  ["f61",null,"Pro PCTG Matte Black","3D Fuel","PCTG","#434443",[],[16,31],false,"A",null,"black",null,"gray:dark,black"],
  ["f62","f56","Pro PCTG Midnight Black","3D Fuel","PCTG","#383737",[],[],false,"",1035,"black",null,"gray:dark,black"],
  ["f63","f56","Pro PCTG Natural","3D Fuel","PCTG","#A9A9A6",[],[2],false,"A",null,"clear",null,"gray:mid,clear"],
  ["f64","f56","Pro PCTG Snow White","3D Fuel","PCTG","#EEF2EF",[],[],false,"A",null,"white",null,"white"],
  ["f65","f56","Pro PCTG Tangerine Orange","3D Fuel","PCTG","#F16A47",[],[],false,"",null,"orange","mid","orange:mid"],
  ["f66","f56","Pro PCTG Toolbox Red","3D Fuel","PCTG","#A74031",[],[14,15,36],false,"R",null,"red","mid","brown:mid,red:mid"],
  ["f67",null,"Prusament ASA","Prusament","ASA","#ff5000",[],[6,7,14],true,"",null,null,null,""],
  ["f68","f67","Prusament ASA Orange","Prusament","ASA","#FFA500",[],[6,7,14],false,"A",null,"orange","mid","orange:mid"],
  ["f69",null,"Prusament PETG","Prusament","PETG","#808080",[],[],true,"",null,null,null,""],
  ["f70","f69","Prusament PETG Prusa Galaxy Black","Prusament","PETG","#494546",[],[],false,"A",null,"black",null,"gray:dark,black"],
  ["f71","f69","Prusament PETG Prusa Orange","Prusament","PETG","#EB5403",[],[],false,"AA",null,"orange","mid","orange:mid"],
  ["f72",null,"Prusament PP Carbon Fiber Black","Prusament","PP-CF","#000000",[],[31,4],false,"A",null,"black",null,"black"],
  ["f73",null,"Prusament Woodfill Chocolate Brown","Prusament","Woodfill","#543c27",[],[],false,"A",null,"brown","dark","brown:dark"],
  ["f74",null,"Prusament rPLA","Prusament","rPLA","#808080",[],[],true,"",null,null,null,""],
  ["f75","f74","Prusament rPLA Algae Pigment","Prusament","rPLA","#674B41",[],[],false,"A",null,"brown","dark","brown:dark"],
  ["f76","f74","Prusament rPLA Corn Pigment","Prusament","rPLA","#B37B46",[],[],false,"A",null,"brown","mid","brown:mid"],
  ["f77","f74","Prusament rPLA Risotto Pigment","Prusament","rPLA","#CCC9BF",[],[],false,"A",null,"gray","light","gray:light"],
  ["f78",null,"Push Plastic PMMA","Push Plastic","PMMA",null,[],[2],false,"A",null,"clear",null,"clear"],
  ["f79",null,"SUNLU PLA","SUNLU","PLA","#F5F5DC",[],[],true,"",null,null,null,""],
  ["f80","f79","SUNLU PLA Beige","SUNLU","PLA","#F5F5DC",[],[],false,"A",null,"beige",null,"white,beige"],
  ["f81","f79","SUNLU PLA Cyan","SUNLU","PLA","#00FFFF",[],[],false,"A",null,"teal","light","teal:light"],
  ["f82","f79","SUNLU PLA Magenta","SUNLU","PLA","#f95e88",[],[],false,"A",null,"pink","mid","pink:mid"],
  ["f83","f79","SUNLU PLA White","SUNLU","PLA","#ffffff",[],[],false,"A",null,"white",null,"white"],
  ["f84","f79","SUNLU PLA Yellow","SUNLU","PLA","#fbe200",[],[],false,"A",null,"yellow","mid","yellow:mid"],
  ["f85",null,"SUNLU PP","SUNLU","PP","#030303",[],[5,15,36],false,"A",null,"black",null,"black"],
  ["f86",null,"Siraya Tech Flex PEBA Air","Siraya Tech","PEBA","#000000",[],[9],false,"A",null,"black",null,"black"],
  ["f87",null,"Siraya Tech Flex TPU Air","Siraya Tech","TPU","#1a1a1a",[],[9],false,"A",null,"black",null,"black"],
  ["f88",null,"Siraya Tech PET-CF","Siraya Tech","PET-CF","#000000",[],[],false,"AA",1156,"black",null,"black"],
  ["f89",null,"Siraya Tech TPU 64D","Siraya Tech","TPU","#000000",[],[9],false,"A",null,"black",null,"black"],
  ["f90",null,"Spectrum PETG-PTFE","Spectrum","PETG","#0000FF",[],[],false,"A",null,"blue","mid","blue:mid"],
  ["f91",null,"The K8 PC Clear White","kexcelled","PC","#eff0f1",[],[6,14,2],false,"A",null,"clear",null,"white,clear"],
  ["f92",null,"Yousu PP","Yousu","PP","#DEE0E6",[],[5,15,36,2],false,"A",null,"clear",null,"white,clear"],
  ["f93",null,"iglidur i150","igus","IGLIDUR","#ffffff",[],[4,15,36],false,"A",null,"white",null,"white"],
];

const LIBRARY: Row[] = FIXTURE.map(([_id, parentId, name, vendor, type, color, sec, tags, hv, sp, tw]) => ({
  _id,
  parentId,
  name,
  vendor,
  type,
  color,
  secondaryColors: sec,
  optTags: tags,
  hasVariants: hv,
  spools: [...sp].map((c) => ({ retired: c === "R", totalWeight: 1000 })),
  totalWeight: tw,
}));
const byName = (name: string) => LIBRARY.find((f) => f.name === name)!;

/** A plain in-stock filament for synthetic cases. */
function fil(over: Partial<Row> = {}): Row {
  return {
    _id: "x",
    parentId: null,
    name: "Acme PLA",
    vendor: "Acme",
    type: "PLA",
    color: null,
    secondaryColors: [],
    optTags: [],
    hasVariants: false,
    spools: [{ retired: false, totalWeight: 1000 }],
    totalWeight: null,
    ...over,
  };
}

describe("constants", () => {
  it("lists 16 families in display order", () => {
    expect(COLOR_FAMILIES).toEqual([
      "black", "gray", "white", "beige", "brown", "red", "orange", "yellow",
      "green", "teal", "blue", "purple", "pink", "clear", "multi", "unknown",
    ]);
    expect(COLOR_SHADES).toEqual(["light", "mid", "dark"]);
    expect(Object.keys(SHADE_BANDS).sort()).toEqual([...SHADED_FAMILIES].sort());
  });

  it("pins the shade bands (brown .64 / pink .76 were retuned on real data)", () => {
    expect(SHADE_BANDS).toEqual({
      gray: [0.53, 0.78], brown: [0.45, 0.64], red: [0.45, 0.7], orange: [0.55, 0.8],
      yellow: [0.7, 0.93], green: [0.5, 0.8], teal: [0.55, 0.82], blue: [0.4, 0.7],
      purple: [0.45, 0.75], pink: [0.62, 0.76],
    });
  });

  it("generates exactly 46 facet values: every family + shaded family-shades", () => {
    expect(COLOR_FACET_VALUES).toHaveLength(46);
    expect(new Set(COLOR_FACET_VALUES).size).toBe(46);
    for (const fam of COLOR_FAMILIES) expect(COLOR_FACET_VALUES).toContain(fam);
    for (const fam of SHADED_FAMILIES) {
      for (const s of COLOR_SHADES) expect(COLOR_FACET_VALUES).toContain(`${fam}-${s}`);
    }
    for (const v of ["white-dark", "black-light", "clear-mid", "multi-dark", "unknown-light"]) {
      expect(COLOR_FACET_VALUES as readonly string[]).not.toContain(v);
    }
  });

  it("every dot color classifies back into its own family", () => {
    for (const fam of COLOR_FAMILIES) {
      const hex = FAMILY_SWATCH_HEX[fam];
      if (fam === "clear" || fam === "multi" || fam === "unknown") {
        expect(hex).toBeNull();
        continue;
      }
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
      expect(classifyOklch(hexToOklch(hex!))).toBe(fam);
    }
  });
});

describe("i18n", () => {
  // The UI builds these keys dynamically (`colorFacet.family.${fam}`), which
  // the literal-key coverage test can't see — so pin them here.
  it("every family and shade label exists in en and de", () => {
    const keys = [
      ...COLOR_FAMILIES.map((f) => `colorFacet.family.${f}`),
      ...COLOR_SHADES.map((s) => `colorFacet.shade.${s}`),
      "inventory.groupBy.color",
    ];
    for (const locale of [en, de] as Record<string, string>[]) {
      for (const k of keys) expect(locale[k], k).toBeTruthy();
    }
  });
});

describe("hexToOklch", () => {
  it("maps black, white and pure red", () => {
    const k = hexToOklch("#000000");
    expect(k.L).toBeCloseTo(0, 6);
    expect(k.C).toBeCloseTo(0, 6);
    const w = hexToOklch("#FFFFFF");
    expect(w.L).toBeCloseTo(1, 4);
    expect(w.C).toBeLessThan(1e-4);
    const r = hexToOklch("#ff0000");
    expect(r.L).toBeCloseTo(0.628, 3);
    expect(r.C).toBeCloseTo(0.2577, 3);
    expect(r.H).toBeCloseTo(29.23, 1);
  });

  it("returns H in [0, 360) and tolerates surrounding whitespace", () => {
    const b = hexToOklch("  #0000FF ");
    expect(b.H).toBeGreaterThanOrEqual(0);
    expect(b.H).toBeLessThan(360);
    expect(b.H).toBeCloseTo(264.05, 1);
    // A negative atan2 hue wraps (magenta-ish purple sits above 300°).
    expect(hexToOklch("#FF00FF").H).toBeCloseTo(328.36, 1);
  });
});

describe("classifyOklch thresholds (both sides of every boundary)", () => {
  const e = 1e-4;
  it("achromatic: C .035, L .32, L .87", () => {
    expect(classifyOklch({ L: 0.5, C: 0.035 - e, H: 200 })).toBe("gray");
    expect(classifyOklch({ L: 0.5, C: 0.035, H: 200 })).toBe("teal");
    expect(classifyOklch({ L: 0.32 - e, C: 0, H: 0 })).toBe("black");
    expect(classifyOklch({ L: 0.32, C: 0, H: 0 })).toBe("gray");
    expect(classifyOklch({ L: 0.87 - e, C: 0, H: 0 })).toBe("gray");
    expect(classifyOklch({ L: 0.87, C: 0, H: 0 })).toBe("white");
  });

  it("brown: 15 <= H < 95, L < .66, C < .14", () => {
    expect(classifyOklch({ L: 0.5, C: 0.1, H: 15 })).toBe("brown");
    expect(classifyOklch({ L: 0.5, C: 0.1, H: 15 - e })).toBe("red");
    expect(classifyOklch({ L: 0.5, C: 0.1, H: 95 - e })).toBe("brown");
    expect(classifyOklch({ L: 0.5, C: 0.1, H: 95 })).toBe("yellow");
    expect(classifyOklch({ L: 0.66 - e, C: 0.05, H: 60 })).toBe("brown");
    expect(classifyOklch({ L: 0.66, C: 0.05, H: 60 })).toBe("beige");
    expect(classifyOklch({ L: 0.5, C: 0.14 - e, H: 60 })).toBe("brown");
    expect(classifyOklch({ L: 0.5, C: 0.14, H: 60 })).toBe("orange");
  });

  it("beige: 45 <= H < 110, L >= .66, C < .10", () => {
    expect(classifyOklch({ L: 0.7, C: 0.05, H: 45 })).toBe("beige");
    expect(classifyOklch({ L: 0.7, C: 0.05, H: 45 - e })).toBe("orange");
    expect(classifyOklch({ L: 0.7, C: 0.05, H: 110 - e })).toBe("beige");
    expect(classifyOklch({ L: 0.7, C: 0.05, H: 110 })).toBe("yellow");
    expect(classifyOklch({ L: 0.7, C: 0.1 - e, H: 60 })).toBe("beige");
    expect(classifyOklch({ L: 0.7, C: 0.1, H: 60 })).toBe("orange");
  });

  it("red/pink around 0°: H >= 340 || H < 10, split at L .60", () => {
    expect(classifyOklch({ L: 0.5, C: 0.2, H: 340 })).toBe("red");
    expect(classifyOklch({ L: 0.5, C: 0.2, H: 340 - e })).toBe("purple");
    expect(classifyOklch({ L: 0.6 - e, C: 0.2, H: 350 })).toBe("red");
    expect(classifyOklch({ L: 0.6, C: 0.2, H: 350 })).toBe("pink");
    expect(classifyOklch({ L: 0.6, C: 0.2, H: 10 - e })).toBe("pink");
    // At H 10 the warm-red rule takes over: L .6 with high chroma is red.
    expect(classifyOklch({ L: 0.6, C: 0.2, H: 10 })).toBe("red");
  });

  it("warm red/pink: H < 33, pink when L >= .78 or (C < .08 and L >= .60)", () => {
    expect(classifyOklch({ L: 0.78 - e, C: 0.2, H: 20 })).toBe("red");
    expect(classifyOklch({ L: 0.78, C: 0.2, H: 20 })).toBe("pink");
    expect(classifyOklch({ L: 0.7, C: 0.08 - e, H: 12 })).toBe("pink");
    expect(classifyOklch({ L: 0.7, C: 0.08, H: 12 })).toBe("red");
    expect(classifyOklch({ L: 0.6 - e, C: 0.07, H: 12 })).toBe("red");
    expect(classifyOklch({ L: 0.7, C: 0.2, H: 33 - e })).toBe("red");
    expect(classifyOklch({ L: 0.7, C: 0.2, H: 33 })).toBe("orange");
  });

  it("hue wheel: 75 / 115 / 180 / 205 / 290", () => {
    const at = (H: number) => classifyOklch({ L: 0.7, C: 0.2, H });
    expect(at(75 - e)).toBe("orange");
    expect(at(75)).toBe("yellow");
    expect(at(115 - e)).toBe("yellow");
    expect(at(115)).toBe("green");
    expect(at(180 - e)).toBe("green");
    expect(at(180)).toBe("teal");
    expect(at(205 - e)).toBe("teal");
    expect(at(205)).toBe("blue");
    expect(at(290 - e)).toBe("blue");
    expect(at(290)).toBe("purple");
  });
});

describe("shadeOf", () => {
  it("splits every shaded family at both band edges", () => {
    for (const fam of SHADED_FAMILIES) {
      const [dark, light] = SHADE_BANDS[fam];
      expect(shadeOf(dark - 1e-4, fam)).toBe("dark");
      expect(shadeOf(dark, fam)).toBe("mid");
      expect(shadeOf(light - 1e-4, fam)).toBe("mid");
      expect(shadeOf(light, fam)).toBe("light");
    }
  });

  it("returns null for unshaded families", () => {
    for (const fam of ["black", "white", "beige", "clear", "multi", "unknown"] as const) {
      expect(shadeOf(0.5, fam)).toBeNull();
    }
  });
});

describe("nameColorWords", () => {
  it("returns families left to right, folding accents, ß and case", () => {
    expect(nameColorWords("Grün / WEISS Weiß schwarz", "Acme", "PLA")).toEqual([
      "green", "white", "white", "black",
    ]);
    expect(nameColorWords("Prusament PETG Prusa Galaxy Black", "Prusament", "PETG")).toEqual(["black"]);
  });

  it("drops tokens that appear in the vendor or type", () => {
    expect(nameColorWords("Blue Ocean PLA Red", "Blue Ocean", "PLA")).toEqual(["red"]);
    expect(nameColorWords("OVV3D Wood Walnut", "OVV3D", "Wood")).toEqual(["brown"]);
  });

  it("tolerates null/undefined fields", () => {
    expect(nameColorWords(null, undefined, null)).toEqual([]);
    expect(nameColorWords("Red", null, undefined)).toEqual(["red"]);
  });
});

describe("classifyFilament — real library fixture", () => {
  it("covers at least 30 rows", () => {
    expect(FIXTURE.length).toBeGreaterThanOrEqual(30);
  });

  it.each(FIXTURE.map((t, i) => [t[2], i] as const))("%s", (_name, i) => {
    const [, , , , , , , , , , , primary, shade, members] = FIXTURE[i];
    const c = classifyFilament(LIBRARY[i]);
    expect(c?.primary ?? null).toBe(primary);
    expect(c?.primaryShade ?? null).toBe(shade);
    expect(membersOf(c)).toBe(members);
  });

  it("pins the hard cases explicitly", () => {
    const expectRow = (name: string, primary: ColorFamily, shade: string | null, members: string) => {
      const c = classifyFilament(byName(name));
      expect([c?.primary, c?.primaryShade ?? null, membersOf(c)]).toEqual([primary, shade, members]);
    };
    expectRow("Pro PCTG Matte Black", "black", null, "gray:dark,black");
    expectRow("Pro PCTG Midnight Black", "black", null, "gray:dark,black");
    expectRow("Prusament PETG Prusa Galaxy Black", "black", null, "gray:dark,black");
    expectRow("Overture PETG Grey", "gray", "mid", "gray:mid");
    expectRow("Overture PLA — Original", "unknown", null, "unknown");
    expectRow("PVB Smoky Black", "black", null, "gray:mid,black,clear");
    expectRow("Overture PETG Transparent", "clear", null, "clear");
    expectRow("Polymaker PolyLite PC Transparent", "clear", null, "white,clear");
    expectRow("OVV3D Oak", "brown", "mid", "brown:mid");
    expectRow("OVV3D Walnut", "brown", "dark", "brown:dark");
    expectRow("Prusament Woodfill Chocolate Brown", "brown", "dark", "brown:dark");
    expectRow("BambuLab PLA Silk+", "pink", "mid", "pink:mid");
    expectRow("Gizmo Dorks HIPS MultiMaterial", "beige", null, "beige");
    expectRow("SUNLU PLA Beige", "beige", null, "white,beige");
    expectRow("SUNLU PLA Cyan", "teal", "light", "teal:light");
    expectRow("SUNLU PLA Magenta", "pink", "mid", "pink:mid");
    expectRow("Prusament rPLA Risotto Pigment", "gray", "light", "gray:light");
    expectRow("Prusament rPLA Corn Pigment", "brown", "mid", "brown:mid");
    expectRow("Pro PCTG Natural", "clear", null, "gray:mid,clear");
    expectRow("Pro PCTG Cobalt Blue", "blue", "mid", "blue:mid");
    expectRow("Pro PCTG Tangerine Orange", "orange", "mid", "orange:mid");
    expectRow("Atomic Filament PCTG PRO", "orange", "mid", "orange:mid");
    expectRow("Pro PCTG Toolbox Red", "red", "mid", "brown:mid,red:mid");
  });

  it("classifies templates as null (colorless)", () => {
    for (const name of ["Pro PCTG", "Prusament PETG", "SUNLU PLA", "OVV3D Wood"]) {
      expect(classifyFilament(byName(name))).toBeNull();
    }
  });
});

describe("the two questions on the real library", () => {
  const nonTemplateMatches = (facet: string) =>
    LIBRARY.filter((f) => matchesColorFacet(f, facet)).map((f) => f.name as string);

  it('Q1 "dark grey" → exactly the three charcoal blacks, via the swatch', () => {
    const names = nonTemplateMatches("gray-dark");
    expect(names).toEqual([
      "Pro PCTG Matte Black",
      "Pro PCTG Midnight Black",
      "Prusament PETG Prusa Galaxy Black",
    ]);
    for (const n of names) {
      expect(matchReason(byName(n), "gray-dark")).toBe("swatch");
      expect(matchReason(byName(n), "black")).toBe("primary");
    }
    expect(typeBreakdown(LIBRARY, "gray-dark")).toEqual([
      { type: "PCTG", inStock: 2, outOfStock: 0 },
      { type: "PETG", inStock: 1, outOfStock: 0 },
    ]);
  });

  it('Q2 "orange types" → PCTG, ASA, PC, PETG with the out-of-stock split', () => {
    expect(typeBreakdown(LIBRARY, "orange")).toEqual([
      { type: "PCTG", inStock: 2, outOfStock: 1 },
      { type: "ASA", inStock: 1, outOfStock: 0 },
      { type: "PC", inStock: 1, outOfStock: 0 },
      { type: "PETG", inStock: 1, outOfStock: 0 },
    ]);
  });

  it("gray types match the approved walkthrough", () => {
    expect(typeBreakdown(LIBRARY, "gray").map((t) => `${t.type} ${t.inStock}`)).toEqual([
      "PCTG 3", "PETG 2", "ASA 1", "PC 1", "PVB 1", "rPLA 1",
    ]);
  });
});

describe("classifyFilament — edge cases", () => {
  const summary = (over: Partial<Row>) => {
    const c = classifyFilament(fil(over));
    return c && [c.primary, c.primaryShade, membersOf(c)];
  };

  it("Rose Gold: right-to-left adjacency rejects gold and accepts rose", () => {
    expect(summary({ name: "Acme PLA Rose Gold", color: "#B76E79" })).toEqual(["pink", "mid", "red:mid,pink:mid"]);
  });

  it("Transparent Smoke → Clear, also Gray · Dark", () => {
    expect(summary({ name: "Acme PETG Transparent Smoke", color: "#3A3A3A", optTags: [2] })).toEqual([
      "clear", null, "gray:dark,clear",
    ]);
  });

  it("Transparent Red stays red, also Clear (translucent tag 3 counts too)", () => {
    expect(summary({ name: "Acme PETG Transparent Red", color: "#FF0000", optTags: [3] })).toEqual([
      "red", "mid", "red:mid,clear",
    ]);
  });

  it("#808080 without a gray word is the blank default", () => {
    expect(summary({ name: "Acme PLA Concrete", color: "#808080" })).toEqual(["unknown", null, "unknown"]);
    expect(summary({ name: "Acme PLA Blue", color: " #808080 " })).toEqual(["blue", null, "blue"]);
    expect(summary({ name: "Acme PLA Grey", color: "#808080" })).toEqual(["gray", "mid", "gray:mid"]);
  });

  it("coextruded black + charcoal → Multicolor, also Black and Gray · Dark", () => {
    expect(summary({ color: "#000000", secondaryColors: ["#3A3A3A"], optTags: [28] })).toEqual([
      "multi", null, "multi,black,gray:dark",
    ]);
    expect(summary({ color: "#000000", secondaryColors: ["#3A3A3A"], optTags: [29, 2] })).toEqual([
      "multi", null, "multi,black,gray:dark,clear",
    ]);
  });

  it("a gradient with only ONE real color falls through to the swatch rules", () => {
    expect(summary({ color: null, secondaryColors: ["#0000FF", "nope"], optTags: [27] })).toEqual([
      "blue", "mid", "blue:mid",
    ]);
  });

  it("a solid filament with a stray secondary is classified by its primary only", () => {
    expect(summary({ color: "#FF0000", secondaryColors: ["#0000FF"] })).toEqual(["red", "mid", "red:mid"]);
    expect(summary({ color: null, secondaryColors: ["#0000FF"] })).toEqual(["blue", "mid", "blue:mid"]);
  });

  it("untagged Natural is white or beige, never Clear", () => {
    expect(summary({ name: "Acme PLA Natural", color: "#F2EFE6" })).toEqual(["white", null, "white"]);
    expect(summary({ name: "Acme PLA Natural", color: "#EDE3C8" })).toEqual(["beige", null, "beige"]);
  });

  it("lenient achromatic word checks (black L<.40, white L>=.85, gray C<.06)", () => {
    expect(summary({ name: "Acme Black", color: "#555555" })).toEqual(["black", null, "gray:dark,black"]);
    expect(summary({ name: "Acme White", color: "#DDDDDD" })).toEqual(["white", null, "white"]);
    expect(summary({ name: "Acme Grey", color: "#B37B46" })).toEqual(["gray", "mid", "brown:mid,gray:mid"]);
    // The lenient checks let an achromatic word beat a NON-adjacent hue.
    expect(summary({ name: "Acme Black", color: "#1A2340" })).toEqual(["black", null, "blue:dark,black"]);
    expect(summary({ name: "Acme Black", color: "#4A5A90" })).toEqual(["blue", "mid", "blue:mid"]);
    expect(summary({ name: "Acme White", color: "#FFE8EE" })).toEqual(["white", null, "white"]);
    expect(summary({ name: "Acme White", color: "#FFB0C8" })?.[0]).toBe("pink");
    expect(summary({ name: "Acme Grey", color: "#6E7F96" })).toEqual(["gray", "mid", "blue:mid,gray:mid"]);
    // A non-adjacent word with a disagreeing swatch is ignored.
    expect(summary({ name: "Acme Navy", color: "#AEC6CF" })).toEqual(["gray", "light", "gray:light"]);
  });

  it("no usable swatch: the last color word wins without a shade", () => {
    expect(summary({ name: "Acme Red Blue", color: "#12" })).toEqual(["blue", null, "blue"]);
    expect(summary({ name: "Acme", color: null })).toEqual(["unknown", null, "unknown"]);
    expect(summary({ name: "Acme", color: null, optTags: [2] })).toEqual(["clear", null, "clear"]);
  });

  it("a template is null; a legacy template still holding stock is classified", () => {
    expect(summary({ hasVariants: true, color: "#FF0000", spools: [] })).toBeNull();
    expect(summary({ hasVariants: true, color: "#FF0000", spools: [{ retired: true, totalWeight: 1 }] })).toBeNull();
    expect(summary({ hasVariants: true, color: "#FF0000", spools: [{ retired: false }] })).toEqual([
      "red", "mid", "red:mid",
    ]);
    expect(summary({ hasVariants: true, color: "#FF0000", spools: null, totalWeight: 900 })).toEqual([
      "red", "mid", "red:mid",
    ]);
  });

  it("tolerates a minimal shape with every field missing", () => {
    const c = classifyFilament({});
    expect(c?.primary).toBe("unknown");
  });

  it("memoizes per object, not per _id", () => {
    const a = fil({ _id: "same", color: "#FF0000" });
    const b = fil({ _id: "same", color: "#0000FF" });
    const first = classifyFilament(a);
    expect(classifyFilament(a)).toBe(first);
    expect(classifyFilament(b)?.primary).toBe("blue");
    expect(classifyFilament(a)?.primary).toBe("red");
    const t = fil({ hasVariants: true, spools: [] });
    expect(classifyFilament(t)).toBeNull();
    expect(classifyFilament(t)).toBeNull(); // cached null
  });
});

describe("parseColorFacet", () => {
  it("parses families and family-shades", () => {
    expect(parseColorFacet("gray")).toEqual({ family: "gray", shade: null });
    expect(parseColorFacet("gray-dark")).toEqual({ family: "gray", shade: "dark" });
    expect(parseColorFacet("unknown")).toEqual({ family: "unknown", shade: null });
    for (const v of COLOR_FACET_VALUES) expect(parseColorFacet(v)).not.toBeNull();
  });

  it("rejects empty and invalid values", () => {
    for (const v of ["", null, undefined, "white-dark", "blue-", "Blue", "grey", "gray-medium", "-dark", "constructor"]) {
      expect(parseColorFacet(v)).toBeNull();
    }
  });
});

describe("matchesColorFacet / matchReason", () => {
  const red = fil({ name: "Acme Red", color: "#FF0000" });
  it("matches family and shade membership", () => {
    expect(matchesColorFacet(red, "red")).toBe(true);
    expect(matchesColorFacet(red, "red-mid")).toBe(true);
    expect(matchesColorFacet(red, "red-dark")).toBe(false);
    expect(matchesColorFacet(red, "blue")).toBe(false);
    expect(matchesColorFacet(red, { family: "red", shade: null })).toBe(true);
  });

  it("is false for an empty/invalid facet and for templates", () => {
    expect(matchesColorFacet(red, "")).toBe(false);
    expect(matchesColorFacet(red, null)).toBe(false);
    expect(matchesColorFacet(red, "red-")).toBe(false);
    expect(matchesColorFacet(fil({ hasVariants: true, spools: [], color: "#FF0000" }), "red")).toBe(false);
  });

  it("reports primary vs swatch vs null", () => {
    const toolbox = byName("Pro PCTG Toolbox Red");
    expect(matchReason(toolbox, "red")).toBe("primary");
    expect(matchReason(toolbox, "red-mid")).toBe("primary");
    expect(matchReason(toolbox, "brown-mid")).toBe("swatch");
    expect(matchReason(toolbox, "blue")).toBeNull();
    expect(matchReason(toolbox, "")).toBeNull();
    // Primary family but the requested shade isn't the primary shade.
    const multi = fil({ color: "#000000", secondaryColors: ["#3A3A3A"], optTags: [28] });
    expect(matchReason(multi, "multi")).toBe("primary");
    expect(matchReason(multi, "gray-dark")).toBe("swatch");
    const legacy = fil({ name: "Acme Grey", color: "#B37B46" });
    expect(matchReason(legacy, { family: "gray", shade: "mid" })).toBe("primary");
    expect(matchReason(legacy, "brown-mid")).toBe("swatch");
  });
});

describe("scopeByColorFacet", () => {
  it("returns the SAME array for an empty or invalid facet", () => {
    expect(scopeByColorFacet(LIBRARY, "")).toBe(LIBRARY);
    expect(scopeByColorFacet(LIBRARY, null)).toBe(LIBRARY);
    expect(scopeByColorFacet(LIBRARY, undefined)).toBe(LIBRARY);
    expect(scopeByColorFacet(LIBRARY, "white-dark")).toBe(LIBRARY);
  });

  it("keeps matching rows plus the templates heading them, in input order", () => {
    expect(scopeByColorFacet(LIBRARY, "gray-dark").map((f) => f.name)).toEqual([
      "Pro PCTG",
      "Pro PCTG Matte Black",
      "Pro PCTG Midnight Black",
      "Prusament PETG",
      "Prusament PETG Prusa Galaxy Black",
    ]);
  });

  it("never includes a template on its own color", () => {
    const tmpl = fil({ _id: "t", name: "Acme PLA Red", color: "#FF0000", hasVariants: true, spools: [] });
    const other = fil({ _id: "v", parentId: "t", color: "#0000FF" });
    expect(scopeByColorFacet([tmpl, other], "red")).toEqual([]);
    expect(scopeByColorFacet([other, tmpl], { family: "blue", shade: null })).toEqual([other, tmpl]);
  });
});

describe("typeBreakdown", () => {
  it("counts exact types over non-template rows with no facet", () => {
    const list = [
      fil({ type: "PCTG", spools: [] }),
      fil({ type: "PCTG-CF" }),
      fil({ type: "PCTG" }),
      fil({ type: "PLA", hasVariants: true, spools: [] }), // template, skipped
      fil({ type: "" }), // untyped, skipped
      fil({ type: "ABS", spools: [] }),
      fil({ type: "ABS", spools: [] }),
    ];
    expect(typeBreakdown(list)).toEqual([
      { type: "PCTG", inStock: 1, outOfStock: 1 },
      { type: "PCTG-CF", inStock: 1, outOfStock: 0 },
      { type: "ABS", inStock: 0, outOfStock: 2 },
    ]);
  });

  it("orders by in-stock desc, then total desc, then type asc", () => {
    const list = [
      fil({ type: "B" }),
      fil({ type: "A" }),
      fil({ type: "C" }),
      fil({ type: "C", spools: [] }),
      fil({ type: "A" }),
    ];
    expect(typeBreakdown(list).map((t) => t.type)).toEqual(["A", "C", "B"]);
    expect(typeBreakdown([fil({ type: "Z" }), fil({ type: "Y" })]).map((t) => t.type)).toEqual(["Y", "Z"]);
  });

  it("filters by facet and honours a custom stock predicate", () => {
    const list = [
      fil({ type: "PLA", color: "#FF0000" }),
      fil({ type: "PETG", color: "#0000FF" }),
    ];
    expect(typeBreakdown(list, "red", () => false)).toEqual([{ type: "PLA", inStock: 0, outOfStock: 1 }]);
    expect(typeBreakdown(list, "invalid-facet")).toHaveLength(2);
  });
});

describe("relaxColorQuery", () => {
  it("suggests drop-shade, all-materials, then the best adjacent family (same shade)", () => {
    expect(relaxColorQuery(LIBRARY, "blue-light", { typeFilter: "PCTG" })).toEqual([
      { kind: "dropShade", facet: "blue", count: 2 },
      { kind: "allMaterials" },
      { kind: "adjacent", facet: "teal-light", count: 1 },
    ]);
  });

  it("uses the family alone for an unshaded neighbor and skips empty steps", () => {
    // gray-dark neighbors: black (unshaded → "black"), white, brown-dark.
    const list = [
      fil({ name: "Acme Black", color: "#000000" }),
      fil({ name: "Acme Walnut", color: "#5A3A1A" }),
      fil({ name: "Acme Walnut 2", color: "#5A3A1A" }),
    ];
    expect(relaxColorQuery(list, "gray-dark", { typeFilter: "  " })).toEqual([
      { kind: "adjacent", facet: "brown-dark", count: 2 },
    ]);
    // Ties go to COLOR_FAMILIES order.
    expect(relaxColorQuery(list.slice(0, 2), "gray-dark", { typeFilter: "" })).toEqual([
      { kind: "adjacent", facet: "black", count: 1 },
    ]);
  });

  it("applies countRow to every count", () => {
    const list = [fil({ color: "#FF0000", spools: [] }), fil({ color: "#FF0000" })];
    const inStock = (f: ColorClassifiable) => (f.spools?.length ?? 0) > 0;
    expect(relaxColorQuery(list, "pink", { typeFilter: "", countRow: inStock })).toEqual([
      { kind: "adjacent", facet: "red", count: 1 },
    ]);
  });

  it("returns [] when nothing helps or the facet is empty", () => {
    expect(relaxColorQuery(LIBRARY, "purple-dark", { typeFilter: "" })).toEqual([]);
    expect(relaxColorQuery(LIBRARY, "multi", { typeFilter: "" })).toEqual([]);
    expect(relaxColorQuery(LIBRARY, "", { typeFilter: "PLA" })).toEqual([]);
  });
});
