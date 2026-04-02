/**
 * TDS (Technical Data Sheet) extraction using Google Gemini AI.
 *
 * Fetches a TDS URL (PDF or web page), sends content to Gemini for
 * structured data extraction, and returns filament properties.
 */

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** Maximum content size to send to Gemini (10 MB) */
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
  "dryingTime": "Recommended drying time in hours (convert from minutes if needed)",
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
- Drying time should be in hours (convert minutes to hours if needed)
- Only include fields you can confidently extract from the document
- Return ONLY valid JSON, no markdown code fences, no explanation`;

/**
 * Fetch TDS content from a URL.
 * Returns the content as either base64 PDF data or plain text.
 */
async function fetchTdsContent(url: string): Promise<{
  type: "pdf" | "text";
  data: string;
  mimeType?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FilamentDB/1.0)",
        Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
      },
      redirect: "follow",
    });

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

    // Truncate to ~50K chars to stay within Gemini limits for text
    if (text.length > 50_000) {
      text = text.slice(0, 50_000);
    }

    return { type: "text", data: text };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call Gemini API to extract filament data from TDS content.
 */
async function callGemini(
  content: { type: "pdf" | "text"; data: string; mimeType?: string },
  apiKey: string,
): Promise<TdsExtractedData> {
  // Build the request parts
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

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    if (res.status === 400 && errorBody.includes("API_KEY")) {
      throw new Error("Invalid Gemini API key. Check your key in Settings.");
    }
    if (res.status === 429) {
      throw new Error("Gemini rate limit exceeded. Wait a moment and try again.");
    }
    throw new Error(`Gemini API error: HTTP ${res.status} — ${errorBody.slice(0, 200)}`);
  }

  const result = await res.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("Gemini returned an empty response. The TDS may not contain extractable data.");
  }

  // Parse the JSON response (strip markdown code fences if present)
  const jsonStr = text.replace(/^```json?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

  try {
    return JSON.parse(jsonStr) as TdsExtractedData;
  } catch {
    throw new Error(`Failed to parse Gemini response as JSON: ${jsonStr.slice(0, 200)}`);
  }
}

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
 * Extract filament data from a TDS URL using Google Gemini.
 */
export async function extractFromTds(
  url: string,
  apiKey: string,
): Promise<TdsExtractResult> {
  try {
    const content = await fetchTdsContent(url);
    const data = await callGemini(content, apiKey);

    // Clean up null values
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
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
