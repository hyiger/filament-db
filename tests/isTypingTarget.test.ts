/**
 * GH #451: NfcProvider must not auto-open the NFC read dialog when the
 * user is actively typing. `isTypingTarget` is the predicate that gates
 * `setDialogOpen(true)`. Pin every text-entry shape we expect to suppress
 * vs every shape we expect to leave alone so a future refactor can't
 * silently regress the steal-focus bug.
 *
 * Duck-typed against minimal `{ tagName, getAttribute }` stand-ins so
 * this test runs in the project's default node environment — vitest is
 * not configured with jsdom.
 */
import { describe, it, expect } from "vitest";
import { isTypingTarget } from "@/components/NfcProvider";

function el(tagName: string, attrs: Record<string, string> = {}) {
  return {
    tagName,
    getAttribute: (name: string) =>
      Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null,
  };
}

describe("isTypingTarget", () => {
  it("returns false for null", () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it("returns false for the document body", () => {
    expect(isTypingTarget(el("BODY"))).toBe(false);
  });

  it("treats text-style input types as typing surfaces", () => {
    for (const type of [
      "text", "search", "url", "tel", "email", "password",
      "number", "date", "datetime-local", "month", "week", "time",
    ]) {
      expect(isTypingTarget(el("INPUT", { type })), `type=${type}`).toBe(true);
    }
  });

  it("treats an INPUT with no type attribute as a typing surface (default = text)", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
  });

  it("treats non-text input types as non-typing", () => {
    for (const type of [
      "button", "submit", "checkbox", "radio", "range", "color", "file", "image", "reset",
    ]) {
      expect(isTypingTarget(el("INPUT", { type })), `type=${type}`).toBe(false);
    }
  });

  it("treats a textarea as a typing surface", () => {
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
  });

  it("treats contenteditable=true as a typing surface", () => {
    expect(isTypingTarget(el("DIV", { contenteditable: "true" }))).toBe(true);
    expect(isTypingTarget(el("DIV", { contenteditable: "" }))).toBe(true);
    expect(isTypingTarget(el("DIV", { contenteditable: "plaintext-only" }))).toBe(true);
  });

  it("treats contenteditable=false and inherit as non-typing", () => {
    expect(isTypingTarget(el("DIV", { contenteditable: "false" }))).toBe(false);
    expect(isTypingTarget(el("DIV", { contenteditable: "inherit" }))).toBe(false);
  });

  it("treats plain divs, links, and buttons as non-typing", () => {
    expect(isTypingTarget(el("DIV"))).toBe(false);
    expect(isTypingTarget(el("A"))).toBe(false);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
  });

  it("normalises tag name casing (handles lowercase too)", () => {
    expect(isTypingTarget(el("input", { type: "text" }))).toBe(true);
    expect(isTypingTarget(el("textarea"))).toBe(true);
  });
});
