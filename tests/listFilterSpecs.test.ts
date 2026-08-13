import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseStoredPrefs,
  HOME_FILTER_SPEC,
  HOME_PERSISTED_KEYS,
  INVENTORY_FILTER_SPEC,
  INVENTORY_PERSISTED_KEYS,
} from "@/lib/listFilterSpecs";
import { serializeFilterParams, type FilterSpec } from "@/lib/listFilterParams";

/**
 * GH #1141. The two invariants that keep the sticky design honest, and that
 * nothing else in this repo can check: `vitest.config.ts` runs
 * `environment: "node"` with no jsdom, so the pages are untestable, which is
 * exactly why the specs moved into `src/lib`.
 *
 * Both failure modes are silent. A persisted key that is not sticky
 * reintroduces the non-deterministic-shared-link bug for that key alone; a
 * sticky key whose fallback serializes to empty is un-stuck by the
 * serializer's own delete branch, with the same result.
 */

const stickyKeys = (spec: FilterSpec) =>
  Object.keys(spec)
    .filter((k) => spec[k].sticky)
    .sort();

describe("list filter specs", () => {
  const cases = [
    { name: "home", spec: HOME_FILTER_SPEC as FilterSpec, persisted: HOME_PERSISTED_KEYS },
    {
      name: "inventory",
      spec: INVENTORY_FILTER_SPEC as FilterSpec,
      persisted: INVENTORY_PERSISTED_KEYS,
    },
  ];

  for (const { name, spec, persisted } of cases) {
    it(`${name}: every persisted key is sticky, and nothing else is`, () => {
      // Not "is a subset" — BOTH directions. A persisted key that is not
      // sticky is the original bug; a sticky key that is not persisted emits
      // noise into every URL for no reason.
      expect(stickyKeys(spec)).toEqual([...persisted].sort());
    });

    it(`${name}: no sticky key's fallback serializes to the empty string`, () => {
      // The serializer drops a value that serializes to empty, since it is
      // indistinguishable from absent after a round trip. A sticky key that
      // hit that branch would be silently un-stuck. None do today — the
      // fallbacks are enum members and a boolean — but `kind`, `type` and
      // `vendor` all have `""` fallbacks, so the day one of them becomes a
      // preference this catches it.
      for (const key of stickyKeys(spec)) {
        const entry = spec[key];
        const raw = entry.serialize ? entry.serialize(entry.fallback) : String(entry.fallback);
        expect(raw, `${name}.${key}`).not.toBe("");
      }
    });

    it(`${name}: a single filter carries every preference explicitly`, () => {
      // End to end over the REAL spec: this is what makes a shared link mean
      // the same thing to the sender and the recipient.
      const state = Object.fromEntries(
        Object.keys(spec).map((k) => [k, spec[k].fallback]),
      ) as Record<string, unknown>;
      state.search = "pla";
      const params = new URLSearchParams(
        serializeFilterParams("", spec, state as never),
      );
      for (const key of stickyKeys(spec)) {
        expect(params.has(spec[key].param), `${name}.${key}`).toBe(true);
      }
    });

    it(`${name}: an all-default view still serializes bare`, () => {
      const state = Object.fromEntries(
        Object.keys(spec).map((k) => [k, spec[k].fallback]),
      ) as Record<string, unknown>;
      expect(serializeFilterParams("", spec, state as never)).toBe("");
    });
  }
});

/**
 * GH #1141 (Codex P2, fourth pass): type and vendor are EXACT keys into
 * stored data — the schema does not trim them and the APIs compare with $eq —
 * so their parsers must not editorialize. Pinned on the REAL specs, because
 * the exactTextParam unit tests alone would stay green if someone swapped an
 * entry back to the trimming textParam.
 */
describe("exact-key params are untrimmed", () => {
  const entries = [
    ["home.typeFilter", HOME_FILTER_SPEC.typeFilter],
    ["home.vendorFilter", HOME_FILTER_SPEC.vendorFilter],
    ["inventory.type", INVENTORY_FILTER_SPEC.type],
    ["inventory.vendor", INVENTORY_FILTER_SPEC.vendor],
  ] as const;

  for (const [label, entry] of entries) {
    it(`${label} round-trips edge whitespace byte-exact`, () => {
      expect(entry.parse("PLA "), label).toBe("PLA ");
    });
  }
});

/**
 * The invariant the key-set comparison above CANNOT catch (Codex P1 review):
 * `groupBy` is both persisted and sticky, so a writer that forgets to record
 * the touch passes every test above while silently never persisting — or, the
 * other way, a URL-derived write laundering into storage.
 *
 * Scanning source is ugly and it is what `tests/ipc-contract-parity.test.ts`
 * already does for the hand-mirrored IPC channels, for the same reason: the
 * contract spans files with no compile-time link.
 */
describe("preference writers record the touch", () => {
  const SETTERS = ["setGroupBy(", "setSortKey(", "setSortDir(", "setIncludeRetired("];

  for (const file of ["src/app/page.tsx", "src/app/inventory/page.tsx"]) {
    it(`${file}: every preference setter is a seed or records a touch`, () => {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      const lines = src.split("\n");
      const offenders: string[] = [];

      lines.forEach((line, i) => {
        if (!SETTERS.some((s) => line.includes(s))) return;
        // The seed and re-seed adopt URL/persisted values and must NOT record
        // a touch — that is the whole point of the gate. Both are recognised
        // by what they PASS, not by proximity: a seeded value always comes out
        // of the `url` object (`seedFilterState` / `parseFilterParams`), and
        // the re-seed's keep-current form is a functional update. Proximity
        // alone was too weak — a long comment between the two pushed a real
        // seed out of the window.
        if (line.includes("url.") || line.includes("(cur) =>")) return;
        // The touch must be in the SAME handler, so the window is tight. A
        // loose one is worthless: with 12 lines, deleting the `sortDir` touch
        // still passed because the neighbouring `sortKey` handler's touch was
        // in range. Every writer here records immediately before its setter,
        // with at most a comment between.
        const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
        const key = SETTERS.find((setter) => line.includes(setter))!
          .slice("set".length, -1);
        const touch = `prefsTouchedRef.current.add("${key[0].toLowerCase()}${key.slice(1)}")`;
        if (!window.includes(touch)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`);
        }
      });

      expect(offenders).toEqual([]);
    });
  }
});

/**
 * GH #1141 (Codex P2). The persist effects parse the stored blob inside a
 * catch-everything try; a corrupt blob threw at the parse, skipped the
 * `setItem`, and so was never overwritten — persistence dead until the user
 * cleared storage by hand. The write path is the one chance to heal, so the
 * parse must be tolerant there.
 */
describe("parseStoredPrefs", () => {
  it("returns the object for a valid blob", () => {
    expect(parseStoredPrefs('{"sortKey":"cost"}')).toEqual({ sortKey: "cost" });
  });

  it("returns {} for absent storage", () => {
    expect(parseStoredPrefs(null)).toEqual({});
    expect(parseStoredPrefs("")).toEqual({});
  });

  it("returns {} for corrupt JSON — the case that killed persistence", () => {
    expect(parseStoredPrefs("{not json")).toEqual({});
  });

  it("returns {} for valid JSON that is not a plain object", () => {
    // Spreading an array would yield index keys, not preferences; a number or
    // null would spread to nothing but signals the blob is garbage either way.
    expect(parseStoredPrefs("42")).toEqual({});
    expect(parseStoredPrefs("null")).toEqual({});
    expect(parseStoredPrefs('"cost"')).toEqual({});
    expect(parseStoredPrefs('[{"sortKey":"cost"}]')).toEqual({});
  });
});
