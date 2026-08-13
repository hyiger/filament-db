import { describe, it, expect } from "vitest";
import {
  getDbNameFromUri,
  isDuplicateKeyError,
  wrapSyncErrorMessage,
} from "../electron/sync-service";
import { strandedPlaceholderNotice, withStrandingNotice } from "@/lib/renameStaging";

describe("getDbNameFromUri", () => {
  it("extracts db name from a basic mongodb URI with explicit path", () => {
    expect(getDbNameFromUri("mongodb://localhost:27017/my-db")).toBe("my-db");
  });

  it("extracts db name from a mongodb+srv URI", () => {
    expect(
      getDbNameFromUri("mongodb+srv://user:pass@cluster.mongodb.net/prod-db")
    ).toBe("prod-db");
  });

  it("preserves the explicit db name across query strings", () => {
    expect(
      getDbNameFromUri(
        "mongodb+srv://user:pass@cluster.mongodb.net/prod-db?retryWrites=true&w=majority"
      )
    ).toBe("prod-db");
  });

  it("falls back to filament-db when URI has no explicit path", () => {
    expect(getDbNameFromUri("mongodb://localhost:27017")).toBe("filament-db");
    expect(getDbNameFromUri("mongodb://localhost:27017/")).toBe("filament-db");
    expect(
      getDbNameFromUri("mongodb+srv://user:pass@cluster.mongodb.net")
    ).toBe("filament-db");
    expect(
      getDbNameFromUri(
        "mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true"
      )
    ).toBe("filament-db");
  });

  it("falls back to filament-db for malformed URIs", () => {
    expect(getDbNameFromUri("not-a-uri")).toBe("filament-db");
    expect(getDbNameFromUri("")).toBe("filament-db");
  });

  it("handles URIs with special characters in the auth portion", () => {
    expect(
      getDbNameFromUri(
        "mongodb+srv://user%40example.com:p%40ss@cluster.mongodb.net/my-db"
      )
    ).toBe("my-db");
  });

  it("handles db names with hyphens, underscores, and dots", () => {
    expect(getDbNameFromUri("mongodb://localhost/my-db_v2.prod")).toBe(
      "my-db_v2.prod"
    );
  });

  // GH #1071: a multi-host authority (self-hosted replica set, or
  // Atlas's non-SRV form) contains a comma, which made the old
  // `new URL()`-based parse THROW — so hybrid sync silently fell back
  // to "filament-db" and targeted the wrong database on the cluster.
  // The driver's own ConnectionString parser handles it.
  it("extracts db name from a multi-host replica-set URI (GH #1071)", () => {
    expect(
      getDbNameFromUri("mongodb://u:p@h1:27017,h2:27017/mydb?replicaSet=rs0")
    ).toBe("mydb");
  });

  it("extracts db name from a three-host URI without credentials", () => {
    expect(
      getDbNameFromUri("mongodb://h1:27017,h2:27017,h3:27017/prod-db")
    ).toBe("prod-db");
  });

  it("falls back to filament-db for a multi-host URI with no db path", () => {
    expect(getDbNameFromUri("mongodb://h1:27017,h2:27017")).toBe(
      "filament-db"
    );
  });
});

