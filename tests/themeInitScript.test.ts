import { describe, it, expect } from "vitest";
import { themeInitScript, THEME_STORAGE_KEY } from "@/lib/themeInitScript";

describe("themeInitScript", () => {
  it("exports the expected storage key", () => {
    expect(THEME_STORAGE_KEY).toBe("filamentdb-theme");
  });

  it("returns an IIFE string that references the storage key", () => {
    const script = themeInitScript();
    expect(script).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(script.trim().startsWith("(() =>")).toBe(true);
    expect(script.trim().endsWith("})();")).toBe(true);
  });

  it("reads from localStorage with a 'system' fallback", () => {
    const script = themeInitScript();
    expect(script).toContain("localStorage.getItem");
    expect(script).toContain('"system"');
  });

  it("applies the dark class when appropriate", () => {
    const script = themeInitScript();
    expect(script).toContain("document.documentElement.classList.add");
    expect(script).toContain('"dark"');
  });

  it("checks prefers-color-scheme for system mode", () => {
    const script = themeInitScript();
    expect(script).toContain("matchMedia");
    expect(script).toContain("prefers-color-scheme: dark");
  });

  it("wraps everything in try/catch so storage errors don't break boot", () => {
    const script = themeInitScript();
    expect(script).toContain("try {");
    expect(script).toContain("catch");
  });
});
