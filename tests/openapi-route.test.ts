import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/openapi/route";

/**
 * Route test for GET /api/openapi. Previously exercised only by the CI smoke
 * curl, never by Vitest. Serves public/openapi.json with the package version
 * injected, memoised after the first read (GH #270).
 */
describe("GET /api/openapi", () => {
  it("serves the OpenAPI spec with an injected string version", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBeTruthy();
    expect(spec.info).toBeTruthy();
    expect(typeof spec.info.version).toBe("string");
    expect(spec.info.version.length).toBeGreaterThan(0);
    expect(spec.paths).toBeTruthy();
  });

  it("returns identical memoised content on a second call (GH #270 cache branch)", async () => {
    const first = await (await GET()).json();
    const second = await (await GET()).json();
    expect(second).toEqual(first);
  });
});

describe("OpenAPI schema invariants", () => {
  it("no schema requires a property it does not declare", async () => {
    // GH #1103: `RestoreBlockedByTemplate` kept `variantName` in `required`
    // after the property was removed, so every real response would have
    // violated the published contract and generated clients would have
    // declared a field the route never returns.
    const spec = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        new URL("../public/openapi.json", import.meta.url),
        "utf-8",
      ),
    ) as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
      };
    };
    const offenders: string[] = [];
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      if (!schema.required || !schema.properties) continue;
      for (const key of schema.required) {
        if (!(key in schema.properties)) offenders.push(`${name}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