describe("wrapSyncErrorMessage", () => {
  it("wraps the Atlas read-only driver message into an actionable hint", () => {
    const err = new Error(
      "user is not allowed to do action [update] on [filament-db.filaments]"
    );
    const wrapped = wrapSyncErrorMessage(err, "filament-db");

    expect(wrapped).toContain("filament-db");
    expect(wrapped).toContain("readWrite");
    expect(wrapped).toContain("Settings → Connection");
    expect(wrapped).not.toContain("user is not allowed to do action");
  });

  it("wraps errors carrying MongoDB code 13 (Unauthorized) even without the matching message", () => {
    // Real MongoServerError shape: a plain Error decorated with a numeric code
    const err = Object.assign(new Error("Unauthorized"), { code: 13 });
    const wrapped = wrapSyncErrorMessage(err, "prod-db");

    expect(wrapped).toContain("prod-db");
    expect(wrapped).toContain("readWrite");
  });

  it("redacts mongodb URIs in non-auth error messages", () => {
    const err = new Error(
      "connection failed to mongodb+srv://user:secret@cluster.mongodb.net/db"
    );
    const wrapped = wrapSyncErrorMessage(err, "filament-db");

    expect(wrapped).not.toContain("secret");
    expect(wrapped).not.toContain("user:");
    expect(wrapped).toContain("mongodb://***");
  });

  it("falls back to a generic message for non-Error throws", () => {
    expect(wrapSyncErrorMessage("oops", "filament-db")).toBe("Sync failed");
    expect(wrapSyncErrorMessage(undefined, "filament-db")).toBe("Sync failed");
  });

  it("is not steered by a user-typed name inside a coded error (GH #1154)", () => {
    // An E11000 echoes the offending value verbatim, so a row literally named
    // "user is not allowed to do action" used to convert a name collision
    // into the Atlas-permissions hint — stored data steering the message. A
    // present numeric code (11000) is now authoritative: not auth.
    const err = Object.assign(
      new Error(
        'E11000 duplicate key error collection: filament-db.filaments index: name_1 dup key: { name: "user is not allowed to do action" }',
      ),
      { code: 11000, keyPattern: { name: 1 } },
    );
    const wrapped = wrapSyncErrorMessage(err, "filament-db");
    expect(wrapped).toContain("E11000");
    expect(wrapped).toContain("user is not allowed to do action"); // the NAME, quoted back
    expect(wrapped).not.toContain("read permission");
    expect(wrapped).not.toContain("readWrite");
  });

  it("keeps the hostile-name suppression through a stranding composition", () => {
    // The cause read-through must apply the same rule: the hostile E11000 as
    // the CAUSE of a stranded-placeholder error keeps the stranding AND the
    // duplicate-key text, and still produces no auth hint.
    const cause = Object.assign(
      new Error('E11000 dup key: { name: "user is not allowed to do action" }'),
      { code: 11000 },
    );
    const wrapped = wrapSyncErrorMessage(
      withStrandingNotice(cause, strandedPlaceholderNotice({
        collection: "bedtypes",
        id: "64b7f0000000000000000001",
        originalName: "Textured PEI",
        placeholderName: "__sync-staging-64b7f0000000000000000001-abc",
      })),
      "filament-db",
    );
    expect(wrapped).toMatch(/rename it back manually/i);
    expect(wrapped).toContain("E11000");
    expect(wrapped).not.toContain("read permission");
  });

  it("still produces the hint for AtlasError 8000 with the matching message", () => {
    // Atlas's shared-tier proxy raises unauthorized writes as code 8000 with
    // a message IT authors — never echoing document values. A literal
    // "code-first, regex only when code is absent" would drop the hint
    // exactly where GH #143 needed it, and CI would not notice, because
    // every other auth test here models the error as code-less.
    const err = Object.assign(
      new Error("user is not allowed to do action [update] on [prod-db.filaments]"),
      { code: 8000, codeName: "AtlasError" },
    );
    const wrapped = wrapSyncErrorMessage(err, "prod-db");
    expect(wrapped).toContain('only has read permission for "prod-db"');
    expect(wrapped).toContain("readWrite");
  });

  it("suppresses the regex for any other numeric code carrying the phrase", () => {
    // The general rule the two cases above instantiate: a coded, non-13,
    // non-8000 error is whatever its code says it is, even if its text
    // happens to contain the magic phrase.
    const err = Object.assign(
      new Error('Path validation failed: "user is not allowed to do action" is not a valid value'),
      { code: 121 },
    );
    const wrapped = wrapSyncErrorMessage(err, "filament-db");
    expect(wrapped).not.toContain("read permission");
    expect(wrapped).toContain("Path validation failed");
  });

  it("does not match the auth regex on incidental text", () => {
    const err = new Error("network reset while updating filament cache");
    const wrapped = wrapSyncErrorMessage(err, "filament-db");
    // No rewrite — message passes through (with URI redaction, n/a here)
    expect(wrapped).toBe("network reset while updating filament cache");
  });
});

