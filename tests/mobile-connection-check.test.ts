import { describe, it, expect, afterEach, vi } from "vitest";
import { checkConnection, probeCaCertificate } from "../packages/mobile/src/lib/connectionCheck";

/**
 * The Server connection screen's check, against a stubbed `fetch`: which
 * requests it makes, and — the part that matters — that the plain-HTTP
 * request for the certificate authority never carries the API key.
 */
const GATEWAY = "https://192.168.1.50:3457";
const CA_URL = "http://192.168.1.50:3457/__filamentdb/ca.crt";
const KEY = "fdb_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB…\n-----END CERTIFICATE-----\n";

type Call = { url: string; init: RequestInit | undefined };

function reply(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response;
}

/** Stub fetch with per-URL behaviour and record every call. */
function stubFetch(routes: Record<string, () => Promise<Response>>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const route = routes[url];
      if (!route) throw new Error(`fetch failed: unexpected request to ${url}`);
      return route();
    }),
  );
  return calls;
}

const header = (call: Call, name: string) =>
  (call.init?.headers as Record<string, string> | undefined)?.[name];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("checkConnection", () => {
  it("passes when the keyed read works, and makes no second request", async () => {
    const calls = stubFetch({ [`${GATEWAY}/api/locations`]: async () => reply(200, "[]") });
    expect(await checkConnection({ baseUrl: GATEWAY, apiKey: KEY }, "ios")).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual([`${GATEWAY}/api/locations`]);
    expect(header(calls[0], "authorization")).toBe(`Bearer ${KEY}`);
  });

  it("diagnoses an untrusted certificate from the CA download, without sending the key over http", async () => {
    const calls = stubFetch({
      [`${GATEWAY}/api/locations`]: async () => {
        // A German iPhone: nothing in the text says "certificate".
        throw new Error("fetch failed: Das Zertifikat für diesen Server ist ungültig.");
      },
      [CA_URL]: async () => reply(200, PEM),
    });
    const result = await checkConnection({ baseUrl: GATEWAY, apiKey: KEY }, "ios");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe("untrusted-certificate");
    expect(result.problem.caUrl).toBe(CA_URL);

    const probe = calls.find((c) => c.url === CA_URL);
    expect(probe).toBeDefined();
    expect(probe?.init?.headers).toBeUndefined();
    expect(probe?.init?.credentials).toBe("omit");
    expect(probe?.init?.redirect).toBe("manual");
    expect(JSON.stringify(probe?.init ?? {})).not.toContain(KEY);
  });

  it("reports a host that answers nothing as unreachable", async () => {
    stubFetch({
      [`${GATEWAY}/api/locations`]: async () => {
        throw new Error("fetch failed: java.net.ConnectException: Failed to connect");
      },
      [CA_URL]: async () => {
        throw new Error("fetch failed: java.net.ConnectException: Failed to connect");
      },
    });
    const result = await checkConnection({ baseUrl: GATEWAY, apiKey: KEY }, "android");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("unreachable");
  });

  it("does not probe when the server answered", async () => {
    const calls = stubFetch({
      [`${GATEWAY}/api/locations`]: async () =>
        reply(401, '{"error":"Unauthorized — this Filament DB address requires an API key."}'),
    });
    const result = await checkConnection({ baseUrl: GATEWAY, apiKey: KEY }, "android");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("key-rejected");
    expect(calls).toHaveLength(1);
  });

  it("does not probe for an http address", async () => {
    const legacy = "http://192.168.1.50:3456";
    const calls = stubFetch({
      [`${legacy}/api/locations`]: async () => {
        throw new Error("fetch failed: java.net.ConnectException: Failed to connect");
      },
    });
    const result = await checkConnection({ baseUrl: legacy, apiKey: null }, "android");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("unreachable");
    expect(calls).toHaveLength(1);
  });

  it("recognises the gateway's answer to an http address on its port", async () => {
    const wrongScheme = "http://192.168.1.50:3457";
    stubFetch({
      [`${wrongScheme}/api/locations`]: async () =>
        reply(400, '{"error":"This port only accepts HTTPS. Use an https:// address."}'),
    });
    const result = await checkConnection({ baseUrl: wrongScheme, apiKey: null }, "android");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe("https-required");
      expect(result.problem.suggestedAddress).toBe(GATEWAY);
    }
  });
});

describe("probeCaCertificate", () => {
  it("skips an http address", async () => {
    const calls = stubFetch({});
    expect(await probeCaCertificate("http://192.168.1.50:3456")).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("classifies what the port answers", async () => {
    stubFetch({ [CA_URL]: async () => reply(404, "<html>404</html>") });
    expect(await probeCaCertificate(GATEWAY)).toBe("plain-http");
  });

  it("reads the gateway's redirect instead of following it", async () => {
    // A gateway with a provided certificate has no CA and redirects the plain
    // request to https://, where the same handshake would fail again.
    stubFetch({ [CA_URL]: async () => reply(308, "") });
    expect(await probeCaCertificate(GATEWAY)).toBe("https-only");
  });

  it("gives up on a port that accepts the connection and never answers", async () => {
    vi.useFakeTimers();
    stubFetch({ [CA_URL]: () => new Promise<Response>(() => {}) });
    const pending = probeCaCertificate(GATEWAY);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toBe("unreachable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up on a body that never arrives", async () => {
    vi.useFakeTimers();
    stubFetch({
      [CA_URL]: async () =>
        ({ ok: true, status: 200, text: () => new Promise<string>(() => {}) }) as unknown as Response,
    });
    const pending = probeCaCertificate(GATEWAY);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toBe("unreachable");
  });
});
