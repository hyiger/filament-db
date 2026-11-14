import { describe, it, expect } from "vitest";
import {
  classifyCaProbe,
  diagnoseConnectionFailure,
  looksLikeCertificateError,
  unreachableMessage,
  type CaProbeResult,
  type ConnectionFailure,
  type DevicePlatform,
} from "../packages/mobile/src/lib/connectionDiagnosis";

/**
 * How the mobile app explains a failed connection.
 *
 * The error texts below are what Expo SDK 56's native `fetch` hands to JS
 * (`fetch failed: ` + the platform's message): the Java exception's
 * `toString()` on Android, `NSError.localizedDescription` — in the phone's
 * language, with no error code — on iOS. They were read from the Expo sources
 * (expo/android/…/fetch/NativeResponse.kt, expo/ios/Fetch/NativeResponse.swift
 * and expo-modules-core's UnexpectedException on each side), not captured
 * from a device.
 */
const GATEWAY = "https://192.168.1.50:3457";
const ANDROID_UNTRUSTED =
  "fetch failed: javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.";
const ANDROID_HOSTNAME =
  "fetch failed: javax.net.ssl.SSLPeerUnverifiedException: Hostname 10.0.0.9 not verified: certificate: sha256/AAAA= subjectAltNames: [192.168.1.50]";
const ANDROID_EXPIRED =
  "fetch failed: javax.net.ssl.SSLHandshakeException: Chain validation failed: java.security.cert.CertificateExpiredException";
const ANDROID_NOT_TLS =
  "fetch failed: javax.net.ssl.SSLHandshakeException: error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER";
const IOS_UNTRUSTED_EN =
  "fetch failed: The certificate for this server is invalid. You might be connecting to a server that is pretending to be “192.168.1.50” which could put your confidential information at risk.";
const IOS_UNTRUSTED_DE =
  "fetch failed: Das Zertifikat für diesen Server ist ungültig. Möglicherweise wird eine Verbindung zu einem Server hergestellt, der sich als „192.168.1.50“ ausgibt.";
const REFUSED = "fetch failed: java.net.ConnectException: Failed to connect to /192.168.1.50:3457";

function diagnose(
  failure: ConnectionFailure,
  caProbe: CaProbeResult,
  opts: { baseUrl?: string; hasKey?: boolean; platform?: DevicePlatform } = {},
) {
  return diagnoseConnectionFailure({
    baseUrl: opts.baseUrl ?? GATEWAY,
    hasKey: opts.hasKey ?? true,
    failure,
    caProbe,
    platform: opts.platform ?? "android",
  });
}
const noResponse = (detail: string | null, timedOut = false): ConnectionFailure => ({
  status: 0,
  message: "Can't reach the server.",
  detail,
  timedOut,
});

describe("classifyCaProbe", () => {
  it("recognises the gateway's certificate authority", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB…\n-----END CERTIFICATE-----\n";
    expect(classifyCaProbe(200, pem)).toBe("certificate");
  });

  it("recognises a port that wants HTTPS and has no CA to offer", () => {
    // The gateway with a provided certificate redirects the plain request (308).
    expect(classifyCaProbe(308, "")).toBe("https-only");
    // nginx and friends: "The plain HTTP request was sent to HTTPS port".
    expect(classifyCaProbe(400, "<html>400 Bad Request</html>")).toBe("https-only");
  });

  it("reads anything else that answered as plain HTTP", () => {
    // A desktop older than the gateway: Next's 404 page for the unknown path.
    expect(classifyCaProbe(404, "<!DOCTYPE html><html>…404…</html>")).toBe("plain-http");
    // A 200 that is not a certificate (a captive portal, another product).
    expect(classifyCaProbe(200, "<html>Sign in to Wi-Fi</html>")).toBe("plain-http");
    expect(classifyCaProbe(500, "")).toBe("plain-http");
  });
});

