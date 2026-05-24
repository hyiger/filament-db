import { NextRequest, NextResponse } from "next/server";
import { extractFromTds, extractFromTdsContent, validateApiKey, type AiProvider } from "@/lib/tdsExtractor";
import { errorResponse, getErrorMessage, isClientInputErrorMessage, MAX_UPLOAD_SIZE } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * In-memory API key/provider store for web mode.
 * In Electron, the key is passed in the request body from the client.
 */
let storedApiKey: string | null = null;
let storedProvider: AiProvider = "gemini";

const VALID_PROVIDERS: readonly AiProvider[] = ["gemini", "claude", "openai"];

function isValidProvider(p: unknown): p is AiProvider {
  return typeof p === "string" && (VALID_PROVIDERS as readonly string[]).includes(p);
}

/** The env API key for a specific provider, if set. */
function envKeyForProvider(provider: AiProvider): string | undefined {
  switch (provider) {
    case "gemini":
      return process.env.GEMINI_API_KEY;
    case "claude":
      return process.env.ANTHROPIC_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
  }
}

/** Provider implied by whichever env key is present, in priority order. */
function providerFromEnv(): AiProvider | null {
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return null;
}

/**
 * GH #251: single source of truth for which provider a request uses,
 * shared by GET (config reporting) and POST (extraction) so the UI never
 * shows one provider while extraction silently runs another.
 *
 * Priority:
 *   1. an explicit, valid provider on the request
 *   2. the provider saved via PUT (web mode), when a key was stored
 *   3. the provider implied by whichever env key is present
 *   4. "gemini" as a last resort
 */
function resolveProvider(bodyProvider?: unknown): AiProvider {
  if (isValidProvider(bodyProvider)) return bodyProvider;
  if (storedApiKey) return storedProvider;
  return providerFromEnv() ?? "gemini";
}

/** GET /api/tds — check if an AI API key is configured */
export async function GET() {
  const provider = resolveProvider();
  // `configured` reflects whether a key is actually usable for the
  // *reported* provider — not just "some env key exists" — so the UI
  // can't claim it's set up when POST would 401.
  const configured = !!resolveApiKey(undefined, provider);
  return NextResponse.json({ configured, provider });
}

/** PUT /api/tds — save AI API key (web mode) */
export async function PUT(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

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

    const validProvider: AiProvider = isValidProvider(provider) ? provider : "gemini";

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
export async function DELETE(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  storedApiKey = null;
  storedProvider = "gemini";
  return NextResponse.json({ success: true });
}

/**
 * Resolve the API key for the chosen provider.
 *   1. an explicit key on the request
 *   2. the env key for *that* provider
 *   3. the stored key — but ONLY when it was saved for the same provider.
 *
 * GH #251: step 3 used to return `storedApiKey` unconditionally, which
 * could hand a Gemini key to a Claude/OpenAI endpoint when the request
 * asked for a different provider than the one the key was saved under.
 */
function resolveApiKey(bodyKey: string | undefined, provider: AiProvider): string | null {
  if (bodyKey) return bodyKey;

  const envKey = envKeyForProvider(provider);
  if (envKey) return envKey;

  return storedProvider === provider ? storedApiKey : null;
}

/** POST /api/tds — extract filament data from a TDS URL or uploaded file */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

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

      const provider = resolveProvider(bodyProvider);

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
        const msg = result.error || "Extraction failed";
        return errorResponse(msg, isClientInputErrorMessage(msg) ? 400 : 502);
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

    const provider = resolveProvider(bodyProvider);
    const apiKey = resolveApiKey(bodyKey, provider);

    if (!apiKey) {
      return errorResponse(
        "AI API key not configured. Add it in Settings or set the appropriate environment variable (GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY).",
        401,
      );
    }

    const result = await extractFromTds(url, apiKey, provider);

    if (!result.success) {
      const msg = result.error || "Extraction failed";
      return errorResponse(msg, isClientInputErrorMessage(msg) ? 400 : 502);
    }

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse("TDS extraction failed", 500, getErrorMessage(err));
  }
}
