import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  API_KEY_FILE,
  API_KEY_PREFIX,
  MIN_API_KEY_LENGTH,
  generateApiKey,
  isUsableApiKey,
  loadOrCreateApiKey,
  rollStoredApiKey,
  writeSecretFile,
} from "@/lib/gatewayKey";

/** The secure gateway's API key: random on first start, stored, rollable. */

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdb-key-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const keyFile = () => path.join(dir, API_KEY_FILE);
const mode = (file: string) => fs.statSync(file).mode & 0o777;
const posix = process.platform !== "win32";

describe("generateApiKey", () => {
  it("is 256 random bits, URL-safe, with a recognisable prefix", () => {
    const key = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.slice(API_KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key.slice(API_KEY_PREFIX.length), "base64url")).toHaveLength(32);
    expect(isUsableApiKey(key)).toBe(true);
  });

  it("never repeats", () => {
    expect(new Set(Array.from({ length: 200 }, generateApiKey)).size).toBe(200);
  });
});

describe("isUsableApiKey", () => {
  it("accepts 32 to 512 printable, space-free ASCII characters", () => {
    expect(MIN_API_KEY_LENGTH).toBe(32);
    expect(isUsableApiKey("a".repeat(32))).toBe(true);
    expect(isUsableApiKey("a".repeat(512))).toBe(true);
    expect(isUsableApiKey("!~" + "x".repeat(30))).toBe(true);
  });

  it("rejects short, long, spaced, control or non-ASCII values", () => {
    for (const value of [
      "",
      "a".repeat(31),
      "a".repeat(513),
      "has a space in the key, though it is long enough",
      "tab\tin-the-key-value-0123456789abcdef",
      "schlüssel-0123456789-0123456789-0123456789",
      "line\nbreak-0123456789-0123456789-0123456789",
    ]) {
      expect(isUsableApiKey(value)).toBe(false);
    }
  });
});

describe("loadOrCreateApiKey", () => {
  it("generates and stores a key on first use, then returns the same one", () => {
    const first = loadOrCreateApiKey({ envKey: null, dir });
    expect(first).toMatchObject({ source: "file", file: keyFile(), created: true });
    expect(fs.readFileSync(keyFile(), "utf8")).toBe(first.key + "\n");

    const second = loadOrCreateApiKey({ envKey: null, dir });
    expect(second).toEqual({ ...first, created: false });
  });

  it.runIf(posix)("stores the key readable by its owner only", () => {
    loadOrCreateApiKey({ envKey: null, dir: path.join(dir, "nested", "secure") });
    expect(mode(path.join(dir, "nested", "secure", API_KEY_FILE))).toBe(0o600);
    expect(mode(path.join(dir, "nested", "secure"))).toBe(0o700);
  });

  it("uses the environment's key as given, and stores nothing", () => {
    expect(loadOrCreateApiKey({ envKey: "short", dir })).toEqual({
      key: "short",
      source: "env",
      file: null,
      created: false,
    });
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it("prefers the environment's key over a stored one", () => {
    const stored = loadOrCreateApiKey({ envKey: null, dir });
    expect(loadOrCreateApiKey({ envKey: "from-the-environment", dir }).key).toBe("from-the-environment");
    // The stored key is untouched and comes back when the variable is removed.
    expect(loadOrCreateApiKey({ envKey: null, dir }).key).toBe(stored.key);
  });

  it("accepts a key the operator wrote into the file", () => {
    fs.writeFileSync(keyFile(), "  operator-chosen-key-0123456789-abcdef  \n");
    expect(loadOrCreateApiKey({ envKey: null, dir })).toMatchObject({
      key: "operator-chosen-key-0123456789-abcdef",
      created: false,
    });
  });

  it("replaces an empty or unusable stored key", () => {
    for (const content of ["", "\n", "too-short-to-be-safe-0123456", "has spaces in the stored key, long enough"]) {
      fs.writeFileSync(keyFile(), content);
      const state = loadOrCreateApiKey({ envKey: null, dir });
      expect(state.created).toBe(true);
      expect(state.key.startsWith(API_KEY_PREFIX)).toBe(true);
      expect(fs.readFileSync(keyFile(), "utf8").trim()).toBe(state.key);
    }
  });
});

describe("rollStoredApiKey", () => {
  it("replaces the stored key with a new random one", () => {
    const before = loadOrCreateApiKey({ envKey: null, dir });
    const rolled = rollStoredApiKey(dir);
    expect(rolled).toEqual({ key: rolled.key, source: "file", file: keyFile() });
    expect(rolled.key).not.toBe(before.key);
    expect(loadOrCreateApiKey({ envKey: null, dir })).toMatchObject({ key: rolled.key, created: false });
  });

  it("creates the directory when it does not exist yet", () => {
    const fresh = path.join(dir, "not-yet");
    const rolled = rollStoredApiKey(fresh);
    expect(fs.readFileSync(path.join(fresh, API_KEY_FILE), "utf8")).toBe(rolled.key + "\n");
  });
});

describe("writeSecretFile", () => {
  it("replaces the content and leaves no temporary file behind", () => {
    const file = path.join(dir, "secret");
    writeSecretFile(file, "one");
    writeSecretFile(file, "two");
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(fs.readdirSync(dir)).toEqual(["secret"]);
  });

  it.runIf(posix)("tightens a file that was world-readable", () => {
    const file = path.join(dir, "secret");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    writeSecretFile(file, "new");
    expect(mode(file)).toBe(0o600);
  });
});
