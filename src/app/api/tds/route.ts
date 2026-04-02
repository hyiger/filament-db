import { NextRequest, NextResponse } from "next/server";
import { extractFromTds, validateApiKey, type AiProvider } from "@/lib/tdsExtractor";
import { errorResponse, getErrorMessage } from "@/lib/apiErrorHandler";

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
  try {
    const { apiKey, provider = "gemini" } = await request.json();
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

/** POST /api/tds — extract filament data from a TDS URL */
export async function POST(request: NextRequest) {
  try {
    const { url, apiKey: bodyKey, provider: bodyProvider } = await request.json();

    if (!url || typeof url !== "string") {
      return errorResponse("URL is required", 400);
    }

    // Resolve provider
    const provider: AiProvider = bodyProvider || storedProvider || "gemini";

    // Resolve API key: body > env (per-provider) > stored
    let apiKey = bodyKey;
    if (!apiKey) {
      switch (provider) {
        case "gemini":
          apiKey = process.env.GEMINI_API_KEY;
          break;
        case "claude":
          apiKey = process.env.ANTHROPIC_API_KEY;
          break;
        case "openai":
          apiKey = process.env.OPENAI_API_KEY;
          break;
      }
    }
    if (!apiKey) {
      apiKey = storedApiKey;
    }

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
