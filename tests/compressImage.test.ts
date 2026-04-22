import { describe, it, expect } from "vitest";
import { compressImageToDataUrl, dataUrlSizeBytes } from "@/lib/compressImage";

describe("dataUrlSizeBytes", () => {
  it("returns raw length when the string has no comma", () => {
    expect(dataUrlSizeBytes("not-a-data-url")).toBe("not-a-data-url".length);
  });

  it("computes decoded size for unpadded base64", () => {
    // "AAAA" = 4 base64 chars with no padding → 3 decoded bytes.
    const dataUrl = "data:image/jpeg;base64,AAAA";
    expect(dataUrlSizeBytes(dataUrl)).toBe(3);
  });

  it("subtracts one byte for single padding", () => {
    // "AAA=" = 3 chars + 1 pad → 2 decoded bytes.
    const dataUrl = "data:image/jpeg;base64,AAA=";
    expect(dataUrlSizeBytes(dataUrl)).toBe(2);
  });

  it("subtracts two bytes for double padding", () => {
    // "AA==" = 2 chars + 2 pad → 1 decoded byte.
    const dataUrl = "data:image/jpeg;base64,AA==";
    expect(dataUrlSizeBytes(dataUrl)).toBe(1);
  });

  it("scales linearly with payload length", () => {
    // 1000 chars of base64 with no padding → 750 bytes.
    const payload = "A".repeat(1000);
    const dataUrl = `data:image/jpeg;base64,${payload}`;
    expect(dataUrlSizeBytes(dataUrl)).toBe(750);
  });

  it("handles empty payload after the comma", () => {
    expect(dataUrlSizeBytes("data:image/jpeg;base64,")).toBe(0);
  });
});

describe("compressImageToDataUrl", () => {
  it("returns null in non-browser environments", async () => {
    // In Node (no window), the helper short-circuits rather than throwing.
    // Guard against Vitest environments that polyfill window.
    const hadWindow = typeof globalThis.window !== "undefined";
    if (hadWindow) return;
    const fakeFile = {} as File;
    const result = await compressImageToDataUrl(fakeFile);
    expect(result).toBeNull();
  });
});
