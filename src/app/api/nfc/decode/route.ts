import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { decodeOpenPrintTagBinary } from "@/lib/openprinttag-decode";
import type { DecodedOpenPrintTag } from "@/lib/openprinttag-decode";
import { parseNdefFromTag } from "@/lib/ndef";
import { parseBambuBlocks, bambuToDecodedTag } from "@/lib/bambuTag";
import { matchFilament } from "@/lib/matchFilament";
import {
  errorResponse,
  errorResponseFromCaught,
  checkContentLength,
} from "@/lib/apiErrorHandler";

/**
 * POST /api/nfc/decode — decode raw NFC tag bytes server-side and attach a DB
 * match. The mobile scanner app's whole job is: read NFC bytes → POST here →
 * render the result. The decode logic (OpenPrintTag CBOR, Bambu MIFARE) is
 * complex, edge-case-laden, and — for Bambu — depends on Node crypto that
 * won't run in React Native, so it lives on the server (GH: mobile-scanner
 * Phase 0). Keeping it here also means one tested code path instead of a
 * duplicate client decoder that drifts from the desktop reader.
 *
 * Request (application/json):
 *   {
 *     tagType: "openprinttag" | "bambu",
 *     // OpenPrintTag (ISO 15693 / NFC-V) — supply ONE of:
 *     payload?:   base64,  // the NDEF record payload (CBOR) — preferred; iOS
 *                          // Core NFC hands back already-parsed NDEF records
 *     tagMemory?: base64,  // raw tag memory; the route runs parseNdefFromTag
 *     // Bambu (MIFARE Classic / ISO 14443-3A):
 *     blocks?: { [blockNumber: string]: base64 }  // 16-byte plaintext blocks
 *   }
 *
 * Response 200: { decoded: DecodedOpenPrintTag, match: Filament | null, candidates: Filament[] }
 * Errors: 400 invalid body / undecodable bytes; 415 unknown tagType.
 *
 * Like GET /api/filaments/match, this route is intentionally NOT behind
 * assertSameOriginRequest: it performs no mutation (decode + read-only lookup)
 * and is meant to be reached by the cross-origin mobile app and slicer
 * integrations, exactly as the match route is. When FILAMENTDB_API_KEY is set,
 * src/proxy.ts requires EVERY /api caller (this route included) to present the
 * bearer key — so the optional key, not assertSameOriginRequest, is what gates
 * off-device access here.
 */

// Tag data is tiny (OpenPrintTag ~320 bytes, a full MIFARE 1K dump ~1 KB);
// base64 inflates ~33%. 64 KB is a generous ceiling that still bounds the
// CBOR/NDEF parse work a hostile caller can trigger.
const MAX_DECODE_BODY = 64 * 1024;

function toBytes(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Bound a decoded string before it feeds matchFilament's regex queries. */
function boundedField(v: string | undefined): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

function decodeOpenPrintTag(body: Record<string, unknown>): DecodedOpenPrintTag {
  const payload = toBytes(body.payload);
  if (payload) {
    return decodeOpenPrintTagBinary(payload);
  }
  const tagMemory = toBytes(body.tagMemory);
  if (tagMemory) {
    return decodeOpenPrintTagBinary(parseNdefFromTag(tagMemory));
  }
  throw new Error(
    "openprinttag decode requires a base64 'payload' (NDEF record payload) or 'tagMemory' (raw tag memory)",
  );
}

function decodeBambu(body: Record<string, unknown>): DecodedOpenPrintTag {
  const blocks = body.blocks;
  if (blocks === null || typeof blocks !== "object" || Array.isArray(blocks)) {
    throw new Error("bambu decode requires a 'blocks' object mapping block number → base64");
  }
  // Sparse array indexed by absolute MIFARE block number (0–63).
  const blockArray: (Buffer | undefined)[] = new Array(64).fill(undefined);
  let populated = 0;
  for (const [key, value] of Object.entries(blocks as Record<string, unknown>)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 0 || n > 63) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    blockArray[n] = Buffer.from(value, "base64");
    populated++;
  }
  // An empty / all-invalid block map would otherwise parse into an all-zero
  // array and yield a fabricated tag (brandName "Bambu Lab", black color, blank
  // material) returned as a 200 success — so a failed phone read or malformed
  // payload would masquerade as a decoded tag (Codex P2 on PR #690). Require at
  // least one usable block.
  if (populated === 0) {
    throw new Error("bambu decode requires at least one readable MIFARE block");
  }
  const parsed = parseBambuBlocks(blockArray);
  // Even with some blocks present, a dump carrying none of the identity blocks
  // (variant/material id, filament type) has nothing we can match or create a
  // filament from — treat it as an undecodable read rather than inventing a tag.
  if (!parsed.filamentType && !parsed.materialVariantId && !parsed.detailedFilamentType) {
    throw new Error("bambu blocks contained no readable filament identity (blocks 1/2/4)");
  }
  return bambuToDecodedTag(parsed);
}

