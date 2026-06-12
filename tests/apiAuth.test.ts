import { describe, it, expect } from "vitest";
import {
  constantTimeEqual,
  decideApiAuth,
  type ApiAuthHeaders,
} from "@/lib/apiAuth";

/**
 * Optional API-key gate (GH: mobile-scanner Phase 0). Pure-function tests for
 * the decision logic that src/proxy.ts wraps. The gate is all-or-nothing: when
 * a key is configured, EVERY /api request must present `Authorization: Bearer
 * <key>` — there is intentionally no same-origin / Sec-Fetch-Site exemption,
 * because those headers are forgeable by the non-browser clients this gate
 * exists to authenticate.
 */

function headers(authorization: string | null): ApiAuthHeaders {
  return { authorization };
}

describe("constantTimeEqual", () => {
  it("is true for identical strings", () => {
    expect(constantTimeEqual("s3cr3t-key", "s3cr3t-key")).toBe(true);
  });
  it("is false for differing same-length strings", () => {
    expect(constantTimeEqual("s3cr3t-key", "s3cr3t-keZ")).toBe(false);
  });
  it("is false for different lengths", () => {
    expect(constantTimeEqual("short", "longer-value")).toBe(false);
  });
  it("is true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("decideApiAuth", () => {
  const KEY = "filamentdb-test-key";

  it("allows everything when no key is configured (undefined)", () => {
    expect(decideApiAuth(undefined, headers(null))).toBe("allow");
  });
  it("treats an empty-string key as disabled", () => {
    expect(decideApiAuth("", headers(null))).toBe("allow");
  });

  it("rejects a request with no Authorization when a key is set", () => {
    expect(decideApiAuth(KEY, headers(null))).toBe("unauthorized");
  });

  it("allows a request presenting the correct bearer key", () => {
    expect(decideApiAuth(KEY, headers(`Bearer ${KEY}`))).toBe("allow");
  });

  it("rejects a wrong bearer key", () => {
    expect(decideApiAuth(KEY, headers("Bearer wrong"))).toBe("unauthorized");
  });

  it("rejects an empty bearer value", () => {
    expect(decideApiAuth(KEY, headers("Bearer "))).toBe("unauthorized");
  });

  it("rejects a non-Bearer Authorization scheme even with the key as the value", () => {
    expect(decideApiAuth(KEY, headers(`Basic ${KEY}`))).toBe("unauthorized");
  });

  it("does NOT trust forgeable browser-provenance signals — a key is still required", () => {
    // A non-browser client can set any header it likes, so the gate must not
    // grant access on Origin / Sec-Fetch-Site. The only inputs that matter are
    // the configured key and the bearer token.
    expect(decideApiAuth(KEY, headers(null))).toBe("unauthorized");
  });
});
