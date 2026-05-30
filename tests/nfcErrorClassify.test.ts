/**
 * GH #450 — classifyNfcError maps pcsclite/reader error messages into
 * one of four buckets so the NFC status pill can show a translated,
 * actionable hint. Pin every wording variant we want to catch so a
 * driver-message rename can't silently drop a user into the generic
 * fallback (and miss the macOS permission-denied prompt that was the
 * original motivation for this PR).
 */
import { describe, it, expect } from "vitest";
import { classifyNfcError } from "@/lib/nfcErrorClassify";

describe("classifyNfcError", () => {
  describe("permission bucket", () => {
    it("matches the macOS 'not authorized' wording", () => {
      expect(classifyNfcError(new Error("Reader is not authorized"))).toBe("permission");
    });

    it("matches the generic 'permission denied' wording", () => {
      expect(classifyNfcError(new Error("Permission denied"))).toBe("permission");
    });

    it("matches 'access denied' (Linux pcscd group missing)", () => {
      expect(classifyNfcError(new Error("Access denied connecting to reader"))).toBe(
        "permission",
      );
    });

    it("matches the SCard error symbol", () => {
      expect(classifyNfcError(new Error("SCARD_E_NO_ACCESS"))).toBe("permission");
    });

    it("is case-insensitive", () => {
      expect(classifyNfcError(new Error("NOT AUTHORIZED"))).toBe("permission");
      expect(classifyNfcError(new Error("Permission Denied"))).toBe("permission");
    });
  });

  describe("busy bucket", () => {
    it("matches 'sharing violation' (canonical SCardConnect failure)", () => {
      expect(classifyNfcError(new Error("Sharing violation"))).toBe("busy");
    });

    it("matches the SCard error symbol", () => {
      expect(classifyNfcError(new Error("SCARD_E_SHARING_VIOLATION"))).toBe("busy");
    });

    it("matches 'reader is in use'", () => {
      expect(classifyNfcError(new Error("Reader is in use by another process"))).toBe(
        "busy",
      );
    });

    it("matches 'shared mode' variants", () => {
      expect(classifyNfcError(new Error("Could not establish shared mode"))).toBe("busy");
    });
  });

  describe("no-daemon bucket", () => {
    it("matches 'no service'", () => {
      expect(classifyNfcError(new Error("No service available"))).toBe("no-daemon");
    });

    it("matches the SCard error symbol", () => {
      expect(classifyNfcError(new Error("SCARD_E_NO_SERVICE"))).toBe("no-daemon");
    });

    it("matches 'daemon' wording", () => {
      expect(classifyNfcError(new Error("pcscd daemon not running"))).toBe("no-daemon");
    });

    it("matches SCardEstablishContext failures", () => {
      expect(classifyNfcError(new Error("SCardEstablishContext failed"))).toBe("no-daemon");
    });

    it("matches the macOS 'service not available' wording (Codex P2 PR #476 r2)", () => {
      // The canonical macOS message when pcscd / Smart Card Service is
      // stopped is "SCardEstablishContext: Service not available".
      // Round 1 only checked "no service" / "daemon", so this dropped
      // through to "generic" — the bug this fix addresses.
      expect(
        classifyNfcError(new Error("SCardEstablishContext: Service not available")),
      ).toBe("no-daemon");
      expect(classifyNfcError(new Error("Service unavailable"))).toBe("no-daemon");
    });
  });

  describe("generic bucket (fallback)", () => {
    it("returns generic for unknown wordings", () => {
      expect(classifyNfcError(new Error("Some unknown PC/SC error"))).toBe("generic");
    });

    it("returns generic for empty messages", () => {
      expect(classifyNfcError(new Error(""))).toBe("generic");
    });

    it("returns generic for non-Error inputs", () => {
      expect(classifyNfcError("plain string error")).toBe("generic");
      expect(classifyNfcError(null)).toBe("generic");
      expect(classifyNfcError(undefined)).toBe("generic");
      expect(classifyNfcError({ message: "object" })).toBe("generic");
    });
  });

  describe("priority order (permission wins over busy wins over no-daemon)", () => {
    // A message that mentions multiple keywords should land in the
    // highest-priority bucket. Permission is most actionable; busy
    // second; no-daemon last. (The function checks in that order.)
    it("classifies 'permission denied — reader in use' as permission", () => {
      expect(classifyNfcError(new Error("Permission denied — reader in use"))).toBe(
        "permission",
      );
    });

    it("classifies 'sharing violation — no service' as busy", () => {
      expect(classifyNfcError(new Error("Sharing violation — no service"))).toBe("busy");
    });
  });
});
