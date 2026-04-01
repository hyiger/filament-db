/**
 * Audit script: show all filaments and their empty fields.
 * Usage: MONGODB_URI=... npx tsx scripts/audit-filaments.ts
 */
import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI!;
if (!MONGODB_URI) { console.error("MONGODB_URI not set"); process.exit(1); }

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db!;
  const filaments = await db.collection("filaments")
    .find({ _deletedAt: null })
    .sort({ name: 1 })
    .toArray();

  console.log(`\nFound ${filaments.length} filaments\n`);

  for (const f of filaments) {
    const empty: string[] = [];
    const check = (field: string, val: unknown) => {
      if (val == null || val === "" || (Array.isArray(val) && val.length === 0)) {
        empty.push(field);
      }
    };

    check("colorName", f.colorName);
    check("cost", f.cost);
    check("density", f.density);
    check("diameter", f.diameter);
    check("nozzle", f.temperatures?.nozzle);
    check("nozzleFirstLayer", f.temperatures?.nozzleFirstLayer);
    check("nozzleRangeMin", f.temperatures?.nozzleRangeMin);
    check("nozzleRangeMax", f.temperatures?.nozzleRangeMax);
    check("bed", f.temperatures?.bed);
    check("bedFirstLayer", f.temperatures?.bedFirstLayer);
    check("standby", f.temperatures?.standby);
    check("maxVolumetricSpeed", f.maxVolumetricSpeed);
    check("spoolWeight", f.spoolWeight);
    check("netFilamentWeight", f.netFilamentWeight);
    check("dryingTemperature", f.dryingTemperature);
    check("dryingTime", f.dryingTime);
    check("transmissionDistance", f.transmissionDistance);
    check("glassTempTransition", f.glassTempTransition);
    check("heatDeflectionTemp", f.heatDeflectionTemp);
    check("shoreHardnessA", f.shoreHardnessA);
    check("shoreHardnessD", f.shoreHardnessD);
    check("minPrintSpeed", f.minPrintSpeed);
    check("maxPrintSpeed", f.maxPrintSpeed);
    check("spoolType", f.spoolType);
    check("optTags", f.optTags);
    check("tdsUrl", f.tdsUrl);

    console.log(`── ${f.name} (${f.type}) ──`);
    console.log(`   Color: ${f.color}  Type: ${f.type}  Vendor: ${f.vendor}`);
    if (empty.length > 0) {
      console.log(`   Empty: ${empty.join(", ")}`);
    } else {
      console.log(`   All fields populated`);
    }
    console.log();
  }

  await mongoose.disconnect();
}

main().catch(console.error);
