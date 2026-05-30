#!/usr/bin/env node
/**
 * GH #396 — `npm start` runs the Next.js standalone server, but
 * standalone output is intentionally minimal: it ships server.js +
 * node_modules but NOT the public/ directory or .next/static/ chunk
 * assets. Without them every page loads with broken CSS/JS/fonts.
 *
 * The Electron build pipeline copies them via the electron:fixlinks
 * script. `npm start` was missing the equivalent step, so anyone
 * running `npm start` after `npm run build` got a hollow server.
 *
 * This script is invoked by the start:prep npm script and copies
 * .next/static + public/ into the right places under
 * .next/standalone. Idempotent — safe to re-run.
 *
 * Bails out with an actionable error if .next/static is missing (the
 * user forgot to run `npm run build` first).
 */
import { cpSync, existsSync } from "node:fs";

const SOURCE_STATIC = ".next/static";
const SOURCE_PUBLIC = "public";
const DEST_STATIC = ".next/standalone/.next/static";
const DEST_PUBLIC = ".next/standalone/public";

if (!existsSync(SOURCE_STATIC)) {
  console.error(
    "start:prep — .next/static not found. Run 'npm run build' first.",
  );
  process.exit(1);
}

cpSync(SOURCE_STATIC, DEST_STATIC, { recursive: true });
cpSync(SOURCE_PUBLIC, DEST_PUBLIC, { recursive: true });

console.log(
  "start:prep — copied .next/static and public/ into .next/standalone",
);
