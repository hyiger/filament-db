import { describe, it, expect } from "vitest";
import {
  cleartextKeyWarning,
  keyFieldState,
  planSave,
} from "../packages/mobile/src/lib/serverKeyPolicy";

/**
 * Which API key the mobile app may send to which server.
 *
 * The bug this replaces: the Server connection screen seeded its key field
 * from the saved key and kept it whatever happened to the address, so tapping
 * a discovered server and pressing Save sent the previous server's key to the
 * new address — in clear text when the advertisement carried no `tls=1`,
 * which anything on the network can arrange.
 */
const GATEWAY = "https://192.168.1.50:3457";
const KEY = "fdb_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const stored = { baseUrl: GATEWAY, apiKey: KEY };

describe("keyFieldState", () => {
  it("shows the saved key for the server it was saved for", () => {
    expect(keyFieldState({ stored, address: GATEWAY, typedKey: null })).toEqual({
      value: KEY,
      withheld: false,
    });
    // The same server, written differently.
    expect(keyFieldState({ stored, address: `${GATEWAY}/`, typedKey: null }).value).toBe(KEY);
  });

  it("withholds the saved key from a discovered server", () => {
    // What tapping an mDNS result does to the form: only the address changes.
    for (const discovered of [
      "http://192.168.1.50:3457", // same host, tls record stripped
      "http://192.168.1.66:3456", // someone else answering the scan
      "https://192.168.1.66:3457",
    ]) {
      expect(keyFieldState({ stored, address: discovered, typedKey: null }), discovered).toEqual({
        value: "",
        withheld: true,
      });
    }
  });

  it("withholds it when the scheme, host or port is edited", () => {
    for (const edited of [
      "http://192.168.1.50:3457",
      "https://192.168.1.51:3457",
      "https://192.168.1.50:3458",
      "https://192.168.1.5", // mid-edit
    ]) {
      expect(keyFieldState({ stored, address: edited, typedKey: null }).value, edited).toBe("");
    }
  });

  it("gives it back when the address is edited back", () => {
    const away = keyFieldState({ stored, address: "https://192.168.1.5", typedKey: null });
    const back = keyFieldState({ stored, address: GATEWAY, typedKey: null });
    expect(away.value).toBe("");
    expect(back.value).toBe(KEY);
  });

  it("does not call an emptied address a different server", () => {
    expect(keyFieldState({ stored, address: "  ", typedKey: null })).toEqual({
      value: "",
      withheld: false,
    });
  });

  it("uses what the user typed, for whatever address they then enter", () => {
    expect(
      keyFieldState({ stored, address: "https://192.168.1.66:3457", typedKey: "fdb_new" }),
    ).toEqual({ value: "fdb_new", withheld: false });
    // Clearing the field is also an edit: the saved key does not come back.
    expect(keyFieldState({ stored, address: GATEWAY, typedKey: "" })).toEqual({
      value: "",
      withheld: false,
    });
  });

  it("has nothing to withhold when no key is saved", () => {
    const none = { baseUrl: "http://192.168.1.50:3456", apiKey: null };
    expect(keyFieldState({ stored: none, address: GATEWAY, typedKey: null })).toEqual({
      value: "",
      withheld: false,
    });
  });
});

describe("planSave", () => {
  /** The key field's content, as the screen passes it on. */
  const fieldKey = (address: string, typedKey: string | null = null) =>
    keyFieldState({ stored, address, typedKey }).value;

  it("never carries the saved key to a discovered http address", () => {
    const address = "http://192.168.1.66:3456";
    const plan = planSave({
      stored,
      address,
      key: fieldKey(address),
      discoveredUrls: [address],
    });
    expect(plan).toEqual({
      ok: true,
      baseUrl: address,
      apiKey: null,
      serverChanged: true,
      cleartextKey: null,
    });
  });

  it("never carries the saved key to a discovered https address either", () => {
    const address = "https://192.168.1.66:3457";
    const plan = planSave({ stored, address, key: fieldKey(address), discoveredUrls: [address] });
    expect(plan.ok && plan.apiKey).toBeNull();
  });

  it("asks before a re-entered key goes to a discovered http address", () => {
    const address = "http://192.168.1.66:3456";
    const plan = planSave({
      stored,
      address,
      key: fieldKey(address, KEY),
      discoveredUrls: ["https://192.168.1.50:3457", `${address}/`],
    });
    expect(plan).toMatchObject({ ok: true, apiKey: KEY, cleartextKey: "discovered" });
  });

  it("asks before a key goes to a typed http address", () => {
    const address = "http://192.168.1.70:3456";
    const plan = planSave({ stored, address, key: KEY, discoveredUrls: [] });
    expect(plan).toMatchObject({ ok: true, apiKey: KEY, cleartextKey: "manual" });
  });

  it("does not ask for https, with or without discovery", () => {
    const address = "https://192.168.1.66:3457";
    expect(planSave({ stored, address, key: KEY, discoveredUrls: [address] })).toMatchObject({
      ok: true,
      baseUrl: address,
      apiKey: KEY,
      serverChanged: true,
      cleartextKey: null,
    });
  });

  it("does not ask for an http address without a key", () => {
    const address = "http://192.168.1.66:3456";
    expect(planSave({ stored, address, key: "  ", discoveredUrls: [address] })).toMatchObject({
      ok: true,
      apiKey: null,
      cleartextKey: null,
    });
  });

  it("does not ask again for an http address and key already in use", () => {
    const legacy = { baseUrl: "http://192.168.1.50:3456", apiKey: "legacy-key" };
    const plan = planSave({
      stored: legacy,
      address: "http://192.168.1.50:3456/",
      key: "legacy-key",
      discoveredUrls: ["http://192.168.1.50:3456"],
    });
    expect(plan).toMatchObject({ ok: true, serverChanged: false, cleartextKey: null });
    // A different key for the same http address is a new decision.
    expect(
      planSave({ stored: legacy, address: legacy.baseUrl, key: "another-key" }),
    ).toMatchObject({ ok: true, cleartextKey: "manual" });
  });

  it("keeps the saved key when only the same server is re-saved", () => {
    expect(planSave({ stored, address: `${GATEWAY}/`, key: fieldKey(GATEWAY) })).toEqual({
      ok: true,
      baseUrl: GATEWAY,
      apiKey: KEY,
      serverChanged: false,
      cleartextKey: null,
    });
  });

  it("drops the key together with the address", () => {
    expect(planSave({ stored, address: "", key: KEY })).toEqual({
      ok: true,
      baseUrl: null,
      apiKey: null,
      serverChanged: true,
      cleartextKey: null,
    });
  });

  it("refuses an address it cannot parse, before anything is sent", () => {
    for (const bad of ["192.168.1.50:3457", "ftp://192.168.1.50", "https://192.168.1.50@evil.example"]) {
      const plan = planSave({ stored, address: bad, key: KEY });
      expect(plan.ok, bad).toBe(false);
      if (!plan.ok) expect(plan.error).toMatch(/https:\/\/192\.168\.1\.50:3457/);
    }
  });
});

describe("cleartextKeyWarning", () => {
  it("names the address and says why a discovered one is riskier", () => {
    const discovered = cleartextKeyWarning("discovered", "http://192.168.1.66:3456");
    expect(discovered.message).toContain("http://192.168.1.66:3456");
    expect(discovered.message).toMatch(/scanning the network/);
    const manual = cleartextKeyWarning("manual", "http://192.168.1.70:3456");
    expect(manual.message).toContain("http://192.168.1.70:3456");
    expect(manual.message).not.toMatch(/scanning the network/);
    expect(manual.title).toBe(discovered.title);
  });
});
