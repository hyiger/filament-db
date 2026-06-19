import { describe, it, expect } from "vitest";
import { pickShareBase } from "@/lib/shareLink";

/**
 * GH #780 — share links must be reachable by others, not localhost-only.
 * `pickShareBase` decides whether to keep the browser origin or upgrade a
 * loopback origin to the LAN IP (only when the instance is actually exposed).
 */
describe("pickShareBase", () => {
  const lan = { ips: ["192.168.1.50"], port: 3456 };

  it("leaves a real (non-loopback) origin unchanged and never warns (web/Docker on a LAN address)", () => {
    expect(pickShareBase("http://192.168.1.50:3456", null, false)).toEqual({
      base: "http://192.168.1.50:3456",
      warnLocalOnly: false,
    });
    expect(pickShareBase("https://filament.example.com", lan, true)).toEqual({
      base: "https://filament.example.com",
      warnLocalOnly: false,
    });
  });

  it("upgrades a loopback origin to the LAN IP when exposeToLan is on", () => {
    expect(pickShareBase("http://localhost:3456", lan, true)).toEqual({
      base: "http://192.168.1.50:3456",
      warnLocalOnly: false,
    });
    expect(pickShareBase("http://[::1]:3456", lan, true).base).toBe("http://192.168.1.50:3456");
  });

  it("warns (no upgrade) on a loopback origin when the server isn't exposed", () => {
    expect(pickShareBase("http://localhost:3456", lan, false)).toEqual({
      base: "http://localhost:3456",
      warnLocalOnly: true,
    });
  });

  it("warns on a loopback origin when exposed but no LAN IP is known", () => {
    expect(pickShareBase("http://127.0.0.1:3456", { ips: [], port: 3456 }, true)).toEqual({
      base: "http://127.0.0.1:3456",
      warnLocalOnly: true,
    });
    expect(pickShareBase("http://localhost:3456", null, true).warnLocalOnly).toBe(true);
  });

  it("returns an empty base unchanged (SSR, no window) without warning", () => {
    expect(pickShareBase("", null, false)).toEqual({ base: "", warnLocalOnly: false });
  });
});
