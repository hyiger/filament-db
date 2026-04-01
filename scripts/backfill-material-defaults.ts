/**
 * Backfill material properties from curated defaults.
 *
 * Populates null/missing fields (glassTempTransition, heatDeflectionTemp,
 * density, dryingTemperature, dryingTime, shoreHardnessA/D, minPrintSpeed,
 * maxPrintSpeed, nozzle temp ranges) based on material type.
 *
 * Safety: ONLY fills fields that are currently null — never overwrites
 * user-entered data.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/backfill-material-defaults.ts [--dry-run]
 */

import mongoose from "mongoose";

const MONGODB_URI: string = (() => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("Error: MONGODB_URI environment variable is not set.");
    process.exit(1);
  }
  return uri;
})();

const DRY_RUN = process.argv.includes("--dry-run");

// ── Material defaults lookup table ─────────────────────────────────
// Sources: manufacturer TDS sheets, MatWeb, material science references.
// Tg and HDT are inherent to the polymer. Drying, speed, and nozzle
// ranges are conservative industry defaults.

interface MaterialDefaults {
  glassTempTransition: number | null;  // °C
  heatDeflectionTemp: number | null;   // °C (at 0.45 MPa)
  density: number;                      // g/cm³
  dryingTemperature: number;            // °C
  dryingTime: number;                   // minutes
  shoreHardnessA: number | null;
  shoreHardnessD: number | null;
  minPrintSpeed: number;                // mm/s
  maxPrintSpeed: number;                // mm/s
  nozzleRangeMin: number;               // °C
  nozzleRangeMax: number;               // °C
}

