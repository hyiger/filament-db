/**
 * Migration script: Consolidate duplicate filaments into single entries.
 *
 * Handles three patterns:
 *   1. Nozzle diameter suffix: "Prusament ASA 0.4" → "Prusament ASA" with 0.4mm nozzle calibration
 *   2. HF suffix: "Gizmo Dorks POM" + "Gizmo Dorks POM HF" → single entry with both nozzle types
 *   3. Shore hardness (PEBA): "Siraya Tech Flex PEBA Air 70A/74A/..." → single entry with presets
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/merge-filaments.ts [--dry-run]
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

interface NozzleDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
  diameter: number;
  highFlow: boolean;
}

interface FilamentDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
  vendor: string;
  type: string;
  color: string;
  cost: number | null;
  density: number | null;
  diameter: number;
  temperatures: {
    nozzle: number | null;
    nozzleFirstLayer: number | null;
    bed: number | null;
    bedFirstLayer: number | null;
  };
  maxVolumetricSpeed: number | null;
  compatibleNozzles: mongoose.Types.ObjectId[];
  calibrations: {
    nozzle: mongoose.Types.ObjectId;
    extrusionMultiplier: number | null;
    maxVolumetricSpeed: number | null;
    pressureAdvance: number | null;
    retractLength: number | null;
    retractSpeed: number | null;
    retractLift: number | null;
  }[];
  presets?: {
    label: string;
    extrusionMultiplier: number | null;
    temperatures: {
      nozzle: number | null;
      nozzleFirstLayer: number | null;
      bed: number | null;
      bedFirstLayer: number | null;
    };
  }[];
  tdsUrl: string | null;
  inherits: string | null;
  parentId: mongoose.Types.ObjectId | null;
  settings: Record<string, string | null>;
}

// ── Helpers ──────────────────────────────────────────────────

function extractPA(settings: Record<string, string | null>): number | null {
  const gcode = settings?.start_filament_gcode;
  if (!gcode) return null;
  const match = gcode.match(/M572\s+S([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

function extractEM(settings: Record<string, string | null>): number | null {
  const val = settings?.extrusion_multiplier;
  if (!val || val === "nil") return null;
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

function extractRetract(settings: Record<string, string | null>) {
  const parseOrNull = (v: string | null | undefined) => {
    if (!v || v === "nil") return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };
  return {
    retractLength: parseOrNull(settings?.filament_retract_length),
    retractSpeed: parseOrNull(settings?.filament_retract_speed),
    retractLift: parseOrNull(settings?.filament_retract_lift),
  };
}

function extractMaxVol(settings: Record<string, string | null>): number | null {
  const val = settings?.filament_max_volumetric_speed;
  if (!val || val === "nil") return null;
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

function parseTemp(settings: Record<string, string | null>, key: string): number | null {
  const val = settings?.[key];
  if (!val || val === "nil") return null;
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

// ── Suffix patterns ──────────────────────────────────────────

// Matches trailing " 0.4", " 0.6", " 0.25", " 0.8"
const NOZZLE_DIAMETER_SUFFIX = /\s+(0\.25|0\.4|0\.6|0\.8)$/;
// Matches trailing " HF"
const HF_SUFFIX = /\s+HF$/;
// Matches trailing shore hardness like " 70A", " 74A", " 95A"
const SHORE_SUFFIX = /\s+(\d+A)$/;

// ── Main ─────────────────────────────────────────────────────

async function merge() {
  console.log(`Connecting to MongoDB...${DRY_RUN ? " (DRY RUN)" : ""}`);
  await mongoose.connect(MONGODB_URI);

  const Nozzle = mongoose.connection.collection("nozzles");
  const Filament = mongoose.connection.collection("filaments");

  // Build nozzle lookup maps
  const nozzleDocs = (await Nozzle.find().toArray()) as unknown as NozzleDoc[];
  const nozzleByDiameter = new Map<number, NozzleDoc>();
  const nozzleByDiameterHF = new Map<number, NozzleDoc>();
  const nozzleByName = new Map<string, NozzleDoc>();
  for (const n of nozzleDocs) {
    nozzleByName.set(n.name, n);
    if (n.highFlow) {
      nozzleByDiameterHF.set(n.diameter, n);
    } else {
      nozzleByDiameter.set(n.diameter, n);
    }
  }

  console.log(`Found ${nozzleDocs.length} nozzles:`);
  for (const n of nozzleDocs) {
    console.log(`  ${n.name} (${n.diameter}mm${n.highFlow ? ", HF" : ""})`);
  }

  // Load all filaments
  const allFilaments = (await Filament.find().toArray()) as unknown as FilamentDoc[];
  console.log(`\nFound ${allFilaments.length} filaments total`);

  // Track processed filament IDs to avoid double-processing
  const processed = new Set<string>();

  // ── Phase 1: Shore hardness merges (PEBA etc.) ─────────

  console.log("\n═══ Phase 1: Shore hardness → Presets ═══");

  const shoreGroups = new Map<string, { baseName: string; members: { filament: FilamentDoc; shore: string }[] }>();
  for (const f of allFilaments) {
    const match = f.name.match(SHORE_SUFFIX);
    if (!match) continue;
    const baseName = f.name.replace(SHORE_SUFFIX, "");
    const shore = match[1];
    if (!shoreGroups.has(baseName)) {
      shoreGroups.set(baseName, { baseName, members: [] });
    }
    shoreGroups.get(baseName)!.members.push({ filament: f, shore });
  }

  // Only merge groups with >1 member
  const shoreMerges = [...shoreGroups.values()].filter((g) => g.members.length > 1);

  for (const group of shoreMerges) {
    console.log(`\n  "${group.baseName}" — ${group.members.length} shore variants:`);
    for (const m of group.members) {
      console.log(`    - ${m.filament.name} (Shore ${m.shore})`);
    }

    // Sort by shore value
    group.members.sort((a, b) => parseInt(a.shore) - parseInt(b.shore));
    const keeper = group.members[0].filament;

    // Build presets from each member
    const presets: NonNullable<FilamentDoc["presets"]> = [];
    const allNozzleIds = new Set<string>();
    const calibrations: FilamentDoc["calibrations"] = [];

    for (const m of group.members) {
      const f = m.filament;
      processed.add(f._id.toString());

      // Collect nozzle IDs
      for (const nId of f.compatibleNozzles || []) {
        allNozzleIds.add(nId.toString());
      }

      // Carry over any existing calibrations from the first member
      if (f._id.toString() === keeper._id.toString() && f.calibrations?.length) {
        for (const cal of f.calibrations) {
          calibrations.push(cal);
        }
      }

      // Build preset
      const em = extractEM(f.settings);
      presets.push({
        label: `Shore ${m.shore}`,
        extrusionMultiplier: em,
        temperatures: {
          nozzle: f.temperatures?.nozzle ?? parseTemp(f.settings, "temperature"),
          nozzleFirstLayer: f.temperatures?.nozzleFirstLayer ?? parseTemp(f.settings, "first_layer_temperature"),
          bed: f.temperatures?.bed ?? parseTemp(f.settings, "bed_temperature"),
          bedFirstLayer: f.temperatures?.bedFirstLayer ?? parseTemp(f.settings, "first_layer_bed_temperature"),
        },
      });
    }

    if (!DRY_RUN) {
      await Filament.updateOne({ _id: keeper._id }, {
        $set: {
          name: group.baseName,
          presets,
          compatibleNozzles: [...allNozzleIds].map((id) => new mongoose.Types.ObjectId(id)),
          ...(calibrations.length > 0 ? { calibrations } : {}),
        },
      });

      for (let i = 1; i < group.members.length; i++) {
        const victim = group.members[i].filament;
        await Filament.updateMany(
          { parentId: victim._id },
          { $set: { parentId: keeper._id } }
        );
        await Filament.deleteOne({ _id: victim._id });
        console.log(`    ✗ Deleted "${victim.name}"`);
      }
      console.log(`  ✓ Merged → "${group.baseName}" with ${presets.length} presets`);
    }
  }

  if (shoreMerges.length === 0) {
    console.log("  (none found)");
  }

  // ── Phase 2: HF suffix merges ─────────────────────────

  console.log("\n═══ Phase 2: HF variants → Combined nozzle entries ═══");

  // Reload filaments after phase 1 deletions
  const remainingFilaments = (await Filament.find().toArray()) as unknown as FilamentDoc[];
  const filamentByName = new Map<string, FilamentDoc>();
  for (const f of remainingFilaments) filamentByName.set(f.name, f);

  let hfMerged = 0;
  for (const f of remainingFilaments) {
    if (processed.has(f._id.toString())) continue;
    if (!HF_SUFFIX.test(f.name)) continue;

    const baseName = f.name.replace(HF_SUFFIX, "");
    const baseFilament = filamentByName.get(baseName);
    if (!baseFilament) {
      // No matching non-HF filament — just rename by stripping HF (it keeps its HF nozzle refs)
      console.log(`\n  "${f.name}" — standalone HF, skipping (no base "${baseName}" found)`);
      continue;
    }
    if (processed.has(baseFilament._id.toString())) continue;

    console.log(`\n  "${baseName}" + "${f.name}" → merge`);
    processed.add(f._id.toString());
    processed.add(baseFilament._id.toString());

    // Merge: base keeps, HF is absorbed
    const allNozzleIds = new Set<string>();
    for (const nId of baseFilament.compatibleNozzles || []) allNozzleIds.add(nId.toString());
    for (const nId of f.compatibleNozzles || []) allNozzleIds.add(nId.toString());

    // Build calibrations from both
    const calibrations: FilamentDoc["calibrations"] = [
      ...(baseFilament.calibrations || []),
    ];

    // Extract calibration from the HF filament for each of its nozzles
    for (const nId of f.compatibleNozzles || []) {
      const nozzleDoc = nozzleDocs.find((n) => n._id.toString() === nId.toString());
      if (!nozzleDoc) continue;

      // Check if calibration already exists for this nozzle
      const exists = calibrations.some((c) => c.nozzle.toString() === nId.toString());
      if (exists) continue;

      const em = extractEM(f.settings);
      const pa = extractPA(f.settings);
      const mvs = f.maxVolumetricSpeed ?? extractMaxVol(f.settings);
      const retract = extractRetract(f.settings);

      if (em != null || pa != null || mvs != null || retract.retractLength != null || retract.retractSpeed != null || retract.retractLift != null) {
        calibrations.push({
          nozzle: new mongoose.Types.ObjectId(nId.toString()),
          extrusionMultiplier: em,
          maxVolumetricSpeed: mvs,
          pressureAdvance: pa,
          retractLength: retract.retractLength,
          retractSpeed: retract.retractSpeed,
          retractLift: retract.retractLift,
        });
      }
    }

    // Also extract calibrations from the base filament's nozzles if not already present
    for (const nId of baseFilament.compatibleNozzles || []) {
      const exists = calibrations.some((c) => c.nozzle.toString() === nId.toString());
      if (exists) continue;

      const em = extractEM(baseFilament.settings);
      const pa = extractPA(baseFilament.settings);
      const mvs = baseFilament.maxVolumetricSpeed ?? extractMaxVol(baseFilament.settings);
      const retract = extractRetract(baseFilament.settings);

      if (em != null || pa != null || mvs != null || retract.retractLength != null || retract.retractSpeed != null || retract.retractLift != null) {
        calibrations.push({
          nozzle: new mongoose.Types.ObjectId(nId.toString()),
          extrusionMultiplier: em,
          maxVolumetricSpeed: mvs,
          pressureAdvance: pa,
          retractLength: retract.retractLength,
          retractSpeed: retract.retractSpeed,
          retractLift: retract.retractLift,
        });
      }
    }

    if (!DRY_RUN) {
      await Filament.updateOne({ _id: baseFilament._id }, {
        $set: {
          compatibleNozzles: [...allNozzleIds].map((id) => new mongoose.Types.ObjectId(id)),
          calibrations,
        },
      });

      await Filament.updateMany(
        { parentId: f._id },
        { $set: { parentId: baseFilament._id } }
      );
      await Filament.deleteOne({ _id: f._id });
      console.log(`    ✗ Deleted "${f.name}"`);
      console.log(`  ✓ Merged → "${baseName}" with ${allNozzleIds.size} nozzles, ${calibrations.length} calibrations`);
    }
    hfMerged++;
  }

  if (hfMerged === 0) {
    console.log("  (none found)");
  }

  // ── Phase 3: Nozzle diameter suffix merges ─────────────

  console.log("\n═══ Phase 3: Nozzle diameter suffixes → Combined entries ═══");

  // Reload filaments after phases 1-2
  const phase3Filaments = (await Filament.find().toArray()) as unknown as FilamentDoc[];

  const nozzleGroups = new Map<string, { baseName: string; members: { filament: FilamentDoc; diameter: number }[] }>();

  for (const f of phase3Filaments) {
    if (processed.has(f._id.toString())) continue;
    const match = f.name.match(NOZZLE_DIAMETER_SUFFIX);
    if (!match) continue;

    const baseName = f.name.replace(NOZZLE_DIAMETER_SUFFIX, "");
    const diam = parseFloat(match[1]);

    if (!nozzleGroups.has(baseName)) {
      nozzleGroups.set(baseName, { baseName, members: [] });
    }
    nozzleGroups.get(baseName)!.members.push({ filament: f, diameter: diam });
  }

  // Process ALL groups (even single-member — to strip the suffix and add calibration)
  const nozzleMerges = [...nozzleGroups.values()];

  for (const group of nozzleMerges) {
    // Check if a filament with the base name already exists (from a previous merge or standalone)
    const existingBase = phase3Filaments.find(
      (f) => f.name === group.baseName && !processed.has(f._id.toString())
    );

    console.log(`\n  "${group.baseName}" — ${group.members.length} nozzle variant${group.members.length !== 1 ? "s" : ""}:`);
    for (const m of group.members) {
      console.log(`    - ${m.filament.name} (${m.diameter}mm)`);
    }
    if (existingBase) {
      console.log(`    (base "${group.baseName}" already exists — absorbing into it)`);
    }

    group.members.sort((a, b) => a.diameter - b.diameter);

    // Keeper is the existing base filament if present, otherwise the first member
    const keeper = existingBase || group.members[0].filament;
    const allNozzleIds = new Set<string>();
    const calibrations: FilamentDoc["calibrations"] = [...(keeper.calibrations || [])];

    // Add keeper's existing nozzles
    for (const nId of keeper.compatibleNozzles || []) {
      allNozzleIds.add(nId.toString());
    }

    for (const m of group.members) {
      const f = m.filament;
      processed.add(f._id.toString());

      // Add this member's nozzles
      for (const nId of f.compatibleNozzles || []) {
        allNozzleIds.add(nId.toString());
      }

      // Find the nozzle for this diameter
      const nozzle = nozzleByDiameter.get(m.diameter);
      if (nozzle) {
        allNozzleIds.add(nozzle._id.toString());

        // Don't duplicate calibrations
        const alreadyHasCal = calibrations.some(
          (c) => c.nozzle.toString() === nozzle._id.toString()
        );
        if (!alreadyHasCal) {
          const em = extractEM(f.settings);
          const pa = extractPA(f.settings);
          const mvs = f.maxVolumetricSpeed ?? extractMaxVol(f.settings);
          const retract = extractRetract(f.settings);

          if (em != null || pa != null || mvs != null || retract.retractLength != null || retract.retractSpeed != null || retract.retractLift != null) {
            calibrations.push({
              nozzle: nozzle._id,
              extrusionMultiplier: em,
              maxVolumetricSpeed: mvs,
              pressureAdvance: pa,
              retractLength: retract.retractLength,
              retractSpeed: retract.retractSpeed,
              retractLift: retract.retractLift,
            });
          }
        }
      }

      // Preserve HF nozzle references
      for (const nId of f.compatibleNozzles || []) {
        const hfNozzle = nozzleDocs.find(
          (n) => n._id.toString() === nId.toString() && n.highFlow
        );
        if (hfNozzle) allNozzleIds.add(hfNozzle._id.toString());
      }
    }

    if (!DRY_RUN) {
      const update: Record<string, unknown> = {
        name: group.baseName,
        compatibleNozzles: [...allNozzleIds].map((id) => new mongoose.Types.ObjectId(id)),
        calibrations,
      };

      await Filament.updateOne({ _id: keeper._id }, { $set: update });

      // Delete the other members (and the members if keeper is the existing base)
      const toDelete = existingBase
        ? group.members.map((m) => m.filament)
        : group.members.slice(1).map((m) => m.filament);

      for (const victim of toDelete) {
        if (victim._id.toString() === keeper._id.toString()) continue;
        await Filament.updateMany(
          { parentId: victim._id },
          { $set: { parentId: keeper._id } }
        );
        await Filament.deleteOne({ _id: victim._id });
        console.log(`    ✗ Deleted "${victim.name}"`);
      }
      console.log(`  ✓ Merged → "${group.baseName}" with ${allNozzleIds.size} nozzles, ${calibrations.length} calibrations`);
    }
  }

  if (nozzleMerges.length === 0) {
    console.log("  (none found)");
  }

  // ── Summary ────────────────────────────────────────────

  if (DRY_RUN) {
    console.log("\n--- DRY RUN: No changes made ---");
  } else {
    const finalCount = await Filament.countDocuments();
    console.log(`\nDone! ${finalCount} filaments remaining.`);
  }

  await mongoose.disconnect();
}

merge().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
