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
  it("no schema anywhere requires a property it does not declare", async () => {
    // GH #1103: `RestoreBlockedByTemplate` kept `variantName` in `required`
    // after the property was removed, so every real response would have
    // violated the published contract and generated clients would have
    // declared a field the route never returns.
    //
    // Walks the WHOLE document, not just `components.schemas` (Codex P2):
    // most of this spec's request/response schemas are declared INLINE under
    // `paths`, and dozens more are nested inside `properties`/`items`/
    // `allOf` — an invariant that only visits the top level would advertise
    // repo-wide coverage while missing almost all of it.
    const spec = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        new URL("../public/openapi.json", import.meta.url),
        "utf-8",
      ),
    ) as unknown;

    const offenders: string[] = [];
    const visit = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => visit(child, `${path}[${i}]`));
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      const required = obj.required;
      const properties = obj.properties;
      // `required` is only a schema keyword when it's an ARRAY of names —
      // as a boolean it's the OpenAPI parameter/requestBody flag.
      if (Array.isArray(required) && typeof properties === "object" && properties !== null) {
        // A composed schema can satisfy `required` from a sibling branch, so
        // only flag a node that declares its own properties and no composer.
        const composed = obj.allOf ?? obj.anyOf ?? obj.oneOf ?? obj.$ref;
        if (composed === undefined) {
          for (const key of required) {
            if (typeof key === "string" && !(key in (properties as Record<string, unknown>))) {
              offenders.push(`${path}.required["${key}"]`);
            }
          }
        }
      }
      for (const [k, v] of Object.entries(obj)) visit(v, `${path}.${k}`);
    };
    visit(spec, "$");

    expect(offenders).toEqual([]);
  });
});
