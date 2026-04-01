/**
 * Comprehensive backfill: populate ALL empty fields from curated defaults.
 *
 * Covers:
 *   - optTags (material tags based on type and name keywords)
 *   - colorName (derived from filament name)
 *   - spoolWeight / netFilamentWeight (vendor-specific defaults)
 *   - standby temperature (material-based)
 *   - spoolType (vendor-specific)
 *   - shoreHardnessA/D (for flexible/rigid materials that have them)
 *
 * Safety: ONLY fills fields that are currently null/empty — never overwrites.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/backfill-all-fields.ts [--dry-run]
 */

import mongoose from "mongoose";

const MONGODB_URI: string = (() => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error("Error: MONGODB_URI not set."); process.exit(1); }
  return uri;
})();

const DRY_RUN = process.argv.includes("--dry-run");

// ── OPT_TAG constants (mirrored from openprinttag.ts) ─────────────
const OPT_TAG = {
  CONTAINS_GLASS_FIBER: 0,
  CONTAINS_ARAMID_FIBER: 1,
  TRANSPARENT: 2,
  TRANSLUCENT: 3,
  ABRASIVE: 4,
  FOOD_SAFE: 5,
  HEAT_RESISTANT: 6,
  UV_RESISTANT: 7,
  FLAME_RETARDANT: 8,
  FLEXIBLE: 9,
  CONDUCTIVE: 10,
  MAGNETIC: 11,
  BIODEGRADABLE: 12,
  WATER_SOLUBLE: 13,
  HIGH_IMPACT: 14,
  LOW_WARP: 15,
  MATTE: 16,
  SILK: 17,
  MARBLE: 18,
  WOOD_FILL: 19,
  METAL_FILL: 20,
  STONE_FILL: 21,
  SPARKLE: 22,
  PHOSPHORESCENT: 23,
  GLOW_IN_THE_DARK: 24,
  COLOR_CHANGING: 25,
  FUZZY: 26,
  GRADIENT: 27,
  DUAL_COLOR: 28,
  TRIPLE_COLOR: 29,
  CONTAINS_CARBON_FIBER: 31,
  CONTAINS_KEVLAR: 32,
  HYGROSCOPIC: 33,
  CHEMICALLY_RESISTANT: 36,
  RECYCLED: 49,
  HIGH_SPEED: 71,
} as const;

// ── Material-type → inherent tags ─────────────────────────────────
// Tags that are always true for a given material type.
const MATERIAL_INHERENT_TAGS: Record<string, number[]> = {
  PLA:   [OPT_TAG.LOW_WARP, OPT_TAG.BIODEGRADABLE],
  PETG:  [OPT_TAG.LOW_WARP, OPT_TAG.CHEMICALLY_RESISTANT],
  ABS:   [OPT_TAG.HIGH_IMPACT, OPT_TAG.HEAT_RESISTANT],
  ASA:   [OPT_TAG.UV_RESISTANT, OPT_TAG.HEAT_RESISTANT, OPT_TAG.HIGH_IMPACT],
  PC:    [OPT_TAG.HEAT_RESISTANT, OPT_TAG.HIGH_IMPACT],
  TPU:   [OPT_TAG.FLEXIBLE],
  TPE:   [OPT_TAG.FLEXIBLE],
  TPC:   [OPT_TAG.FLEXIBLE],
  PEBA:  [OPT_TAG.FLEXIBLE],
  HIPS:  [OPT_TAG.HIGH_IMPACT],
  PVA:   [OPT_TAG.WATER_SOLUBLE],
  BVOH:  [OPT_TAG.WATER_SOLUBLE],
  PP:    [OPT_TAG.CHEMICALLY_RESISTANT, OPT_TAG.LOW_WARP, OPT_TAG.FOOD_SAFE],
  POM:   [OPT_TAG.CHEMICALLY_RESISTANT, OPT_TAG.LOW_WARP, OPT_TAG.ABRASIVE],
  PA:    [OPT_TAG.HYGROSCOPIC, OPT_TAG.HIGH_IMPACT],
  PA6:   [OPT_TAG.HYGROSCOPIC, OPT_TAG.HIGH_IMPACT],
  PA12:  [OPT_TAG.HYGROSCOPIC],
  PA66:  [OPT_TAG.HYGROSCOPIC, OPT_TAG.HIGH_IMPACT],
  PPA:   [OPT_TAG.HEAT_RESISTANT, OPT_TAG.HYGROSCOPIC, OPT_TAG.CHEMICALLY_RESISTANT],
  PEI:   [OPT_TAG.HEAT_RESISTANT, OPT_TAG.FLAME_RETARDANT, OPT_TAG.CHEMICALLY_RESISTANT],
  PEEK:  [OPT_TAG.HEAT_RESISTANT, OPT_TAG.CHEMICALLY_RESISTANT],
  PEKK:  [OPT_TAG.HEAT_RESISTANT, OPT_TAG.CHEMICALLY_RESISTANT],
  PVB:   [OPT_TAG.TRANSLUCENT],
  PCTG:  [OPT_TAG.LOW_WARP, OPT_TAG.CHEMICALLY_RESISTANT, OPT_TAG.HIGH_IMPACT],
  PHA:   [OPT_TAG.BIODEGRADABLE],
  IGLIDUR: [OPT_TAG.ABRASIVE, OPT_TAG.CHEMICALLY_RESISTANT, OPT_TAG.LOW_WARP],
};

