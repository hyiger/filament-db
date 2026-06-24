import { describe, it, expect } from "vitest";
import {
  isKnownLocationKind,
  KNOWN_LOCATION_KINDS,
} from "@/lib/locationKind";

describe("isKnownLocationKind (#822)", () => {
  it("accepts every UI-picker kind", () => {
    for (const k of KNOWN_LOCATION_KINDS) {
      expect(isKnownLocationKind(k)).toBe(true);
    }
  });

  it("rejects an arbitrary kind created via the REST API", () => {
    expect(isKnownLocationKind("garage")).toBe(false);
    expect(isKnownLocationKind("")).toBe(false);
  });

  it("rejects null / undefined", () => {
    expect(isKnownLocationKind(null)).toBe(false);
    expect(isKnownLocationKind(undefined)).toBe(false);
  });
});
