import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";
import { parseIniFilaments } from "../src/lib/parseIni";

const MONGODB_URI: string = (() => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("Error: MONGODB_URI environment variable is not set.");
    console.error("Set it in .env.local or pass it inline: MONGODB_URI=... npx tsx scripts/seed.ts");
    process.exit(1);
  }
  return uri;
})();

interface NozzleSpec {
  diameter: number;
  highFlow: boolean;
}

function parseNozzleSpecs(condition: string | null): NozzleSpec[] {
  if (!condition) return [];

  const specs: NozzleSpec[] = [];

  // Extract nozzle_diameter values
  const diameterMatches = condition.matchAll(/nozzle_diameter\[0\]\s*==\s*([\d.]+)/g);
  for (const match of diameterMatches) {
    const diameter = parseFloat(match[1]);
    // Check high-flow status
    const hasHighFlow = /nozzle_high_flow\[0\]/.test(condition);
    const isNotHighFlow = /!\s*nozzle_high_flow\[0\]/.test(condition);

    if (hasHighFlow && !isNotHighFlow) {
      specs.push({ diameter, highFlow: true });
    } else if (isNotHighFlow) {
      specs.push({ diameter, highFlow: false });
    } else {
      // No high-flow constraint — add standard
      specs.push({ diameter, highFlow: false });
    }
  }

  // If no specific diameter match, check for != patterns (means "any except those")
  if (specs.length === 0) {
    const defaultDiameters = [0.25, 0.4, 0.6, 0.8];
    const excludeMatches = condition.matchAll(/nozzle_diameter\[0\]\s*!=\s*([\d.]+)/g);
    const excluded = new Set<number>();
    for (const match of excludeMatches) {
      excluded.add(parseFloat(match[1]));
    }
    if (excluded.size > 0) {
      const isNotHighFlow = /!\s*nozzle_high_flow\[0\]/.test(condition);
      for (const d of defaultDiameters) {
        if (!excluded.has(d)) {
          specs.push({ diameter: d, highFlow: isNotHighFlow ? false : false });
        }
      }
    }
  }

  return specs;
}

function nozzleName(spec: NozzleSpec): string {
  return `${spec.diameter}mm${spec.highFlow ? " HF" : ""}`;
}

async function seed() {
  const iniPath =
    process.argv[2] ||
    path.join(process.env.HOME || "/Users/rlewis", "Downloads", "PrusaSlicer_config_bundle.ini");

  console.log(`Reading INI file: ${iniPath}`);
  const content = fs.readFileSync(iniPath, "utf-8");

  const filaments = parseIniFilaments(content);
  console.log(`Parsed ${filaments.length} filament profiles`);

  console.log("Connecting to MongoDB Atlas...");
  await mongoose.connect(MONGODB_URI);

  // Define schemas inline
  const NozzleSchema = new mongoose.Schema(
    {
      name: { type: String, required: true, unique: true, index: true },
      diameter: { type: Number, required: true, index: true },
      type: { type: String, required: true, index: true },
      highFlow: { type: Boolean, default: false },
      notes: { type: String, default: "" },
    },
    { timestamps: true }
  );

  const FilamentSchema = new mongoose.Schema(
    {
      name: { type: String, required: true, unique: true, index: true },
      vendor: { type: String, required: true, index: true },
      type: { type: String, required: true, index: true },
      color: { type: String, default: "#808080" },
      cost: { type: Number, default: null },
      density: { type: Number, default: null },
      diameter: { type: Number, default: 1.75 },
      temperatures: {
        nozzle: { type: Number, default: null },
        nozzleFirstLayer: { type: Number, default: null },
        bed: { type: Number, default: null },
        bedFirstLayer: { type: Number, default: null },
      },
      maxVolumetricSpeed: { type: Number, default: null },
      compatibleNozzles: [{ type: mongoose.Schema.Types.ObjectId, ref: "Nozzle" }],
      inherits: { type: String, default: null },
      settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
  );

  const Nozzle = mongoose.models.Nozzle || mongoose.model("Nozzle", NozzleSchema);
  const Filament = mongoose.models.Filament || mongoose.model("Filament", FilamentSchema);

  // Collect all unique nozzle specs from filaments
  const nozzleMap = new Map<string, NozzleSpec>();
  const filamentNozzleMap = new Map<string, string[]>();

  for (const filament of filaments) {
    const condition = filament.settings.compatible_printers_condition;
    const specs = parseNozzleSpecs(condition ?? null);
    const nozzleNames: string[] = [];
    for (const spec of specs) {
      const name = nozzleName(spec);
      nozzleMap.set(name, spec);
      nozzleNames.push(name);
    }
    filamentNozzleMap.set(filament.name, nozzleNames);
  }

  // Upsert nozzles
  console.log(`\nFound ${nozzleMap.size} unique nozzle configurations:`);
  const nozzleIdMap = new Map<string, mongoose.Types.ObjectId>();

  for (const [name, spec] of nozzleMap) {
    const nozzle = await Nozzle.findOneAndUpdate(
      { name },
      { name, diameter: spec.diameter, type: "Brass", highFlow: spec.highFlow },
      { upsert: true, new: true, returnDocument: "after" }
    );
    nozzleIdMap.set(name, nozzle._id);
    console.log(`  ✓ ${name} (${spec.diameter}mm, ${spec.highFlow ? "high-flow" : "standard"})`);
  }

  // Upsert filaments with nozzle references
  console.log(`\nImporting filaments:`);
  for (const filament of filaments) {
    const nozzleNames = filamentNozzleMap.get(filament.name) || [];
    const nozzleIds = nozzleNames
      .map((n) => nozzleIdMap.get(n))
      .filter(Boolean);

    await Filament.findOneAndUpdate(
      { name: filament.name },
      { ...filament, compatibleNozzles: nozzleIds },
      { upsert: true, new: true, returnDocument: "after" }
    );

    const nozzleInfo = nozzleNames.length > 0 ? ` [${nozzleNames.join(", ")}]` : "";
    console.log(`  ✓ ${filament.name} (${filament.vendor} - ${filament.type})${nozzleInfo}`);
  }

  console.log(`\nSeeded ${filaments.length} filaments and ${nozzleMap.size} nozzles successfully!`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