// ── Name-keyword → additional tags ────────────────────────────────
// Scanned against filament name (case-insensitive).
const KEYWORD_TAGS: [RegExp, number][] = [
  [/\bCF\d*\b|carbon\s*fiber/i, OPT_TAG.CONTAINS_CARBON_FIBER],
  [/\bGF\d*\b|glass\s*fiber/i, OPT_TAG.CONTAINS_GLASS_FIBER],
  [/\bCF\d*\b|carbon\s*fiber/i, OPT_TAG.ABRASIVE],  // CF is abrasive
  [/\bGF\d*\b|glass\s*fiber/i, OPT_TAG.ABRASIVE],   // GF is abrasive
  [/matte/i,                    OPT_TAG.MATTE],
  [/silk/i,                     OPT_TAG.SILK],
  [/marble/i,                   OPT_TAG.MARBLE],
  [/wood/i,                     OPT_TAG.WOOD_FILL],
  [/metal/i,                    OPT_TAG.METAL_FILL],
  [/stone|mineral/i,            OPT_TAG.STONE_FILL],
  [/sparkle|glitter/i,          OPT_TAG.SPARKLE],
  [/glow/i,                     OPT_TAG.GLOW_IN_THE_DARK],
  [/phosphor/i,                 OPT_TAG.PHOSPHORESCENT],
  [/color.?chang/i,             OPT_TAG.COLOR_CHANGING],
  [/fuzzy|fur/i,                OPT_TAG.FUZZY],
  [/gradient|rainbow/i,         OPT_TAG.GRADIENT],
  [/dual.?color/i,              OPT_TAG.DUAL_COLOR],
  [/triple.?color|tri.?color/i, OPT_TAG.TRIPLE_COLOR],
  [/recycl/i,                   OPT_TAG.RECYCLED],
  [/high.?speed|HS\b/i,        OPT_TAG.HIGH_SPEED],
  [/kevlar|aramid/i,            OPT_TAG.CONTAINS_KEVLAR],
  [/transparent|clear/i,        OPT_TAG.TRANSPARENT],
  [/translucent/i,              OPT_TAG.TRANSLUCENT],
  [/flex/i,                     OPT_TAG.FLEXIBLE],
  [/ESD/i,                      OPT_TAG.CONDUCTIVE],
];

