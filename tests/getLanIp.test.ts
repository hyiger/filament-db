import { describe, it, expect } from "vitest";
import { pickLanIpv4, type NetworkAddress } from "@/lib/getLanIp";

const v4 = (address: string, internal = false): NetworkAddress => ({
  address,
  family: "IPv4",
  internal,
});
const v4num = (address: string, internal = false): NetworkAddress => ({
  address,
  family: 4,
  internal,
});
const v6 = (address: string, internal = false): NetworkAddress => ({
  address,
  family: "IPv6",
  internal,
});

describe("pickLanIpv4", () => {
  it("returns the non-internal IPv4 address", () => {
    expect(
      pickLanIpv4({
        lo0: [v4("127.0.0.1", true), v6("::1", true)],
        en0: [v4("192.168.1.42"), v6("fe80::1")],
      }),
    ).toEqual(["192.168.1.42"]);
  });

  it("skips loopback / internal interfaces", () => {
    expect(pickLanIpv4({ lo0: [v4("127.0.0.1", true)] })).toEqual([]);
  });

  it("skips IPv6 addresses", () => {
    expect(pickLanIpv4({ en0: [v6("fe80::abcd"), v6("2001:db8::1")] })).toEqual([]);
  });

  it("skips link-local APIPA (169.254.x.x)", () => {
    expect(
      pickLanIpv4({ en0: [v4("169.254.10.20"), v4("10.0.0.5")] }),
    ).toEqual(["10.0.0.5"]);
  });

  it("accepts numeric family (Node 18+ shape)", () => {
    expect(pickLanIpv4({ en0: [v4num("192.168.4.29")] })).toEqual(["192.168.4.29"]);
  });

  it("recognises all RFC1918 private ranges", () => {
    expect(pickLanIpv4({ a: [v4("192.168.0.1")] })).toEqual(["192.168.0.1"]);
    expect(pickLanIpv4({ a: [v4("10.1.2.3")] })).toEqual(["10.1.2.3"]);
    expect(pickLanIpv4({ a: [v4("172.16.0.1")] })).toEqual(["172.16.0.1"]);
    expect(pickLanIpv4({ a: [v4("172.20.20.20")] })).toEqual(["172.20.20.20"]);
    expect(pickLanIpv4({ a: [v4("172.31.255.254")] })).toEqual(["172.31.255.254"]);
  });

  it("treats 172.15 and 172.32 as NON-private (boundary check)", () => {
    // both still returned (they're valid non-internal IPv4), just ranked after privates
    const out = pickLanIpv4({
      vpn: [v4("172.15.0.1")],
      lan: [v4("192.168.1.1")],
    });
    expect(out).toEqual(["192.168.1.1", "172.15.0.1"]);
  });

  it("orders private LAN addresses ahead of public/VPN ones", () => {
    expect(
      pickLanIpv4({
        tailscale0: [v4("100.101.102.103")], // CGNAT / VPN — not RFC1918
        en0: [v4("192.168.1.50")],
      }),
    ).toEqual(["192.168.1.50", "100.101.102.103"]);
  });

  it("keeps original order within the same rank (stable sort)", () => {
    expect(
      pickLanIpv4({
        en0: [v4("192.168.1.10")],
        en1: [v4("10.0.0.10")],
      }),
    ).toEqual(["192.168.1.10", "10.0.0.10"]);
  });

  it("handles undefined interface entries and empty input", () => {
    expect(pickLanIpv4({ ghost: undefined, en0: [v4("192.168.1.1")] })).toEqual([
      "192.168.1.1",
    ]);
    expect(pickLanIpv4({})).toEqual([]);
  });

  it("collects addresses across multiple active interfaces", () => {
    expect(
      pickLanIpv4({
        lo0: [v4("127.0.0.1", true)],
        en0: [v4("192.168.1.5")],
        en1: [v4("10.0.0.5")],
      }),
    ).toEqual(["192.168.1.5", "10.0.0.5"]);
  });
});
