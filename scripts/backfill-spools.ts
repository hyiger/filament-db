/**
 * Backfill spools: give every spool-less filament one spool.
 *
 * Filament DB treats "owning a filament" and "having a spool" as the same
 * thing — when you add a filament you physically have it, so the UI now
 * auto-creates a spool on every new filament (web + mobile). This script
 * applies the same assumption RETROACTIVELY to filaments that were created
 * before that behaviour existed and therefore have an empty `spools` array.
 *
 * For each spool-less, non-deleted, non-parent filament it adds ONE spool whose
 * gross weight mirrors the create-time spool defaulting the web "+ Add
 * Filament" form now does:
 *
 *   gross = totalWeight (if set)                       // explicit initial weight
 *          else netFilamentWeight + (spoolWeight ?? 0)  // a full, nominal spool
 *         else null                                     // weight unknown
 *
 * Variant inheritance is resolved with the SAME `resolveFilament()` the app
 * uses, so a variant that leaves `netFilamentWeight` / `spoolWeight` blank
 * picks up the parent's net + tare. When a real parent tare is inherited the
 * script leaves the variant's `spoolWeight` untouched, so it keeps tracking the
 * parent and `remaining = gross - inheritedTare` resolves to the nominal net.
 * When the resulting spool would have NO effective tare at all (own or
 * inherited), the script pins `spoolWeight: 0` — otherwise the app's
 * getRemainingGrams reads a spooled-but-null-tare filament as "untracked" and
 * hides the weight. Weight-unknown spools (no net anywhere) get neither.
 *
 * SAFE BY DEFAULT:
 *   - Dry run unless `--apply` is passed. The dry run mutates nothing.
 *   - Idempotent: only touches filaments with ZERO spools, and the write is
 *     guarded so a row that gained a spool (or, when pinning the tare, a
 *     spoolWeight) between scan and write is skipped, not clobbered. Re-running
 *     after a successful apply is a no-op.
 *   - Skips parents (filaments that have variants — their inventory lives on
 *     the variants), trashed (`_deletedAt`) and purged (`_purged`) rows, and
 *     filaments that already have at least one spool (retired or not).
 *   - Bumps `updatedAt` on each write so the hybrid-sync engine (last-write-
 *     wins on `updatedAt`) propagates the added spool; clears the legacy
 *     top-level `totalWeight` once its value lives on the spool.
 *   - On `--apply` it writes a JSON log of every (filamentId, spoolId,
 *     totalWeight, pinnedTareZero, clearedTotalWeight) it added, so the backfill
 *     can be reversed precisely (pull the spool; for pinned rows reset
 *     spoolWeight to null; restore any clearedTotalWeight).
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/backfill-spools.ts            # dry run
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/backfill-spools.ts --apply    # write
 *   npx tsx scripts/backfill-spools.ts --weight=unknown --apply                   # weight-unknown spools
 *
 * If MONGODB_URI is not in the environment the script falls back to reading it
 * from `.env.local` (the same file the dev/Electron server uses), so a local
 * checkout can run it without re-pasting the connection string.
 *
 * Flags:
 *   --apply            Actually write. Omit for a dry run (default).
 *   --weight=MODE      nominal (default) = net + tare full spool; unknown = no weight.
 *   --help             Show this usage.
 */
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { resolveFilament } from "../src/lib/resolveFilament";

type Doc = Record<string, unknown>;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Backfill a spool onto every spool-less filament (mirrors create-time spool defaulting).",
      "",
      "  npx tsx scripts/backfill-spools.ts             # dry run (no changes)",
      "  npx tsx scripts/backfill-spools.ts --apply     # write the spools",
      "  npx tsx scripts/backfill-spools.ts --weight=unknown --apply",
      "",
      "MONGODB_URI is read from the environment, falling back to .env.local.",
    ].join("\n"),
  );
  process.exit(0);
}