// ── Type aliases ──────────────────────────────────────────────────
const TYPE_ALIASES: Record<string, string> = {
  "PLA+": "PLA",
  "PLA-CF": "PLA",
  "PETG-CF": "PETG",
  "PET-GF": "PETG",
  "ABS-CF": "ABS",
  "ASA-CF": "ASA",
  "PC-CF": "PC",
  PA: "PA6",
  NYLON: "PA6",
  "PA-CF": "PA6",
  "NYLON-CF": "PA6",
  FLEX: "TPU",
  IGLIDUR: "IGLIDUR",
};

function resolveBaseType(type: string): string {
  const key = type.toUpperCase().replace(/\s+/g, "");
  if (MATERIAL_INHERENT_TAGS[key]) return key;
  if (TYPE_ALIASES[key] && MATERIAL_INHERENT_TAGS[TYPE_ALIASES[key]]) return TYPE_ALIASES[key];
  return key;
}

// ── Determine tags for a filament ─────────────────────────────────
function computeTags(name: string, type: string): number[] {
  const tags = new Set<number>();

  // Material-inherent tags
  const base = resolveBaseType(type);
  const inherent = MATERIAL_INHERENT_TAGS[base];
  if (inherent) inherent.forEach((t) => tags.add(t));

  // Type-derived tags for composites
  const typeKey = type.toUpperCase().replace(/\s+/g, "");
  if (typeKey.includes("CF") || typeKey.includes("CARBON")) {
    tags.add(OPT_TAG.CONTAINS_CARBON_FIBER);
    tags.add(OPT_TAG.ABRASIVE);
  }
  if (typeKey.includes("GF") || typeKey.includes("GLASS")) {
    tags.add(OPT_TAG.CONTAINS_GLASS_FIBER);
    tags.add(OPT_TAG.ABRASIVE);
  }

  // Name-keyword tags
  for (const [regex, tag] of KEYWORD_TAGS) {
    if (regex.test(name)) tags.add(tag);
  }

  return [...tags].sort((a, b) => a - b);
}

