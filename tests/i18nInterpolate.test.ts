import { describe, it, expect } from "vitest";
import { interpolate } from "@/i18n/interpolate";

/**
 * GH #1007 F1: t() interpolation must insert param values LITERALLY. A string
 * argument to String.prototype.replace treats `$$`, `$&`, `` $` `` and `$'` as
 * special replacement patterns, so a value carrying them (a filament name, a
 * raw server error) rendered corrupted — including in the destructive
 * delete/retire confirm dialogs. interpolate() uses a function replacement.
 */
describe("interpolate — GH #1007 F1", () => {
  it("returns the template unchanged when no params are given", () => {
    expect(interpolate("Delete {name}?")).toBe("Delete {name}?");
  });

  it("substitutes a plain value", () => {
    expect(interpolate("Delete {name}?", { name: "PLA Red" })).toBe("Delete PLA Red?");
  });

  it("replaces every occurrence of a token", () => {
    expect(interpolate("{x} and {x}", { x: "A" })).toBe("A and A");
  });

  it("coerces numeric values to string", () => {
    expect(interpolate("Retire {count} spool(s)?", { count: 3 })).toBe("Retire 3 spool(s)?");
  });

  // The core regression cases — `$` sequences in the VALUE must survive verbatim.
  it("keeps a literal $$ in the value ($$ is a replace() escape for $)", () => {
    expect(interpolate("Delete {name}?", { name: "Cheap $$ PLA" })).toBe("Delete Cheap $$ PLA?");
  });

  it("keeps $& in the value (would otherwise splice the whole match)", () => {
    expect(interpolate("Delete {name}?", { name: "PLA $& Black" })).toBe("Delete PLA $& Black?");
  });

  it("keeps $` and $' in the value (would otherwise splice the surrounding text)", () => {
    expect(interpolate("A {name} B", { name: "x $` y $' z" })).toBe("A x $` y $' z B");
  });

  it("keeps $1 in the value (numbered-group pattern)", () => {
    expect(interpolate("Delete {name}?", { name: "Item $1" })).toBe("Delete Item $1?");
  });

  it("substitutes multiple distinct params, each literally", () => {
    expect(
      interpolate("{a} / {b}", { a: "100% $$", b: "$& done" }),
    ).toBe("100% $$ / $& done");
  });
});

/**
 * GH #1029 — the substitution must be SINGLE-PASS.
 *
 * The previous implementation folded over Object.entries(params), re-scanning
 * the OUTPUT of each pass, so a `{token}` sitting inside an already-substituted
 * VALUE was picked up as a live token by a later param and replaced. Filament /
 * printer / location names are user-controlled and flow into multi-param
 * strings, and whether the bug bit depended on the CALL SITE's key insertion
 * order — a value can only inject a token belonging to a LATER param — which is
 * why it stayed invisible.
 */
describe("interpolate — single-pass, no token reentrancy (GH #1029)", () => {
  it("renders a {token} inside a param VALUE literally", () => {
    // The canonical repro from the issue.
    expect(
      interpolate("Delete {name}? ({count} spools)", { name: "PLA {count}", count: 7 }),
    ).toBe("Delete PLA {count}? (7 spools)");
  });

  it("is independent of param key order (both directions)", () => {
    const template = "Delete {name}? ({count} spools)";
    const a = interpolate(template, { name: "PLA {count}", count: 7 });
    const b = interpolate(template, { count: 7, name: "PLA {count}" });
    expect(a).toBe(b);
    expect(a).toBe("Delete PLA {count}? (7 spools)");
  });

  it("does not let a value inject a token that appears EARLIER in the template", () => {
    // Mirrors the bambuImport.success shape: { verb, name } where name is
    // user-controlled. Pre-fix this was safe only by insertion-order luck.
    expect(
      interpolate('{verb} "{name}"', { verb: "Updated", name: "PLA {verb}" }),
    ).toBe('Updated "PLA {verb}"');
    expect(
      interpolate('{verb} "{name}"', { name: "PLA {verb}", verb: "Updated" }),
    ).toBe('Updated "PLA {verb}"');
  });

  it("handles a value that is exactly another token", () => {
    expect(interpolate("{a}/{b}", { a: "{b}", b: "X" })).toBe("{b}/X");
    expect(interpolate("{a}/{b}", { b: "X", a: "{b}" })).toBe("{b}/X");
  });

  it("still leaves an unknown token verbatim", () => {
    expect(interpolate("Hi {name}, you have {unknown}", { name: "Sam" })).toBe(
      "Hi Sam, you have {unknown}",
    );
  });

  it("never substitutes an inherited Object.prototype key", () => {
    // `{constructor}` / `{toString}` must not resolve off the prototype chain.
    expect(interpolate("x {constructor} y", { name: "n" })).toBe("x {constructor} y");
    expect(interpolate("x {toString} y", { name: "n" })).toBe("x {toString} y");
  });

  it("does not mis-match a param name containing regex metacharacters", () => {
    // Pre-fix the name was spliced into a RegExp unescaped, so `.` acted as a
    // wildcard and "{aXb}" matched a param keyed "a.b".
    expect(interpolate("x {aXb} y", { "a.b": "PWNED" })).toBe("x {aXb} y");
  });

  it("preserves the GH #1007 F1 guarantee: $-patterns stay literal", () => {
    // Regression guard — the single-pass rewrite must keep the FUNCTION replacer.
    expect(interpolate("Delete {name}?", { name: "Cheap $$ PLA" })).toBe(
      "Delete Cheap $$ PLA?",
    );
    expect(interpolate("Delete {name}?", { name: "A $& B" })).toBe("Delete A $& B?");
    expect(interpolate("{a}-{b}", { a: "$`", b: "$'" })).toBe("$`-$'");
  });

  it("is stateless across calls (module-scoped global regex lastIndex)", () => {
    // A `g` regex reused via .test()/.exec() would advance lastIndex and make
    // the 2nd call behave differently. .replace() resets it — pin that.
    const t = "{a} {a} {a}";
    expect(interpolate(t, { a: "1" })).toBe("1 1 1");
    expect(interpolate(t, { a: "2" })).toBe("2 2 2");
    expect(interpolate(t, { a: "3" })).toBe("3 3 3");
  });
});

/**
 * GH #1029 invariant: the TOKEN_RE character class (`\w+`) must keep covering
 * every token both locale files actually use. If someone adds a dotted or
 * hyphenated key, this fails LOUDLY here rather than silently not substituting
 * at runtime. Widen the class in src/i18n/interpolate.ts if it trips — don't
 * delete this test.
 */
describe("interpolate — locale token grammar invariant (GH #1029)", () => {
  it("every {token} in en.json and de.json matches the \\w+ token class", async () => {
    const [en, de] = await Promise.all([
      import("@/i18n/locales/en.json"),
      import("@/i18n/locales/de.json"),
    ]);
    const tokens = new Set<string>();
    for (const bundle of [en.default, de.default]) {
      for (const value of Object.values(bundle as Record<string, string>)) {
        if (typeof value !== "string") continue;
        for (const m of value.matchAll(/\{([^}]*)\}/g)) tokens.add(m[1]);
      }
    }
    expect(tokens.size).toBeGreaterThan(0);
    const offenders = [...tokens].filter((t) => !/^\w+$/.test(t));
    expect(offenders).toEqual([]);
  });
});
