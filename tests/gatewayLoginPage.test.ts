import { describe, it, expect } from "vitest";
import { escapeHtml, loginLocale, renderLoginPage } from "@/lib/gatewayLoginPage";

/** The secure gateway's sign-in page: served before authentication, so it must
 * be self-contained and must not echo anything unescaped. */

describe("loginLocale", () => {
  it("picks the first language the browser lists that the page has", () => {
    expect(loginLocale("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(loginLocale("de")).toBe("de");
    expect(loginLocale("en-US,en;q=0.9,de;q=0.8")).toBe("en");
    expect(loginLocale("fr-FR,de;q=0.8,en;q=0.7")).toBe("de");
    expect(loginLocale(" DE-at ")).toBe("de");
  });

  it("falls back to English", () => {
    expect(loginLocale(undefined)).toBe("en");
    expect(loginLocale("")).toBe("en");
    expect(loginLocale("fr-FR,ja")).toBe("en");
    // "den" is not German.
    expect(loginLocale("den")).toBe("en");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter in text and attributes", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("renderLoginPage", () => {
  const page = (over: Partial<Parameters<typeof renderLoginPage>[0]> = {}) =>
    renderLoginPage({ locale: "en", action: "/__filamentdb/login", next: "/", error: null, ...over });

  it("is a self-contained form posting the key and the return path", () => {
    const html = page({ next: "/inventory?location=abc" });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<form method="post" action="/__filamentdb/login">');
    expect(html).toContain('<input type="hidden" name="next" value="/inventory?location=abc">');
    expect(html).toMatch(/<input id="key" name="key" type="password"[^>]*required/);
    expect(html).toContain("Sign in to Filament DB");
    // No scripts and nothing fetched from the app, which sits behind the sign-in.
    expect(html).not.toMatch(/<script|<link|src=|url\(/i);
    expect(html).not.toContain('role="alert"');
  });

  it("escapes the return path", () => {
    const html = page({ next: `/x"><script>alert(1)</script>` });
    expect(html).not.toContain("<script>");
    expect(html).toContain('value="/x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it("shows a wrong-key message", () => {
    expect(page({ error: "invalid" })).toContain('<p class="error" role="alert">That key is not correct.</p>');
  });

  it("shows how long to wait when attempts are limited", () => {
    expect(page({ error: "limited", retryAfterSeconds: 42 })).toContain("Wait 42 seconds");
    expect(page({ error: "limited" })).toContain("Wait 60 seconds");
  });

  it("renders German", () => {
    const html = page({ locale: "de", error: "invalid" });
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("Bei Filament DB anmelden");
    expect(html).toContain("Dieser Schlüssel ist nicht korrekt.");
    expect(page({ locale: "de", error: "limited", retryAfterSeconds: 7 })).toContain("Warten Sie 7 Sekunden");
  });
});