const MATERIAL_DEFAULTS: Record<string, MaterialDefaults> = {
  // ── Tier 1: Common materials ─────────────────────────────────────
  PLA: {
    glassTempTransition: 60,
    heatDeflectionTemp: 55,
    density: 1.24,
    dryingTemperature: 45,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 100,
    nozzleRangeMin: 190,
    nozzleRangeMax: 230,
  },
  PETG: {
    glassTempTransition: 80,
    heatDeflectionTemp: 70,
    density: 1.27,
    dryingTemperature: 65,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 80,
    nozzleRangeMin: 220,
    nozzleRangeMax: 250,
  },
  ABS: {
    glassTempTransition: 105,
    heatDeflectionTemp: 90,
    density: 1.04,
    dryingTemperature: 65,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 80,
    nozzleRangeMin: 230,
    nozzleRangeMax: 260,
  },
  ASA: {
    glassTempTransition: 105,
    heatDeflectionTemp: 90,
    density: 1.07,
    dryingTemperature: 65,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 80,
    nozzleRangeMin: 235,
    nozzleRangeMax: 260,
  },
  PC: {
    glassTempTransition: 147,
    heatDeflectionTemp: 130,
    density: 1.20,
    dryingTemperature: 80,
    dryingTime: 480,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 60,
    nozzleRangeMin: 260,
    nozzleRangeMax: 300,
  },
  TPU: {
    glassTempTransition: null,
    heatDeflectionTemp: null,
    density: 1.21,
    dryingTemperature: 60,
    dryingTime: 240,
    shoreHardnessA: 95,
    shoreHardnessD: null,
    minPrintSpeed: 15,
    maxPrintSpeed: 40,
    nozzleRangeMin: 210,
    nozzleRangeMax: 240,
  },
  HIPS: {
    glassTempTransition: 100,
    heatDeflectionTemp: 80,
    density: 1.05,
    dryingTemperature: 60,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 80,
    nozzleRangeMin: 220,
    nozzleRangeMax: 250,
  },
  PVA: {
    glassTempTransition: null,
    heatDeflectionTemp: null,
    density: 1.23,
    dryingTemperature: 45,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 40,
    nozzleRangeMin: 185,
    nozzleRangeMax: 210,
  },
  PVB: {
    glassTempTransition: 65,
    heatDeflectionTemp: null,
    density: 1.08,
    dryingTemperature: 50,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 60,
    nozzleRangeMin: 200,
    nozzleRangeMax: 230,
  },

  // ── Tier 2: Engineering materials ────────────────────────────────
  PCTG: {
    glassTempTransition: 84,
    heatDeflectionTemp: 70,
    density: 1.23,
    dryingTemperature: 65,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 80,
    nozzleRangeMin: 230,
    nozzleRangeMax: 260,
  },
  PA6: {
    glassTempTransition: 47,
    heatDeflectionTemp: 65,
    density: 1.14,
    dryingTemperature: 80,
    dryingTime: 480,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 60,
    nozzleRangeMin: 240,
    nozzleRangeMax: 270,
  },
  PA11: {
    glassTempTransition: 46,
    heatDeflectionTemp: 55,
    density: 1.04,
    dryingTemperature: 80,
    dryingTime: 480,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 60,
    nozzleRangeMin: 235,
    nozzleRangeMax: 260,
  },
  PA12: {
    glassTempTransition: 42,
    heatDeflectionTemp: 55,
    density: 1.02,
    dryingTemperature: 80,
    dryingTime: 480,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 60,
    nozzleRangeMin: 235,
    nozzleRangeMax: 265,
  },
  PA66: {
    glassTempTransition: 50,
    heatDeflectionTemp: 70,
    density: 1.14,
    dryingTemperature: 80,
    dryingTime: 480,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 60,
    nozzleRangeMin: 250,
    nozzleRangeMax: 280,
  },
  PP: {
    glassTempTransition: -10,
    heatDeflectionTemp: 60,
    density: 0.90,
    dryingTemperature: 55,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 60,
    nozzleRangeMin: 220,
    nozzleRangeMax: 250,
  },
  CPE: {
    glassTempTransition: 80,
    heatDeflectionTemp: 70,
    density: 1.25,
    dryingTemperature: 65,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 70,
    nozzleRangeMin: 240,
    nozzleRangeMax: 270,
  },
  TPE: {
    glassTempTransition: null,
    heatDeflectionTemp: null,
    density: 1.15,
    dryingTemperature: 55,
    dryingTime: 240,
    shoreHardnessA: 85,
    shoreHardnessD: null,
    minPrintSpeed: 15,
    maxPrintSpeed: 35,
    nozzleRangeMin: 200,
    nozzleRangeMax: 240,
  },
  TPC: {
    glassTempTransition: null,
    heatDeflectionTemp: null,
    density: 1.14,
    dryingTemperature: 60,
    dryingTime: 240,
    shoreHardnessA: 90,
    shoreHardnessD: null,
    minPrintSpeed: 15,
    maxPrintSpeed: 40,
    nozzleRangeMin: 210,
    nozzleRangeMax: 240,
  },
  PEBA: {
    glassTempTransition: null,
    heatDeflectionTemp: null,
    density: 1.01,
    dryingTemperature: 60,
    dryingTime: 240,
    shoreHardnessA: 85,
    shoreHardnessD: null,
    minPrintSpeed: 15,
    maxPrintSpeed: 40,
    nozzleRangeMin: 220,
    nozzleRangeMax: 250,
  },
  POM: {
    glassTempTransition: -60,
    heatDeflectionTemp: 110,
    density: 1.41,
    dryingTemperature: 80,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 60,
    nozzleRangeMin: 195,
    nozzleRangeMax: 230,
  },
  PPA: {
    glassTempTransition: 125,
    heatDeflectionTemp: 100,
    density: 1.13,
    dryingTemperature: 80,
    dryingTime: 480,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 60,
    nozzleRangeMin: 280,
    nozzleRangeMax: 320,
  },

  // ── Tier 3: High-performance ─────────────────────────────────────
  PEI: {
    glassTempTransition: 217,
    heatDeflectionTemp: 190,
    density: 1.27,
    dryingTemperature: 120,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 40,
    nozzleRangeMin: 340,
    nozzleRangeMax: 380,
  },
  PEEK: {
    glassTempTransition: 143,
    heatDeflectionTemp: 250,
    density: 1.30,
    dryingTemperature: 150,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 40,
    nozzleRangeMin: 360,
    nozzleRangeMax: 420,
  },
  PEKK: {
    glassTempTransition: 160,
    heatDeflectionTemp: 220,
    density: 1.30,
    dryingTemperature: 150,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 40,
    nozzleRangeMin: 340,
    nozzleRangeMax: 400,
  },
  PPS: {
    glassTempTransition: 90,
    heatDeflectionTemp: 200,
    density: 1.35,
    dryingTemperature: 120,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 40,
    nozzleRangeMin: 290,
    nozzleRangeMax: 330,
  },
  PPSU: {
    glassTempTransition: 220,
    heatDeflectionTemp: 207,
    density: 1.29,
    dryingTemperature: 120,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 40,
    nozzleRangeMin: 340,
    nozzleRangeMax: 380,
  },
  PSU: {
    glassTempTransition: 190,
    heatDeflectionTemp: 174,
    density: 1.24,
    dryingTemperature: 100,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 40,
    nozzleRangeMin: 330,
    nozzleRangeMax: 370,
  },
  PBT: {
    glassTempTransition: 55,
    heatDeflectionTemp: 60,
    density: 1.31,
    dryingTemperature: 80,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 60,
    nozzleRangeMin: 230,
    nozzleRangeMax: 260,
  },
  PVDF: {
    glassTempTransition: -38,
    heatDeflectionTemp: 90,
    density: 1.78,
    dryingTemperature: 80,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 50,
    nozzleRangeMin: 230,
    nozzleRangeMax: 270,
  },
  PMMA: {
    glassTempTransition: 105,
    heatDeflectionTemp: 95,
    density: 1.18,
    dryingTemperature: 70,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 50,
    nozzleRangeMin: 235,
    nozzleRangeMax: 260,
  },

  // ── Tier 4: Specialty ────────────────────────────────────────────
  PET: {
    glassTempTransition: 75,
    heatDeflectionTemp: 65,
    density: 1.38,
    dryingTemperature: 65,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 70,
    nozzleRangeMin: 220,
    nozzleRangeMax: 250,
  },
  PHA: {
    glassTempTransition: 5,
    heatDeflectionTemp: null,
    density: 1.25,
    dryingTemperature: 50,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 60,
    nozzleRangeMin: 180,
    nozzleRangeMax: 220,
  },
  BVOH: {
    glassTempTransition: null,
    heatDeflectionTemp: null,
    density: 1.14,
    dryingTemperature: 50,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 40,
    nozzleRangeMin: 195,
    nozzleRangeMax: 220,
  },
  PCL: {
    glassTempTransition: -60,
    heatDeflectionTemp: null,
    density: 1.15,
    dryingTemperature: 45,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 40,
    nozzleRangeMin: 60,
    nozzleRangeMax: 100,
  },
  PS: {
    glassTempTransition: 100,
    heatDeflectionTemp: 85,
    density: 1.05,
    dryingTemperature: 60,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 30,
    maxPrintSpeed: 70,
    nozzleRangeMin: 220,
    nozzleRangeMax: 250,
  },
  SBS: {
    glassTempTransition: null,
    heatDeflectionTemp: null,
    density: 0.94,
    dryingTemperature: 50,
    dryingTime: 240,
    shoreHardnessA: 75,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 50,
    nozzleRangeMin: 210,
    nozzleRangeMax: 240,
  },
  EVA: {
    glassTempTransition: null,
    heatDeflectionTemp: null,
    density: 0.93,
    dryingTemperature: 50,
    dryingTime: 240,
    shoreHardnessA: 80,
    shoreHardnessD: null,
    minPrintSpeed: 15,
    maxPrintSpeed: 40,
    nozzleRangeMin: 180,
    nozzleRangeMax: 220,
  },
  PVC: {
    glassTempTransition: 80,
    heatDeflectionTemp: 65,
    density: 1.40,
    dryingTemperature: 60,
    dryingTime: 240,
    shoreHardnessA: null,
    shoreHardnessD: null,
    minPrintSpeed: 20,
    maxPrintSpeed: 50,
    nozzleRangeMin: 170,
    nozzleRangeMax: 210,
  },
};

