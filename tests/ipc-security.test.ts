import { describe, it, expect } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { assertTrustedSender, validateMongoUri } from "../electron/ipc-security";

/**
 * GH #516 — pin the security boundary on every privileged IPC handler.
 *
 * `assertTrustedSender` gates 18 ipcMain channels in electron/main.ts
 * (config / NFC / label-printer / sync / runtime-mode / connectivity)
 * and 4 more in electron/auto-updater.ts. `validateMongoUri` runs
 * inline on every renderer-supplied URI in save-config + test-connection.
 *
 * Both files live under electron/ which is excluded from the enforced
 * coverage scope (tsconfig + vitest.config) — so without these tests CI
 * gives no signal when the reject branches regress.
 *
 * `IpcMainInvokeEvent` is structurally simple enough that we don't need
 * to mock the whole Electron module — a partial cast lets us drive the
 * relevant `senderFrame` shape into the helper.
 */
type SenderFrame = {
  parent: SenderFrame | null;
  url: string;
};
function makeEvent(senderFrame: SenderFrame | null): IpcMainInvokeEvent {
  return { senderFrame } as unknown as IpcMainInvokeEvent;
}

describe("assertTrustedSender", () => {
  const topFrame = (url: string): SenderFrame => ({ parent: null, url });
  const subFrame = (url: string, parentUrl = "http://localhost:3456/"): SenderFrame => ({
    parent: topFrame(parentUrl),
    url,
  });

  it("accepts a top-level frame at the expected origin", () => {
    expect(() =>
      assertTrustedSender(makeEvent(topFrame("http://localhost:3456/")), "ch"),
    ).not.toThrow();
  });

  it("accepts the expected origin with a path + query string", () => {
    expect(() =>
      assertTrustedSender(
        makeEvent(topFrame("http://localhost:3456/filaments/123?x=1")),
        "ch",
      ),
    ).not.toThrow();
  });

  it("rejects when the sender frame is missing entirely", () => {
    expect(() => assertTrustedSender(makeEvent(null), "ch")).toThrow(
      /no sender frame/,
    );
  });

  it("rejects when the sender is a sub-frame (iframe / embedded TDS)", () => {
    // The file's docstring threat model: an embedded TDS document or an
    // iframe XSS payload would have a non-null parent. Privileged
    // handlers must only run from the top frame.
    expect(() =>
      assertTrustedSender(
        makeEvent(subFrame("http://localhost:3456/embedded")),
        "ch",
      ),
    ).toThrow(/sub-frame/);
  });

  it("rejects an unparseable sender URL", () => {
    expect(() =>
      assertTrustedSender(makeEvent(topFrame("not-a-url")), "ch"),
    ).toThrow(/unparseable sender URL/);
  });

  it("rejects an empty-string sender URL (URL constructor throws)", () => {
    expect(() => assertTrustedSender(makeEvent(topFrame("")), "ch")).toThrow(
      /unparseable sender URL/,
    );
  });

  it("rejects an untrusted origin even at top-level", () => {
    expect(() =>
      assertTrustedSender(
        makeEvent(topFrame("https://evil.example.com/")),
        "ch",
      ),
    ).toThrow(/untrusted origin/);
  });

  it("rejects a different port on localhost as untrusted", () => {
    // 3457 isn't the embedded server port — a phantom Next.js dev
    // instance shouldn't get the same trust.
    expect(() =>
      assertTrustedSender(makeEvent(topFrame("http://localhost:3457/")), "ch"),
    ).toThrow(/untrusted origin/);
  });

  it("rejects http://127.0.0.1 even though it's loopback (origin string differs)", () => {
    // APP_ORIGIN is the literal "http://localhost:<port>". 127.0.0.1 is
    // a different URL origin string even though it resolves to the
    // same host. Trust check is exact-string.
    expect(() =>
      assertTrustedSender(makeEvent(topFrame("http://127.0.0.1:3456/")), "ch"),
    ).toThrow(/untrusted origin/);
  });

  it("includes the channel name in every rejection (for log triage)", () => {
    const errs: string[] = [];
    for (const evt of [
      makeEvent(null),
      makeEvent(subFrame("http://localhost:3456/")),
      makeEvent(topFrame("not-a-url")),
      makeEvent(topFrame("https://evil.example.com/")),
    ]) {
      try {
        assertTrustedSender(evt, "my-channel");
      } catch (e) {
        errs.push((e as Error).message);
      }
    }
    expect(errs).toHaveLength(4);
    for (const msg of errs) {
      expect(msg).toMatch(/"my-channel"/);
    }
  });
});

