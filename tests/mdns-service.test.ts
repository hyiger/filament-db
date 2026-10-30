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

describe("advertisedHostName", () => {
  it.each([
    ["MacBook-Pro.local", "filamentdb-macbook-pro.local"],
    ["Studio-Mac.local", "filamentdb-studio-mac.local"],
    ["Mac-mini.lan", "filamentdb-mac-mini-lan.local"],
    ["printers.example.com", "filamentdb-printers-example-com.local"],
    ["DESKTOP-4F2K9QZ", "filamentdb-desktop-4f2k9qz.local"],
    ["raspberrypi", "filamentdb-raspberrypi.local"],
    ["my_host", "filamentdb-my-host.local"],
    ["  spaced name  ", "filamentdb-spaced-name.local"],
    ["--edge--", "filamentdb-edge.local"],
    ["a__--__b", "filamentdb-a-b.local"],
    ["Büro-PC", "filamentdb-b-ro-pc.local"],
    ["MacBook-Pro.local.", "filamentdb-macbook-pro.local"],
  ])("derives a dedicated name from %j", (input, expected) => {
    expect(advertisedHostName(input)).toBe(expected);
  });

  it.each([[""], ["   "], [".local"], ["___"], ["éè"]])(
    "falls back to filamentdb.local for an unusable hostname %j",
    (input) => {
      expect(advertisedHostName(input)).toBe("filamentdb.local");
    },
  );

  it("stays distinct wherever the instance name is (#723)", () => {
    // Same first label, different domains: the instance names differ, so the
    // host names must too, or both desktops would answer for one name.
    expect(instanceName("mac.lan")).not.toBe(instanceName("mac.home"));
    expect(advertisedHostName("mac.lan")).toBe("filamentdb-mac-lan.local");
    expect(advertisedHostName("mac.home")).toBe("filamentdb-mac-home.local");
    // The same machine name with and without .local is one instance name, and
    // one host name.
    expect(advertisedHostName("Studio-Mac")).toBe(advertisedHostName("Studio-Mac.local"));
  });

  it("never returns the machine's own .local name", () => {
    for (const host of ["MacBook-Pro.local", "filamentdb.local", "filamentdb-x.local", "Mac"]) {
      expect(advertisedHostName(host).toLowerCase()).not.toBe(
        host.toLowerCase().replace(/\.local$/, "") + ".local",
      );
    }
  });

  it("keeps the label within the 63-octet DNS limit with no trailing hyphen", () => {
    const long = `${"a".repeat(51)}-${"b".repeat(40)}.local`;
    const label = advertisedHostName(long).replace(/\.local$/, "");
    expect(label.length).toBeLessThanOrEqual(63);
    // "filamentdb-" + 51 a's is 62 chars; the cut lands on the hyphen after them.
    expect(label).toBe(`filamentdb-${"a".repeat(51)}`);
    expect(label.endsWith("-")).toBe(false);

    const exact = advertisedHostName("c".repeat(100)).replace(/\.local$/, "");
    expect(exact).toBe(`filamentdb-${"c".repeat(52)}`);
    expect(exact.length).toBe(63);
  });

  it("produces only DNS-label characters", () => {
    for (const host of ["Office's MacBook Pro", "host.with.dots", "日本語-pc", "x!@#$%^&*()y"]) {
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
      host: "filamentdb-studio-mac.local",
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
    expect(config.host).toBe("filamentdb-studio-mac.local");
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