/**
 * GH #1142 (Codex P2, twice). A stranded row needs a HUMAN — nothing scans for
 * leftover `__sync-staging-…` names on a later cycle, and the equal-`updatedAt`
 * case is documented as never repaired by LWW — so the one announcement has to
 * survive whatever else the wrapper decides about the error.
 *
 * The previous attempt tried to achieve that by ORDERING the composed message.
 * It cannot work: the auth branch RETURNS a fresh string and never reads the
 * original, so both orderings lose equally. These cases pin the structural
 * property instead, and the first two FAIL on that design.
 */
describe("wrapSyncErrorMessage + a stranded placeholder", () => {
  const info = {
    collection: "bedtypes",
    id: "64b7f0000000000000000001",
    originalName: "Textured PEI",
    placeholderName: "__sync-staging-64b7f0000000000000000001-abc",
  };
  const expectStranding = (wrapped: string) => {
    expect(wrapped).toContain("bedtypes 64b7f0000000000000000001");
    expect(wrapped).toContain('"Textured PEI"');
    expect(wrapped).toContain('"__sync-staging-64b7f0000000000000000001-abc"');
    expect(wrapped).toMatch(/rename it back manually/i);
  };
  /** Exactly what the settlement path hands up: the row's notice, the real
   *  failure as `cause`. */
  const stranded = (cause: unknown) =>
    withStrandingNotice(cause, strandedPlaceholderNotice(info));

  it("keeps BOTH the stranding and the Atlas hint when the cause is auth-shaped", () => {
    const wrapped = wrapSyncErrorMessage(
      stranded(Object.assign(
          new Error("user is not allowed to do action [update] on [prod-db.bedtypes]"),
          { code: 13 },
        )),
      "prod-db",
    );
    expectStranding(wrapped);
    expect(wrapped).toContain('only has read permission for "prod-db"');
    expect(wrapped).toContain("readWrite");
  });

  it("still recognises code 13 through the wrapper — a composed Error inherits no code", () => {
    // The inverse gap, and the more damaging half: `new Error(msg, {cause})`
    // does not copy `code`, so classifying the OUTER error threw away the
    // signal the docblock calls the reliable one. A fix that merely appends the
    // notice inside the auth branch passes the case above and fails this one.
    const wrapped = wrapSyncErrorMessage(
      stranded(Object.assign(new Error("Unauthorized"), { code: 13 })),
      "prod-db",
    );
    expectStranding(wrapped);
    expect(wrapped).toContain('only has read permission for "prod-db"');
  });

  it("keeps the stranding and the driver text when the cause is not auth", () => {
    const wrapped = wrapSyncErrorMessage(
      stranded(new Error('E11000 duplicate key error index: name_1 dup key: { name: "Textured PEI" }')),
      "prod-db",
    );
    expectStranding(wrapped);
    expect(wrapped).toContain("E11000");
    expect(wrapped).not.toContain("only has read permission");
  });

  it("redacts a connection string in the cause without losing the stranding", () => {
    // Redaction has to run over the FINAL string: the notice is concatenated
    // after the branch decision, so redacting only the body would leave a
    // future notice-borne URI in the clear.
    const wrapped = wrapSyncErrorMessage(
      stranded(new Error("connect failed to mongodb+srv://user:secret@cluster.mongodb.net/db")),
      "prod-db",
    );
    expectStranding(wrapped);
    expect(wrapped).toContain("mongodb://***");
    expect(wrapped).not.toContain("secret");
  });

  it("keeps a non-Error cause's text rather than collapsing it", () => {
    // Guards the recursion trap: re-entering the wrapper with the cause would
    // turn a string cause into "Sync failed".
    const wrapped = wrapSyncErrorMessage(
      stranded("socket hang up"),
      "prod-db",
    );
    expectStranding(wrapped);
    expect(wrapped).toContain("socket hang up");
  });

  it("leaves an ordinary auth error exactly as GH #143 specified", () => {
    const wrapped = wrapSyncErrorMessage(
      new Error("user is not allowed to do action [update] on [prod-db.bedtypes]"),
      "prod-db",
    );
    expect(wrapped).toContain('only has read permission for "prod-db"');
    expect(wrapped).not.toContain("staging");
    expect(wrapped).not.toMatch(/rename it back manually/i);
  });
});

