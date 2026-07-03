import { describe, it, expect } from "vitest";
import {
  validateSpoolBody,
  isValidIsoDateString,
  validateSpoolPhotoDataUrl,
  MAX_SPOOL_TEXT_LENGTH,
} from "@/lib/validateSpoolBody";

describe("validateSpoolBody (POST semantics)", () => {
  it("accepts an empty body and defaults label/totalWeight", () => {
    const r = validateSpoolBody({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBe("");
    expect(r.totalWeight).toBe(null);
  });

  it("accepts a well-formed body", () => {
    const r = validateSpoolBody({ label: "Spool A", totalWeight: 1250 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBe("Spool A");
    expect(r.totalWeight).toBe(1250);
  });

  it("accepts totalWeight: null explicitly", () => {
    const r = validateSpoolBody({ label: "X", totalWeight: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalWeight).toBe(null);
  });

  it("rejects non-string label", () => {
    const r = validateSpoolBody({ label: 123, totalWeight: 100 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/label/);
  });

  it("rejects non-numeric totalWeight", () => {
    const r = validateSpoolBody({ label: "X", totalWeight: "abc" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/totalWeight/);
  });

  it("rejects NaN and Infinity totalWeight", () => {
    expect(validateSpoolBody({ totalWeight: NaN }).ok).toBe(false);
    expect(validateSpoolBody({ totalWeight: Infinity }).ok).toBe(false);
    expect(validateSpoolBody({ totalWeight: -Infinity }).ok).toBe(false);
  });

  it("rejects negative totalWeight", () => {
    const r = validateSpoolBody({ totalWeight: -50 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/non-negative/);
  });

  it("rejects a non-object body", () => {
    expect(validateSpoolBody(null).ok).toBe(false);
    expect(validateSpoolBody("not an object").ok).toBe(false);
    expect(validateSpoolBody([1, 2, 3]).ok).toBe(false);
    expect(validateSpoolBody(42).ok).toBe(false);
  });

  it("passes through optional string fields", () => {
    const r = validateSpoolBody({
      lotNumber: "L123",
      purchaseDate: "2025-01-01",
      openedDate: "2025-02-01",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lotNumber).toBe("L123");
    expect(r.purchaseDate).toBe("2025-01-01");
    expect(r.openedDate).toBe("2025-02-01");
  });

  it("accepts null for optional string fields", () => {
    const r = validateSpoolBody({ lotNumber: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lotNumber).toBe(null);
  });

  it("rejects non-string optional fields", () => {
    expect(validateSpoolBody({ lotNumber: 12345 }).ok).toBe(false);
    expect(validateSpoolBody({ purchaseDate: { invalid: true } }).ok).toBe(false);
  });

  // GH #953: cap the free-form spool text fields so an unbounded string can't
  // persist (and then bloat the /api/filaments list projection, exports, sync).
  it("accepts label/lotNumber at exactly the length cap", () => {
    const atCap = "x".repeat(MAX_SPOOL_TEXT_LENGTH);
    const r = validateSpoolBody({ label: atCap, lotNumber: atCap });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBe(atCap);
    expect(r.lotNumber).toBe(atCap);
  });

  it("rejects a label over the length cap", () => {
    const r = validateSpoolBody({ label: "x".repeat(MAX_SPOOL_TEXT_LENGTH + 1) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/label must be \d+ characters or fewer/);
  });

  it("rejects a lotNumber over the length cap", () => {
    const r = validateSpoolBody({ lotNumber: "x".repeat(MAX_SPOOL_TEXT_LENGTH + 1) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/lotNumber must be \d+ characters or fewer/);
  });

  it("caps label on PUT (partial) semantics too", () => {
    const r = validateSpoolBody(
      { label: "x".repeat(MAX_SPOOL_TEXT_LENGTH + 1) },
      { partial: true },
    );
    expect(r.ok).toBe(false);
  });

  // GH #372: date strings must parse to a real date, not just be string-shaped.
  // Pre-fix, "not a date" / "2024-13-99" rode through to Mongoose and either
  // saved as "Invalid Date" or broke downstream consumers.
  it("rejects un-parseable date strings", () => {
    for (const bad of ["not a date", "2024-13-99", "yesterday", "abc123"]) {
      const r1 = validateSpoolBody({ purchaseDate: bad });
      expect(r1.ok, `purchaseDate=${bad}`).toBe(false);
      if (r1.ok) continue;
      expect(r1.error).toMatch(/purchaseDate/);

      const r2 = validateSpoolBody({ openedDate: bad });
      expect(r2.ok, `openedDate=${bad}`).toBe(false);
    }
  });

  // GH #372 (Codex follow-up): the original check used `new Date(s)` only,
  // which silently NORMALISES out-of-range calendar dates ("2025-02-29"
  // becomes March 1 in a non-leap year). A typoed date used to pass and
  // persist as a different day — exactly the silent corruption the
  // validator was supposed to prevent.
  it("rejects ISO-shaped but impossible calendar dates", () => {
    for (const bad of [
      "2025-02-29",  // Feb 29 in non-leap year → silently became Mar 1
      "2023-02-30",  // Feb 30 doesn't exist
      "2025-04-31",  // Apr has 30 days
      "2025-13-01",  // month 13
      "2025-00-15",  // month 0
      "2025-01-00",  // day 0
      "2025-01-32",  // day 32
    ]) {
      const r = validateSpoolBody({ purchaseDate: bad });
      expect(r.ok, `expected ${bad} to be rejected`).toBe(false);
    }
  });

  it("accepts ISO-shaped date strings", () => {
    for (const good of [
      "2025-01-01",
      "2025-01-01T12:34:56Z",
      "2025-12-31T23:59:59.000Z",
      "2024-02-29",       // leap year — Feb 29 is real
      "2000-02-29",       // century leap year
      "2025-03-15T08:00:00+05:30",  // ISO with positive offset
    ]) {
      const r = validateSpoolBody({ purchaseDate: good, openedDate: good });
      expect(r.ok, `expected ${good} to be accepted`).toBe(true);
    }
  });

  it("still accepts null for date fields", () => {
    const r = validateSpoolBody({ purchaseDate: null, openedDate: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.purchaseDate).toBeNull();
    expect(r.openedDate).toBeNull();
  });
});

// Direct unit coverage for the helper. The validateSpoolBody tests above
// already exercise the end-to-end path; these target the helper itself
// because the import route also calls it directly.
describe("isValidIsoDateString", () => {
  it("accepts well-formed YYYY-MM-DD", () => {
    expect(isValidIsoDateString("2025-01-01")).toBe(true);
    expect(isValidIsoDateString("2024-02-29")).toBe(true);
    expect(isValidIsoDateString("1999-12-31")).toBe(true);
  });

  it("accepts full ISO 8601 timestamps", () => {
    expect(isValidIsoDateString("2025-01-01T00:00:00Z")).toBe(true);
    expect(isValidIsoDateString("2025-01-01T12:34:56.789Z")).toBe(true);
    expect(isValidIsoDateString("2025-01-01T12:34:56-05:00")).toBe(true);
    expect(isValidIsoDateString("2025-01-01T12:34:56+0530")).toBe(true);
  });

  it("rejects calendar-impossible dates that JS Date silently normalises", () => {
    expect(isValidIsoDateString("2025-02-29")).toBe(false);  // not leap
    expect(isValidIsoDateString("2023-02-30")).toBe(false);
    expect(isValidIsoDateString("2025-04-31")).toBe(false);
    expect(isValidIsoDateString("2025-13-01")).toBe(false);
    expect(isValidIsoDateString("2025-00-15")).toBe(false);
    expect(isValidIsoDateString("2025-01-32")).toBe(false);
    expect(isValidIsoDateString("2025-01-00")).toBe(false);
  });

  it("rejects free-form and non-ISO inputs", () => {
    expect(isValidIsoDateString("yesterday")).toBe(false);
    expect(isValidIsoDateString("01/15/2025")).toBe(false);
    expect(isValidIsoDateString("15-01-2025")).toBe(false);
    expect(isValidIsoDateString("")).toBe(false);
    expect(isValidIsoDateString("1737936000")).toBe(false);  // unix epoch as string
  });

  it("rejects malformed time portions", () => {
    expect(isValidIsoDateString("2025-01-01T25:00:00Z")).toBe(false);  // bad hour
    expect(isValidIsoDateString("2025-01-01T12:61:00Z")).toBe(false);  // bad minute
  });

  // GH #524.2: ECMA-262 aliases T24:00[:00] to 00:00 of the next day, so
  // `new Date(...)` accepts it (a silent +1-day shift) — the isNaN check at
  // line 97 does NOT catch it. The explicit hour>=24 guard rejects it.
  it("rejects T24:00 aliasing (silent +1-day shift)", () => {
    expect(isValidIsoDateString("2025-01-01T24:00Z")).toBe(false);
    expect(isValidIsoDateString("2025-01-01T24:00:00Z")).toBe(false);
    expect(isValidIsoDateString("2025-01-01T24:00:00.000Z")).toBe(false);
    // A time portion with no explicit Z/offset still trips the guard.
    expect(isValidIsoDateString("2025-01-01T24:00")).toBe(false);
    // Boundary: hour 23 with a valid time is still accepted.
    expect(isValidIsoDateString("2025-01-01T23:00:00Z")).toBe(true);
  });

  // Codex P3 on PR #375: Date.UTC has a legacy 2-digit-year remap that
  // would silently shift years 0-99 into 1900-1999, falsely rejecting
  // valid 4-digit ISO inputs like "0099-12-31". The helper now uses
  // setUTCFullYear which takes the year verbatim.
  it("accepts years 0000-0099 (no Date.UTC 2-digit remap)", () => {
    expect(isValidIsoDateString("0099-12-31")).toBe(true);
    expect(isValidIsoDateString("0050-06-15")).toBe(true);
    expect(isValidIsoDateString("0001-01-01")).toBe(true);
    expect(isValidIsoDateString("0000-01-01")).toBe(true);
    // Impossible-day rules still apply in the low-year range.
    expect(isValidIsoDateString("0050-02-30")).toBe(false);
  });
});

// Direct coverage for the extracted photo-URL helper (GH #626) — shared with
// the embedded-spool write paths, so it's a public entry point in its own right.
describe("validateSpoolPhotoDataUrl", () => {
  it("passes undefined through as undefined (field absent)", () => {
    const r = validateSpoolPhotoDataUrl(undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeUndefined();
  });

  it("passes null through as null", () => {
    const r = validateSpoolPhotoDataUrl(null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
  });

  it("rejects a non-string value", () => {
    for (const bad of [42, {}, [], true]) {
      const r = validateSpoolPhotoDataUrl(bad);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toMatch(/photoDataUrl must be a string or null/);
    }
  });

  it("normalises empty string to null", () => {
    const r = validateSpoolPhotoDataUrl("");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
  });

  it("accepts a valid raster data URL verbatim", () => {
    const url = "data:image/png;base64,AAAA";
    const r = validateSpoolPhotoDataUrl(url);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(url);
  });
});

describe("validateSpoolBody (PUT semantics with partial: true)", () => {
  it("does not default missing fields", () => {
    const r = validateSpoolBody({}, { partial: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBeUndefined();
    expect(r.totalWeight).toBeUndefined();
  });

  it("validates only fields that are present", () => {
    const r = validateSpoolBody({ totalWeight: 500 }, { partial: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalWeight).toBe(500);
    expect(r.label).toBeUndefined();
  });

  it("still rejects invalid types in partial mode", () => {
    expect(validateSpoolBody({ totalWeight: "x" }, { partial: true }).ok).toBe(false);
    expect(validateSpoolBody({ label: false }, { partial: true }).ok).toBe(false);
  });

  // Guard: the allow-list MIME regex in validateSpoolBody is narrower than
  // "image/*" specifically so `image/svg+xml` can't slip through — SVGs
  // can embed <script> that runs if the data URL is ever rendered in a
  // context that doesn't treat it as a bitmap image.

  it("accepts common raster image data URLs", () => {
    for (const mime of ["jpeg", "jpg", "png", "gif", "webp", "avif", "heic", "heif"]) {
      const r = validateSpoolBody({
        photoDataUrl: `data:image/${mime};base64,AAAA`,
      });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects SVG data URLs", () => {
    const r = validateSpoolBody({
      photoDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects non-image data URLs", () => {
    const r = validateSpoolBody({
      photoDataUrl: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects photoDataUrl over 5MB", () => {
    const huge = "data:image/jpeg;base64," + "A".repeat(6 * 1024 * 1024);
    const r = validateSpoolBody({ photoDataUrl: huge });
    expect(r.ok).toBe(false);
  });

  it("treats empty photoDataUrl as null (UI clear-button path)", () => {
    const r = validateSpoolBody({ photoDataUrl: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.photoDataUrl).toBeNull();
  });

  it("rejects a non-string, non-null photoDataUrl via validateSpoolBody", () => {
    const r = validateSpoolBody({ photoDataUrl: 12345 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/photoDataUrl must be a string or null/);
  });

  // locationId: string (an ObjectId) or null.
  it("accepts locationId: null explicitly", () => {
    const r = validateSpoolBody({ locationId: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.locationId).toBeNull();
  });

  it("accepts a string locationId", () => {
    const r = validateSpoolBody({ locationId: "507f1f77bcf86cd799439011" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.locationId).toBe("507f1f77bcf86cd799439011");
  });

  it("rejects a non-string, non-null locationId", () => {
    const r = validateSpoolBody({ locationId: 42 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/locationId must be a string or null/);
  });

  // retired: boolean.
  it("accepts a boolean retired flag", () => {
    const rTrue = validateSpoolBody({ retired: true });
    expect(rTrue.ok).toBe(true);
    if (rTrue.ok) expect(rTrue.retired).toBe(true);

    const rFalse = validateSpoolBody({ retired: false });
    expect(rFalse.ok).toBe(true);
    if (rFalse.ok) expect(rFalse.retired).toBe(false);
  });

  it("rejects a non-boolean retired flag", () => {
    const r = validateSpoolBody({ retired: "yes" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/retired must be a boolean/);
  });

  // #732 Phase 4: user-entered/edited spool instanceId + regenerate.
  describe("instanceId (#732 Phase 4)", () => {
    const ok = (v: unknown) => validateSpoolBody({ instanceId: v });

    it("accepts a numeric Prusa roll id, hex, and a custom id", () => {
      for (const id of ["1086170252", "a1b2c3d4e5", "drybox-A.1", "X_2"]) {
        const r = ok(id);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.instanceId).toBe(id);
      }
    });

    it("trims surrounding whitespace", () => {
      const r = ok("  abc123  ");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.instanceId).toBe("abc123");
    });

    it("accepts a 128-char id and rejects 129", () => {
      expect(ok("a".repeat(128)).ok).toBe(true);
      const tooLong = ok("a".repeat(129));
      expect(tooLong.ok).toBe(false);
      if (!tooLong.ok) expect(tooLong.error).toMatch(/128/);
    });

    it("rejects empty / whitespace-only", () => {
      expect(ok("").ok).toBe(false);
      expect(ok("   ").ok).toBe(false);
    });

    it("rejects disallowed characters", () => {
      for (const bad of ["foo@bar", "has space", "slash/x", "semi;colon", "quote'x"]) {
        const r = ok(bad);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/letters, numbers/);
      }
    });

    it("rejects a non-string instanceId", () => {
      expect(ok(123).ok).toBe(false);
      expect(ok({}).ok).toBe(false);
    });

    it("parses regenerate:true and ignores any instanceId supplied alongside", () => {
      const r = validateSpoolBody({ regenerate: true, instanceId: "ignored123" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.regenerate).toBe(true);
      expect(r.instanceId).toBeUndefined();
    });

    it("rejects a non-boolean regenerate", () => {
      expect(validateSpoolBody({ regenerate: "yes" }).ok).toBe(false);
    });
  });
});
