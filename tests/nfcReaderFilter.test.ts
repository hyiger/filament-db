import { describe, it, expect } from "vitest";
import { isLikelyContactlessReader } from "@/lib/nfcReaderFilter";

describe("isLikelyContactlessReader (#847)", () => {
  it("accepts real contactless NFC readers", () => {
    for (const name of [
      "ACS ACR1552 1S CL Reader",
      "ACS ACR122U PICC Interface",
      "ACS ACR1252 1S CL Reader",
      "Sony FeliCa Port/PaSoRi 3.0 (RC-S380)",
      "Identiv uTrust 3700 F CL Reader",
      "HID Global OMNIKEY 5022 Smart Card Reader",
      "SCM Microsystems Inc. Contactless Reader",
    ]) {
      expect(isLikelyContactlessReader(name)).toBe(true);
    }
  });

  it("rejects Windows virtual / system smart-card readers", () => {
    for (const name of [
      "Microsoft Virtual Smart Card 0",
      "Windows Hello for Business",
      "Microsoft UICC ISO Reader 0",
      "Identity Device (Microsoft Generic profile)\\TPM Virtual Smart Card",
      "Some VSC Reader",
      "Microsoft Base Smart Card Crypto Provider (virtual)",
    ]) {
      expect(isLikelyContactlessReader(name)).toBe(false);
    }
  });

  it("rejects built-in CONTACT smart-card slots (not contactless)", () => {
    expect(isLikelyContactlessReader("Broadcom Corp Contacted SmartCard 0")).toBe(false);
    // …but does not reject a contactless reader whose name contains "contact".
    expect(isLikelyContactlessReader("Vendor Contactless SmartCard 0")).toBe(true);
  });

  it("rejects empty / missing names", () => {
    expect(isLikelyContactlessReader("")).toBe(false);
    expect(isLikelyContactlessReader("   ")).toBe(false);
    expect(isLikelyContactlessReader(null)).toBe(false);
    expect(isLikelyContactlessReader(undefined)).toBe(false);
  });
});