describe("looksLikeCertificateError", () => {
  it("recognises Android's certificate exceptions", () => {
    expect(looksLikeCertificateError(ANDROID_UNTRUSTED)).toBe(true);
    expect(looksLikeCertificateError(ANDROID_HOSTNAME)).toBe(true);
    expect(looksLikeCertificateError(ANDROID_EXPIRED)).toBe(true);
  });

  it("recognises iOS's sentence only in English", () => {
    expect(looksLikeCertificateError(IOS_UNTRUSTED_EN)).toBe(true);
    // Why the text is only a hint: the same failure on a German iPhone.
    expect(looksLikeCertificateError(IOS_UNTRUSTED_DE)).toBe(false);
  });

  it("does not call a plain-text port or an unreachable host a certificate problem", () => {
    expect(looksLikeCertificateError(ANDROID_NOT_TLS)).toBe(false);
    expect(looksLikeCertificateError(REFUSED)).toBe(false);
    expect(looksLikeCertificateError("fetch failed: timed out")).toBe(false);
    expect(looksLikeCertificateError(null)).toBe(false);
    expect(looksLikeCertificateError("")).toBe(false);
  });
});

describe("diagnoseConnectionFailure — https address, no response", () => {
  it("names the certificate when the port serves the gateway's CA, whatever the error text", () => {
    for (const detail of [ANDROID_UNTRUSTED, IOS_UNTRUSTED_EN, IOS_UNTRUSTED_DE, "fetch failed: ???", null]) {
      const p = diagnose(noResponse(detail), "certificate");
      expect(p.kind, String(detail)).toBe("untrusted-certificate");
      expect(p.caUrl).toBe("http://192.168.1.50:3457/__filamentdb/ca.crt");
      expect(p.message).toMatch(/Nothing was sent/);
    }
  });

  it("gives the steps for the platform, with the download and the fingerprint check", () => {
    const android = diagnose(noResponse(ANDROID_UNTRUSTED), "certificate", { platform: "android" });
    const ios = diagnose(noResponse(IOS_UNTRUSTED_DE), "certificate", { platform: "ios" });
    const other = diagnose(noResponse(null), "certificate", { platform: "other" });
    for (const p of [android, ios, other]) {
      const steps = p.steps.join("\n");
      expect(steps).toContain("http://192.168.1.50:3457/__filamentdb/ca.crt");
      expect(steps).toMatch(/SHA-256 fingerprint/);
      expect(steps).toMatch(/Settings → Network on the Filament DB desktop/);
    }
    expect(android.steps.join("\n")).toMatch(/Install a certificate → CA certificate/);
    expect(ios.steps.join("\n")).toMatch(/Certificate Trust Settings/);
    expect(android.steps.join("\n")).not.toMatch(/Certificate Trust Settings/);
  });

  it("says so when the certificate is for another address", () => {
    const p = diagnose(noResponse(ANDROID_HOSTNAME), "certificate", {
      baseUrl: "https://10.0.0.9:3457",
    });
    expect(p.kind).toBe("untrusted-certificate");
    expect(p.message).toMatch(/not valid for this\s+address/);
  });

  it("does not offer a CA download for a server with its own certificate", () => {
    // Recognised without any help from the error text (a German iPhone).
    for (const detail of [ANDROID_EXPIRED, IOS_UNTRUSTED_DE]) {
      const p = diagnose(noResponse(detail), "https-only");
      expect(p.kind).toBe("untrusted-certificate");
      expect(p.caUrl).toBeNull();
      expect(p.steps).toEqual([]);
      expect(p.message).toMatch(/given its own certificate/);
      expect(p.message).toMatch(/Nothing was sent/);
    }
  });

  it("suggests http for a port that answers in plain text (an older desktop)", () => {
    const p = diagnose(noResponse(ANDROID_NOT_TLS), "plain-http", {
      baseUrl: "https://192.168.1.50:3456",
    });
    expect(p.kind).toBe("not-https");
    expect(p.suggestedAddress).toBe("http://192.168.1.50:3456");
    expect(p.caUrl).toBeNull();
  });

  it("falls back on the error text when the CA request got no answer", () => {
    const p = diagnose(noResponse(ANDROID_UNTRUSTED), "unreachable");
    expect(p.kind).toBe("untrusted-certificate");
    expect(p.caUrl).toBe("http://192.168.1.50:3457/__filamentdb/ca.crt");
    expect(p.message).toMatch(/If this is a Filament DB that generated its own certificate/);
  });

  it("reports an unreachable host as unreachable, not as a certificate problem", () => {
    const refused = diagnose(noResponse(REFUSED), "unreachable");
    expect(refused.kind).toBe("unreachable");
    expect(refused.caUrl).toBeNull();
    expect(refused.message).toContain(REFUSED);

    const timedOut = diagnose(noResponse(null, true), "unreachable");
    expect(timedOut.kind).toBe("timeout");
  });
});

