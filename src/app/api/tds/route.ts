import { NextRequest, NextResponse } from "next/server";
import { extractFromTds } from "@/lib/tdsExtractor";
import { errorResponse, getErrorMessage } from "@/lib/apiErrorHandler";

/**
 * In-memory API key store for web mode.
 * In Electron, the key is passed in the request body from the client.
 */
let storedApiKey: string | null = null;

/** GET /api/tds — check if Gemini API key is configured */
export async function GET() {
  const configured = !!(process.env.GEMINI_API_KEY || storedApiKey);
  return NextResponse.json({ configured });
}

/** PUT /api/tds — save Gemini API key (web mode) */
export async function PUT(request: NextRequest) {
  try {
    const { apiKey } = await request.json();
    if (!apiKey || typeof apiKey !== "string") {
      return errorResponse("API key is required", 400);
    }

    // Validate the key with a lightweight Gemini call
    const testRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    );
    if (!testRes.ok) {
      return errorResponse("Invalid Gemini API key", 401);
    }

    storedApiKey = apiKey;
    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse("Failed to save API key", 500, getErrorMessage(err));
  }
}

/** DELETE /api/tds — remove Gemini API key */
export async function DELETE() {
  storedApiKey = null;
  return NextResponse.json({ success: true });
}

/** POST /api/tds — extract filament data from a TDS URL */
export async function POST(request: NextRequest) {
  try {
    const { url, apiKey: bodyKey } = await request.json();

    if (!url || typeof url !== "string") {
      return errorResponse("URL is required", 400);
    }

    // Resolve API key: body > env > stored
    const apiKey = bodyKey || process.env.GEMINI_API_KEY || storedApiKey;
    if (!apiKey) {
      return errorResponse(
        "Gemini API key not configured. Add it in Settings or set GEMINI_API_KEY environment variable.",
        401,
      );
    }

    const result = await extractFromTds(url, apiKey);

    if (!result.success) {
      return errorResponse(result.error || "Extraction failed", 502);
    }

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse("TDS extraction failed", 500, getErrorMessage(err));
  }
}
