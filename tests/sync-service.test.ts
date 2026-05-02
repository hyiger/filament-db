import { describe, it, expect } from "vitest";
import { getDbNameFromUri, wrapSyncErrorMessage } from "../electron/sync-service";

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

  it("does not match the auth regex on incidental text", () => {
    const err = new Error("network reset while updating filament cache");
    const wrapped = wrapSyncErrorMessage(err, "filament-db");
    // No rewrite — message passes through (with URI redaction, n/a here)
    expect(wrapped).toBe("network reset while updating filament cache");
  });
});
