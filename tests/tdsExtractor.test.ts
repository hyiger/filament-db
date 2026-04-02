import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the internal parsing/cleaning logic by importing the module
// and mocking fetch for the Gemini API calls

describe("tdsExtractor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
                dryingTime: 4,
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
  });
});
