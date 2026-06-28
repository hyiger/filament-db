import { describe, it, expect } from "vitest";
import nextConfig from "../next.config";

/**
 * GH #878: `src/proxy.ts` matches every `/api/*` request, so Next buffers the
 * request body (default 10MB) and SILENTLY truncates anything larger to a
 * partial body — the request continues, it doesn't error. `POST /api/snapshot`
 * accepts up to 50MB (`MAX_SNAPSHOT_SIZE` in src/app/api/snapshot/route.ts), so
 * without raising the proxy cap a valid 10–50MB backup is truncated before the
 * handler and fails as "Invalid JSON" instead of restoring.
 *
 * This invariant pins the proxy buffer >= the largest accepted route body, so a
 * future change can't silently drop the cap (or raise the snapshot cap past it)
 * and reintroduce the truncation. The route-level handler tests can't catch this
 * — they bypass the proxy layer entirely.
 *
 * Keep MAX_SNAPSHOT_SIZE in sync with the route if it ever changes.
 */
const MAX_SNAPSHOT_SIZE = 50 * 1024 * 1024; // src/app/api/snapshot/route.ts

function parseSize(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(v.trim());
  if (!m) return 0;
  const mult: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return parseFloat(m[1]) * mult[(m[2] || "b").toLowerCase()];
}

describe("#878 — proxy body limit covers the largest API route body", () => {
  it("experimental.proxyClientMaxBodySize is set and >= MAX_SNAPSHOT_SIZE", () => {
    const experimental = nextConfig.experimental as Record<string, unknown> | undefined;
    const cap = parseSize(experimental?.proxyClientMaxBodySize);
    expect(cap).toBeGreaterThanOrEqual(MAX_SNAPSHOT_SIZE);
  });
});
