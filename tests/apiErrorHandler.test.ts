import { describe, it, expect } from "vitest";
import {
  getErrorMessage,
  errorResponse,
  handleDuplicateKeyError,
  checkFileSize,
  MAX_UPLOAD_SIZE,
} from "@/lib/apiErrorHandler";

describe("getErrorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(getErrorMessage(new Error("test error"))).toBe("test error");
  });

  it("converts non-Error values to strings", () => {
    expect(getErrorMessage("string error")).toBe("string error");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
  });
});

describe("errorResponse", () => {
  it("returns JSON response with error and status", async () => {
    const res = errorResponse("Not found", 404);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Not found" });
  });

  it("includes detail when provided", async () => {
    const res = errorResponse("Server error", 500, "Connection refused");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Server error", detail: "Connection refused" });
  });
});

describe("handleDuplicateKeyError", () => {
  it("returns 409 response for MongoDB code 11000", async () => {
    const err = { code: 11000, keyValue: { name: "Existing Name" } };
    const res = handleDuplicateKeyError(err, "filament");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body.error).toContain("filament");
    expect(body.error).toContain("name");
    expect(body.error).toContain("Existing Name");
  });

  it("returns null for non-duplicate-key errors", () => {
    const err = new Error("Some other error");
    expect(handleDuplicateKeyError(err, "filament")).toBeNull();
  });

  it("returns null for non-object errors", () => {
    expect(handleDuplicateKeyError("string error", "nozzle")).toBeNull();
  });

  it("handles missing keyValue gracefully", async () => {
    const err = { code: 11000 };
    const res = handleDuplicateKeyError(err, "printer");
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.error).toContain("printer");
  });
});

describe("checkFileSize", () => {
  it("returns null for files under the limit", () => {
    const file = new File(["data"], "test.csv", { type: "text/csv" });
    expect(checkFileSize(file)).toBeNull();
  });

  it("returns 413 response for files over 10 MB", async () => {
    // Create a mock File-like object with a large size
    const bigFile = {
      size: MAX_UPLOAD_SIZE + 1,
      name: "big.csv",
    } as File;
    const res = checkFileSize(bigFile);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(413);
    const body = await res!.json();
    expect(body.error).toContain("too large");
  });
});
