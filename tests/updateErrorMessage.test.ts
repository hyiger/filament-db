import { describe, it, expect } from "vitest";
import { classifyUpdateError } from "@/lib/updateErrorMessage";

describe("classifyUpdateError (GH #946)", () => {
  it("classifies the reported missing-latest.yml 404 as no-metadata and strips the stack", () => {
    // The exact shape from the issue: a multi-line blob with the 404 body and a
    // JS stack trace. The user must never see this raw.
    const err = new Error(
      [
        "Cannot find latest-mac.yml in the latest release artifacts (https://github.com/hyiger/filament-db/releases/download/v1.62.0/latest-mac.yml): HttpError: 404",
        '"method: GET url: https://github.com/.../latest-mac.yml',
        "Please double check that your authentication token is correct.",
        "    at createHttpError (/Applications/Filament DB.app/Contents/Resources/app/electron-dist/main.js:21812:14)",
        "    at ElectronHttpExecutor.handleResponse (.../main.js:21905:18)",
      ].join("\n"),
    );
    const { kind, detail } = classifyUpdateError(err);
    expect(kind).toBe("no-metadata");
    expect(detail).toMatch(/^Cannot find latest-mac\.yml/);
    expect(detail).not.toMatch(/\bat createHttpError/);
    expect(detail).not.toContain("\n");
    expect(detail.length).toBeLessThanOrEqual(140);
  });

  it("classifies DNS / connection / timeout failures as network", () => {
    expect(classifyUpdateError(new Error("getaddrinfo ENOTFOUND github.com")).kind).toBe("network");
    expect(classifyUpdateError(new Error("connect ECONNREFUSED 140.82.113.3:443")).kind).toBe("network");
    expect(classifyUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED")).kind).toBe("network");
    expect(classifyUpdateError(new Error("The request timed out.")).kind).toBe("network");
  });

  it("prioritizes a transport error over the metadata URL it was fetching (Codex review)", () => {
    // A DNS/timeout failure while requesting latest-mac.yml carries the URL in
    // its message; it must classify as `network`, not `no-metadata`.
    expect(
      classifyUpdateError(
        new Error(
          "getaddrinfo ENOTFOUND github.com (requesting https://github.com/o/r/releases/download/v1/latest-mac.yml)",
        ),
      ).kind,
    ).toBe("network");
    expect(
      classifyUpdateError(new Error("Could not download latest.yml: net::ERR_TIMED_OUT")).kind,
    ).toBe("network");
  });

  it("classifies checksum / code-signature failures as signature", () => {
    expect(classifyUpdateError(new Error("sha512 checksum mismatch, expected X got Y")).kind).toBe("signature");
    expect(classifyUpdateError(new Error("Could not get code signature for running application")).kind).toBe("signature");
  });

  it("prioritizes signing failures that also mention a certificate over the network branch (Codex review)", () => {
    // electron-updater's Windows verification rejects an installer whose
    // signing certificate is wrong/expired with messages that carry both
    // signature/publisher wording AND the word `certificate` — these must not
    // read as "check your connection".
    expect(
      classifyUpdateError(
        new Error(
          "New version 1.63.0 is not signed by the application owner: publisherNames: [Hyiger], raw info: certificate chain is invalid",
        ),
      ).kind,
    ).toBe("signature");
    expect(
      classifyUpdateError(
        new Error("Code signature validation failed: signing certificate has expired"),
      ).kind,
    ).toBe("signature");
  });

  it("still classifies TLS-layer certificate failures as network", () => {
    expect(classifyUpdateError(new Error("self signed certificate in certificate chain")).kind).toBe("network");
    expect(classifyUpdateError(new Error("unable to verify the first certificate")).kind).toBe("network");
    expect(classifyUpdateError(new Error("certificate has expired")).kind).toBe("network");
    expect(classifyUpdateError(new Error("net::ERR_CERT_AUTHORITY_INVALID")).kind).toBe("network");
  });

  it("falls back to unknown with a short, first-line detail", () => {
    const { kind, detail } = classifyUpdateError(
      new Error("Something unexpected went wrong\n    at foo (bar.js:1:1)"),
    );
    expect(kind).toBe("unknown");
    expect(detail).toBe("Something unexpected went wrong");
  });

  it("caps an overlong single-line detail with an ellipsis", () => {
    const { detail } = classifyUpdateError(new Error("x".repeat(500)));
    expect(detail.length).toBeLessThanOrEqual(140);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("handles non-Error inputs (string / null / message-bearing object)", () => {
    expect(classifyUpdateError("plain string boom").detail).toBe("plain string boom");
    expect(classifyUpdateError(null).kind).toBe("unknown");
    expect(classifyUpdateError({ message: "obj message ETIMEDOUT" }).kind).toBe("network");
  });
});
