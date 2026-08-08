import { describe, it, expect } from "vitest";
import {
  parseIniFilaments,
  INI_TOP_LEVEL_SETTING_KEYS,
  serializeIniValue,
  decodeMultilineWireValue,
  wrapIniString,
  unwrapIniString,
} from "@/lib/parseIni";

describe("parseIniFilaments", () => {
  it("returns empty array for empty content", () => {
    expect(parseIniFilaments("")).toEqual([]);
  });

  it("returns empty array for content with no filament sections", () => {
    const content = `
[print:0.2mm QUALITY]
layer_height = 0.2
perimeters = 3

[printer:My Printer]
bed_shape = 0x0,250x0,250x210,0x210
`;
    expect(parseIniFilaments(content)).toEqual([]);
  });

  it("parses a single filament section with all fields", () => {
    const content = `
[filament:Test PLA]
filament_vendor = TestBrand
filament_type = PLA
filament_colour = #FF0000
filament_cost = 25.99
filament_density = 1.24
filament_diameter = 1.75
temperature = 210
first_layer_temperature = 215
bed_temperature = 60
first_layer_bed_temperature = 65
filament_max_volumetric_speed = 15
inherits = Generic PLA
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "Test PLA",
      vendor: "TestBrand",
      type: "PLA",
      color: "#FF0000",
      cost: 25.99,
      density: 1.24,
      diameter: 1.75,
      temperatures: {
        nozzle: 210,
        nozzleFirstLayer: 215,
        bed: 60,
        bedFirstLayer: 65,
      },
      maxVolumetricSpeed: 15,
      inherits: "Generic PLA",
    });
  });

  it("parses multiple filament sections", () => {
    const content = `
[filament:PLA One]
filament_vendor = VendorA
filament_type = PLA
temperature = 200

[filament:PETG Two]
filament_vendor = VendorB
filament_type = PETG
temperature = 240
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("PLA One");
    expect(result[0].vendor).toBe("VendorA");
    expect(result[1].name).toBe("PETG Two");
    expect(result[1].vendor).toBe("VendorB");
  });

  it("handles nil values correctly", () => {
    const content = `
[filament:Nil Test]
filament_vendor = Test
filament_type = PLA
temperature = nil
filament_cost = nil
filament_density = nil
inherits = nil
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    expect(result[0].temperatures.nozzle).toBeNull();
    expect(result[0].cost).toBeNull();
    expect(result[0].density).toBeNull();
    expect(result[0].inherits).toBeNull();
    // nil values stored as null in settings
    expect(result[0].settings.temperature).toBeNull();
  });

  it("handles missing optional fields with defaults", () => {
    const content = `
[filament:Minimal]
filament_type = ABS
temperature = 250
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    expect(result[0].vendor).toBe("Unknown");
    expect(result[0].color).toBe("#808080");
    expect(result[0].diameter).toBe(1.75);
    expect(result[0].cost).toBeNull();
    expect(result[0].density).toBeNull();
    expect(result[0].temperatures.nozzleFirstLayer).toBeNull();
    expect(result[0].temperatures.bed).toBeNull();
    expect(result[0].temperatures.bedFirstLayer).toBeNull();
    expect(result[0].maxVolumetricSpeed).toBeNull();
    expect(result[0].inherits).toBeNull();
  });

  it("GH #955: ignores in-section comment lines (# and ;) even when they contain =", () => {
    const content = `
[filament:Comment Test]
filament_vendor = Test
filament_type = PLA
# this is a comment = with an equals sign
; another comment = here too
some_real_key = value
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    const settings = result[0].settings;
    // Comment lines must NOT become junk settings keys.
    expect(settings["# this is a comment"]).toBeUndefined();
    expect(settings["; another comment"]).toBeUndefined();
    // A real in-section key is still parsed.
    expect(settings.some_real_key).toBe("value");
    expect(result[0].vendor).toBe("Test");
  });

  it("handles percentage values in numeric fields", () => {
    const content = `
[filament:Percent Test]
filament_vendor = Test
filament_type = PLA
filament_cost = 50%
`;
    const result = parseIniFilaments(content);
    expect(result[0].cost).toBe(50);
  });

  it("handles NaN values gracefully", () => {
    const content = `
[filament:NaN Test]
filament_vendor = Test
filament_type = PLA
filament_cost = notanumber
temperature = abc
`;
    const result = parseIniFilaments(content);
    expect(result[0].cost).toBeNull();
    expect(result[0].temperatures.nozzle).toBeNull();
  });

  it("handles empty string values", () => {
    const content = `
[filament:Empty Test]
filament_vendor = Test
filament_type = PLA
filament_cost =
temperature =
filament_diameter =
`;
    const result = parseIniFilaments(content);
    expect(result[0].cost).toBeNull();
    expect(result[0].temperatures.nozzle).toBeNull();
    expect(result[0].diameter).toBe(1.75); // fallback default
  });

  it("skips non-filament sections between filament sections", () => {
    const content = `
[filament:First]
filament_vendor = A
filament_type = PLA
temperature = 200

[print:Some Print Profile]
layer_height = 0.2

[filament:Second]
filament_vendor = B
filament_type = PETG
temperature = 240
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("First");
    expect(result[1].name).toBe("Second");
  });

  it("stores all raw settings in the settings object", () => {
    const content = `
[filament:Settings Test]
filament_vendor = Test
filament_type = PLA
custom_key = custom_value
another_setting = 42
`;
    const result = parseIniFilaments(content);
    expect(result[0].settings).toMatchObject({
      filament_vendor: "Test",
      filament_type: "PLA",
      custom_key: "custom_value",
      another_setting: "42",
    });
  });

  it("handles values containing equals signs", () => {
    const content = `
[filament:Equals Test]
filament_vendor = Test
filament_type = PLA
some_gcode = G1 X=10 Y=20
`;
    const result = parseIniFilaments(content);
    expect(result[0].settings.some_gcode).toBe("G1 X=10 Y=20");
  });

  it("trims whitespace from keys and values", () => {
    const content = `
[filament:Whitespace Test]
  filament_vendor   =   Trimmed Vendor
  filament_type  =  PLA
  temperature  =  210
`;
    const result = parseIniFilaments(content);
    expect(result[0].vendor).toBe("Trimmed Vendor");
    expect(result[0].type).toBe("PLA");
    expect(result[0].temperatures.nozzle).toBe(210);
  });

  it("handles filament section with no key-value pairs", () => {
    const content = `
[filament:Empty Section]

[filament:Has Data]
filament_vendor = Test
filament_type = PLA
`;
    const result = parseIniFilaments(content);
    // Empty section produces no filament (no settings)
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Has Data");
  });

  it("flushes last filament at end of file", () => {
    const content = `[filament:Last One]
filament_vendor = Final
filament_type = ASA
temperature = 260`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Last One");
    expect(result[0].vendor).toBe("Final");
  });

  it("ignores lines without equals sign in filament section", () => {
    const content = `
[filament:Comment Test]
filament_vendor = Test
filament_type = PLA
# this is a comment
just some text
temperature = 200
`;
    const result = parseIniFilaments(content);
    expect(result[0].settings.filament_vendor).toBe("Test");
    expect(result[0].settings.temperature).toBe("200");
    expect(Object.keys(result[0].settings)).not.toContain("# this is a comment");
  });

  it("handles missing filament_vendor with Unknown default", () => {
    const content = `
[filament:No Vendor]
filament_type = PLA
temperature = 200
`;
    const result = parseIniFilaments(content);
    expect(result[0].vendor).toBe("Unknown");
  });

  it("handles missing filament_type with Unknown default", () => {
    const content = `
[filament:No Type]
filament_vendor = TestVendor
temperature = 200
`;
    const result = parseIniFilaments(content);
    expect(result[0].type).toBe("Unknown");
  });

  // --- #66: empty section name after colon is skipped ---

  it("skips filament section with empty name after colon", () => {
    const content = `
[filament:]
filament_vendor = Ghost
filament_type = PLA
temperature = 200

[filament:Real Filament]
filament_vendor = Legit
filament_type = PETG
temperature = 240
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Real Filament");
    expect(result[0].vendor).toBe("Legit");
  });

  it("skips filament section with whitespace-only name after colon", () => {
    const content = `
[filament:   ]
filament_vendor = Ghost
filament_type = PLA
temperature = 200
`;
    const result = parseIniFilaments(content);
    expect(result).toHaveLength(0);
  });

  // GH #951 (Codex R2-B): INI_TOP_LEVEL_SETTING_KEYS is the source of truth the
  // bulk importers use to strip settings-bag shadows of top-level fields. It
  // MUST list exactly the keys flushFilament lifts into a top-level FilamentData
  // field — otherwise a listed-but-not-extracted key would be lost on import, or
  // an extracted-but-unlisted key would keep leaking a stale shadow.
  it("INI_TOP_LEVEL_SETTING_KEYS matches the keys parseIni lifts to top-level fields", () => {
    const ini = `[filament:Lockstep]
filament_vendor = Acme
filament_type = PLA
filament_colour = #123456
filament_cost = 25
filament_density = 1.24
filament_diameter = 1.6
filament_max_volumetric_speed = 15
temperature = 210
first_layer_temperature = 215
bed_temperature = 60
first_layer_bed_temperature = 65
inherits = *PLA*
`;
    const [f] = parseIniFilaments(ini);
    // Every listed key resolves to a populated (non-default) top-level field.
    expect(f.vendor).toBe("Acme");
    expect(f.type).toBe("PLA");
    expect(f.color).toBe("#123456");
    expect(f.cost).toBe(25);
    expect(f.density).toBe(1.24);
    expect(f.diameter).toBe(1.6);
    expect(f.maxVolumetricSpeed).toBe(15);
    expect(f.temperatures.nozzle).toBe(210);
    expect(f.temperatures.nozzleFirstLayer).toBe(215);
    expect(f.temperatures.bed).toBe(60);
    expect(f.temperatures.bedFirstLayer).toBe(65);
    expect(f.inherits).toBe("*PLA*");
    // The exact set (guards drift in either direction).
    expect([...INI_TOP_LEVEL_SETTING_KEYS].sort()).toEqual([
      "bed_temperature",
      "filament_colour",
      "filament_cost",
      "filament_density",
      "filament_diameter",
      "filament_max_volumetric_speed",
      "filament_shrinkage_compensation_xy",
      "filament_shrinkage_compensation_z",
      "filament_spool_weight",
      "filament_type",
      "filament_vendor",
      "first_layer_bed_temperature",
      "first_layer_temperature",
      "inherits",
      "temperature",
    ]);
  });

  // GH #951 (Codex R3): spool weight + shrinkage are lifted to top-level so
  // their settings-bag shadow can be stripped without data loss.
  it("lifts filament_spool_weight and filament_shrinkage_* to top-level fields", () => {
    const ini = `[filament:Lift]
filament_type = PLA
filament_vendor = Acme
filament_spool_weight = 250
filament_shrinkage_compensation_xy = 0.3%
filament_shrinkage_compensation_z = 0.5%
`;
    const [f] = parseIniFilaments(ini);
    expect(f.spoolWeight).toBe(250);
    // parseNum strips the trailing '%', matching the form + per-id sync handling.
    expect(f.shrinkageXY).toBe(0.3);
    expect(f.shrinkageZ).toBe(0.5);
  });

  it("leaves spool weight + shrinkage UNDEFINED (not null) when the INI omits them — no-clobber guard", () => {
    const ini = `[filament:NoLift]
filament_type = PLA
filament_vendor = Acme
`;
    const [f] = parseIniFilaments(ini);
    // undefined (key absent) — NOT null — so the importer's $set omits them and
    // can't clobber an existing top-level value on a root/resurrected filament.
    expect("spoolWeight" in f).toBe(false);
    expect("shrinkageXY" in f).toBe(false);
    expect("shrinkageZ" in f).toBe(false);
  });

  // --- GH #1070: the bag stores WIRE form — imported values stay verbatim ---
  // (Codex P2s on PR #1086 killed an earlier decode-on-import revision: it
  // flipped a quoted "nil" into the bare nil marker on the next export,
  // stripped literal boundary quotes, and broke splitInheritedImportSet's
  // strict-equality comparison against a parent's form-stored wire value.)

  it("GH #1070: stores a quoted escaped value VERBATIM (wire-canonical bag)", () => {
    const ini = `[filament:Escaped]
filament_type = PLA
filament_vendor = Acme
start_filament_gcode = "; setup\\nM572 S0.04\\n; done"
`;
    const [f] = parseIniFilaments(ini);
    expect(f.settings.start_filament_gcode).toBe('"; setup\\nM572 S0.04\\n; done"');
  });

  it("GH #1070: a QUOTED \"nil\" stays the literal wire string, never the nil marker", () => {
    const ini = `[filament:QuotedNil]
filament_type = PLA
filament_vendor = Acme
filament_notes = "nil"
`;
    const [f] = parseIniFilaments(ini);
    expect(f.settings.filament_notes).toBe('"nil"');
  });
});

describe("serializeIniValue (GH #1070)", () => {

  it("serializes a single-line value BYTE-IDENTICAL (fast path)", () => {
    // Already-escaped fork-shaped value: literal backslash-n, quoted — the
    // exact bytes PrusaSlicer sends on sync-back. Must never double-escape.
    expect(serializeIniValue('"; setup\\nM572 S0.04"')).toBe('"; setup\\nM572 S0.04"');
    // Unquoted single-line values with quotes/backslashes also pass through.
    expect(serializeIniValue("G1 X=10")).toBe("G1 X=10");
    expect(serializeIniValue('say "hi" \\ there')).toBe('say "hi" \\ there');
  });

  it("escapes + wraps a raw multi-line unquoted value", () => {
    expect(serializeIniValue("line one\nline two")).toBe('"line one\\nline two"');
  });

  it("escapes a raw carriage return", () => {
    expect(serializeIniValue("a\rb")).toBe('"a\\rb"');
  });

  it("unwraps a legacy form-wrapped raw multi-line value before escaping (no literal quote leakage)", () => {
    // Pre-#1070 FilamentForm stored `"${textarea}"` — outer quotes are the
    // WRAPPER. Interior raw quotes and backslashes are content and get escaped.
    // The strip is KEY-SCOPED to the three keys the form actually wrote (r9).
    expect(serializeIniValue('"line one\nsay "hi"\\done"', "filament_notes")).toBe(
      '"line one\\nsay \\"hi\\"\\\\done"',
    );
    expect(serializeIniValue('"a\nb"', "start_filament_gcode")).toBe('"a\\nb"');
    expect(serializeIniValue('"a\nb"', "end_filament_gcode")).toBe('"a\\nb"');
  });

  it("preserves boundary quotes as CONTENT on non-form keys (Codex P2 r9)", () => {
    // A pre-upgrade generic-API / Bambu-import row could hold raw multi-line
    // content that genuinely begins and ends with quotes on some OTHER key —
    // the form never wrote that key, so those quotes can't be a wrapper.
    expect(serializeIniValue('"first\nlast"', "custom_note")).toBe(
      '"\\"first\\nlast\\""',
    );
    // No key (direct/unknown caller) — same conservative posture.
    expect(serializeIniValue('"first\nlast"')).toBe('"\\"first\\nlast\\""');
    // Unquoted raw multi-line on a non-form key still escapes normally.
    expect(serializeIniValue("a\nb", "custom_note")).toBe('"a\\nb"');
  });

  it("round-trips: serializeIniValue output re-imports byte-identically (wire-canonical)", () => {
    // Whatever the emitter produces is a single-line wire value; a re-import
    // stores it verbatim and the next export passes it through the fast
    // path unchanged — export → import → export is stable by construction.
    const raw = 'line one\nkey = value\n[filament:Other]\nsay "hi" \\ end\rcr';
    const wire = serializeIniValue(raw);
    expect(wire.includes("\n")).toBe(false);
    expect(serializeIniValue(wire)).toBe(wire);
  });

  it("round-trips: the form codec decodes what the emitter produced", () => {
    // unwrapIniString is the ONLY decoder (form display); it restores the
    // raw content the emitter escaped, including the injection payload.
    const raw = 'line one\nkey = value\n[filament:Other]\nsay "hi" \\ end\rcr';
    expect(unwrapIniString(serializeIniValue(raw))).toBe(raw);
  });
});

describe("decodeMultilineWireValue (GH #1070 r3, Orca/Bambu JSON export decode)", () => {
  it("decodes a clean-quoted multi-line wire value to raw content", () => {
    expect(decodeMultilineWireValue('"a\\nb"')).toBe("a\nb");
    expect(decodeMultilineWireValue('"a\\rb"')).toBe("a\rb");
    expect(decodeMultilineWireValue('"\\"first\\nlast\\""')).toBe('"first\nlast"');
  });

  it("leaves single-line quoted values verbatim (Orca round-trip byte-identity)", () => {
    expect(decodeMultilineWireValue('"quoted single line"')).toBe('"quoted single line"');
    expect(decodeMultilineWireValue('"say \\"hi\\""')).toBe('"say \\"hi\\""');
  });

  it("leaves non-clean shapes verbatim (vectors, expressions, unterminated, unquoted)", () => {
    expect(decodeMultilineWireValue('"A";"B"')).toBe('"A";"B"');
    expect(decodeMultilineWireValue('"PLA"=="PLA"')).toBe('"PLA"=="PLA"');
    expect(decodeMultilineWireValue('"abc\\"')).toBe('"abc\\"');
    expect(decodeMultilineWireValue('"abc')).toBe('"abc');
    expect(decodeMultilineWireValue('"')).toBe('"');
    expect(decodeMultilineWireValue("plain")).toBe("plain");
  });

  it("returns a legacy raw wrap with non-canonical escapes VERBATIM (Codex P2 r10)", () => {
    // Same distinction as unwrapIniString (r5), now on the JSON-export
    // decode: `\t` proves a pre-#1070 raw wrap whose `\n` is literal
    // Windows-path content, not an escape — decoding corrupted it.
    expect(decodeMultilineWireValue('"Use C:\\new\\tool"')).toBe(
      '"Use C:\\new\\tool"',
    );
    // A raw wrap holding BOTH literal backslashes and a real newline.
    expect(decodeMultilineWireValue('"C:\\temp\nline2"')).toBe(
      '"C:\\temp\nline2"',
    );
  });

  it("ACCEPTED RESIDUE (r8): wire-lookalike literal content decodes as wire", () => {
    // A JSON value whose LITERAL text is `"a\nb"` (quotes + backslash as
    // characters) is byte-identical to Prusa wire — no provenance bit can
    // tell them apart. Wire wins by deliberate bias: every pre-#1070 export
    // wrote wire into Orca/Bambu JSON verbatim, so wire-shaped strings in
    // real profiles are overwhelmingly actual wire that MUST decode; see
    // decodeMultilineWireValue's docblock before "fixing" this.
    expect(decodeMultilineWireValue('"a\\nb"')).toBe("a\nb");
  });

  it("never decodes \\t as a tab — verbatim path, matching upstream semantics (r8/r10)", () => {
    // prusa3d/PrusaSlicer src/libslic3r/Config.cpp special-cases ONLY r/n
    // and its escaper never produces \t (real tabs ride raw) — so a `\t`
    // escape can't come from a canonical writer. Since r10 that means the
    // whole value routes to the VERBATIM branch (a legacy raw wrap) rather
    // than being unescaped at all; bytes are preserved, never turned into
    // a tab.
    expect(decodeMultilineWireValue('"a\\tb\\nc"')).toBe('"a\\tb\\nc"');
    // A real tab in content survives the wrap round-trip raw + unescaped.
    expect(wrapIniString("col1\tcol2\nrow2")).toBe('"col1\tcol2\\nrow2"');
    expect(unwrapIniString('"col1\tcol2\\nrow2"')).toBe("col1\tcol2\nrow2");
  });
});

describe("wrapIniString / unwrapIniString (GH #1070, FilamentForm codec)", () => {
  it("wraps raw textarea content into the quoted-escaped wire form", () => {
    expect(wrapIniString("simple note")).toBe('"simple note"');
    expect(wrapIniString('line one\nsay "hi"')).toBe('"line one\\nsay \\"hi\\""');
    expect(wrapIniString("back\\slash\rcr")).toBe('"back\\\\slash\\rcr"');
  });

  it("unwrap is the inverse of wrap (identity round-trip)", () => {
    const samples = [
      "simple",
      'line one\nline two\nsay "hi"',
      "back\\slash",
      "a\rb",
      'temperature = 250 works best\n[filament:Other]',
    ];
    for (const s of samples) {
      expect(unwrapIniString(wrapIniString(s))).toBe(s);
    }
  });

  it("returns an unquoted value verbatim (legacy raw bag values)", () => {
    expect(unwrapIniString("120 100 6.6 6.8")).toBe("120 100 6.6 6.8");
    expect(unwrapIniString("")).toBe("");
  });

  it("leniently unwraps a legacy hand-wrapped value with interior raw quotes", () => {
    // Pre-#1070 form output for a note containing quotes: `"say "hi""` —
    // NOT a cleanly-escaped string, but the outer quotes are still the wrapper.
    expect(unwrapIniString('"say "hi""')).toBe('say "hi"');
  });

  it("unwraps + unescapes a fork-shaped multi-line gcode for the textarea", () => {
    expect(unwrapIniString('"; setup\\nM572 S0.04"')).toBe("; setup\nM572 S0.04");
  });

  it("leaves a lone quote character verbatim (too short to be wrapped)", () => {
    expect(unwrapIniString('"')).toBe('"');
  });

  it("preserves a trailing lone backslash when leniently unwrapping malformed content", () => {
    // `"abc\"` — lenient unwrap slices to `abc\`; the dangling backslash has
    // nothing to escape and is kept verbatim.
    expect(unwrapIniString('"abc\\"')).toBe("abc\\");
  });

  it("returns a legacy raw wrap with non-canonical escapes VERBATIM (Codex P2 r5)", () => {
    // Pre-#1070 form output for a Windows path: `"Use C:\new\tool"` — the
    // `\t` proves no canonical escaper produced this (they emit only
    // \\ \" \n \r), so the raw content comes back untouched instead of
    // `\n` rendering as a newline and `\t` losing its backslash.
    expect(unwrapIniString('"Use C:\\new\\tool"')).toBe("Use C:\\new\\tool");
    // ... and a later edit re-encodes CANONICALLY, healing the wire value.
    expect(wrapIniString("Use C:\\new\\tool")).toBe('"Use C:\\\\new\\\\tool"');
  });

  it("still decodes canonical-only escapes as wire (the ambiguous case)", () => {
    // `"C:\new"` raw vs canonical are byte-identical; wire semantics win —
    // this is exactly what PrusaSlicer's unescape reads from those bytes.
    expect(unwrapIniString('"C:\\new"')).toBe("C:\new");
    expect(unwrapIniString('"C:\\\\tool"')).toBe("C:\\tool");
  });

  it("serializes a bare newline (shorter than a quoted wrapper) via the unquoted path", () => {
    expect(serializeIniValue("\n")).toBe('"\\n"');
  });
});