export async function POST(request: NextRequest) {
  const tooLarge = checkContentLength(request, MAX_DECODE_BODY);
  if (tooLarge) return tooLarge;

  // Belt-and-suspenders: checkContentLength only inspects the Content-Length
  // header, so a chunked / header-less body slips past it. Re-check the
  // buffered byte length before parsing so this public, cross-origin-reachable
  // endpoint has a real memory bound (the pattern src/app/api/filaments/
  // prusaslicer/route.ts adopted for the same gap, Codex P2 on PR #685).
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_DECODE_BODY) {
    return errorResponse(
      `Request body too large. Maximum is ${(MAX_DECODE_BODY / 1024).toFixed(0)} KB.`,
      413,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Request body must be an object", 400);
  }
  const b = body as Record<string, unknown>;

  const tagType = b.tagType;
  if (tagType !== "openprinttag" && tagType !== "bambu") {
    return errorResponse(
      "tagType must be 'openprinttag' or 'bambu'",
      415,
    );
  }

  let decoded: DecodedOpenPrintTag;
  try {
    decoded = tagType === "openprinttag" ? decodeOpenPrintTag(b) : decodeBambu(b);
  } catch (err) {
    // Bad bytes / wrong-format tag is client input, not a server fault → 400.
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse("Could not decode tag", 400, message);
  }

  try {
    await dbConnect();
    // An OpenPrintTag written by Filament DB carries the filament's instanceId
    // in its spool_uid field (see GET /api/filaments/{id}/openprinttag, which
    // sets spoolUid = filament.instanceId), so the decoded spoolUid is the
    // strongest match signal for our own tags — matchFilament tries it first.
    // For a Bambu tag (spoolUid = 32-char tray UID) or a community OpenPrintTag
    // it won't collide with a 10-char FDB instanceId, so it harmlessly falls
    // through to the name/vendor/type matching that mirrors scanMatchHandler.
    const queriedInstanceId = boundedField(decoded.spoolUid);
    const { match, candidates, matchedSpool } = await matchFilament({
      instanceId: queriedInstanceId,
      name: boundedField(decoded.materialName),
      vendor: boundedField(decoded.brandName),
      type: boundedField(decoded.materialType),
    });
    // Tell the scanner HOW we matched. Only an instanceId match is a confident
    // "this exact physical tag is in the DB" — the tag's spool_uid equals a
    // filament's instanceId, which is what Filament DB wrote into the tag for
    // that filament (GET /api/filaments/{id}/openprinttag). The weaker name /
    // vendor+type heuristics (matchFilament's fallback tiers) can
    // open an existing sibling color, so the scanner must NOT treat them as
    // exact: it offers "create new" alongside opening the heuristic match.
    // instanceId is detected EITHER by a spool-level hit (#732 — matchedSpool
    // is non-null, the tag's spool_uid equals a spools[].instanceId) OR by the
    // filament-level fallback (the matched row's top-level instanceId equals
    // the queried spool_uid, case-insensitively). Both are confident "this
    // exact physical tag is in the DB". A spool hit's matched FILAMENT carries a
    // DIFFERENT top-level instanceId than the queried spool id, so the
    // matchedSpool check must come first — otherwise a genuine spool match would
    // be mislabelled "heuristic". The weaker name / vendor+type tiers
    // (matchedSpool null AND no filament-id equality) stay "heuristic" so the
    // scanner offers "create new" alongside opening the heuristic match.
    let matchedBy: "instanceId" | "heuristic" | null = null;
    if (match) {
      const matchedInstanceId = (match as { instanceId?: unknown }).instanceId;
      const filamentIdHit =
        !!queriedInstanceId &&
        typeof matchedInstanceId === "string" &&
        matchedInstanceId.toLowerCase() === queriedInstanceId.toLowerCase();
      matchedBy = matchedSpool || filamentIdHit ? "instanceId" : "heuristic";
    }
    return NextResponse.json({ decoded, match, candidates, matchedBy, matchedSpool });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to match decoded tag");
  }
}