describe("diagnoseConnectionFailure — http address, no response", () => {
  it("never mentions certificates", () => {
    const p = diagnose(noResponse(REFUSED), "skipped", { baseUrl: "http://192.168.1.50:3456" });
    expect(p.kind).toBe("unreachable");
    expect(p.caUrl).toBeNull();
    expect(p.message).not.toMatch(/certificate/i);
  });
});

describe("diagnoseConnectionFailure — the server answered", () => {
  const answered = (status: number, message: string): ConnectionFailure => ({ status, message });

  it("points an http address on the gateway port at https", () => {
    const p = diagnose(
      answered(400, "This port only accepts HTTPS. Use an https:// address."),
      "skipped",
      { baseUrl: "http://192.168.1.50:3457" },
    );
    expect(p.kind).toBe("https-required");
    expect(p.suggestedAddress).toBe("https://192.168.1.50:3457");
  });

  it("tells a missing key from a wrong one", () => {
    const msg = "Unauthorized — this Filament DB address requires an API key.";
    expect(diagnose(answered(401, msg), "skipped", { hasKey: false }).kind).toBe("key-required");
    expect(diagnose(answered(401, msg), "skipped", { hasKey: true }).kind).toBe("key-rejected");
  });

  it("passes on the gateway's lockout message", () => {
    const msg = "Too many attempts with a wrong API key. Try again later.";
    const p = diagnose(answered(429, msg), "skipped");
    expect(p.kind).toBe("too-many-attempts");
    expect(p.message).toBe(msg);
  });

  it("flags an address that is not Filament DB", () => {
    expect(diagnose(answered(404, "Request failed (404)"), "skipped").kind).toBe("not-filament-db");
  });

  it("reports the server's own trouble in the server's words", () => {
    const p = diagnose(answered(503, "Database unavailable"), "skipped");
    expect(p.kind).toBe("server-error");
    expect(p.message).toContain("Database unavailable");
    // Any other 400 is the server's message, not the https hint.
    expect(diagnose(answered(400, "Bad request"), "skipped").kind).toBe("server-error");
  });
});

describe("unreachableMessage", () => {
  it("names the certificate when the text gives it away", () => {
    const msg = unreachableMessage({ baseUrl: GATEWAY, detail: ANDROID_UNTRUSTED, timedOut: false });
    expect(msg).toMatch(/doesn't trust the server's certificate/);
    expect(msg).toMatch(/Server connection/);
  });

  it("still points an https address at the check when the text does not", () => {
    const msg = unreachableMessage({ baseUrl: GATEWAY, detail: IOS_UNTRUSTED_DE, timedOut: false });
    expect(msg).toMatch(/^Can't reach the server\./);
    expect(msg).toMatch(/uses its own certificate/);
    expect(msg).toContain(IOS_UNTRUSTED_DE);
  });

  it("keeps the plain message for an http address", () => {
    const msg = unreachableMessage({
      baseUrl: "http://192.168.1.50:3456",
      detail: REFUSED,
      timedOut: false,
    });
    expect(msg).not.toMatch(/certificate/i);
    expect(msg).toContain(REFUSED);
  });

  it("reports a timeout as one", () => {
    expect(unreachableMessage({ baseUrl: GATEWAY, detail: null, timedOut: true })).toMatch(
      /didn't respond/,
    );
  });
});
