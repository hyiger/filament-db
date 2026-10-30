import { createHash } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The desktop's mDNS advertisement must never publish records under the
 * machine's own `<hostname>.local`. bonjour-service defaults its `host` to
 * `os.hostname()`, so the A/AAAA records it published for every interface
 * address contradicted the ones the OS responder (mDNSResponder / avahi)
 * advertises for the same name, and macOS renamed the computer on every app
 * start ("This computer's local hostname … is already in use on this
 * network"). The advertisement now owns a dedicated `filamentdb-<host>.local`.
 */

const { publish, BonjourCtor, hostname } = vi.hoisted(() => {
  const publish = vi.fn(() => ({ on: vi.fn(), stop: vi.fn() }));
  const BonjourCtor = vi.fn(function Bonjour() {
    return { publish, unpublishAll: vi.fn(), destroy: vi.fn() };
  });
  const hostname = vi.fn(() => "Studio-Mac.local");
  return { publish, BonjourCtor, hostname };
});

vi.mock("bonjour-service", () => ({ Bonjour: BonjourCtor }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const mocked = { ...actual, hostname };
  return { ...mocked, default: mocked };
});

import {
  advertisedHostName,
  advertisementConfig,
  instanceName,
  startMdnsAdvertisement,
  stopMdnsAdvertisement,
} from "../electron/mdns-service";

/** The 8-hex SHA-256 prefix advertisedHostName appends, recomputed here. */
function digest(machineName: string): string {
  return createHash("sha256").update(machineName.toLowerCase()).digest("hex").slice(0, 8);
}

describe("advertisedHostName", () => {
  it.each([
    ["MacBook-Pro.local", "macbook-pro", "MacBook-Pro"],
    ["Studio-Mac.local", "studio-mac", "Studio-Mac"],
    ["Mac-mini.lan", "mac-mini-lan", "Mac-mini.lan"],
    ["printers.example.com", "printers-example-com", "printers.example.com"],
    ["DESKTOP-4F2K9QZ", "desktop-4f2k9qz", "DESKTOP-4F2K9QZ"],
    ["raspberrypi", "raspberrypi", "raspberrypi"],
    ["my_host", "my-host", "my_host"],
    ["  spaced name  ", "spaced-name", "spaced name"],
    ["--edge--", "edge", "--edge--"],
    ["a__--__b", "a-b", "a__--__b"],
    ["Büro-PC", "b-ro-pc", "Büro-PC"],
    ["MacBook-Pro.local.", "macbook-pro", "MacBook-Pro"],
  ])("derives a dedicated name from %j", (input, readable, machineName) => {
    expect(advertisedHostName(input)).toBe(`filamentdb-${readable}-${digest(machineName)}.local`);
  });

  it("pins the digest algorithm, so a released build's name doesn't drift", () => {
    expect(advertisedHostName("Studio-Mac.local")).toBe("filamentdb-studio-mac-972477ff.local");
  });

  it.each([[""], ["   "], [".local"], [" .local. "]])(
    "falls back to filamentdb.local when there is no hostname (%j)",
    (input) => {
      expect(advertisedHostName(input)).toBe("filamentdb.local");
    },
  );

  it("keeps a digest-only name for a hostname with no usable characters", () => {
    expect(advertisedHostName("___")).toBe(`filamentdb-${digest("___")}.local`);
    expect(advertisedHostName("éè")).toBe(`filamentdb-${digest("éè")}.local`);
  });

  it("keeps distinct hostnames distinct after sanitizing and truncating", () => {
    const pairs: Array<[string, string]> = [
      ["mac.lan", "mac.home"],
      ["mac.lan", "mac-lan"],
      ["my_host", "my-host"],
      ["éè", "ëë"],
      [`${"x".repeat(60)}-one`, `${"x".repeat(60)}-two`],
    ];
    for (const [a, b] of pairs) {
      expect(advertisedHostName(a)).not.toBe(advertisedHostName(b));
    }
  });

  it("is stable for one machine name, ignoring case and a .local suffix", () => {
    expect(advertisedHostName("Studio-Mac")).toBe(advertisedHostName("Studio-Mac.local"));
    expect(advertisedHostName("STUDIO-MAC.LOCAL")).toBe(advertisedHostName("studio-mac"));
    expect(advertisedHostName("Studio-Mac.local")).toBe(advertisedHostName("Studio-Mac.local"));
  });

  it("never returns the machine's own .local name", () => {
    for (const host of ["MacBook-Pro.local", "filamentdb.local", "filamentdb-x.local", "Mac"]) {
      expect(advertisedHostName(host).toLowerCase()).not.toBe(
        host.toLowerCase().replace(/\.local$/, "") + ".local",
      );
    }
  });

  it("keeps the label within the 63-octet DNS limit with no doubled hyphen", () => {
    // 43 readable characters fit; this cut lands on the hyphen after the a's.
    const cutOnHyphen = `${"a".repeat(42)}-${"b".repeat(40)}.local`;
    const label = advertisedHostName(cutOnHyphen).replace(/\.local$/, "");
    expect(label).toBe(`filamentdb-${"a".repeat(42)}-${digest(cutOnHyphen.replace(/\.local$/, ""))}`);
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).not.toMatch(/--/);

    const full = advertisedHostName("c".repeat(100)).replace(/\.local$/, "");
    expect(full).toBe(`filamentdb-${"c".repeat(43)}-${digest("c".repeat(100))}`);
    expect(full.length).toBe(63);
  });

  it("produces only DNS-label characters", () => {
    for (const host of ["Office's MacBook Pro", "host.with.dots", "日本語-pc", "x!@#$%^&*()y", "___"]) {
      expect(advertisedHostName(host)).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.local$/);
    }
  });
});

