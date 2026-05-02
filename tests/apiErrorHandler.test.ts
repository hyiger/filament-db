import { describe, it, expect } from "vitest";
import {
  getErrorMessage,
  errorResponse,
  errorResponseFromCaught,
  handleDuplicateKeyError,
  checkFileSize,
  isClientInputError,
  isClientInputErrorMessage,
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

describe("isClientInputErrorMessage", () => {
  it("matches Mongoose-style validator messages from pre-update hooks", () => {
    expect(isClientInputErrorMessage("tdsUrl must be a valid http(s) URL")).toBe(true);
  });

  it("matches every assertExternalUrl rejection message", () => {
    expect(isClientInputErrorMessage("Invalid URL")).toBe(true);
    expect(isClientInputErrorMessage('Disallowed URL scheme "javascript:" — only http(s) is supported.')).toBe(true);
    expect(isClientInputErrorMessage("URL has no hostname")).toBe(true);
    expect(isClientInputErrorMessage("URL hostname does not resolve: not-a-real-host.test")).toBe(true);
    expect(isClientInputErrorMessage("URL resolves to a private/internal address — only public hosts are allowed.")).toBe(true);
  });

  it("does not match unrelated server-fault messages", () => {
    expect(isClientInputErrorMessage("ECONNREFUSED")).toBe(false);
    expect(isClientInputErrorMessage("Gemini API error: HTTP 500 — boom")).toBe(false);
    expect(isClientInputErrorMessage("Failed to update filament")).toBe(false);
  });
});

describe("isClientInputError", () => {
  it("returns true for Mongoose ValidationError by name", () => {
    const err = new Error("Filament validation failed: name is required");
    err.name = "ValidationError";
    expect(isClientInputError(err)).toBe(true);
  });

  it("returns true when the message matches a known client-input pattern", () => {
    expect(isClientInputError(new Error("tdsUrl must be a valid http(s) URL"))).toBe(true);
    expect(isClientInputError(new Error('Disallowed URL scheme "file:"'))).toBe(true);
  });

  it("returns false for plain Errors with unrelated messages", () => {
    expect(isClientInputError(new Error("ECONNRESET"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isClientInputError("Invalid URL")).toBe(false);
    expect(isClientInputError(null)).toBe(false);
    expect(isClientInputError({ message: "Disallowed URL scheme" })).toBe(false);
  });
});

describe("errorResponseFromCaught", () => {
  it("returns 400 with the error message when input was a client-input rejection", async () => {
    const err = new Error('Disallowed URL scheme "javascript:" — only http(s) is supported.');
    const res = errorResponseFromCaught(err, "Failed to update filament");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Disallowed URL scheme "javascript:" — only http(s) is supported.' });
  });

  it("returns 400 for Mongoose ValidationError", async () => {
    const err = new Error("tdsUrl must be a valid http(s) URL");
    err.name = "ValidationError";
    const res = errorResponseFromCaught(err, "Failed to update filament");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("tdsUrl must be a valid http(s) URL");
  });

  it("returns the supplied fallback status with detail for unrecognised server faults", async () => {
    const res = errorResponseFromCaught(new Error("ECONNREFUSED"), "Failed to update filament");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to update filament", detail: "ECONNREFUSED" });
  });

  it("honours an explicit fallbackStatus override", async () => {
    const res = errorResponseFromCaught(new Error("upstream blew up"), "TDS extraction failed", 502);
    expect(res.status).toBe(502);
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