// ── Color name extraction from filament name ──────────────────────
// Strips known vendor/material prefixes and suffixes to extract color.
function extractColorName(name: string, vendor: string, type: string): string | null {
  let colorName = name;

  // Remove vendor name
  const vendorWords = vendor.split(/\s+/);
  for (const word of vendorWords) {
    colorName = colorName.replace(new RegExp(`\\b${escapeRegex(word)}\\b`, "gi"), "");
  }

  // Remove known brand names
  const brands = [
    "Prusament", "Prusa", "Overture", "Polymaker", "SirayaTech", "Siraya Tech",
    "3D-Fuel", "3DFuel", "Sunlu", "SunLu", "Yousu", "Gizmo Dorks", "GizmoDorks",
    "Generic", "Fiberon", "Fibreheart", "kexcelled", "igus", "iglidur",
  ];
  for (const brand of brands) {
    colorName = colorName.replace(new RegExp(`\\b${escapeRegex(brand)}\\b`, "gi"), "");
  }

  // Remove material type and variants
  const materialTypes = [
    type,
    ...type.split("-"),
    "PLA", "PETG", "PCTG", "ABS", "ASA", "PC", "TPU", "HIPS", "PVA", "PVB",
    "PA6", "PA", "PP", "POM", "PPA", "PEI", "PEEK", "PEBA", "PET-GF", "CF",
    "CF20", "Blend", "Easy", "Flex", "Air", "MultiMaterial",
  ];
  for (const mt of materialTypes) {
    colorName = colorName.replace(new RegExp(`\\b${escapeRegex(mt)}\\b`, "gi"), "");
  }

  // Remove weight/version suffixes like "500g", "1kg", "v1", "- v1"
  colorName = colorName.replace(/\b\d+g\b/gi, "");
  colorName = colorName.replace(/\b\d+kg\b/gi, "");
  colorName = colorName.replace(/[-–]\s*v\d+/gi, "");
  colorName = colorName.replace(/\bv\d+\b/gi, "");

  // Remove "The K8" prefix
  colorName = colorName.replace(/\bThe\s+K8\b/gi, "");

  // Remove model numbers / hardness specs (e.g. "64D", "i150", "CF20")
  colorName = colorName.replace(/\b\d+[A-D]\b/g, "");
  colorName = colorName.replace(/\bi\d+\b/gi, "");
  colorName = colorName.replace(/\bCF\d+\b/gi, "");

  // Clean up
  colorName = colorName.replace(/[®™]/g, "");
  colorName = colorName.replace(/\s*[-–—]\s*/g, " ");
  colorName = colorName.trim().replace(/\s+/g, " ");

  return colorName.length > 0 ? colorName : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Vendor-specific spool defaults ────────────────────────────────
interface SpoolDefaults {
  spoolWeight: number;
  netFilamentWeight: number;
  spoolType: string;
}

const VENDOR_SPOOL_DEFAULTS: Record<string, SpoolDefaults> = {
  "Prusa Polymers":  { spoolWeight: 186, netFilamentWeight: 1000, spoolType: "Prusament Reusable" },
  "Prusa Research":  { spoolWeight: 186, netFilamentWeight: 1000, spoolType: "Prusament Reusable" },
  "Prusa":           { spoolWeight: 186, netFilamentWeight: 1000, spoolType: "Prusament Reusable" },
  "Prusament":       { spoolWeight: 186, netFilamentWeight: 1000, spoolType: "Prusament Reusable" },
  "Overture":        { spoolWeight: 230, netFilamentWeight: 1000, spoolType: "Cardboard" },
  "3D-Fuel":         { spoolWeight: 240, netFilamentWeight: 750,  spoolType: "Cardboard" },
  "Polymaker":       { spoolWeight: 180, netFilamentWeight: 750,  spoolType: "Plastic" },
  "Filatech":        { spoolWeight: 250, netFilamentWeight: 1000, spoolType: "Plastic" },
  "SirayaTech":      { spoolWeight: 250, netFilamentWeight: 750,  spoolType: "Plastic" },
  "SunLu":           { spoolWeight: 250, netFilamentWeight: 1000, spoolType: "Plastic" },
  "Yousu":           { spoolWeight: 250, netFilamentWeight: 1000, spoolType: "Plastic" },
  "Gizmo Dorks":     { spoolWeight: 250, netFilamentWeight: 1000, spoolType: "Plastic" },
  "Generic":         { spoolWeight: 250, netFilamentWeight: 1000, spoolType: "Plastic" },
  "kexcelled":       { spoolWeight: 250, netFilamentWeight: 1000, spoolType: "Plastic" },
  "igus":            { spoolWeight: 250, netFilamentWeight: 750,  spoolType: "Plastic" },
};

// ── Standby temperature defaults (material-based) ─────────────────
const STANDBY_TEMP: Record<string, number> = {
  PLA:  170,
  PETG: 170,
  PCTG: 170,
  ABS:  170,
  ASA:  170,
  PC:   200,
  TPU:  170,
  TPE:  170,
  PEBA: 170,
  PA:   200,
  PA6:  200,
  PA12: 200,
  PP:   170,
  POM:  170,
  HIPS: 170,
  PVA:  170,
  PVB:  170,
  PPA:  200,
  PEI:  250,
  PEEK: 280,
};

// ── Main ──────────────────────────────────────────────────────────

interface FilamentDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
  vendor: string;
  type: string;
  color: string;
  colorName: string | null;
  spoolWeight: number | null;
  netFilamentWeight: number | null;
  spoolType: string | null;
  optTags: number[];
  shoreHardnessA: number | null;
  shoreHardnessD: number | null;
  temperatures?: {
    standby?: number | null;
  };
}

