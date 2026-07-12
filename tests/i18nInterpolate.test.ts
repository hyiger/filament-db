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