describe("validateMongoUri", () => {
  describe("type/shape rejections", () => {
    it.each([
      ["non-string number", 123],
      ["non-string boolean", true],
      ["non-string object", { uri: "mongodb://x" }],
      ["null", null],
      ["undefined", undefined],
    ])("rejects %s as non-string", (_label, v) => {
      const r = validateMongoUri(v);
      expect(r).toBe("MongoDB URI must be a non-empty string");
    });

    it("rejects the empty string", () => {
      expect(validateMongoUri("")).toBe("MongoDB URI must be a non-empty string");
    });

    it("rejects a whitespace-only string", () => {
      expect(validateMongoUri("   ")).toBe(
        "MongoDB URI must be a non-empty string",
      );
    });
  });

  describe("scheme rejections", () => {
    it.each([
      ["http", "http://localhost/db"],
      ["https", "https://atlas.example.com/db"],
      ["file", "file:///etc/passwd"],
      ["javascript", "javascript:alert(1)"],
      ["data", "data:,foo"],
      ["plain-no-scheme", "localhost:27017/db"],
    ])("rejects %s scheme", (_label, uri) => {
      const r = validateMongoUri(uri);
      expect(r).toMatch(/must start with mongodb:\/\/ or mongodb\+srv:\/\//);
    });

    it("accepts mongodb:// scheme", () => {
      expect(validateMongoUri("mongodb://localhost:27017/db")).toBeNull();
    });

    it("accepts mongodb+srv:// scheme", () => {
      expect(
        validateMongoUri("mongodb+srv://user:pw@cluster.mongodb.net/db"),
      ).toBeNull();
    });

    it("accepts a multi-host mongodb URI that doesn't round-trip through WHATWG URL", () => {
      // Replica-set notation per the file's own comment about why the
      // scheme check is a regex rather than `new URL()`.
      expect(
        validateMongoUri("mongodb://h1.example,h2.example,h3.example:27017/db"),
      ).toBeNull();
    });

    it("accepts scheme case-insensitively", () => {
      expect(validateMongoUri("MONGODB://localhost/db")).toBeNull();
      expect(validateMongoUri("MongoDB+SRV://x.mongodb.net/db")).toBeNull();
    });

    it("trims leading/trailing whitespace before the scheme check", () => {
      expect(validateMongoUri("  mongodb://localhost/db  ")).toBeNull();
    });
  });

  describe("filesystem TLS option rejections (GH #300)", () => {
    // The whole point of this list is to block a renderer-supplied URI
    // from causing the Mongo driver to open a local file during the TLS
    // handshake — an arbitrary-file-read pivot.
    it.each([
      "tlsCAFile",
      "tlsCertificateKeyFile",
      "tlsCRLFile",
      "sslCA",
      "sslCert",
      "sslKey",
    ])("rejects %s", (option) => {
      const r = validateMongoUri(
        `mongodb://localhost/db?${option}=/etc/passwd`,
      );
      expect(r).toMatch(new RegExp(`option "${option.toLowerCase()}".*not allowed`));
    });

    it.each([
      "TLSCAFILE",
      "TlsCertificateKeyFile",
      "sslKEY",
    ])("rejects %s case-insensitively", (option) => {
      const r = validateMongoUri(`mongodb://localhost/db?${option}=/foo`);
      expect(r).toMatch(/not allowed/);
    });

    it("rejects the option when it appears as a non-first query parameter", () => {
      const r = validateMongoUri(
        "mongodb://localhost/db?replicaSet=rs0&tlsCAFile=/etc/ca.pem&authSource=admin",
      );
      expect(r).toMatch(/tlscafile.*not allowed/);
    });

    it("does NOT reject a benign TLS option that doesn't reference a file", () => {
      expect(
        validateMongoUri("mongodb://localhost/db?tls=true&tlsAllowInvalidCertificates=false"),
      ).toBeNull();
    });

    it("does NOT reject a value that COINCIDENTALLY contains a filesystem option name (no '=' after)", () => {
      // The check is `${opt}=` — a username/password/db-name containing
      // the substring `tlscafile` without a trailing `=` must not
      // false-positive.
      expect(
        validateMongoUri("mongodb://tlscafile_lookalike:pw@host/db"),
      ).toBeNull();
    });
  });
});