async function main() {
  console.log(`\n🔧 Comprehensive Field Backfill${DRY_RUN ? " (DRY RUN)" : ""}\n`);
  console.log(`Connecting to: ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db!;
  const collection = db.collection("filaments");

  const filaments = await collection
    .find<FilamentDoc>({ _deletedAt: null })
    .project({
      name: 1, vendor: 1, type: 1, color: 1, colorName: 1,
      spoolWeight: 1, netFilamentWeight: 1, spoolType: 1,
      optTags: 1, shoreHardnessA: 1, shoreHardnessD: 1,
      temperatures: 1,
    })
    .toArray();

  console.log(`Found ${filaments.length} filaments\n`);

  let updated = 0;
  let skippedAlreadySet = 0;

  for (const doc of filaments) {
    const $set: Record<string, unknown> = {};
    const details: string[] = [];

    // ── optTags ──
    if (!doc.optTags || doc.optTags.length === 0) {
      const tags = computeTags(doc.name, doc.type);
      if (tags.length > 0) {
        $set.optTags = tags;
        details.push(`optTags=[${tags.join(",")}]`);
      }
    }

    // ── colorName ──
    if (!doc.colorName) {
      const cn = extractColorName(doc.name, doc.vendor, doc.type);
      if (cn) {
        $set.colorName = cn;
        details.push(`colorName="${cn}"`);
      }
    }

    // ── spoolWeight / netFilamentWeight / spoolType from vendor defaults ──
    const vendorDefaults = VENDOR_SPOOL_DEFAULTS[doc.vendor];
    if (vendorDefaults) {
      if (doc.spoolWeight == null) {
        $set.spoolWeight = vendorDefaults.spoolWeight;
        details.push(`spoolWeight=${vendorDefaults.spoolWeight}`);
      }
      if (doc.netFilamentWeight == null) {
        // Check if name contains weight hint
        let netWeight = vendorDefaults.netFilamentWeight;
        const nameMatch = doc.name.match(/(\d+)\s*g\b/i);
        const kgMatch = doc.name.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
        if (nameMatch) {
          netWeight = parseInt(nameMatch[1]);
        } else if (kgMatch) {
          netWeight = parseFloat(kgMatch[1]) * 1000;
        }
        $set.netFilamentWeight = netWeight;
        details.push(`netFilamentWeight=${netWeight}`);
      }
      if (!doc.spoolType) {
        $set.spoolType = vendorDefaults.spoolType;
        details.push(`spoolType="${vendorDefaults.spoolType}"`);
      }
    } else if (!doc.spoolType) {
      $set.spoolType = "Plastic";
      details.push(`spoolType="Plastic"`);
    }

    // ── standby temperature ──
    if (doc.temperatures?.standby == null) {
      const baseType = resolveBaseType(doc.type);
      const standby = STANDBY_TEMP[baseType];
      if (standby) {
        $set["temperatures.standby"] = standby;
        details.push(`standby=${standby}`);
      }
    }

    // ── shore hardness for flexible types (TPU: 95A default already set by previous backfill, but
    //    we add Shore D for specific filaments) ──
    // SirayaTech TPU 64D: name says "64D"
    if (doc.shoreHardnessD == null) {
      const dMatch = doc.name.match(/(\d+)\s*D\b/);
      if (dMatch && parseInt(dMatch[1]) >= 30 && parseInt(dMatch[1]) <= 100) {
        $set.shoreHardnessD = parseInt(dMatch[1]);
        details.push(`shoreHardnessD=${dMatch[1]}`);
      }
    }

    if (Object.keys($set).length === 0) {
      skippedAlreadySet++;
      continue;
    }

    console.log(`  ✓ ${doc.name}`);
    for (const d of details) {
      console.log(`      ${d}`);
    }

    if (!DRY_RUN) {
      await collection.updateOne({ _id: doc._id }, { $set });
    }
    updated++;
  }

  console.log(`\n─── Summary ───`);
  console.log(`  Total filaments: ${filaments.length}`);
  console.log(`  Updated:         ${updated}`);
  console.log(`  Already set:     ${skippedAlreadySet}`);

  if (DRY_RUN) {
    console.log(`\n  (dry run — no changes written)\n`);
  } else {
    console.log();
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
