/**
 * TDS (Technical Data Sheet) extraction using AI providers.
 *
 * Fetches a TDS URL (PDF or web page), sends content to an AI provider
 * for structured data extraction, and returns filament properties.
 *
 * Supported providers: Google Gemini, Anthropic Claude, OpenAI ChatGPT.
 */

import { assertExternalUrl } from "@/lib/externalUrlGuard";

export type AiProvider = "gemini" | "claude" | "openai";

export const AI_PROVIDERS: { id: AiProvider; name: string; keyUrl: string; keyPrefix: string }[] = [
  { id: "gemini", name: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey", keyPrefix: "AI" },
  { id: "claude", name: "Anthropic Claude", keyUrl: "https://console.anthropic.com/settings/keys", keyPrefix: "sk-ant-" },
  { id: "openai", name: "OpenAI ChatGPT", keyUrl: "https://platform.openai.com/api-keys", keyPrefix: "sk-" },
];

/** Maximum content size (10 MB) */
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;

/** Fields extracted from a TDS */
export interface TdsExtractedData {
  name?: string;
  vendor?: string;
  type?: string;
  color?: string;
  density?: number;
  diameter?: number;
  temperatures?: {
    nozzle?: number;
    nozzleFirstLayer?: number;
    nozzleRangeMin?: number;
    nozzleRangeMax?: number;
    bed?: number;
    bedFirstLayer?: number;
    bedRangeMin?: number;
    bedRangeMax?: number;
    standby?: number;
  };
  dryingTemperature?: number;
  /** Minutes — must match the unit the Filament schema stores (480 = 8 hours).
   * The extractor prompt explicitly asks the AI to convert hours→minutes. */
  dryingTime?: number;
  glassTempTransition?: number;
  heatDeflectionTemp?: number;
  shoreHardnessA?: number;
  shoreHardnessD?: number;
  maxVolumetricSpeed?: number;
  minPrintSpeed?: number;
  maxPrintSpeed?: number;
  netFilamentWeight?: number;
  spoolWeight?: number;
  maxPrintTemp?: number;
  minPrintTemp?: number;
}

export interface TdsExtractResult {
  success: boolean;
  data?: TdsExtractedData;
  fieldsExtracted?: number;
  error?: string;
}

const EXTRACTION_PROMPT = `You are a 3D printing filament data extraction expert. Extract filament properties from this Technical Data Sheet (TDS).

Return ONLY a JSON object with the following fields. Use null for any field not found in the document. Use numeric values only (no units, no strings for numbers).

{
  "name": "Full product name (e.g. 'Prusament PLA Galaxy Black')",
  "vendor": "Manufacturer/brand name",
  "type": "Material type — use standard abbreviations: PLA, PETG, ABS, ASA, TPU, PA, PC, PVA, HIPS, PP, POM, PEBA, PA6-CF, PA6-GF, PET-CF, PPA-CF, PPA-GF, etc.",
  "density": "g/cm³ as a decimal (e.g. 1.24)",
  "diameter": "Filament diameter in mm (typically 1.75 or 2.85)",
  "temperatures": {
    "nozzle": "Recommended nozzle temperature in °C (use the typical/middle value if a range is given)",
    "nozzleRangeMin": "Minimum recommended nozzle temperature in °C",
    "nozzleRangeMax": "Maximum recommended nozzle temperature in °C",
    "bed": "Recommended bed/platform temperature in °C (use the typical/middle value if a range is given)",
    "bedRangeMin": "Minimum recommended bed temperature in °C",
    "bedRangeMax": "Maximum recommended bed temperature in °C"
  },
  "dryingTemperature": "Recommended drying temperature in °C",
  "dryingTime": "Recommended drying time in MINUTES (e.g. 480 for 8 hours — convert any TDS-quoted hours to minutes by multiplying by 60)",
  "glassTempTransition": "Glass transition temperature (Tg) in °C",
  "heatDeflectionTemp": "Heat deflection temperature (HDT) in °C (prefer 0.45 MPa value if both are given)",
  "shoreHardnessA": "Shore A hardness (for flexible materials like TPU/TPE/PEBA)",
  "shoreHardnessD": "Shore D hardness (for rigid materials)",
  "maxVolumetricSpeed": "Maximum volumetric speed in mm³/s",
  "minPrintSpeed": "Minimum recommended print speed in mm/s",
  "maxPrintSpeed": "Maximum recommended print speed in mm/s",
  "netFilamentWeight": "Net filament weight per spool in grams",
  "spoolWeight": "Empty spool weight in grams"
}

Important:
- Temperature ranges like "210-230°C" should be split: nozzleRangeMin=210, nozzleRangeMax=230, nozzle=220 (midpoint)
- For bed temperature ranges, do the same split
- Density is typically in g/cm³ (e.g. 1.24, not 1240 kg/m³ — convert if needed)
- Drying time MUST be returned in minutes (multiply hours by 60 — e.g. "8 hours" → 480, "30 minutes" → 30). The downstream filament schema stores minutes.
- Only include fields you can confidently extract from the document
- Return ONLY valid JSON, no markdown code fences, no explanation`;

// ── Content fetching ──

interface TdsContent {
  type: "pdf" | "text";
  data: string;
  mimeType?: string;
}

/** Cap redirect chains. Real-world TDS hosts rarely chain more than 2-3.
 * Matches the embed-check route limit so the two SSRF-guarded fetchers
 * behave consistently. */
const MAX_REDIRECTS = 5;

/**
 * Fetch TDS content from a URL.
 * Returns the content as either base64 PDF data or plain text.
 *
 * SSRF: every redirect hop re-runs assertExternalUrl, so a public host
 * can't bounce us into RFC1918/loopback/metadata space via a 3xx. Same
 * pattern as src/app/api/embed-check/route.ts. The previous
 * `redirect: "follow"` left the gap that an attacker who could plant a
 * hostile TDS URL plus the AI-key gate could pivot to private infra.
 */
async function fetchTdsContent(url: string): Promise<TdsContent> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    let currentUrl = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Re-validate every hop so a hostile public host can't bounce us into
      // private space via 30x. assertExternalUrl throws on disallowed
      // schemes / loopback / RFC1918 / metadata IPs.
      await assertExternalUrl(currentUrl);

      const hopRes = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; FilamentDB/1.0)",
          Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
        },
        redirect: "manual",
      });

      // Treat 3xx (except 304) as a redirect we follow ourselves so the
      // next hop is re-validated.
      const isRedirect = hopRes.status >= 300 && hopRes.status < 400 && hopRes.status !== 304;
      if (!isRedirect) {
        res = hopRes;
        break;
      }
      const loc = hopRes.headers.get("location");
      hopRes.body?.cancel().catch(() => {});
      if (!loc) {
        throw new Error(`Failed to fetch TDS: HTTP ${hopRes.status} with no Location header`);
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Failed to fetch TDS: too many redirects (>${MAX_REDIRECTS})`);
      }
      // Resolve relative redirects against the URL we just fetched.
      currentUrl = new URL(loc, currentUrl).toString();
    }

    if (!res) {
      // Defensive: shouldn't happen because the loop either breaks on a
      // non-redirect or throws on too-many-redirects.
      throw new Error("Failed to fetch TDS: no final response");
    }

    if (!res.ok) {
      throw new Error(`Failed to fetch TDS: HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "";
    const contentLength = parseInt(res.headers.get("content-length") || "0", 10);

    if (contentLength > MAX_CONTENT_SIZE) {
      throw new Error(`TDS content too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
    }

    const isPdf = contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf");

    if (isPdf) {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_CONTENT_SIZE) {
        throw new Error(`PDF too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
      }
      const base64 = Buffer.from(buffer).toString("base64");
      return { type: "pdf", data: base64, mimeType: "application/pdf" };
    }

    // HTML/text content
    let text = await res.text();
    if (text.length > MAX_CONTENT_SIZE) {
      text = text.slice(0, MAX_CONTENT_SIZE);
    }

    // Strip HTML tags, scripts, styles to get clean text
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#\d+;/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Truncate to ~50K chars to stay within context limits for text
    if (text.length > 50_000) {
      text = text.slice(0, 50_000);
    }

    return { type: "text", data: text };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Retry with backoff ──

/** Error subclass for rate-limit responses so we can detect and retry. */
class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(provider: string, retryAfterMs: number) {
    super(`${provider} rate limit exceeded`);
    this.retryAfterMs = retryAfterMs;
  }
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 5_000; // 5 seconds initial wait

/**
 * Retry a provider call with exponential backoff on rate-limit errors.
 */
async function withRetry(
  fn: () => Promise<string>,
  provider: string,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RateLimitError && attempt < MAX_RETRIES) {
        const delay = err.retryAfterMs || BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`Rate limited by ${provider}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${provider} rate limit exceeded after ${MAX_RETRIES} retries.`);
}