describe("isDuplicateKeyError (GH #439, scoped to syncId per Codex on #464)", () => {
  // The recogniser MUST be scoped to the `syncId` index — every synced
  // collection also has unique indexes on `name` / `instanceId` /
  // etc., and silently swallowing those would leave real conflicts
  // unsynced while the cycle reported success.

  it("returns true for an E11000 on the syncId index", () => {
    const err = Object.assign(new Error("E11000 duplicate key"), {
      code: 11000,
      keyPattern: { syncId: 1 },
      keyValue: { syncId: "abc-123" },
    });
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it("returns FALSE for an E11000 on a name index (real conflict to surface)", () => {
    const err = Object.assign(new Error("E11000 duplicate key"), {
      code: 11000,
      keyPattern: { name: 1 },
      keyValue: { name: "0.4 Brass" },
    });
    expect(isDuplicateKeyError(err)).toBe(false);
  });

  it("returns FALSE for an E11000 on instanceId", () => {
    const err = Object.assign(new Error("E11000 duplicate key"), {
      code: 11000,
      keyPattern: { instanceId: 1 },
      keyValue: { instanceId: "abc-123" },
    });
    expect(isDuplicateKeyError(err)).toBe(false);
  });

  it("returns FALSE for a different error code", () => {
    expect(isDuplicateKeyError({ code: 121, keyPattern: { syncId: 1 } })).toBe(false);
  });

  it("returns FALSE for a bare Error with no code", () => {
    expect(isDuplicateKeyError(new Error("generic failure"))).toBe(false);
  });

  it("returns FALSE for an E11000 with no keyPattern (ambiguous — surface it)", () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(false);
    expect(isDuplicateKeyError(Object.assign(new Error("dup"), { code: 11000 }))).toBe(false);
  });

  it("returns FALSE for non-error inputs", () => {
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError("E11000 string")).toBe(false);
    expect(isDuplicateKeyError(11000)).toBe(false);
  });
});

/**
 * GH #1153 (Codex P2, several rounds of it): a quarantine without a report is
 * a silently held-back pair under a green cycle — the posture violation the
 * sweep exists to end, and it was reintroduced three separate times on three
 * different branches. Pin it structurally: every quarantine site must have a
 * user-facing notice within its lexical neighborhood.
 */
describe("every quarantine reports (source invariant)", () => {
  it("finds a notice push near each quarantinedSyncIds.add", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("electron/sync-service.ts", "utf8");
    const offenders: number[] = [];
    const re = /quarantinedSyncIds\.add\([^)]*\);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 500);
      const before = src.slice(Math.max(0, m.index - 700), m.index);
      const reports =
        after.includes("sweptHoldbacks.push") ||
        after.includes("sweptConflicts.push") ||
        before.includes("sweptHoldbacks.push") ||
        before.includes("sweptConflicts.push") ||
        before.includes("strandedPlaceholderNotice");
      if (!reports) offenders.push(src.slice(0, m.index).split("\n").length);
    }
    expect(offenders).toEqual([]);
  });
});
