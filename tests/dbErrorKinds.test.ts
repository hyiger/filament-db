import { describe, it, expect } from "vitest";
import en from "@/i18n/locales/en.json";
import de from "@/i18n/locales/de.json";
import {
  DB_ERROR_KINDS,
  DB_ERROR_MESSAGE_KEYS,
  dbErrorFromBody,
  dbErrorMessageKey,
  isDbErrorKind,
  type DbErrorSurface,
} from "@/lib/dbErrorKinds";
import {
  describeDbError,
  notConfiguredError,
  toDbUnavailableError,
} from "@/lib/dbErrorText";
import { isDbUnavailableError } from "@/lib/mongoConnectionError";

/**
 * GH #1231. The UI builds these translation keys at runtime, which the
 * literal-`t("…")` coverage test can't see, so this file pins them: every
 * key the mapping can return exists in BOTH locales, and the mapping only
 * ever returns keys from the published list.
 */

const SURFACES: DbErrorSurface[] = ["desktop", "server"];

describe("dbErrorMessageKey", () => {
  it("only returns listed keys, for every input combination", () => {
    const seen = new Set<string>();
    for (const kind of DB_ERROR_KINDS) {
      for (const atlas of [true, false]) {
        for (const side of [undefined, "local", "remote"] as const) {
          for (const surface of SURFACES) {
            const key = dbErrorMessageKey({ kind, atlas, side }, surface);
            expect(DB_ERROR_MESSAGE_KEYS).toContain(key);
            seen.add(key);
          }
        }
      }
    }
    // …and every listed key is reachable.
    expect([...seen].sort()).toEqual([...DB_ERROR_MESSAGE_KEYS].sort());
  });

  it("every key exists in both locale files, non-empty", () => {
    for (const key of DB_ERROR_MESSAGE_KEYS) {
      expect((en as Record<string, string>)[key], `en: ${key}`).toBeTruthy();
      expect((de as Record<string, string>)[key], `de: ${key}`).toBeTruthy();
    }
  });

  it("names whose IP address the advice is about, per surface", () => {
    const info = { kind: "ip-not-allowed" as const, atlas: true };
    expect(dbErrorMessageKey(info, "desktop")).toBe("db.error.ipNotAllowed.desktop");
    expect(dbErrorMessageKey(info, "server")).toBe("db.error.ipNotAllowed.server");
    expect((en as Record<string, string>)["db.error.ipNotAllowed.server"]).toMatch(/Docker host/);
  });

  it("never gives Atlas advice for a non-Atlas target or the local database", () => {
    expect(dbErrorMessageKey({ kind: "ip-not-allowed", atlas: false }, "desktop")).toBe("db.error.tls");
    expect(dbErrorMessageKey({ kind: "unreachable", atlas: false }, "server")).toBe("db.error.unreachable");
    expect(dbErrorMessageKey({ kind: "ip-not-allowed", atlas: true, side: "local" }, "desktop")).toBe("db.error.local");
  });

  it("uses MongoDB's current wording, never 'whitelist'", () => {
    for (const key of DB_ERROR_MESSAGE_KEYS) {
      expect((en as Record<string, string>)[key]).not.toMatch(/whitelist/i);
    }
    expect((en as Record<string, string>)["db.error.ipNotAllowed.desktop"]).toMatch(/IP Access List/);
  });
});

describe("isDbErrorKind / dbErrorFromBody", () => {
  it("accepts only known kinds", () => {
    expect(isDbErrorKind("dns")).toBe(true);
    expect(isDbErrorKind("nope")).toBe(false);
    expect(isDbErrorKind(3)).toBe(false);
  });

  it("reads the db_unavailable body and nothing else", () => {
    expect(dbErrorFromBody({ code: "db_unavailable", kind: "ip-not-allowed", atlas: true })).toEqual({
      kind: "ip-not-allowed",
      atlas: true,
    });
    expect(dbErrorFromBody({ code: "db_unavailable", kind: "dns" })).toEqual({ kind: "dns", atlas: false });
    expect(dbErrorFromBody({ code: "db_unavailable", kind: "from-the-future" })).toBeNull();
    expect(dbErrorFromBody({ error: "Failed to fetch nozzles", detail: "x" })).toBeNull();
    expect(dbErrorFromBody(null)).toBeNull();
    expect(dbErrorFromBody("text")).toBeNull();
  });
});

describe("dbErrorText (server-side English)", () => {
  it("reads the SAME English as the locale file", () => {
    expect(describeDbError({ kind: "dns", atlas: false }, "server")).toBe(
      (en as Record<string, string>)["db.error.dns"],
    );
  });

  it("notConfiguredError names MONGODB_URI, not .env.local", () => {
    const err = notConfiguredError();
    expect(isDbUnavailableError(err)).toBe(true);
    expect(err.kind).toBe("not-configured");
    expect(err.message).toMatch(/MONGODB_URI/);
    expect(err.message).not.toMatch(/\.env\.local/);
  });

  it("toDbUnavailableError keeps the raw error as cause and logs a redacted line", () => {
    const raw = Object.assign(new Error("connect ECONNREFUSED for mongodb://u:hunter2@h/db"), {
      code: "ECONNREFUSED",
    });
    const { error, logLine } = toDbUnavailableError(raw, "mongodb://u:hunter2@h/db");
    expect(error.kind).toBe("unreachable");
    expect(error.atlas).toBe(false);
    expect(error.cause).toBe(raw);
    expect(error.message).toBe((en as Record<string, string>)["db.error.unreachable"]);
    expect(error.message).not.toContain("hunter2");
    expect(logLine).toContain("unreachable, ECONNREFUSED");
    expect(logLine).not.toContain("hunter2");
  });

  it("marks an Atlas target and omits a missing signal in the log line", () => {
    const { logLine } = toDbUnavailableError({}, "mongodb+srv://cluster0.abcde.mongodb.net/db");
    expect(logLine).toBe("[db] Database connection failed (MongoDB Atlas): unknown.");
  });
});
