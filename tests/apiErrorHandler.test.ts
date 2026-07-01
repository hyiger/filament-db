import { describe, it, expect } from "vitest";
import {
  getErrorMessage,
  errorResponse,
  errorResponseFromCaught,
  handleDuplicateKeyError,
  handleVersionError,
  assertActiveRefs,
  assertMultipartFormData,
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
    expect(isClientInputErrorMessage("Invalid URL: not a url")).toBe(true);
    expect(isClientInputErrorMessage('Disallowed URL scheme "javascript:" — only http(s) is supported.')).toBe(true);
    expect(isClientInputErrorMessage("URL has no hostname")).toBe(true);
    expect(isClientInputErrorMessage("URL hostname does not resolve: not-a-real-host.test")).toBe(true);
    expect(isClientInputErrorMessage("URL resolves to a private/internal address — only public hosts are allowed.")).toBe(true);
  });

  it("does NOT match the bare 'Invalid URL' (Codex P2 PR #167)", () => {
    // The bare `new URL(...)` constructor throws this when an upstream
    // server's redirect Location header is malformed — that's a 502 case,
    // not a 400. Only the colon-prefixed `assertExternalUrl` variant
    // counts as client input.
    expect(isClientInputErrorMessage("Invalid URL")).toBe(false);
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

  it("returns true for Mongoose CastError (GH #202 — invalid ObjectId on path param)", () => {
    // CastError fires when a route's {id} path param isn't a parseable
    // ObjectId, e.g. GET /api/filaments/notavalidobjectid. Bad client
    // input — the route should return 400, not 500.
    const err = new Error('Cast to ObjectId failed for value "notavalidobjectid" (type string) at path "_id" for model "Filament"');
    err.name = "CastError";
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

describe("handleVersionError", () => {
  it("returns 409 when the error name is VersionError", async () => {
    const err = new Error("No matching document found for id ... version 3");
    err.name = "VersionError";
    const res = handleVersionError(err);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body.error).toContain("modified by another request");
  });

  it("returns 409 when only the constructor name is VersionError", async () => {
    // Mongoose's VersionError is a subclass whose instance .name may be reset;
    // the helper also matches on err.constructor.name (line 140 branch).
    class VersionError extends Error {}
    const err = new VersionError("stale version");
    // Blank the .name so the first predicate can't match — force the
    // constructor?.name branch to carry the decision.
    Object.defineProperty(err, "name", { value: "", configurable: true });
    const res = handleVersionError(err);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
  });

  it("returns null for a non-version Error (line 147)", () => {
    expect(handleVersionError(new Error("some other failure"))).toBeNull();
  });

  it("returns null for a non-Error value", () => {
    expect(handleVersionError("VersionError")).toBeNull();
    expect(handleVersionError(null)).toBeNull();
  });
});

describe("assertActiveRefs", () => {
  // Minimal countable-model stub that returns a plain Promise<number>.
  function promiseModel(count: number) {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      countDocuments(filter: Record<string, unknown>): Promise<number> {
        calls.push(filter);
        return Promise.resolve(count);
      },
    };
  }

  // Countable-model stub whose countDocuments returns a Mongoose-style
  // query object exposing .exec() (exercises the exec() branch, line 178-179).
  function queryModel(count: number) {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      countDocuments(filter: Record<string, unknown>) {
        calls.push(filter);
        return { exec: () => Promise.resolve(count) };
      },
    };
  }

  it("returns null immediately when ids is undefined (no query run)", async () => {
    const model = promiseModel(0);
    expect(await assertActiveRefs(model, undefined, "printers")).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  it("returns null immediately when ids is empty (no query run)", async () => {
    const model = promiseModel(0);
    expect(await assertActiveRefs(model, [], "printers")).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  it("returns null when every deduped id resolves to an active doc (plain Promise)", async () => {
    // 3 distinct ids after dedupe, count == 3 → all active.
    const model = promiseModel(3);
    const res = await assertActiveRefs(model, ["a", "b", "c"], "printers");
    expect(res).toBeNull();
    // dedupe + $in / _deletedAt:null filter shape.
    expect(model.calls[0]).toEqual({ _id: { $in: ["a", "b", "c"] }, _deletedAt: null });
  });

  it("dedupes ids before comparing against the count", async () => {
    // ["a","a","b"] dedupes to ["a","b"] (len 2); count 2 → active.
    const model = promiseModel(2);
    const res = await assertActiveRefs(model, ["a", "a", "b"], "bed types");
    expect(res).toBeNull();
    expect(model.calls[0]).toEqual({ _id: { $in: ["a", "b"] }, _deletedAt: null });
  });

  it("returns null via the .exec() query branch when counts match", async () => {
    const model = queryModel(1);
    const res = await assertActiveRefs(model, ["x"], "nozzles");
    expect(res).toBeNull();
  });

  it("returns a 400 naming the field when a ref is missing (deduped mismatch)", async () => {
    // 2 distinct ids but only 1 active → mismatch.
    const model = promiseModel(1);
    const res = await assertActiveRefs(model, ["a", "b"], "printers");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("One or more printers no longer exist.");
  });

  it("returns a 400 via the .exec() branch on a mismatch", async () => {
    const model = queryModel(0);
    const res = await assertActiveRefs(model, ["a"], "locations");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("One or more locations no longer exist.");
  });
});

describe("assertMultipartFormData", () => {
  it("returns null when the content type is multipart/form-data", () => {
    const req = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
    });
    expect(assertMultipartFormData(req)).toBeNull();
  });

  it("is case-insensitive on the content type", () => {
    const req = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "MULTIPART/FORM-DATA; boundary=xyz" },
    });
    expect(assertMultipartFormData(req)).toBeNull();
  });

  it("returns a 400 for a non-multipart content type", async () => {
    const req = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = assertMultipartFormData(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toContain("multipart/form-data");
  });

  it("returns a 400 when the content-type header is absent (|| \"\" fallback, branch 238)", async () => {
    const req = new Request("http://localhost/api/x", { method: "POST" });
    // No content-type header set → header.get returns null → the `|| ""`
    // fallback drives the branch, and `.includes` is false.
    const res = assertMultipartFormData(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });
});
