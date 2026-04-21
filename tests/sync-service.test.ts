import { describe, it, expect } from "vitest";
import { getDbNameFromUri } from "../electron/sync-service";

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
