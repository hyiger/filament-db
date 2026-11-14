import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { httpPortApiKey } from "@/lib/apiAuth";
import {
  DEFAULT_DESKTOP_HTTPS_PORT,
  DEFAULT_SECURE_DIR_NAME,
  GATEWAY_GLOBAL_KEY,
  desktopHttpsPort,
  parseGatewayEnv,
  secureGatewayRunning,
} from "@/lib/gatewayConfig";

/** Environment configuration of the secure gateway (HTTPS + API key). */

const CWD = path.resolve("/srv/filament-db");
const HOME = path.resolve("/home/filament");

function enabled(env: Record<string, string | undefined>) {
  const result = parseGatewayEnv(env, CWD, HOME);
  if (result.state !== "enabled") throw new Error(`expected enabled, got ${JSON.stringify(result)}`);
  return result.config;
}

describe("parseGatewayEnv", () => {
  it("is disabled without FILAMENTDB_HTTPS_PORT", () => {
    expect(parseGatewayEnv({}, CWD)).toEqual({ state: "disabled" });
    expect(parseGatewayEnv({ FILAMENTDB_HTTPS_PORT: "" }, CWD)).toEqual({ state: "disabled" });
    expect(parseGatewayEnv({ FILAMENTDB_HTTPS_PORT: "   " }, CWD)).toEqual({ state: "disabled" });
    // The other variables alone do not turn it on.
    expect(
      parseGatewayEnv({ FILAMENTDB_API_KEY: "k", FILAMENTDB_SECURE_DIR: "/data" }, CWD, HOME),
    ).toEqual({ state: "disabled" });
  });

  it("applies defaults", () => {
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443" })).toEqual({
      port: 3443,
      host: "0.0.0.0",
      upstream: { host: "127.0.0.1", port: 3000 },
      secureDir: path.join(HOME, ".filament-db", "secure"),
      envApiKey: null,
      tlsCertFile: null,
      tlsKeyFile: null,
      extraHosts: [],
    });
  });

  it("reads every setting", () => {
    expect(
      enabled({
        FILAMENTDB_HTTPS_PORT: " 3457 ",
        FILAMENTDB_HTTPS_HOST: " 192.168.1.10 ",
        PORT: "3456",
        HOSTNAME: "localhost",
        FILAMENTDB_SECURE_DIR: "/data/secure",
        FILAMENTDB_API_KEY: "my-own-key",
        FILAMENTDB_TLS_CERT: "/certs/fullchain.pem",
        FILAMENTDB_TLS_KEY: "/certs/privkey.pem",
        FILAMENTDB_TLS_HOSTS: " nas.lan , 10.0.0.5,, ",
      }),
    ).toEqual({
      port: 3457,
      host: "192.168.1.10",
      upstream: { host: "localhost", port: 3456 },
      secureDir: path.resolve("/data/secure"),
      envApiKey: "my-own-key",
      tlsCertFile: "/certs/fullchain.pem",
      tlsKeyFile: "/certs/privkey.pem",
      extraHosts: ["nas.lan", "10.0.0.5"],
    });
  });

  it("resolves a relative secure directory against the working directory", () => {
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443", FILAMENTDB_SECURE_DIR: "secrets" }).secureDir).toBe(
      path.join(CWD, "secrets"),
    );
  });

  it("reaches a wildcard-bound HTTP server over loopback", () => {
    for (const HOSTNAME of [undefined, "", "0.0.0.0", "::", "[::]", "  "]) {
      expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443", HOSTNAME }).upstream.host).toBe("127.0.0.1");
    }
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443", HOSTNAME: "[::1]" }).upstream.host).toBe("::1");
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443", HOSTNAME: "10.0.0.2" }).upstream.host).toBe("10.0.0.2");
  });

  it("falls back to port 3000 when PORT is not a port", () => {
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443", PORT: "http" }).upstream.port).toBe(3000);
  });

  it("is invalid for a port that is not a port", () => {
    for (const FILAMENTDB_HTTPS_PORT of ["abc", "0", "65536", "-1", "3443.5", "34 43", "1e3", "999999"]) {
      const result = parseGatewayEnv({ FILAMENTDB_HTTPS_PORT }, CWD);
      expect(result.state).toBe("invalid");
      expect(result).toMatchObject({ error: expect.stringContaining("FILAMENTDB_HTTPS_PORT") });
    }
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "1" }).port).toBe(1);
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "65535" }).port).toBe(65535);
  });

  it("is invalid when it would share the HTTP port", () => {
    expect(parseGatewayEnv({ FILAMENTDB_HTTPS_PORT: "3456", PORT: "3456" }, CWD).state).toBe("invalid");
    expect(parseGatewayEnv({ FILAMENTDB_HTTPS_PORT: "3000" }, CWD).state).toBe("invalid");
  });

  it("is invalid with only half of an own certificate", () => {
    const base = { FILAMENTDB_HTTPS_PORT: "3443" };
    expect(parseGatewayEnv({ ...base, FILAMENTDB_TLS_CERT: "/c.pem" }, CWD)).toEqual({
      state: "invalid",
      error: "Set both FILAMENTDB_TLS_CERT and FILAMENTDB_TLS_KEY, or neither.",
    });
    expect(parseGatewayEnv({ ...base, FILAMENTDB_TLS_KEY: "/k.pem" }, CWD).state).toBe("invalid");
    expect(parseGatewayEnv({ ...base, FILAMENTDB_TLS_CERT: " ", FILAMENTDB_TLS_KEY: "" }, CWD).state).toBe(
      "enabled",
    );
  });

  it("keeps the key and certificates in the home directory by default, not the working directory", () => {
    // Next's standalone server.js changes into .next/standalone, which every
    // build deletes: a default there would lose the key and CA on each update.
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443" }).secureDir).toBe(
      path.join(HOME, ".filament-db", "secure"),
    );
    const homeless = parseGatewayEnv({ FILAMENTDB_HTTPS_PORT: "3443" }, CWD, "");
    expect(homeless.state === "enabled" && homeless.config.secureDir).toBe(
      path.join(CWD, DEFAULT_SECURE_DIR_NAME),
    );
  });

  it("defaults the working and home directories to the process's", () => {
    const result = parseGatewayEnv({ FILAMENTDB_HTTPS_PORT: "3443" });
    expect(result.state === "enabled" && path.isAbsolute(result.config.secureDir)).toBe(true);
    const relative = parseGatewayEnv({ FILAMENTDB_HTTPS_PORT: "3443", FILAMENTDB_SECURE_DIR: "s" });
    expect(relative.state === "enabled" && relative.config.secureDir).toBe(path.join(process.cwd(), "s"));
  });

  it("trims the environment's key and treats a blank one as unset", () => {
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443", FILAMENTDB_API_KEY: "  key-with-newline\n" }).envApiKey).toBe(
      "key-with-newline",
    );
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443", FILAMENTDB_API_KEY: "   " }).envApiKey).toBeNull();
    expect(enabled({ FILAMENTDB_HTTPS_PORT: "3443", FILAMENTDB_API_KEY: "" }).envApiKey).toBeNull();
  });
});