// ── Type normalization ─────────────────────────────────────────────
// Maps composite/alias type strings to their base material.
// Same logic as MATERIAL_TYPE_MAP in openprinttag.ts.

const TYPE_ALIASES: Record<string, string> = {
  "PLA+": "PLA",
  "PLA-CF": "PLA",
  "PETG-CF": "PETG",
  "PET-GF": "PET",
  "ABS-CF": "ABS",
  "ASA-CF": "ASA",
  "PC-CF": "PC",
  PA: "PA6",
  NYLON: "PA6",
  "PA-CF": "PA6",
  "NYLON-CF": "PA6",
  FLEX: "TPU",
  IGLIDUR: "POM",
};

function resolveBaseType(type: string): string | null {
  const key = type.toUpperCase().replace(/\s+/g, "");
  if (MATERIAL_DEFAULTS[key]) return key;
  if (TYPE_ALIASES[key] && MATERIAL_DEFAULTS[TYPE_ALIASES[key]]) return TYPE_ALIASES[key];
  return null;
}

// ── Main ───────────────────────────────────────────────────────────

interface FilamentDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
  type: string;
  density: number | null;
  dryingTemperature: number | null;
  dryingTime: number | null;
  glassTempTransition: number | null;
  heatDeflectionTemp: number | null;
  shoreHardnessA: number | null;
  shoreHardnessD: number | null;
  minPrintSpeed: number | null;
  maxPrintSpeed: number | null;
  temperatures?: {
    nozzleRangeMin?: number | null;
    nozzleRangeMax?: number | null;
  };
}

