import { describe, it, expect } from "vitest";
import { discoveredServersFromService } from "../packages/mobile/src/lib/zeroconf";

/**
 * The mobile app's mDNS result → server address mapping. The desktop's secure
 * gateway advertises `tls=1` (electron/mdns-service.ts); the address the app
 * offers has to use the scheme the advertised port actually speaks.
 */
describe("discoveredServersFromService", () => {
  it("offers https for a desktop that advertises its secure gateway", () => {
    const servers = discoveredServersFromService({
      name: "Filament DB (studio)",
      port: 3457,
      addresses: ["192.168.1.50"],
      txt: { app: "filament-db", version: "1.86.0", tls: "1", auth: "key" },
    });
    expect(servers).toEqual([
      {
        id: "https://192.168.1.50:3457",
        name: "Filament DB (studio)",
        url: "https://192.168.1.50:3457",
        secure: true,
      },
    ]);
  });

  it("marks each entry secure or not, for the list and for the key rule", () => {
    // The settings screen shows this flag, and serverKeyPolicy asks before a
    // key goes to an address that was discovered without it.
    const [secure] = discoveredServersFromService({
      port: 3457,
      addresses: ["192.168.1.50"],
      txt: { tls: "1" },
    });
    const [legacy] = discoveredServersFromService({ port: 3456, addresses: ["192.168.1.50"] });
    expect(secure.secure).toBe(true);
    expect(legacy.secure).toBe(false);
    // The flag and the scheme never disagree.
    expect(secure.url.startsWith("https://")).toBe(true);
    expect(legacy.url.startsWith("http://")).toBe(true);
  });

  it("keeps http for a desktop that predates the gateway (no tls record)", () => {
    const withoutTxt = discoveredServersFromService({
      name: "Filament DB",
      port: 3456,
      addresses: ["192.168.1.50"],
    });
    const withOtherTxt = discoveredServersFromService({
      name: "Filament DB",
      port: 3456,
      addresses: ["192.168.1.50"],
      txt: { app: "filament-db", version: "1.85.0" },
    });
    expect(withoutTxt.map((s) => s.url)).toEqual(["http://192.168.1.50:3456"]);
    expect(withOtherTxt.map((s) => s.url)).toEqual(["http://192.168.1.50:3456"]);
  });

  it("treats only the exact value 1 as TLS", () => {
    for (const tls of ["0", "", "true", 0, null, undefined]) {
      const [server] = discoveredServersFromService({
        port: 3456,
        addresses: ["10.0.0.5"],
        txt: { tls },
      });
      expect(server.url).toBe("http://10.0.0.5:3456");
    }
    // A numeric 1 from a platform that parses TXT values is the same record.
    const [numeric] = discoveredServersFromService({
      port: 3457,
      addresses: ["10.0.0.5"],
      txt: { tls: 1 },
    });
    expect(numeric.url).toBe("https://10.0.0.5:3457");
  });

  it("applies the scheme to the .local fallback and to every address", () => {
    const fallback = discoveredServersFromService({
      host: "filamentdb-studio-1a2b3c4d.local.",
      port: 3457,
      txt: { tls: "1" },
    });
    expect(fallback.map((s) => s.url)).toEqual(["https://filamentdb-studio-1a2b3c4d.local:3457"]);

    const many = discoveredServersFromService({
      port: 3457,
      addresses: ["100.64.0.2", "192.168.1.50", "fe80::1", "169.254.1.1"],
      txt: { tls: "1" },
    });
    expect(many.map((s) => s.url)).toEqual([
      "https://192.168.1.50:3457",
      "https://100.64.0.2:3457",
    ]);
  });

  it("returns nothing without a port or a service", () => {
    expect(discoveredServersFromService(null)).toEqual([]);
    expect(discoveredServersFromService({ addresses: ["192.168.1.50"], txt: { tls: "1" } })).toEqual([]);
  });
});
