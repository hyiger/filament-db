import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the internal parsing/cleaning logic by importing the module
// and mocking fetch for the Gemini API calls.
//
// dns.lookup is mocked at the module level: the real extractor calls it
// inside its SSRF guard before fetch, and the fake-timer rate-limit test
// would otherwise hang waiting on real-time DNS while wall time is frozen.
// The mock returns a public address so the guard sees example.com as
// external; tests that exercise the guard's reject paths use literal IPs
// or non-http schemes that short-circuit before reaching this lookup.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

describe("tdsExtractor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("SSRF guard (assertExternalUrl)", () => {
    // The guard runs before fetch, so a URL that fails validation never
    // reaches the network. We confirm by stubbing fetch to throw if it's
    // ever called — the test passes only if the guard short-circuits.
    const denyFetch = () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        throw new Error("FETCH SHOULD NOT BE CALLED — guard should have blocked");
      }));
    };

    it("rejects loopback URLs", async () => {
      denyFetch();
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("http://127.0.0.1/tds.pdf", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/private|internal/i);
    });

    it("rejects RFC1918 private IPs", async () => {
      denyFetch();
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("http://10.0.0.5/tds.pdf", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/private|internal/i);
    });

    it("rejects the AWS/GCP/Azure metadata IP (169.254.169.254)", async () => {
      denyFetch();
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("http://169.254.169.254/latest/meta-data/", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/private|internal/i);
    });

    it("rejects file:// and other non-http(s) schemes", async () => {
      denyFetch();
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("file:///etc/passwd", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/scheme/i);
    });

    it("rejects IPv6 loopback (::1)", async () => {
      denyFetch();
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("http://[::1]/tds.pdf", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/private|internal/i);
    });
  });

  // Per-hop SSRF revalidation: a public host that 30x-redirects to a private
  // IP must NOT pivot us into private space. Same pattern as embed-check.
  describe("redirect handling (manual, per-hop revalidation)", () => {
    it("rejects a public URL that 302-redirects to a private IP", async () => {
      const fetchMock = vi.fn().mockImplementationOnce(() =>
        Promise.resolve({
          status: 302,
          headers: new Headers({ location: "http://10.0.0.5/secret" }),
          body: { cancel: () => Promise.resolve() },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://attacker.example.com/start", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/private|internal/i);
      // Critical: the second fetch (to the private IP) must NOT have happened.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a redirect to the AWS/GCP/Azure metadata IP", async () => {
      const fetchMock = vi.fn().mockImplementationOnce(() =>
        Promise.resolve({
          status: 302,
          headers: new Headers({ location: "http://169.254.169.254/latest/meta-data/" }),
          body: { cancel: () => Promise.resolve() },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/innocuous", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/private|internal/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a redirect to a non-http(s) scheme (e.g. file://)", async () => {
      const fetchMock = vi.fn().mockImplementationOnce(() =>
        Promise.resolve({
          status: 302,
          headers: new Headers({ location: "file:///etc/passwd" }),
          body: { cancel: () => Promise.resolve() },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/innocuous", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/scheme/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("follows a public→public redirect chain to the final response", async () => {
      const geminiResponse = {
        candidates: [{ content: { parts: [{ text: '{"name": "Chained PLA", "type": "PLA"}' }] } }],
      };
      // 302 → 301 → 200 (HTML) → Gemini
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          headers: new Headers({ location: "https://b.example.com/redirected" }),
          body: { cancel: () => Promise.resolve() },
        })
        .mockResolvedValueOnce({
          status: 301,
          headers: new Headers({ location: "https://c.example.com/final" }),
          body: { cancel: () => Promise.resolve() },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          text: () => Promise.resolve("<html><body>chained PLA</body></html>"),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(geminiResponse),
        });
      vi.stubGlobal("fetch", fetchMock);
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://a.example.com/start", "fake-key");
      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("Chained PLA");
      // 3 redirect/fetch hops + 1 Gemini call
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("resolves a relative Location header against the previous URL", async () => {
      const geminiResponse = {
        candidates: [{ content: { parts: [{ text: '{"name": "Rel", "type": "PLA"}' }] } }],
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          headers: new Headers({ location: "/elsewhere" }),
          body: { cancel: () => Promise.resolve() },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          text: () => Promise.resolve("<html>x</html>"),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(geminiResponse),
        });
      vi.stubGlobal("fetch", fetchMock);
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      await extractFromTds("https://example.com/path/start", "fake-key");
      const secondCallUrl = fetchMock.mock.calls[1][0];
      expect(secondCallUrl).toBe("https://example.com/elsewhere");
    });

    it("aborts after MAX_REDIRECTS (5) hops", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        const next = url.replace(/\/(\d+)$/, (_, n) => `/${Number(n) + 1}`);
        return Promise.resolve({
          status: 302,
          headers: new Headers({ location: next }),
          body: { cancel: () => Promise.resolve() },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/0", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/too many redirects/i);
      // 6 calls = initial + MAX_REDIRECTS (5) follow attempts before bailing.
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });
  });

  describe("extractFromTds", () => {
    it("returns error when URL fetch fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/tds.pdf", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });

    it("returns error when URL returns 404", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Map(),
      }));
      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/missing.pdf", "fake-key");
      expect(result.success).toBe(false);
      expect(result.error).toContain("404");
    });

    it("retries on Gemini rate limit and eventually fails", async () => {
      vi.useFakeTimers();

      let apiCallCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        if (url.includes("example.com")) {
          // URL fetch succeeds with HTML
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "text/html" }),
            text: () => Promise.resolve("<html><body>PLA filament specs</body></html>"),
          });
        }
        // Gemini API always returns 429
        apiCallCount++;
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers(),
          text: () => Promise.resolve("Rate limit exceeded"),
        });
      }));

      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const resultPromise = extractFromTds("https://example.com/tds.html", "fake-key");

      // Advance through retry delays (5s, 10s, 20s)
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain("rate limit");
      // Should have retried: 1 initial + 3 retries = 4 API calls
      expect(apiCallCount).toBe(4);

      vi.useRealTimers();
    });

    it("successfully extracts data from HTML TDS", async () => {
      const geminiResponse = {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                name: "SuperPLA",
                vendor: "TestBrand",
                type: "PLA",
                density: 1.24,
                diameter: 1.75,
                temperatures: {
                  nozzle: 215,
                  nozzleRangeMin: 200,
                  nozzleRangeMax: 230,
                  bed: 60,
                },
                dryingTemperature: 55,
                // The prompt now asks for minutes (480 = 8h). Older mocks
                // used 4 here, which would silently render as 4 minutes
                // downstream — see src/models/Filament.ts dryingTime comment.
                dryingTime: 480,
                glassTempTransition: 60,
                heatDeflectionTemp: null,
                shoreHardnessA: null,
                shoreHardnessD: null,
              }),
            }],
          },
        }],
      };

      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "text/html" }),
            text: () => Promise.resolve("<html><body><h1>SuperPLA TDS</h1><p>Density: 1.24 g/cm³</p></body></html>"),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(geminiResponse),
        });
      }));

      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/tds.html", "fake-key");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("SuperPLA");
      expect(result.data?.vendor).toBe("TestBrand");
      expect(result.data?.type).toBe("PLA");
      expect(result.data?.density).toBe(1.24);
      expect(result.data?.temperatures?.nozzle).toBe(215);
      expect(result.data?.temperatures?.nozzleRangeMin).toBe(200);
      expect(result.data?.dryingTemperature).toBe(55);
      expect(result.fieldsExtracted).toBeGreaterThanOrEqual(8);
    });

    it("handles Gemini response with markdown code fences", async () => {
      const geminiResponse = {
        candidates: [{
          content: {
            parts: [{
              text: "```json\n{\"name\": \"TestPLA\", \"vendor\": \"TestCo\", \"type\": \"PLA\"}\n```",
            }],
          },
        }],
      };

      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "text/html" }),
            text: () => Promise.resolve("Test TDS content"),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(geminiResponse),
        });
      }));

      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/tds", "fake-key");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("TestPLA");
    });

    it("cleans null values from extracted data", async () => {
      const geminiResponse = {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                name: "TestPLA",
                vendor: "TestCo",
                type: "PLA",
                density: null,
                shoreHardnessA: null,
                temperatures: {
                  nozzle: 210,
                  bed: null,
                },
              }),
            }],
          },
        }],
      };

      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "text/html" }),
            text: () => Promise.resolve("Test content"),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(geminiResponse),
        });
      }));

      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/tds", "fake-key");

      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty("density");
      expect(result.data).not.toHaveProperty("shoreHardnessA");
      expect(result.data?.temperatures?.nozzle).toBe(210);
      expect(result.data?.temperatures).not.toHaveProperty("bed");
      // Only name, vendor, type, temperatures.nozzle = 4 fields
      expect(result.fieldsExtracted).toBe(4);
    });

    it("detects PDF by URL extension", async () => {
      const pdfBytes = Buffer.from("fake-pdf-content");

      let callCount = 0;
      let geminiBody: string | undefined;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: { body?: string }) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "application/octet-stream" }),
            arrayBuffer: () => Promise.resolve(pdfBytes.buffer),
          });
        }
        geminiBody = opts?.body;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            candidates: [{ content: { parts: [{ text: '{"name": "PDF PLA", "type": "PLA"}' }] } }],
          }),
        });
      }));

      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/filament.pdf", "fake-key");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("PDF PLA");
      // Verify the Gemini request included inlineData (PDF mode)
      const parsed = JSON.parse(geminiBody!);
      expect(parsed.contents[0].parts[0].inlineData).toBeDefined();
      expect(parsed.contents[0].parts[0].inlineData.mimeType).toBe("application/pdf");
    });

    it("calls Claude API when provider is claude", async () => {
      const claudeResponse = {
        content: [{ type: "text", text: '{"name": "Claude PLA", "vendor": "TestCo", "type": "PLA"}' }],
      };

      let callCount = 0;
      let apiUrl = "";
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "text/html" }),
            text: () => Promise.resolve("TDS content"),
          });
        }
        apiUrl = url;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(claudeResponse),
        });
      }));

      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/tds", "sk-ant-test", "claude");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("Claude PLA");
      expect(apiUrl).toContain("anthropic.com");
    });

    it("calls OpenAI API when provider is openai", async () => {
      const openaiResponse = {
        choices: [{ message: { content: '{"name": "GPT PLA", "vendor": "TestCo", "type": "PLA"}' } }],
      };

      let callCount = 0;
      let apiUrl = "";
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "text/html" }),
            text: () => Promise.resolve("TDS content"),
          });
        }
        apiUrl = url;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(openaiResponse),
        });
      }));

      const { extractFromTds } = await import("@/lib/tdsExtractor");
      const result = await extractFromTds("https://example.com/tds", "sk-test", "openai");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("GPT PLA");
      expect(apiUrl).toContain("openai.com");
    });
  });

  describe("extractFromTdsContent", () => {
    it("extracts data from a PDF file upload", async () => {
      const geminiResponse = {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                name: "PDF Filament",
                vendor: "TestBrand",
                type: "PETG",
                density: 1.27,
                diameter: 1.75,
              }),
            }],
          },
        }],
      };

      let geminiBody: string | undefined;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: { body?: string }) => {
        geminiBody = opts?.body;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(geminiResponse),
        });
      }));

      const { extractFromTdsContent } = await import("@/lib/tdsExtractor");
      const pdfBuffer = Buffer.from("fake-pdf-content");
      const result = await extractFromTdsContent(pdfBuffer, "application/pdf", "fake-key", "gemini");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("PDF Filament");
      expect(result.data?.type).toBe("PETG");
      expect(result.data?.density).toBe(1.27);
      // Verify PDF was sent as base64 inlineData
      const parsed = JSON.parse(geminiBody!);
      expect(parsed.contents[0].parts[0].inlineData).toBeDefined();
      expect(parsed.contents[0].parts[0].inlineData.mimeType).toBe("application/pdf");
    });

    it("extracts data from an HTML file upload", async () => {
      const geminiResponse = {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                name: "HTML Filament",
                vendor: "TestCo",
                type: "PLA",
              }),
            }],
          },
        }],
      };

      let geminiBody: string | undefined;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: { body?: string }) => {
        geminiBody = opts?.body;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(geminiResponse),
        });
      }));

      const { extractFromTdsContent } = await import("@/lib/tdsExtractor");
      const htmlBuffer = Buffer.from("<html><body><h1>PLA TDS</h1><p>Density: 1.24</p></body></html>");
      const result = await extractFromTdsContent(htmlBuffer, "text/html", "fake-key", "gemini");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("HTML Filament");
      // Verify HTML tags were stripped (sent as text, not inlineData)
      const parsed = JSON.parse(geminiBody!);
      expect(parsed.contents[0].parts[0].text).toBeDefined();
      expect(parsed.contents[0].parts[0].text).not.toContain("<html>");
      expect(parsed.contents[0].parts[0].text).toContain("PLA TDS");
    });

    it("strips HTML tags and entities from uploaded HTML files", async () => {
      const geminiResponse = {
        candidates: [{
          content: { parts: [{ text: '{"name": "Stripped", "type": "ABS"}' }] },
        }],
      };

      let geminiBody: string | undefined;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts?: { body?: string }) => {
        geminiBody = opts?.body;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(geminiResponse),
        });
      }));

      const { extractFromTdsContent } = await import("@/lib/tdsExtractor");
      const htmlBuffer = Buffer.from(
        "<html><head><script>alert('x')</script><style>.a{}</style></head>" +
        "<body><p>Temp&nbsp;210&amp;230&lt;C&gt;</p></body></html>"
      );
      const result = await extractFromTdsContent(htmlBuffer, "text/html", "fake-key");

      expect(result.success).toBe(true);
      const parsed = JSON.parse(geminiBody!);
      const text = parsed.contents[0].parts[0].text;
      // Scripts and styles should be stripped
      expect(text).not.toContain("alert");
      expect(text).not.toContain("<style>");
      // HTML entities should be decoded
      expect(text).toContain("210&230<C>");
    });

    it("returns error when AI provider call fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("API unreachable")));

      const { extractFromTdsContent } = await import("@/lib/tdsExtractor");
      const buffer = Buffer.from("some content");
      const result = await extractFromTdsContent(buffer, "text/plain", "fake-key", "gemini");

      expect(result.success).toBe(false);
      expect(result.error).toContain("API unreachable");
    });

    it("routes to Claude provider for file uploads", async () => {
      const claudeResponse = {
        content: [{ type: "text", text: '{"name": "Claude File", "type": "TPU"}' }],
      };

      let apiUrl = "";
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        apiUrl = url;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(claudeResponse),
        });
      }));

      const { extractFromTdsContent } = await import("@/lib/tdsExtractor");
      const buffer = Buffer.from("TPU filament specs");
      const result = await extractFromTdsContent(buffer, "text/plain", "sk-ant-test", "claude");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("Claude File");
      expect(apiUrl).toContain("anthropic.com");
    });

    it("routes to OpenAI provider for file uploads", async () => {
      const openaiResponse = {
        choices: [{ message: { content: '{"name": "GPT File", "type": "ASA"}' } }],
      };

      let apiUrl = "";
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        apiUrl = url;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(openaiResponse),
        });
      }));

      const { extractFromTdsContent } = await import("@/lib/tdsExtractor");
      const buffer = Buffer.from("ASA filament specs");
      const result = await extractFromTdsContent(buffer, "text/plain", "sk-test", "openai");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("GPT File");
      expect(apiUrl).toContain("openai.com");
    });

    it("rejects PDF input for OpenAI provider with informative error", async () => {
      vi.stubGlobal("fetch", vi.fn());

      const { extractFromTdsContent } = await import("@/lib/tdsExtractor");
      const pdfBuffer = Buffer.from("fake-pdf-content");
      const result = await extractFromTdsContent(pdfBuffer, "application/pdf", "sk-test", "openai");

      expect(result.success).toBe(false);
      expect(result.error).toContain("OpenAI provider does not support PDF");
      expect(result.error).toContain("Gemini or Claude");
    });
  });

  describe("validateApiKey", () => {
    it("returns true for valid Gemini key", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const { validateApiKey } = await import("@/lib/tdsExtractor");
      const result = await validateApiKey("gemini", "valid-gemini-key");
      expect(result).toBe(true);
    });

    it("returns false for invalid Gemini key", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
      const { validateApiKey } = await import("@/lib/tdsExtractor");
      const result = await validateApiKey("gemini", "invalid-key");
      expect(result).toBe(false);
    });

    it("returns true for valid Claude key", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
      const { validateApiKey } = await import("@/lib/tdsExtractor");
      const result = await validateApiKey("claude", "sk-ant-valid");
      expect(result).toBe(true);
      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain("anthropic.com");
    });

    it("returns false for invalid Claude key (401)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      const { validateApiKey } = await import("@/lib/tdsExtractor");
      const result = await validateApiKey("claude", "sk-ant-invalid");
      expect(result).toBe(false);
    });

    it("returns true for valid OpenAI key", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const { validateApiKey } = await import("@/lib/tdsExtractor");
      const result = await validateApiKey("openai", "sk-valid");
      expect(result).toBe(true);
      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain("openai.com");
    });

    it("returns false for unknown provider", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const { validateApiKey } = await import("@/lib/tdsExtractor");
      const result = await validateApiKey("unknown" as never, "any-key");
      expect(result).toBe(false);
    });
  });
});