async function main() {
  console.log(`\n🔧 Backfill Material Defaults${DRY_RUN ? " (DRY RUN)" : ""}\n`);
  console.log(`Connecting to: ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db!;
  const collection = db.collection("filaments");

  const filaments = await collection
    .find<FilamentDoc>({ _deletedAt: null })
    .project({
      name: 1,
      type: 1,
      density: 1,
      dryingTemperature: 1,
      dryingTime: 1,
      glassTempTransition: 1,
      heatDeflectionTemp: 1,
      shoreHardnessA: 1,
      shoreHardnessD: 1,
      minPrintSpeed: 1,
      maxPrintSpeed: 1,
      temperatures: 1,
    })
    .toArray();

  console.log(`Found ${filaments.length} filaments\n`);

  let updated = 0;
  let skippedNoMatch = 0;
  let skippedAlreadySet = 0;

  for (const doc of filaments) {
    const baseType = resolveBaseType(doc.type);
    if (!baseType) {
      console.log(`  ⚠ Skip "${doc.name}" — unknown type "${doc.type}"`);
      skippedNoMatch++;
      continue;
    }

    const defaults = MATERIAL_DEFAULTS[baseType];
    const $set: Record<string, number> = {};

    if (doc.glassTempTransition == null && defaults.glassTempTransition != null) {
      $set.glassTempTransition = defaults.glassTempTransition;
    }
    if (doc.heatDeflectionTemp == null && defaults.heatDeflectionTemp != null) {
      $set.heatDeflectionTemp = defaults.heatDeflectionTemp;
    }
    if (doc.density == null) {
      $set.density = defaults.density;
    }
    if (doc.dryingTemperature == null) {
      $set.dryingTemperature = defaults.dryingTemperature;
    }
    if (doc.dryingTime == null) {
      $set.dryingTime = defaults.dryingTime;
    }
    if (doc.shoreHardnessA == null && defaults.shoreHardnessA != null) {
      $set.shoreHardnessA = defaults.shoreHardnessA;
    }
    if (doc.shoreHardnessD == null && defaults.shoreHardnessD != null) {
      $set.shoreHardnessD = defaults.shoreHardnessD;
    }
    if (doc.minPrintSpeed == null) {
      $set.minPrintSpeed = defaults.minPrintSpeed;
    }
    if (doc.maxPrintSpeed == null) {
      $set.maxPrintSpeed = defaults.maxPrintSpeed;
    }
    if (doc.temperatures?.nozzleRangeMin == null) {
      $set["temperatures.nozzleRangeMin"] = defaults.nozzleRangeMin;
    }
    if (doc.temperatures?.nozzleRangeMax == null) {
      $set["temperatures.nozzleRangeMax"] = defaults.nozzleRangeMax;
    }

    if (Object.keys($set).length === 0) {
      skippedAlreadySet++;
      continue;
    }

    const fields = Object.keys($set).map((k) => k.replace("temperatures.", "")).join(", ");
    console.log(`  ✓ ${doc.name} (${doc.type} → ${baseType}): ${fields}`);

    if (!DRY_RUN) {
      await collection.updateOne({ _id: doc._id }, { $set });
    }
    updated++;
  }

  console.log(`\n─── Summary ───`);
  console.log(`  Total filaments: ${filaments.length}`);
  console.log(`  Updated:         ${updated}`);
  console.log(`  Already set:     ${skippedAlreadySet}`);
  console.log(`  Unknown type:    ${skippedNoMatch}`);

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