describe("instanceName (#723 collision protection)", () => {
  it("suffixes the hostname without .local", () => {
    expect(instanceName("Studio-Mac.local")).toBe("Filament DB (Studio-Mac)");
    expect(instanceName("raspberrypi")).toBe("Filament DB (raspberrypi)");
  });

  it("falls back to the bare service name for an empty hostname", () => {
    expect(instanceName("")).toBe("Filament DB");
    expect(instanceName(" .local")).toBe("Filament DB");
  });
});

describe("advertisementConfig", () => {
  it("sets an explicit host so bonjour-service never defaults to os.hostname()", () => {
    expect(advertisementConfig(3456, "1.84.0", "Studio-Mac.local")).toEqual({
      name: "Filament DB (Studio-Mac)",
      type: "filamentdb",
      port: 3456,
      host: `filamentdb-studio-mac-${digest("Studio-Mac")}.local`,
      txt: { app: "filament-db", version: "1.84.0" },
    });
  });
});

describe("startMdnsAdvertisement", () => {
  beforeEach(() => {
    publish.mockClear();
    BonjourCtor.mockClear();
    hostname.mockReset();
    hostname.mockReturnValue("Studio-Mac.local");
  });
  afterEach(() => {
    stopMdnsAdvertisement();
  });

  it("publishes under the dedicated host, not the machine's own name", () => {
    startMdnsAdvertisement(3456, "1.84.0");
    expect(publish).toHaveBeenCalledTimes(1);
    const config = (publish.mock.calls[0] as unknown[])[0] as { host?: string; name?: string };
    expect(config.host).toBe(`filamentdb-studio-mac-${digest("Studio-Mac")}.local`);
    expect(config.host).not.toBe("Studio-Mac.local");
    expect(config.name).toBe("Filament DB (Studio-Mac)");
  });

  it("still advertises when os.hostname() throws", () => {
    hostname.mockImplementation(() => {
      throw new Error("uv_os_gethostname failed");
    });
    startMdnsAdvertisement(3456, "1.84.0");
    const config = (publish.mock.calls[0] as unknown[])[0] as { host?: string; name?: string };
    expect(config.host).toBe("filamentdb.local");
    expect(config.name).toBe("Filament DB");
  });
});