describe("desktopHttpsPort", () => {
  it("defaults to 3457", () => {
    expect(DEFAULT_DESKTOP_HTTPS_PORT).toBe(3457);
    expect(desktopHttpsPort(undefined, 3456)).toBe(3457);
    expect(desktopHttpsPort("", 3456)).toBe(3457);
  });

  it("uses a requested port that is a real port", () => {
    expect(desktopHttpsPort("8443", 3456)).toBe(8443);
    expect(desktopHttpsPort(" 8443 ", 3456)).toBe(8443);
  });

  it("falls back to the default for a value that is not a port", () => {
    for (const requested of ["https", "0", "65536", "34.57", "-1"]) {
      expect(desktopHttpsPort(requested, 3456)).toBe(3457);
    }
  });

  it("never returns the HTTP port, requested or by default", () => {
    // Requested the same port as HTTP: fall back.
    expect(desktopHttpsPort("3456", 3456)).toBe(3457);
    // The app itself runs on 3457 (PORT=3457): the default would collide.
    expect(desktopHttpsPort(undefined, 3457)).toBe(3458);
    expect(desktopHttpsPort("3457", 3457)).toBe(3458);
    expect(desktopHttpsPort("nope", 3457)).toBe(3458);
    // Whatever comes out is a pair parseGatewayEnv accepts.
    for (const [requested, http] of [[undefined, 3457], ["3457", 3457], ["3456", 3456], [undefined, 3456]] as const) {
      const port = desktopHttpsPort(requested, http);
      expect(
        parseGatewayEnv({ FILAMENTDB_HTTPS_PORT: String(port), PORT: String(http) }, CWD, HOME).state,
      ).toBe("enabled");
    }
  });
});

describe("secureGatewayRunning", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g[GATEWAY_GLOBAL_KEY];
  });

  it("is true only while the process holds a listening gateway", () => {
    expect(secureGatewayRunning()).toBe(false);
    g[GATEWAY_GLOBAL_KEY] = { gateway: null, configured: true, error: "Port 3457 is already in use" };
    expect(secureGatewayRunning()).toBe(false);
    g[GATEWAY_GLOBAL_KEY] = { gateway: {} };
    expect(secureGatewayRunning()).toBe(true);
  });
});

describe("httpPortApiKey", () => {
  it("gates the HTTP port with FILAMENTDB_API_KEY while no gateway is running", () => {
    expect(httpPortApiKey({ FILAMENTDB_API_KEY: "k" }, false)).toBe("k");
    expect(httpPortApiKey({}, false)).toBeUndefined();
  });

  it("leaves the HTTP port open while the gateway holds the key", () => {
    expect(httpPortApiKey({ FILAMENTDB_API_KEY: "k", FILAMENTDB_HTTPS_PORT: "3443" }, true)).toBeUndefined();
    expect(httpPortApiKey({ FILAMENTDB_HTTPS_PORT: "3443" }, true)).toBeUndefined();
  });

  it("keeps gating when a gateway is configured but not running", () => {
    // A valid port with an unreadable certificate, a taken port, a mistyped
    // port: none of them may open a keyed deployment's HTTP port.
    expect(httpPortApiKey({ FILAMENTDB_API_KEY: "k", FILAMENTDB_HTTPS_PORT: "3443" }, false)).toBe("k");
    expect(httpPortApiKey({ FILAMENTDB_API_KEY: "k", FILAMENTDB_HTTPS_PORT: "abc" }, false)).toBe("k");
  });

  it("reads the running state from the process by default", () => {
    const g = globalThis as Record<string, unknown>;
    expect(httpPortApiKey({ FILAMENTDB_API_KEY: "k", FILAMENTDB_HTTPS_PORT: "3443" })).toBe("k");
    g[GATEWAY_GLOBAL_KEY] = { gateway: {} };
    try {
      expect(httpPortApiKey({ FILAMENTDB_API_KEY: "k" })).toBeUndefined();
    } finally {
      delete g[GATEWAY_GLOBAL_KEY];
    }
  });
});