const APPLY = args.includes("--apply");
const weightArg = (args.find((a) => a.startsWith("--weight=")) ?? "--weight=nominal").split("=")[1];
if (weightArg !== "nominal" && weightArg !== "unknown") {
  console.error(`Invalid --weight=${weightArg} (expected "nominal" or "unknown")`);
  process.exit(1);
}
const WEIGHT_MODE: "nominal" | "unknown" = weightArg;

/** Read MONGODB_URI from env, falling back to a bare parse of .env.local. */
function resolveMongoUri(): string | null {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return null;
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== "MONGODB_URI") continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    return val || null;
  }
  return null;
}

/** Finite number or null — matches the app's `num` helper for weight fields. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface SpoolPlan {
  /** Gross weight to stamp on the new spool, or null = weight unknown. */
  gross: number | null;
  /**
   * Whether to also pin the filament's spoolWeight to 0. A weighted spool on a
   * filament with no effective tare reads as "untracked" in getRemainingGrams
   * (null spoolWeight → null), hiding the gross as unknown remaining. Pinning 0
   * makes remaining resolve to the gross — but ONLY safe when the gross was
   * derived from net (filament-only, so remaining = net). An explicit
   * totalWeight is an on-scale gross that INCLUDES the unknown spool mass, so
   * pinning 0 there would overstate remaining by the tare — leave such a spool
   * untracked until the tare is known. Never set when there's already an
   * effective tare (own or inherited), so a variant inheriting a real parent
   * tare is never clobbered.
   */
  pinTareZero: boolean;
  /**
   * Whether the gross came from the legacy top-level `totalWeight` field, which
   * must then be nulled. The web create path moves an entered initial weight
   * into the spool and clears `totalWeight` (route.ts) — left in place, the
   * OpenPrintTag/NFC export still reads `actualWeightGrams` off the stale
   * top-level value after the user edits the new spool. Mirror that migration.
   */
  clearTotalWeight: boolean;
}

/** Plan the spool for one filament: its gross weight, mirroring the web
 * create-time spool defaulting, plus whether a 0-tare must be pinned. */
function planSpool(filament: Doc, parent: Doc | null): SpoolPlan {
  // Unknown mode never derives a weight, but still clears a legacy top-level
  // totalWeight (recorded in the rollback log) so the NFC/OPT export can't keep
  // reading a stale scale weight after the row gets a weight-unknown spool
  // (Codex P2). The spool itself stays unweighted per the flag.
  if (WEIGHT_MODE === "unknown") {
    return { gross: null, pinTareZero: false, clearTotalWeight: num(filament.totalWeight) != null };
  }
  const eff = parent ? resolveFilament(filament, parent) : filament;
  const effTare = num(eff.spoolWeight);
  // totalWeight is variant-only (never inherited) — read it off the doc.
  const total = num(filament.totalWeight);
  let gross: number | null;
  let derivedFromNet = false;
  if (total != null) {
    gross = total;
  } else {
    const net = num(eff.netFilamentWeight);
    if (net == null) {
      gross = null;
    } else {
      gross = net + (effTare ?? 0);
      derivedFromNet = true;
    }
  }
  return { gross, pinTareZero: derivedFromNet && effTare == null, clearTotalWeight: total != null };
}

