import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Drift guard for the three-file Electron IPC contract.
 *
 * A channel is declared in THREE places with no compile-time link between
 * them:
 *   1. `electron/main.ts` (or a sibling) — `ipcMain.handle("channel", …)`
 *   2. `electron/preload.ts` — `ipcRenderer.invoke("channel")` behind a
 *      contextBridge method
 *   3. `src/types/electron.d.ts` — the typed `ElectronAPI` surface
 *
 * Only the (3)→renderer edge is typechecked. Channel names are plain strings
 * on both sides of the preload boundary, so a typo yields a runtime
 * "No handler registered for 'x'" rejection and never a build error; and
 * preload is bundled separately by esbuild, so nothing links (2) to (3)
 * either.
 *
 * This has already bitten in production: GH #1006 F4, where preload's local
 * NfcStatus silently omitted `lastError` and the typecheck could not see it.
 * These tests make that class of drift a CI failure.
 */

const ELECTRON_DIR = join(__dirname, "..", "electron");
const PRELOAD = readFileSync(join(ELECTRON_DIR, "preload.ts"), "utf8");
const DTS = readFileSync(join(__dirname, "..", "src", "types", "electron.d.ts"), "utf8");

/**
 * Every string literal appearing under electron/, EXCLUDING preload.ts.
 *
 * Channel names registered from a table (see LABEL_PRINTER_CHANNELS in
 * main.ts) are not literal at the `ipcMain.handle(` call site, so matching on
 * `handle(` alone would report false failures — but the literal still has to
 * exist somewhere on the main-process side.
 *
 * Excluding preload.ts is what makes the check meaningful. Including it let
 * the scan find a channel literal in preload's OWN source, so a typo'd
 * `ipcRenderer.invoke("tspl-printer-prnt")` matched itself and passed — the
 * exact drift this test exists to catch.
 */
function mainProcessStringLiterals(): Set<string> {
  const out = new Set<string>();
  for (const entry of readdirSync(ELECTRON_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name === "preload.ts") continue;
    const src = readFileSync(join(ELECTRON_DIR, entry.name), "utf8");
    for (const m of src.matchAll(/"([^"\\\n]+)"/g)) out.add(m[1]);
  }
  return out;
}

/** Top-level keys of the object passed to contextBridge.exposeInMainWorld.
 *  Brace-depth tracked so nested type literals (the NfcStatus shape, the
 *  disableBidi union) don't masquerade as bridge methods. */
function contextBridgeKeys(): string[] {
  const start = PRELOAD.indexOf("exposeInMainWorld");
  expect(start).toBeGreaterThan(-1);
  const open = PRELOAD.indexOf("{", start);
  const keys: string[] = [];
  let depth = 0;
  let lineStart = open;
  for (let i = open; i < PRELOAD.length; i++) {
    const ch = PRELOAD[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) break;
    } else if (ch === "\n") {
      lineStart = i + 1;
      continue;
    }
    // A top-level key sits at depth 1 immediately after a newline.
    if (depth === 1 && i === lineStart) {
      const line = PRELOAD.slice(i, PRELOAD.indexOf("\n", i));
      const m = line.match(/^\s*([a-zA-Z_$][\w$]*)\s*:/);
      if (m) keys.push(m[1]);
    }
  }
  return keys;
}

/** Declared member names of `interface ElectronAPI`, brace-depth tracked for
 *  the same reason. */
function electronApiMembers(): Set<string> {
  const start = DTS.indexOf("interface ElectronAPI");
  expect(start).toBeGreaterThan(-1);
  const open = DTS.indexOf("{", start);
  const out = new Set<string>();
  let depth = 0;
  let lineStart = open;
  for (let i = open; i < DTS.length; i++) {
    const ch = DTS[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) break;
    } else if (ch === "\n") {
      lineStart = i + 1;
      continue;
    }
    if (depth === 1 && i === lineStart) {
      const line = DTS.slice(i, DTS.indexOf("\n", i));
      const m = line.match(/^\s*(?:readonly\s+)?([a-zA-Z_$][\w$]*)\??\s*:/);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

describe("Electron IPC contract parity", () => {
  it("every channel preload invokes is registered somewhere under electron/", () => {
    const literals = mainProcessStringLiterals();
    const invoked = [...PRELOAD.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]);
    // Sanity floor so a regex that silently stops matching can't pass vacuously.
    expect(invoked.length).toBeGreaterThan(20);
    const orphaned = invoked.filter((c) => !literals.has(c));
    expect(orphaned).toEqual([]);
  });

  it("every contextBridge method is declared on ElectronAPI", () => {
    const keys = contextBridgeKeys();
    const declared = electronApiMembers();
    expect(keys.length).toBeGreaterThan(20);
    expect(declared.size).toBeGreaterThan(20);
    const undeclared = keys.filter((k) => !declared.has(k));
    expect(undeclared).toEqual([]);
  });

  it("both label printers expose a complete, symmetric channel set", () => {
    // The Brother and TSPL printers are independent device selections driven
    // by one shared handler table in main.ts. If a future edit adds a channel
    // to one and forgets the other, the two pickers diverge silently — this
    // pins the symmetry that table is there to guarantee.
    const literals = mainProcessStringLiterals();
    const declared = electronApiMembers();
    for (const verb of ["get-device-path", "set-device-path", "print"]) {
      expect(literals.has(`label-printer-${verb}`)).toBe(true);
      expect(literals.has(`tspl-printer-${verb}`)).toBe(true);
    }
    for (const method of ["GetDevicePath", "SetDevicePath", "Print"]) {
      expect(declared.has(`labelPrinter${method}`)).toBe(true);
      expect(declared.has(`tsplPrinter${method}`)).toBe(true);
    }
    // Device listing is deliberately NOT duplicated — the lister is
    // printer-agnostic and both pickers share it.
    expect(declared.has("tsplPrinterListDevices")).toBe(false);
  });
});
