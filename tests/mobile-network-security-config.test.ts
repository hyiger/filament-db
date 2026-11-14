import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

/**
 * The Android network security configuration the mobile app's config plugin
 * writes (packages/mobile/plugins). It is what lets the Android app accept a
 * Filament DB secure gateway's generated certificate once the owner has
 * installed its certificate authority — and it is security configuration, so
 * what it grants is pinned here.
 *
 * Loaded with `require`: the file is plain CommonJS because Expo loads config
 * plugins through Node as they are.
 */
const require = createRequire(import.meta.url);
const {
  NETWORK_SECURITY_CONFIG_RESOURCE,
  NETWORK_SECURITY_CONFIG_XML,
  applyNetworkSecurityConfig,
} = require("../packages/mobile/plugins/networkSecurityConfig.js") as {
  NETWORK_SECURITY_CONFIG_RESOURCE: string;
  NETWORK_SECURITY_CONFIG_XML: string;
  applyNetworkSecurityConfig: (application: { $?: Record<string, string> }) => {
    $: Record<string, string>;
  };
};

describe("Android network security config", () => {
  const anchors = [...NETWORK_SECURITY_CONFIG_XML.matchAll(/<certificates\s+src="([^"]+)"/g)].map(
    (m) => m[1],
  );

  it("trusts user-installed certificate authorities next to the system ones", () => {
    // Listing trust anchors replaces the default set, so both must be named.
    expect(anchors).toEqual(["system", "user"]);
  });

  it("keeps cleartext allowed for desktops older than the secure gateway", () => {
    // With a config present, this — not android:usesCleartextTraffic — decides
    // on Android 7+, and the default for a current target SDK is "no".
    expect(NETWORK_SECURITY_CONFIG_XML).toMatch(/<base-config cleartextTrafficPermitted="true">/);
  });

  it("grants nothing else", () => {
    // No bundled certificate (`@raw/…`), no per-domain exceptions, no pinning
    // overrides, no debug-only block that a release build would silently lack.
    expect(NETWORK_SECURITY_CONFIG_XML).not.toMatch(/@raw\//);
    expect(NETWORK_SECURITY_CONFIG_XML).not.toMatch(/<domain-config|<debug-overrides|<pin-set/);
    expect(NETWORK_SECURITY_CONFIG_XML).not.toMatch(/overridePins/);
    expect(NETWORK_SECURITY_CONFIG_XML.match(/<base-config/g)).toHaveLength(1);
  });

  it("is a well-formed resource file", () => {
    expect(NETWORK_SECURITY_CONFIG_XML.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
    expect(NETWORK_SECURITY_CONFIG_XML).toMatch(/<\/network-security-config>\n$/);
    expect(NETWORK_SECURITY_CONFIG_RESOURCE).toMatch(/^[a-z_]+$/);
  });

  it("points the manifest's application at the resource, keeping its other attributes", () => {
    const application = { $: { "android:name": ".MainApplication", "android:usesCleartextTraffic": "true" } };
    expect(applyNetworkSecurityConfig(application).$).toEqual({
      "android:name": ".MainApplication",
      "android:usesCleartextTraffic": "true",
      "android:networkSecurityConfig": `@xml/${NETWORK_SECURITY_CONFIG_RESOURCE}`,
    });
    expect(applyNetworkSecurityConfig({}).$).toEqual({
      "android:networkSecurityConfig": "@xml/network_security_config",
    });
  });
});