// ── Provider-specific API calls ──

/**
 * Call Google Gemini API.
 */
async function callGemini(
  content: TdsContent,
  apiKey: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [];

  if (content.type === "pdf") {
    parts.push({
      inlineData: {
        mimeType: content.mimeType || "application/pdf",
        data: content.data,
      },
    });
    parts.push({ text: EXTRACTION_PROMPT });
  } else {
    parts.push({
      text: `Here is the content of a 3D printing filament Technical Data Sheet:\n\n${content.data}\n\n${EXTRACTION_PROMPT}`,
    });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      }),
    },
  );

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    if (res.status === 400 && errorBody.includes("API_KEY")) {
      throw new Error("Invalid Gemini API key. Check your key in Settings.");
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      throw new RateLimitError("Gemini", retryAfter ? retryAfter * 1000 : 0);
    }
    throw new Error(`Gemini API error: HTTP ${res.status} — ${errorBody.slice(0, 200)}`);
  }

  const result = await res.json();
  return result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

/**
 * Call Anthropic Claude API.
 */
async function callClaude(
  content: TdsContent,
  apiKey: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contentBlocks: any[] = [];

  if (content.type === "pdf") {
    contentBlocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: content.data,
      },
    });
    contentBlocks.push({ type: "text", text: EXTRACTION_PROMPT });
  } else {
    contentBlocks.push({
      type: "text",
      text: `Here is the content of a 3D printing filament Technical Data Sheet:\n\n${content.data}\n\n${EXTRACTION_PROMPT}`,
    });
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content: contentBlocks }],
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error("Invalid Claude API key. Check your key in Settings.");
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      throw new RateLimitError("Claude", retryAfter ? retryAfter * 1000 : 0);
    }
    throw new Error(`Claude API error: HTTP ${res.status} — ${errorBody.slice(0, 200)}`);
  }

  const result = await res.json();
  const textBlock = result?.content?.find((b: { type: string }) => b.type === "text");
  return textBlock?.text || "";
}