async function main() {
  const uri = resolveMongoUri();
  if (!uri) {
    console.error("MONGODB_URI not set (and not found in .env.local).");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const conn = mongoose.connection;
  const col = conn.db!.collection("filaments");

  console.log("\nFilament DB — backfill spools");
  console.log(`  DB:     ${conn.name}@${conn.host}`);
  console.log(`  Mode:   ${APPLY ? "APPLY (writing changes)" : "DRY RUN (no changes)"}`);
  console.log(`  Weight: ${WEIGHT_MODE === "nominal" ? "nominal (net + tare full spool)" : "unknown (no weight)"}\n`);

  // Load ALL filaments once. Parents resolve from this full map INCLUDING
  // trashed/purged parents, because the app's filament-list $lookup that
  // resolves a variant's effective net/tare does NOT filter the parent by
  // _deletedAt — so a variant of a trashed parent still inherits in the UI and
  // the backfill must match that (Codex review F4). Candidates + parent
  // detection use the LIVE subset only: never backfill a trashed/purged row,
  // and "is a parent" = has a LIVE variant (mirrors the app's hasVariants()).
  const all = (await col.find({}).toArray()) as Doc[];
  const byId = new Map<string, Doc>();
  for (const f of all) byId.set(String(f._id), f);

  const live = all.filter((f) => f._deletedAt == null && f._purged !== true);
  const parentIds = new Set<string>();
  for (const f of live) {
    if (f.parentId) parentIds.add(String(f.parentId));
  }

  // "No spools" = empty array, missing field, or an explicit null — raw-driver
  // / import / sync data can leave null; the write below handles all three.
  const hasNoSpools = (f: Doc) =>
    f.spools == null || (Array.isArray(f.spools) && f.spools.length === 0);

  let skippedParent = 0;
  let skippedHasSpools = 0;
  const targets: { f: Doc; plan: SpoolPlan }[] = [];

  for (const f of live) {
    if (!hasNoSpools(f)) {
      skippedHasSpools++;
      continue;
    }
    if (parentIds.has(String(f._id))) {
      skippedParent++;
      continue; // parents track inventory on their variants
    }
    const parent = f.parentId ? byId.get(String(f.parentId)) ?? null : null;
    targets.push({ f, plan: planSpool(f, parent) });
  }

  const nominalCount = targets.filter((t) => t.plan.gross != null).length;
  const unknownCount = targets.length - nominalCount;
  const pinnedCount = targets.filter((t) => t.plan.pinTareZero).length;

  console.log(`Scanned ${live.length} live filaments:`);
  console.log(`  · already have a spool — skipped: ${skippedHasSpools}`);
  console.log(`  · parents (track variants) — skipped: ${skippedParent}`);
  console.log(`  · spool-less candidates: ${targets.length}`);
  console.log(`      → spool with a weight: ${nominalCount}`);
  console.log(`      → weight-unknown spool: ${unknownCount}`);
  if (pinnedCount > 0) {
    console.log(`    (of the weighted spools, ${pinnedCount} also pin empty-spool weight to 0 — no tare on record)`);
  }
  console.log();

  if (targets.length > 0) {
    console.log(`Sample (first ${Math.min(15, targets.length)}):`);
    for (const t of targets.slice(0, 15)) {
      const name = String(t.f.name ?? "(unnamed)");
      const tag = t.f.parentId ? " [variant]" : "";
      const w = t.plan.gross == null ? "weight unknown" : `gross ${t.plan.gross} g`;
      const pin = t.plan.pinTareZero ? " (tare→0)" : "";
      console.log(`  ${name}${tag} → ${w}${pin}`);
    }
    console.log();
  }

  if (!APPLY) {
    console.log(`DRY RUN — re-run with --apply to add ${targets.length} spool(s).\n`);
    await mongoose.disconnect();
    return;
  }

  if (targets.length === 0) {
    console.log("Nothing to do.\n");
    await mongoose.disconnect();
    return;
  }

  // Build each spool subdoc ourselves — the raw driver applies no Mongoose
  // schema defaults, so every field the app reads must be set explicitly. One
  // guarded updateOne per doc (a one-off maintenance run, not perf-critical) so
  // the log records ONLY rows actually written — the guard can skip a row that
  // gained a spool (or, for the pinned case, a tare) between scan and write.
  const now = new Date();
  const logEntries: {
    filamentId: string;
    name: string;
    spoolId: string;
    totalWeight: number | null;
    pinnedTareZero: boolean;
    clearedTotalWeight: number | null;
  }[] = [];
  let wrote = 0;
  let skipped = 0;

  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const logPath = path.resolve(process.cwd(), `backfill-spools-${stamp}.json`);
  // Persist whatever has been logged so far. Called from `finally` so a thrown
  // updateOne partway through still leaves a durable, precise rollback log
  // rather than losing the already-written spool IDs (Codex P2 on #707).
  const flushLog = () => {
    if (logEntries.length === 0) return;
    fs.writeFileSync(
      logPath,
      JSON.stringify(
        { db: conn.name, weightMode: WEIGHT_MODE, appliedAt: now.toISOString(), added: logEntries },
        null,
        2,
      ),
    );
  };

  try {
    for (const t of targets) {
    const spoolId = new mongoose.Types.ObjectId();
    const spool = {
      _id: spoolId,
      label: "",
      totalWeight: t.plan.gross,
      lotNumber: null,
      purchaseDate: null,
      openedDate: null,
      createdAt: now,
      locationId: null,
      photoDataUrl: null,
      retired: false,
      dryCycles: [],
      usageHistory: [],
    };
    // $set the whole array rather than $push: $push errors on an explicit
    // `spools: null` (F3), and the guard already pins us to a spool-less row so
    // there's nothing to append to. Also bump updatedAt — the raw driver
    // bypasses Mongoose timestamps, and the hybrid-sync engine uses updatedAt
    // for last-write-wins, so without it a peer can ignore the added spool (F5).
    const set: Record<string, unknown> = { spools: [spool], updatedAt: now };
    if (t.plan.pinTareZero) set.spoolWeight = 0;
    // Clear the legacy top-level totalWeight once its value lives on the spool,
    // mirroring the web create migration — else NFC/OPT export reads the stale
    // value after a spool edit (F6).
    const clearedTotalWeight = t.plan.clearTotalWeight ? num(t.f.totalWeight) : null;
    if (t.plan.clearTotalWeight) set.totalWeight = null;

    // Guard so the write lands only while the row still matches what we scanned
    // — idempotent, concurrent-safe, re-runnable. Always require spools still
    // empty (missing / [] / null). When pinning the tare, also require
    // spoolWeight unset, so a tare set by a concurrent edit / sync isn't
    // clobbered with 0 (F1). When clearing the legacy totalWeight, also require
    // it unchanged, so a newer scale reading written between scan and write
    // isn't dropped (Codex P2). A non-match counts as skipped; a re-run picks
    // up the new value.
    const guards: Record<string, unknown>[] = [
      { $or: [{ spools: { $size: 0 } }, { spools: { $exists: false } }, { spools: null }] },
    ];
    if (t.plan.pinTareZero) {
      guards.push({ $or: [{ spoolWeight: null }, { spoolWeight: { $exists: false } }] });
    }
    if (t.plan.clearTotalWeight) {
      guards.push({ totalWeight: clearedTotalWeight });
    }
    const filter = { _id: t.f._id, $and: guards };

    const res = await col.updateOne(filter, { $set: set });
    if (res.modifiedCount === 1) {
      wrote++;
      logEntries.push({
        filamentId: String(t.f._id),
        name: String(t.f.name ?? ""),
        spoolId: String(spoolId),
        totalWeight: t.plan.gross,
        pinnedTareZero: t.plan.pinTareZero,
        clearedTotalWeight,
      });
    } else {
      skipped++;
    }
    }
  } finally {
    flushLog();
  }

  console.log(`APPLY — wrote ${wrote} spool(s)${skipped > 0 ? ` (${skipped} skipped — gained a spool or tare between scan and write)` : ""}.`);
  console.log(`Rollback log: ${logPath}`);
  console.log("  (To reverse: pull each spoolId from its filament's spools; for");
  console.log("   pinnedTareZero entries reset spoolWeight to null; for entries with a");
  console.log("   clearedTotalWeight, restore that top-level totalWeight value.)\n");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
