import { NextRequest, NextResponse } from "next/server";
import { extractFromTds, extractFromTdsContent, validateApiKey, type AiProvider } from "@/lib/tdsExtractor";
import { errorResponse, getErrorMessage, MAX_UPLOAD_SIZE } from "@/lib/apiErrorHandler";

/**
 * In-memory API key/provider store for web mode.
 * In Electron, the key is passed in the request body from the client.
 */
let storedApiKey: string | null = null;
let storedProvider: AiProvider = "gemini";

/** GET /api/tds — check if an AI API key is configured */
export async function GET() {
  const envKey = process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  const configured = !!(envKey || storedApiKey);

  // Detect provider from env if no stored provider
  let provider = storedProvider;
  if (!storedApiKey && envKey) {
    if (process.env.ANTHROPIC_API_KEY) provider = "claude";
    else if (process.env.OPENAI_API_KEY) provider = "openai";
    else provider = "gemini";
  }

  return NextResponse.json({ configured, provider });
}

/** PUT /api/tds — save AI API key (web mode) */
export async function PUT(request: NextRequest) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  try {
    const { apiKey, provider = "gemini" } = body;
    if (!apiKey || typeof apiKey !== "string") {
      return errorResponse("API key is required", 400);
    }

    const validProvider = ["gemini", "claude", "openai"].includes(provider) ? provider as AiProvider : "gemini";

    // Validate the key
    const valid = await validateApiKey(validProvider, apiKey);
    if (!valid) {
      return errorResponse(`Invalid ${validProvider} API key`, 401);
    }

    storedApiKey = apiKey;
    storedProvider = validProvider;
    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse("Failed to save API key", 500, getErrorMessage(err));
  }
}

/** DELETE /api/tds — remove AI API key */
export async function DELETE() {
  storedApiKey = null;
  storedProvider = "gemini";
  return NextResponse.json({ success: true });
}

/**
 * Resolve the API key from various sources.
 */
function resolveApiKey(bodyKey: string | undefined, provider: AiProvider): string | null {
  if (bodyKey) return bodyKey;

  switch (provider) {
    case "gemini":
      if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
      break;
    case "claude":
      if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
      break;
    case "openai":
      if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
      break;
  }

  return storedApiKey;
}

/** POST /api/tds — extract filament data from a TDS URL or uploaded file */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") || "";

    // ── File upload (multipart/form-data) ──
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      const bodyKey = formData.get("apiKey") as string | null;
      const bodyProvider = formData.get("provider") as string | null;

      if (!file) {
        return errorResponse("File is required", 400);
      }

      if (file.size > MAX_UPLOAD_SIZE) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        return errorResponse(`File too large (${sizeMB} MB). Maximum is 10 MB.`, 413);
      }

      const provider: AiProvider = (bodyProvider && ["gemini", "claude", "openai"].includes(bodyProvider))
        ? bodyProvider as AiProvider
        : storedProvider || "gemini";

      const apiKey = resolveApiKey(bodyKey || undefined, provider);
      if (!apiKey) {
        return errorResponse(
          "AI API key not configured. Add it in Settings or set the appropriate environment variable.",
          401,
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const mimeType = file.type || (file.name?.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain");

      const result = await extractFromTdsContent(buffer, mimeType, apiKey, provider);

      if (!result.success) {
        return errorResponse(result.error || "Extraction failed", 502);
      }

      return NextResponse.json(result);
    }

    // ── URL-based extraction (JSON body) ──
    let jsonBody;
    try {
      jsonBody = await request.json();
    } catch {
      return errorResponse("Invalid JSON in request body", 400);
    }
    const { url, apiKey: bodyKey, provider: bodyProvider } = jsonBody;

    if (!url || typeof url !== "string") {
      return errorResponse("URL is required", 400);
    }

    const provider: AiProvider = (bodyProvider && ["gemini", "claude", "openai"].includes(bodyProvider))
      ? bodyProvider as AiProvider : storedProvider || "gemini";
    const apiKey = resolveApiKey(bodyKey, provider);

    if (!apiKey) {
      return errorResponse(
        "AI API key not configured. Add it in Settings or set the appropriate environment variable (GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY).",
        401,
      );
    }

    const result = await extractFromTds(url, apiKey, provider);

    if (!result.success) {
      return errorResponse(result.error || "Extraction failed", 502);
    }

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse("TDS extraction failed", 500, getErrorMessage(err));
  }
}