/**
 * Call OpenAI ChatGPT API.
 */
async function callOpenAI(
  content: TdsContent,
  apiKey: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contentParts: any[] = [];

  if (content.type === "pdf") {
    throw new Error("OpenAI provider does not support PDF input. Please use Gemini or Claude for PDF Technical Data Sheets, or provide a URL to an HTML/text version.");
  } else {
    contentParts.push({
      type: "text",
      text: `Here is the content of a 3D printing filament Technical Data Sheet:\n\n${content.data}\n\n${EXTRACTION_PROMPT}`,
    });
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      max_tokens: 2048,
      messages: [
        { role: "user", content: contentParts },
      ],
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error("Invalid OpenAI API key. Check your key in Settings.");
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      throw new RateLimitError("OpenAI", retryAfter ? retryAfter * 1000 : 0);
    }
    throw new Error(`OpenAI API error: HTTP ${res.status} — ${errorBody.slice(0, 200)}`);
  }

  const result = await res.json();
  return result?.choices?.[0]?.message?.content || "";
}

// ── Provider dispatch ──

async function callProvider(
  provider: AiProvider,
  content: TdsContent,
  apiKey: string,
): Promise<TdsExtractedData> {
  let callFn: () => Promise<string>;

  switch (provider) {
    case "gemini":
      callFn = () => callGemini(content, apiKey);
      break;
    case "claude":
      callFn = () => callClaude(content, apiKey);
      break;
    case "openai":
      callFn = () => callOpenAI(content, apiKey);
      break;
    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }

  const rawText = await withRetry(callFn, provider);

  if (!rawText) {
    throw new Error(`${provider} returned an empty response. The TDS may not contain extractable data.`);
  }

  // Parse the JSON response (strip markdown code fences if present)
  const jsonStr = rawText.replace(/^```json?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

  try {
    return JSON.parse(jsonStr) as TdsExtractedData;
  } catch {
    throw new Error(`Failed to parse ${provider} response as JSON: ${jsonStr.slice(0, 200)}`);
  }
}

// ── Validation ──

/**
 * Validate an API key by making a lightweight call to the provider.
 */
export async function validateApiKey(
  provider: AiProvider,
  apiKey: string,
): Promise<boolean> {
  switch (provider) {
    case "gemini": {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      );
      return res.ok;
    }
    case "claude": {
      // Use the messages count endpoint (lightweight, free)
      const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "test" }],
        }),
      });
      // 200 = valid key, 401 = invalid, other = valid but some other issue
      return res.status !== 401;
    }
    case "openai": {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return res.ok;
    }
    default:
      return false;
  }
}

// ── Main export ──

/**
 * Count non-null fields in extracted data.
 */
function countFields(data: TdsExtractedData): number {
  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (key === "temperatures" && typeof value === "object" && value !== null) {
      for (const v of Object.values(value)) {
        if (v != null) count++;
      }
    } else if (value != null) {
      count++;
    }
  }
  return count;
}

/**
 * Clean up extracted data: remove null values, count fields.
 */
function cleanExtractedData(data: TdsExtractedData): TdsExtractResult {
  const cleaned: TdsExtractedData = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "temperatures" && typeof value === "object" && value !== null) {
      const temps: Record<string, number | undefined> = {};
      for (const [tk, tv] of Object.entries(value)) {
        if (tv != null) temps[tk] = tv as number;
      }
      if (Object.keys(temps).length > 0) {
        cleaned.temperatures = temps as TdsExtractedData["temperatures"];
      }
    } else if (value != null) {
      (cleaned as Record<string, unknown>)[key] = value;
    }
  }
  const fieldsExtracted = countFields(cleaned);
  return { success: true, data: cleaned, fieldsExtracted };
}

/**
 * Extract filament data from pre-fetched TDS content (for file uploads).
 */
export async function extractFromTdsContent(
  fileData: Buffer | Uint8Array,
  mimeType: string,
  apiKey: string,
  provider: AiProvider = "gemini",
): Promise<TdsExtractResult> {
  try {
    let content: TdsContent;

    if (mimeType === "application/pdf" || mimeType.includes("pdf")) {
      content = {
        type: "pdf",
        data: Buffer.from(fileData).toString("base64"),
        mimeType: "application/pdf",
      };
    } else {
      // Text/HTML file — decode and strip
      let text = Buffer.from(fileData).toString("utf-8");
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#\d+;/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > 50_000) text = text.slice(0, 50_000);
      content = { type: "text", data: text };
    }

    const data = await callProvider(provider, content, apiKey);
    return cleanExtractedData(data);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Extract filament data from a TDS URL using the specified AI provider.
 */
export async function extractFromTds(
  url: string,
  apiKey: string,
  provider: AiProvider = "gemini",
): Promise<TdsExtractResult> {
  try {
    const content = await fetchTdsContent(url);
    const data = await callProvider(provider, content, apiKey);
    return cleanExtractedData(data);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
