import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import nextConfig from "../next.config";

/**
 * GH #878: `src/proxy.ts` matches every `/api/*` request, so Next buffers the
 * request body (default 10MB) and SILENTLY truncates anything larger to a
 * partial body — the request continues, it doesn't error. `POST /api/snapshot`
 * accepts up to `MAX_SNAPSHOT_SIZE` (src/app/api/snapshot/route.ts), so without
 * raising the proxy cap a valid 10–50MB backup is truncated before the handler
 * and fails as "Invalid JSON" instead of restoring.
 *
 * This invariant pins the proxy buffer >= the largest accepted route body, so a
 * future change can't silently drop the cap (or raise the snapshot cap past it)
 * and reintroduce the truncation. Route-level handler tests can't catch this —
 * they bypass the proxy layer entirely.
 */
function parseSize(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(v.trim());
  if (!m) return 0;
  const mult: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return parseFloat(m[1]) * mult[(m[2] || "b").toLowerCase()];
}

/**
 * Derive the snapshot route's cap from its source rather than hard-coding it, so
 * raising `MAX_SNAPSHOT_SIZE` without also raising the proxy cap fails this test
 * (Codex P3) instead of silently passing. The handler defines it as a local
 * const (not exported), and importing the route would pull in mongoose/db deps —
 * so read the literal arithmetic and evaluate it safely (digits / `*` only).
 */
function snapshotRouteCapBytes(): number {
  const src = readFileSync("src/app/api/snapshot/route.ts", "utf-8");
  const m = /MAX_SNAPSHOT_SIZE\s*=\s*([\d.\s*]+?)\s*;/.exec(src);
  if (!m) {
    throw new Error(
      "Could not find MAX_SNAPSHOT_SIZE in src/app/api/snapshot/route.ts — update this test",
    );
  }
  const expr = m[1].trim();
  if (!/^[\d.\s*]+$/.test(expr)) {
    throw new Error(`Unexpected MAX_SNAPSHOT_SIZE expression: ${expr}`);
  }
  return expr.split("*").reduce((acc, part) => acc * parseFloat(part.trim()), 1);
}

describe("#878 — proxy body limit covers the largest API route body", () => {
  it("experimental.proxyClientMaxBodySize is set and >= the snapshot route's MAX_SNAPSHOT_SIZE", () => {
    const experimental = nextConfig.experimental as Record<string, unknown> | undefined;
    const proxyCap = parseSize(experimental?.proxyClientMaxBodySize);
    const routeCap = snapshotRouteCapBytes();
    expect(routeCap).toBeGreaterThan(0); // sanity: the derivation actually parsed
    expect(proxyCap).toBeGreaterThanOrEqual(routeCap);
  });
});
